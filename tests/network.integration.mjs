import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "complete authenticated workspace flow with real HTTP provider adapters",
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "imagine-api-test-"));
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: "#9bc46d" },
    })
      .png()
      .toBuffer();
    const calls = [];
    const mock = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      calls.push({
        url: req.url,
        authorization: req.headers.authorization,
        type: req.headers["content-type"],
        raw,
      });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/models")
        return res.end(JSON.stringify({ data: [{ id: "test-image" }] }));
      const body = req.headers["content-type"]?.includes("application/json")
        ? JSON.parse(raw)
        : null;
      if (body?.prompt === "slow task") {
        await delay(1500);
      }
      if (body?.prompt === "upstream error") {
        res.statusCode = 401;
        return res.end(
          JSON.stringify({ error: { message: "Invalid Bearer sk-super-secret-test" } }),
        );
      }
      res.end(
        JSON.stringify({
          data: Array.from({ length: body?.n || 1 }, () => ({ b64_json: png.toString("base64") })),
        }),
      );
    });
    mock.listen(0, "127.0.0.1");
    await once(mock, "listening");
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    const child = spawn(process.execPath, ["server/index.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        DATA_DIR: dir,
        ADMIN_TOKEN: "test-workspace-token",
        ENCRYPTION_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    let cookie = "";
    async function call(route, method = "GET", body, auth = true) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(auth && cookie ? { Cookie: cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await response.json();
      return { response, data };
    }
    async function waitJob(id) {
      for (let i = 0; i < 80; i++) {
        const { data } = await call("/api/jobs");
        const job = data.find((j) => j.id === id);
        if (!["queued", "running"].includes(job.status)) return job;
        await delay(50);
      }
      throw new Error("Job did not complete");
    }
    try {
      for (let i = 0; i < 100; i++) {
        try {
          await fetch(`http://127.0.0.1:${port}/api/session`);
          break;
        } catch {
          if (child.exitCode !== null) throw new Error(output);
          await delay(50);
        }
      }
      assert.equal((await call("/api/providers")).response.status, 401);
      assert.equal((await call("/api/session", "POST", { token: "wrong" })).response.status, 401);
      const login = await call("/api/session", "POST", { token: "test-workspace-token" });
      assert.equal(login.response.status, 200);
      cookie = login.response.headers.get("set-cookie").split(";")[0];
      const base = {
        type: "xai",
        name: "Mock Grok",
        enabled: true,
        supportsEdit: true,
        baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
        model: "test-image",
        apiKey: "sk-super-secret-test",
      };
      const created = await call("/api/providers", "POST", base);
      assert.equal(created.response.status, 201);
      const provider = created.data;
      assert.equal(provider.hasKey, true);
      assert.equal("secret" in provider, false);
      assert.equal("apiKey" in provider, false);
      assert.equal(
        readFileSync(path.join(dir, "workspace.json"), "utf8").includes(base.apiKey),
        false,
      );
      const update = await call(`/api/providers/${provider.id}`, "PUT", { ...base, apiKey: "" });
      assert.equal(update.data.hasKey, true);
      assert.equal((await call(`/api/providers/${provider.id}/test`, "POST")).data.ok, true);
      const queued = await call("/api/jobs", "POST", {
        providerId: provider.id,
        prompt: "green hills",
        count: 2,
        ratio: "3:2",
      });
      assert.equal(queued.response.status, 202);
      const job = await waitJob(queued.data.id);
      assert.equal(job.status, "succeeded", JSON.stringify(job));
      assert.equal(job.imageIds.length, 2);
      const generationCall = calls.find((c) => c.url === "/v1/images/generations");
      assert.equal(generationCall.authorization, `Bearer ${base.apiKey}`);
      assert.equal(JSON.parse(generationCall.raw).aspect_ratio, "3:2");
      const gallery = (await call("/api/images")).data;
      assert.equal(gallery.length, 2);
      assert.equal(
        (await call(`/api/images/${gallery[0].id}`, "PATCH", { favorite: true })).data.favorite,
        true,
      );
      const media = await fetch(`http://127.0.0.1:${port}${gallery[0].url}`, {
        headers: { Cookie: cookie },
      });
      assert.equal(media.status, 200);
      assert.equal((await media.arrayBuffer()).byteLength > 0, true);
      assert.equal((await fetch(`http://127.0.0.1:${port}${gallery[0].url}`)).status, 401);
      const upload = await call("/api/uploads", "POST", {
        data: `data:image/png;base64,${png.toString("base64")}`,
        name: "test.png",
      });
      assert.equal(upload.response.status, 201);
      const editing = await call("/api/jobs", "POST", {
        providerId: provider.id,
        prompt: "make it blue",
        mode: "edit",
        sourceId: upload.data.id,
      });
      assert.equal((await waitJob(editing.data.id)).status, "succeeded");
      const xaiEdit = calls.find((c) => c.url === "/v1/images/edits");
      assert.equal(xaiEdit.type, "application/json");
      assert.match(JSON.parse(xaiEdit.raw).image.url, /^data:image\/png;base64,/);
      const openai = (
        await call("/api/providers", "POST", { ...base, type: "openai", name: "Mock OpenAI" })
      ).data;
      const openaiEdit = await call("/api/jobs", "POST", {
        providerId: openai.id,
        prompt: "change style",
        mode: "edit",
        sourceId: upload.data.id,
        maskId: upload.data.id,
      });
      assert.equal((await waitJob(openaiEdit.data.id)).status, "succeeded");
      const multipart = calls.find(
        (c) => c.url === "/v1/images/edits" && c.type.startsWith("multipart/form-data"),
      );
      assert.ok(multipart);
      assert.match(multipart.raw, /name="image"/);
      assert.match(multipart.raw, /name="mask"/);
      assert.equal(
        (
          await call("/api/jobs", "POST", {
            providerId: provider.id,
            prompt: "edit without reference",
            mode: "edit",
          })
        ).response.status,
        400,
      );
      assert.equal(
        (
          await call("/api/jobs", "POST", {
            providerId: provider.id,
            prompt: "bad count",
            count: 99,
          })
        ).response.status,
        400,
      );
      const failing = await call("/api/jobs", "POST", {
        providerId: provider.id,
        prompt: "upstream error",
      });
      const failed = await waitJob(failing.data.id);
      assert.equal(failed.status, "failed");
      assert.equal(failed.error.includes(base.apiKey), false);
      const slow = await call("/api/jobs", "POST", {
        providerId: provider.id,
        prompt: "slow task",
      });
      await call(`/api/jobs/${slow.data.id}/cancel`, "POST");
      assert.equal((await waitJob(slow.data.id)).status, "cancelled");
      const before = (await call("/api/images")).data.length;
      assert.equal((await call(`/api/images/${gallery[0].id}`, "DELETE")).response.status, 200);
      assert.equal((await call("/api/images")).data.length, before - 1);
      const cross = await fetch(`http://127.0.0.1:${port}/api/providers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: "https://evil.example",
        },
        body: JSON.stringify(base),
      });
      assert.equal(cross.status, 403);
      await call("/api/session", "DELETE");
    } finally {
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
      await new Promise((resolve) => mock.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
