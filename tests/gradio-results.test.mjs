import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@gradio/client";
import { connectSpace, runSpace } from "../server/providers.mjs";
import { analyzeSpaceApi, applyAiConfiguration } from "../server/space-config.mjs";
import {
  extractGradioImages,
  repairEncodedEditProvider,
  selectGradioOutput,
} from "../server/gradio-images.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../server/store.mjs";
import { createApp } from "../server/app.mjs";
import { dispatch } from "./request.mjs";
const source = Buffer.from("test image bytes");
const dataUrl = `data:image/png;base64,${source.toString("base64")}`;
const schema = {
  named_endpoints: {
    "/infer": {
      parameters: [
        {
          parameter_name: "images_b64_json",
          component: "Textbox",
          parameter_has_default: true,
          parameter_default: "[]",
          type: { type: "string" },
        },
        { parameter_name: "prompt", component: "Textbox", type: { type: "string" } },
        {
          parameter_name: "steps",
          component: "Slider",
          parameter_has_default: true,
          parameter_default: 4,
          type: { type: "number" },
        },
      ],
      returns: [{ component: "JSON", type: { type: "object" } }],
    },
  },
};
const job = {
  mode: "edit",
  count: 1,
  prompt: "blue background",
  seed: 42,
  steps: 4,
  guidance: 1,
  width: 1024,
  height: 1024,
};
function fakeClient(messages, onSubmit = () => {}) {
  return {
    config: { root: "https://test-model.hf.space" },
    api_prefix: "/gradio_api",
    close() {},
    submit(endpoint, parameters) {
      onSubmit(endpoint, parameters);
      return {
        cancel() {},
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message;
        },
      };
    },
  };
}
const settings = {
  editEndpoint: "/infer",
  editTemplate: { images_b64_json: "{{images_b64_json}}", prompt: "{{prompt}}" },
  editOutputPath: "0",
};

test("encoded image text inputs are edit-only and JSON image outputs can be configured automatically", () => {
  const config = analyzeSpaceApi(schema, "owner/Qwen-Image-Edit");
  assert.equal(config.ready, true);
  assert.equal(config.supportsGenerate, false);
  assert.equal(config.supportsEdit, true);
  assert.equal(config.editTemplate.images_b64_json, "{{images_b64_json}}");
  assert.equal(config.editOutputPath, "0");
  assert.throws(
    () =>
      applyAiConfiguration(schema, "owner/space", {
        generate: { endpoint: "/infer", template: { prompt: "{{prompt}}", images_b64_json: "[]" } },
      }),
    /图片映射/,
  );
  assert.throws(
    () =>
      applyAiConfiguration(schema, "owner/space", {
        edit: {
          endpoint: "/infer",
          template: { prompt: "{{prompt}}", images_b64_json: "{{image}}" },
        },
      }),
    /编码/,
  );
  const ai = applyAiConfiguration(schema, "owner/space", {
    edit: {
      endpoint: "/infer",
      template: { prompt: "{{prompt}}", images_b64_json: "{{images_b64_json}}" },
    },
  });
  assert.equal(ai.ready, true);
});

test("SDK connects with both data and status events so upstream errors are observable", async (t) => {
  let options;
  const mocked = t.mock.method(Client, "connect", async (_space, input) => {
    options = input;
    return {};
  });
  await connectSpace({ space: "owner/space" }, "hf_test_token");
  assert.deepEqual(options.events, ["data", "status"]);
  assert.equal(options.token, "hf_test_token");
  mocked.mock.restore();
});

test("edit submits JSON-stringified image data URIs and parses JSON-string image results", async () => {
  let params;
  const client = fakeClient(
    [{ type: "data", data: [JSON.stringify({ image: dataUrl, seed: 42 })] }],
    (_endpoint, input) => {
      params = input;
    },
  );
  const images = await runSpace(
    settings,
    "",
    job,
    source,
    null,
    new AbortController().signal,
    async () => client,
  );
  assert.deepEqual(JSON.parse(params.images_b64_json), [dataUrl]);
  assert.equal(typeof params.images_b64_json, "string");
  assert.equal(params.prompt, job.prompt);
  assert.equal(images[0].url, dataUrl);
  await assert.rejects(
    runSpace(
      { endpoint: "/infer", template: { images_b64_json: "[]" } },
      "",
      { ...job, mode: "generate" },
      null,
      null,
      new AbortController().signal,
      async () => {
        throw new Error("should not connect");
      },
    ),
    /需要参考图片/,
  );
});

test("upstream error status preserves its actual message instead of blaming the output path", async () => {
  const client = fakeClient([
    {
      type: "status",
      stage: "error",
      message: [{ msg: "Please upload at least one image to edit." }],
    },
  ]);
  await assert.rejects(
    runSpace(settings, "", job, source, null, new AbortController().signal, async () => client),
    /Please upload at least one image/,
  );
});

