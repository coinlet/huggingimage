import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.mjs";
import { dispatch } from "./request.mjs";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("MCP provider discovery, encrypted credentials, generation and chained edits share the existing workspace", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imagine-mcp-api-"));
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "green" } })
    .png()
    .toBuffer();
  const inspections = [],
    inferences = [];
  const key = "private-mcp-token-123";
  const discovered = {
    transport: "streamable-http",
    tools: [{ name: "generate_image" }, { name: "edit_image" }],
    endpoint: "generate_image",
    editEndpoint: "edit_image",
    template: { prompt: "{{prompt}}" },
    editTemplate: { prompt: "{{prompt}}", image: "{{image_data_uri}}" },
    supportsGenerate: true,
    supportsEdit: true,
  };
  const workspace = createApp({
    dataDir: dir,
    adminToken: "workspace-token",
    inspectMcp: async (provider, token) => {
      inspections.push({ provider, token });
      return discovered;
    },
    runMcp: async (provider, token, job, source) => {
      inferences.push({ provider, token, job: { ...job }, source });
      return [
        {
          url: `data:image/png;base64,${png.toString("base64")}`,
          authOrigin: "https://mcp.example.com",
        },
      ];
    },
  });
  const call = (route, method = "GET", body, authenticated = true) =>
    dispatch(workspace.app, route, {
      method,
      body,
      headers: authenticated ? { authorization: "Bearer workspace-token" } : {},
    });
  async function wait(id) {
    for (let n = 0; n < 100; n++) {
      const job = (await call("/api/jobs")).data.find((j) => j.id === id);
      if (!["queued", "running"].includes(job.status)) return job;
      await delay(10);
    }
    throw new Error("Job timeout");
  }
  try {
    assert.equal(
      (await call("/api/mcp/discover", "POST", { baseUrl: "https://mcp.example.com/mcp" }, false))
        .status,
      401,
    );
    const detect = await call("/api/mcp/discover", "POST", {
      baseUrl: "https://mcp.example.com/mcp",
      apiKey: key,
    });
    assert.equal(detect.status, 200);
    assert.equal(inspections[0].token, key);
    assert.equal(inferences.length, 0);
    const body = {
      ...discovered,
      name: "Remote MCP",
      type: "mcp",
      enabled: true,
      baseUrl: "https://mcp.example.com/mcp",
      mcpTransport: "auto",
      mcpAuth: "x-api-key",
      apiKey: key,
      defaults: { generate: { steps: 4 }, edit: { steps: 8 } },
    };
    const created = await call("/api/providers", "POST", body);
    assert.equal(created.status, 201);
    const provider = created.data;
    assert.equal(provider.hasKey, true);
    assert.equal(provider.mcpTransport, "auto");
    assert.equal(provider.apiKey, undefined);
    assert.equal(provider.secret, undefined);
    assert.equal(JSON.stringify(provider).includes(key), false);
    const db = new DatabaseSync(path.join(dir, "workspace.sqlite"), { readOnly: true });
    assert.equal(db.prepare("SELECT payload FROM providers").get().payload.includes(key), false);
    db.close();
    const saved = await call(`/api/providers/${provider.id}`, "PUT", { ...body, apiKey: "" });
    assert.equal(saved.data.hasKey, true);
    assert.equal(saved.data.defaults.edit.steps, 8);
    const readSaved = await call("/api/mcp/discover", "POST", {
      baseUrl: body.baseUrl,
      providerId: provider.id,
    });
    assert.equal(readSaved.status, 200);
    assert.equal(inspections.at(-1).token, key);
    const before = inspections.length;
    const changed = await call("/api/mcp/discover", "POST", {
      baseUrl: "https://different.example.com/mcp",
      providerId: provider.id,
    });
    assert.equal(changed.status, 400);
    assert.equal(inspections.length, before);
    assert.equal((await call(`/api/providers/${provider.id}/test`, "POST")).data.ok, true);
    assert.equal(inferences.length, 0);
    const queued = (
      await call("/api/jobs", "POST", {
        providerId: provider.id,
        prompt: "forest",
        resolution: "custom",
        width: 1280,
        height: 720,
      })
    ).data;
    const generated = await wait(queued.id);
    assert.equal(generated.status, "succeeded");
    assert.equal(inferences[0].token, key);
    assert.equal(inferences[0].job.width, 1280);
    assert.equal(inferences[0].provider.endpoint, "generate_image");
    const edited = (
      await call("/api/jobs", "POST", {
        providerId: provider.id,
        mode: "edit",
        sourceId: generated.imageIds[0],
        prompt: "add snow",
      })
    ).data;
    const editJob = await wait(edited.id);
    assert.equal(editJob.status, "succeeded");
    assert.ok(Buffer.isBuffer(inferences[1].source));
    const thread = (await call(`/api/images/${editJob.imageIds[0]}/thread`)).data;
    assert.deepEqual(
      thread.map((i) => i.prompt),
      ["forest", "add snow"],
    );
    assert.equal(thread[1].parentId, generated.imageIds[0]);
    assert.equal((await call(thread[1].url)).status, 200);
    assert.equal((await call("/api/providers", "POST", { ...body, template: [] })).status, 400);
  } finally {
    workspace.close();
    await delay(30);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP discovery errors redact credentials instead of returning tokens to the browser", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imagine-mcp-redact-"));
  const key = "sensitive-mcp-key";
  const workspace = createApp({
    dataDir: dir,
    adminToken: "",
    inspectMcp: async () => {
      throw new Error(`Invalid token ${key}`);
    },
  });
  try {
    const result = await dispatch(workspace.app, "/api/mcp/discover", {
      method: "POST",
      body: { baseUrl: "https://mcp.example.com/mcp", apiKey: key },
    });
    assert.equal(result.status, 400);
    assert.equal(result.data.error.includes(key), false);
    assert.match(result.data.error, /已隐藏/);
  } finally {
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
