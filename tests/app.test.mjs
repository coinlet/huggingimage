import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";
import { dispatch } from "./request.mjs";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "authenticated workspace: provider management, job lifecycle, editing, assets, favorites and deletion",
  { timeout: 10000 },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "imagine-app-test-"));
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: "#b4d593" },
    })
      .png()
      .toBuffer();
    const calls = [];
    const workspace = createApp({
      dataDir: dir,
      adminToken: "test-token",
      runCompatible: async (provider, key, job, source, mask, signal) => {
        calls.push({ provider, key, job, source, mask });
        if (job.prompt === "failure") throw new Error(`Invalid Bearer ${key}`);
        if (job.prompt === "slow")
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 1500);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(signal.reason);
              },
              { once: true },
            );
          });
        return Array.from(
          { length: job.count },
          () => `data:image/png;base64,${png.toString("base64")}`,
        );
      },
      requestJson: async () => ({ data: [{ id: "test-image" }] }),
    });
    let cookie = "";
    const call = (route, method = "GET", body, extra = {}) =>
      dispatch(workspace.app, route, { method, body, cookie, ...extra });
    const waitJob = async (id) => {
      for (let i = 0; i < 100; i++) {
        const job = (await call("/api/jobs")).data.find((j) => j.id === id);
        if (!["queued", "running"].includes(job.status)) return job;
        await delay(10);
      }
      throw new Error("Task timed out");
    };
    try {
      assert.equal((await call("/api/session")).data.authenticated, false);
      assert.equal((await call("/api/providers")).status, 401);
      assert.equal((await call("/api/session", "POST", { token: "wrong" })).status, 401);
      const login = await call("/api/session", "POST", { token: "test-token" });
      assert.equal(login.status, 200);
      cookie = login.headers["set-cookie"].split(";")[0];
      assert.equal((await call("/api/session")).data.authenticated, true);
      const base = {
        type: "xai",
        name: "Test model",
        model: "image-test",
        baseUrl: "https://api.example.com/v1",
        enabled: true,
        supportsEdit: true,
        apiKey: "sk-test-sensitive",
      };
      const created = await call("/api/providers", "POST", base);
      assert.equal(created.status, 201);
      const provider = created.data;
      assert.equal(provider.hasKey, true);
      assert.equal("secret" in provider, false);
      assert.equal("apiKey" in provider, false);
      assert.equal(
        readFileSync(path.join(dir, "workspace.sqlite"), "utf8").includes(base.apiKey),
        false,
      );
      assert.equal(
        (await call(`/api/providers/${provider.id}`, "PUT", { ...base, apiKey: "" })).data.hasKey,
        true,
      );
      assert.equal((await call(`/api/providers/${provider.id}/test`, "POST")).data.ok, true);
      const queued = await call("/api/jobs", "POST", {
        providerId: provider.id,
        prompt: "green hills",
        count: 2,
        ratio: "3:2",
      });
      assert.equal(queued.status, 202);
      const job = await waitJob(queued.data.id);
      assert.equal(job.status, "succeeded", JSON.stringify(job));
      assert.equal(job.imageIds.length, 2);
      assert.equal(calls[0].key, base.apiKey);
      assert.equal(calls[0].job.width, 1536);
      const gallery = (await call("/api/images")).data;
      assert.equal(gallery.length, 2);
      assert.equal(gallery[0].seed, undefined);
      assert.equal(
        (await call(`/api/images/${gallery[0].id}`, "PATCH", { favorite: true })).data.favorite,
        true,
      );
      const media = await call(gallery[0].url);
      assert.equal(media.status, 200);
      assert.ok(media.bytes.length > 0);
      assert.equal((await sharp(media.bytes).metadata()).width, 64);
      assert.equal((await call(gallery[0].url, "GET", undefined, { cookie: "" })).status, 401);
      const uploaded = await call("/api/uploads", "POST", {
        data: `data:image/png;base64,${png.toString("base64")}`,
        name: "source.png",
      });
      assert.equal(uploaded.status, 201);
      const edit = await call("/api/jobs", "POST", {
        providerId: provider.id,
        prompt: "make it blue",
        mode: "edit",
        sourceId: uploaded.data.id,
        maskId: uploaded.data.id,
      });
      assert.equal((await waitJob(edit.data.id)).status, "succeeded");
      assert.ok(Buffer.isBuffer(calls[1].source));
      assert.ok(Buffer.isBuffer(calls[1].mask));
      const editedJob = await waitJob(edit.data.id);
      const firstEdit = editedJob.imageIds[0];
      const secondEdit = await call("/api/jobs", "POST", {
        providerId: provider.id,
        prompt: "add sunlight",
        mode: "edit",
        sourceId: firstEdit,
      });
      const secondJob = await waitJob(secondEdit.data.id);
      assert.equal(secondJob.status, "succeeded");
      const branch = await call("/api/jobs", "POST", {
        providerId: provider.id,
        prompt: "alternate red",
        mode: "edit",
        sourceId: uploaded.data.id,
      });
      assert.equal((await waitJob(branch.data.id)).status, "succeeded");
      const thread = await call(`/api/images/${secondJob.imageIds[0]}/thread`);
      assert.equal(thread.status, 200);
      assert.deepEqual(
        thread.data.map((i) => i.prompt),
        [undefined, "make it blue", "add sunlight", "alternate red"],
      );
      assert.ok(thread.data.every((i) => i.threadId === uploaded.data.id));
      assert.equal(thread.data[2].parentId, firstEdit);
      assert.equal(thread.data[3].parentId, uploaded.data.id);
      assert.equal(thread.data[0].kind, "upload");
      assert.equal(
        (await call(`/api/images/${firstEdit}/thread`, "GET", undefined, { cookie: "" })).status,
        401,
      );
      assert.equal((await call("/api/images/missing/thread")).status, 404);

      assert.equal(
        (
          await call("/api/jobs", "POST", {
            providerId: provider.id,
            prompt: "no image",
            mode: "edit",
          })
        ).status,
        400,
      );
      assert.equal(
        (await call("/api/jobs", "POST", { providerId: provider.id, prompt: "too many", count: 5 }))
          .status,
        400,
      );
      const failed = await call("/api/jobs", "POST", {
        providerId: provider.id,
        prompt: "failure",
      });
      const failedJob = await waitJob(failed.data.id);
      assert.equal(failedJob.status, "failed");
      assert.equal(failedJob.error.includes(base.apiKey), false);
      const slow = await call("/api/jobs", "POST", { providerId: provider.id, prompt: "slow" });
      await call(`/api/jobs/${slow.data.id}/cancel`, "POST");
      assert.equal((await waitJob(slow.data.id)).status, "cancelled");
      const before = (await call("/api/images")).data.length;
      assert.equal((await call(`/api/images/${gallery[0].id}`, "DELETE")).status, 200);
      assert.equal((await call("/api/images")).data.length, before - 1);
      assert.equal(
        (await call("/api/providers", "POST", base, { origin: "https://evil.test" })).status,
        403,
      );
      assert.equal(
        (
          await call(`/api/providers/${provider.id}`, "PUT", {
            ...base,
            apiKey: "",
            clearKey: true,
          })
        ).data.hasKey,
        false,
      );
      assert.equal((await call(`/api/providers/${provider.id}`, "DELETE")).status, 200);
      assert.equal((await call("/api/providers")).data.length, 0);
    } finally {
      workspace.close();
      await delay(20);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("local workspace validates incoming hosts and accepts local provider URLs", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imagine-local-test-"));
  const workspace = createApp({ dataDir: dir, adminToken: "" });
  try {
    assert.equal(
      (await dispatch(workspace.app, "/api/providers", { host: "evil.test" })).status,
      403,
    );
    assert.equal(
      (
        await dispatch(workspace.app, "/api/providers", {
          method: "POST",
          body: { type: "openai", name: "test", model: "test", baseUrl: "http://127.0.0.1/v1" },
        })
      ).status,
      201,
    );
  } finally {
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
