import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";
import { dispatch } from "./request.mjs";
const schema = JSON.parse(readFileSync(new URL("./fixtures/qwen-edit-api.json", import.meta.url)));

test("URL and token discover a savable edit-only provider without creating or invoking a model", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imagine-discovery-test-"));
  const inspections = [];
  const workspace = createApp({
    dataDir: dir,
    adminToken: "",
    inspectSpace: async (provider, key) => {
      inspections.push({ space: provider.space, key });
      return schema;
    },
  });
  const call = (route, method = "GET", body) => dispatch(workspace.app, route, { method, body });
  try {
    const found = await call("/api/spaces/discover", "POST", {
      space: "https://huggingface.co/spaces/Qwen/Qwen-Image-Edit",
      apiKey: "hf_test_discovery_token",
    });
    assert.equal(found.status, 200);
    assert.equal(found.data.ready, true);
    assert.equal(found.data.supportsGenerate, false);
    assert.deepEqual(inspections, [
      { space: "Qwen/Qwen-Image-Edit", key: "hf_test_discovery_token" },
    ]);
    assert.doesNotMatch(JSON.stringify(found.data), /hf_test_discovery_token/);
    assert.equal((await call("/api/providers")).data.length, 0);
    assert.equal((await call("/api/jobs")).data.length, 0);
    const saved = await call("/api/providers", "POST", {
      ...found.data,
      type: "gradio",
      enabled: true,
      apiKey: "hf_test_discovery_token",
    });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.hasKey, true);
    assert.equal(saved.data.editEndpoint, "/infer");
    assert.deepEqual(saved.data.defaults.edit, { steps: 50, guidance: 4 });
    const reused = await call("/api/spaces/discover", "POST", {
      space: found.data.space,
      providerId: saved.data.id,
    });
    assert.equal(reused.status, 200);
    assert.equal(inspections.at(-1).key, "hf_test_discovery_token");
    const changed = await call("/api/spaces/discover", "POST", {
      space: "another/space",
      providerId: saved.data.id,
    });
    assert.equal(changed.status, 400);
    assert.equal(inspections.length, 2);
    const invalid = await call("/api/spaces/discover", "POST", {
      space: "https://127.0.0.1/private",
      apiKey: "hf_test_discovery_token",
    });
    assert.equal(invalid.status, 400);
    const generation = await call("/api/jobs", "POST", {
      providerId: saved.data.id,
      prompt: "forest",
      mode: "generate",
    });
    assert.equal(generation.status, 400);
    assert.match(generation.data.error, /仅支持图片编辑/);
  } finally {
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
