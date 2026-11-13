import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@gradio/client";
import { inspectSpace, runSpace } from "../server/providers.mjs";
import { analyzeSpaceApi } from "../server/space-config.mjs";
import { discoverConfiguration } from "../server/space-discovery.mjs";
import { readSpaceSchema, mapAspectRatio } from "../server/gradio-schema.mjs";

// Reduced contract from the API definition supplied by the user; no live GPU calls.
const api = JSON.parse(readFileSync(new URL("./fixtures/qwen-aio-api.json", import.meta.url)));
const ratio = api.named_endpoints["/generate"].parameters.find(
  (p) => p.parameter_name === "aspect_ratio",
);

test("inspection preserves raw enums, endpoint metadata and HF authentication", async (t) => {
  let closed = false;
  t.mock.method(Client, "connect", async () => ({
    config: { root: "https://example-model.hf.space/" },
    api_prefix: "/gradio_api/",
    async fetch(url, options) {
      assert.equal(url, "https://example-model.hf.space/gradio_api/info");
      assert.equal(options.headers.Authorization, "Bearer hf_test");
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(api);
    },
    view_api() {
      throw new Error("simplified schema must not be used");
    },
    close() {
      closed = true;
    },
  }));
  const raw = await inspectSpace({ space: "owner/model" }, "hf_test");
  assert.deepEqual(raw, api);
  assert.equal(closed, true);
});

test("raw schema supports legacy API prefixes and rejects unreadable responses", async () => {
  const client = {
    config: { root: "https://example-model.hf.space/base/" },
    api_prefix: "",
    async fetch(url, options) {
      assert.equal(url, "https://example-model.hf.space/base/info");
      assert.deepEqual(options.headers, {});
      return Response.json({ api });
    },
  };
  assert.deepEqual(await readSpaceSchema(client, ""), api);
  client.fetch = async () => new Response("", { status: 401 });
  await assert.rejects(readSpaceSchema(client, ""), /HTTP 401/);
  client.fetch = async () => Response.json({});
  await assert.rejects(readSpaceSchema(client, ""), /API 定义/);
});

test("Qwen AIO selects generation and single-image edit, leaves optional LoRAs blank and disables enhancement", async () => {
  const detected = analyzeSpaceApi(api, "owner/model");
  assert.equal(detected.ready, true);
  assert.equal(detected.endpoint, "/generate");
  assert.equal(detected.editEndpoint, "/generate");
  assert.equal(detected.outputPath, "0");
  assert.equal(detected.editOutputPath, "0");
  assert.equal(detected.template.mode, "Text to Image");
  assert.equal(detected.editTemplate.mode, "Edit Image (1 Ref)");
  assert.equal(detected.template.ref_image_1, null);
  assert.equal(detected.editTemplate.ref_image_1, "{{image}}");
  for (const template of [detected.template, detected.editTemplate]) {
    assert.equal(template.ref_image_2, null);
    assert.deepEqual(template.multi_refs, []);
    assert.equal(template.enhance_mode, "Off");
    assert.equal(template.pe_api_key, "");
    assert.equal(template.pe_base_url, "");
    for (let i = 1; i <= 4; i++) {
      assert.equal(template[`custom_repo_${i}`], "");
      assert.equal(template[`custom_file_${i}`], "");
    }
    for (const p of api.named_endpoints["/generate"].parameters)
      assert.ok(
        p.parameter_has_default || Object.hasOwn(template, p.parameter_name),
        p.parameter_name,
      );
  }
  assert.ok(detected.warnings.some((w) => w.includes("多图参考")));
  const result = await discoverConfiguration(api, "owner/model", {
    ai: { key: "test", baseUrl: "https://ai.test/v1", model: "test" },
    transport() {
      throw new Error("known mapping should not be replaced by AI");
    },
  });
  assert.deepEqual(result.editTemplate, detected.editTemplate);
});

test("only recognized Qwen AIO blank fields bypass required-value review", () => {
  const unknown = structuredClone(api);
  unknown.named_endpoints["/generate"].parameters.push({
    parameter_name: "unknown_required",
    component: "Textbox",
    type: { type: "string" },
    parameter_has_default: false,
  });
  const detected = analyzeSpaceApi(unknown, "owner/model");
  assert.equal(detected.ready, false);
  assert.ok(detected.warnings.some((w) => w.includes("unknown_required")));
  const other = structuredClone(api);
  other.named_endpoints["/generate"].parameters = other.named_endpoints[
    "/generate"
  ].parameters.filter((p) => p.parameter_name !== "mode");
  assert.equal(analyzeSpaceApi(other, "owner/model").ready, false);
});

test("aspect ratios map to advertised full labels and unsupported ratios fail clearly", () => {
  assert.equal(mapAspectRatio("16:9", ratio), "Landscape · 16:9 (1344x768)");
  assert.equal(mapAspectRatio("3:4", ratio), "Portrait · 3:4 (864x1152)");
  assert.throws(() => mapAspectRatio("3:2", ratio), /不支持比例 3:2/);
  assert.equal(mapAspectRatio("1:1", { type: "string" }), "1:1");
});

test("configured Space execution sends correct modes, uploaded image and full ratio labels", async () => {
  const provider = analyzeSpaceApi(api, "owner/model");
  let submitted = 0,
    closed = 0;
  let mode;
  const connector = async () => ({
    config: { root: "https://example-model.hf.space" },
    api_prefix: "/gradio_api",
    fetch: async () => Response.json(api),
    close() {
      closed++;
    },
    submit(endpoint, params) {
      submitted++;
      assert.equal(endpoint, "/generate");
      assert.equal(params.mode, mode === "edit" ? "Edit Image (1 Ref)" : "Text to Image");
      assert.equal(params.aspect_ratio, "Landscape · 16:9 (1344x768)");
      assert.equal(params.enhance_mode, "Off");
      assert.equal(params.pe_api_key, "");
      if (mode === "edit") assert.ok(params.ref_image_1);
      else assert.equal(params.ref_image_1, null);
      return {
        cancel() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: "data",
            data: [
              { url: "https://example-model.hf.space/result.png" },
              null,
              42,
              "details",
              "prompt",
            ],
          };
        },
      };
    },
  });
  for (mode of ["generate", "edit"]) {
    const result = await runSpace(
      provider,
      "",
      { mode, count: 1, prompt: "forest", ratio: "16:9", seed: 42, steps: 30, guidance: 1 },
      mode === "edit" ? Buffer.from("image") : null,
      null,
      new AbortController().signal,
      connector,
    );
    assert.equal(result.length, 1);
  }
  assert.equal(submitted, 2);
  assert.equal(closed, 2);
});