test("supports nested dictionaries, gallery wrappers, updates, unwrapped results and private file paths", () => {
  const options = { root: "https://test-model.hf.space", apiPrefix: "/gradio_api" };
  assert.deepEqual(extractGradioImages({ result: { images: [{ image: dataUrl }] } }, options), [
    dataUrl,
  ]);
  assert.deepEqual(
    extractGradioImages({ __type__: "update", value: { image: dataUrl } }, options),
    [dataUrl],
  );
  assert.deepEqual(
    extractGradioImages(
      { path: "/tmp/gradio/hash/result.png", url: null, meta: { _type: "gradio.FileData" } },
      options,
    ),
    ["https://test-model.hf.space/gradio_api/file=%2Ftmp%2Fgradio%2Fhash%2Fresult.png"],
  );
  assert.deepEqual(
    extractGradioImages({ path: "/tmp/gradio/hash/result.png", url: null }, options),
    ["https://test-model.hf.space/gradio_api/file=%2Ftmp%2Fgradio%2Fhash%2Fresult.png"],
  );
  assert.deepEqual(extractGradioImages({ url: "/gradio_api/file=result.png" }, options), [
    "https://test-model.hf.space/gradio_api/file=result.png",
  ]);
  assert.deepEqual(extractGradioImages({ path: "/etc/passwd", url: null }), []);
  assert.deepEqual(
    extractGradioImages({ path: "/tmp/result.png", url: null }, { root: "http://127.0.0.1" }),
    [],
  );
  assert.deepEqual(selectGradioOutput({ image: dataUrl }, "0"), { image: dataUrl });
  assert.deepEqual(
    extractGradioImages({ metadata: { url: "https://example.com/unrelated-link" } }),
    [],
  );
});

test("no-change update retains the result; explicit null does not silently return a preview", async () => {
  const messages = [
    { type: "data", data: [{ image: dataUrl }] },
    { type: "data", data: [{ __type__: "update" }] },
  ];
  const images = await runSpace(
    settings,
    "",
    job,
    source,
    null,
    new AbortController().signal,
    async () => fakeClient(messages),
  );
  assert.equal(images[0].url, dataUrl);
  await assert.rejects(
    runSpace(settings, "", job, source, null, new AbortController().signal, async () =>
      fakeClient([...messages, { type: "data", data: [null] }]),
    ),
    /返回结构/,
  );
});

test("missing-output diagnostics expose structure rather than image data, prompts or tokens", async () => {
  const client = fakeClient([
    { type: "data", data: [{ message: "hf_private_value_do_not_log", seed: 42 }] },
  ]);
  await assert.rejects(
    runSpace(settings, "", job, source, null, new AbortController().signal, async () => client),
    (error) => {
      assert.match(error.message, /对象\{message, seed\}/);
      assert.doesNotMatch(error.message, /hf_private_value|test image bytes|blue background/);
      return true;
    },
  );
});

test("legacy empty-image generation config migrates once and preserves key, defaults and custom settings", async () => {
  const provider = {
    id: "test",
    type: "gradio",
    space: "owner/Qwen-Image-Edit-2511-LoRAs-Fast",
    name: "Custom name",
    secret: "encrypted-key",
    endpoint: "/infer",
    editEndpoint: "",
    supportsGenerate: true,
    supportsEdit: false,
    template: { images_b64_json: "[]", prompt: "{{prompt}}", lora_adapter: "chosen-adapter" },
    outputPath: "0",
    defaults: { generate: { steps: 4 }, edit: {} },
  };
  assert.equal(repairEncodedEditProvider(provider), true);
  assert.equal(provider.supportsGenerate, false);
  assert.equal(provider.supportsEdit, true);
  assert.equal(provider.editTemplate.images_b64_json, "{{images_b64_json}}");
  assert.equal(provider.editTemplate.lora_adapter, "chosen-adapter");
  assert.equal(provider.secret, "encrypted-key");
  assert.deepEqual(provider.defaults.edit, { steps: 4 });
  assert.equal(repairEncodedEditProvider(provider), false);
  const directory = mkdtempSync(path.join(os.tmpdir(), "imagine-encoded-repair-"));
  try {
    const store = createStore(directory);
    store.state.providers.push({
      ...provider,
      endpoint: "/infer",
      editEndpoint: "",
      supportsGenerate: true,
      supportsEdit: false,
      template: { images_b64_json: "[]", prompt: "{{prompt}}" },
      editTemplate: {},
    });
    store.save();
    const workspace = createApp({ dataDir: directory, adminToken: "" });
    const list = await dispatch(workspace.app, "/api/providers");
    assert.equal(list.data[0].supportsEdit, true);
    assert.equal(list.data[0].editEndpoint, "/infer");
    workspace.close();
    assert.equal(
      JSON.parse(readFileSync(path.join(directory, "workspace.json"))).providers[0]
        .supportsGenerate,
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a pending status with success=false is not a terminal failure", async () => {
  const client = fakeClient([
    { type: "status", stage: "pending", success: false },
    { type: "data", data: [{ image: dataUrl }] },
  ]);
  const result = await runSpace(
    settings,
    "",
    job,
    source,
    null,
    new AbortController().signal,
    async () => client,
  );
  assert.equal(result[0].url, dataUrl);
});
