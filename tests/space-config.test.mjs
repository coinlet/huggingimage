import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeSpaceApi, applyAiConfiguration, aiSchema } from "../server/space-config.mjs";
import { discoverConfiguration } from "../server/space-discovery.mjs";
import { validateSpace, runSpace } from "../server/providers.mjs";
const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
const image = { component: "Image", type: { type: "object", title: "ImageData" } };
const parameter = (name, component = "Textbox", other = {}) => ({
  parameter_name: name,
  label: name,
  component,
  parameter_has_default: false,
  type: { type: "string" },
  ...other,
});
const endpoint = (parameters, returns = [image]) => ({ parameters, returns });

test("normalizes HF page links and hosted URLs and rejects arbitrary servers", () => {
  assert.equal(
    validateSpace("https://huggingface.co/spaces/Qwen/Qwen-Image-Edit/"),
    "Qwen/Qwen-Image-Edit",
  );
  assert.equal(
    validateSpace("https://huggingface.co/spaces/Qwen/Qwen-Image-Edit?logs=true"),
    "Qwen/Qwen-Image-Edit",
  );
  assert.equal(validateSpace("Qwen/Qwen-Image-Edit"), "Qwen/Qwen-Image-Edit");
  assert.equal(
    validateSpace("https://qwen-qwen-image-edit.hf.space/"),
    "https://qwen-qwen-image-edit.hf.space",
  );
  for (const url of [
    "https://evil.test/spaces/user/model",
    "https://huggingface.co/spaces/user/model/blob/main/app.py",
    "https://huggingface.co.evil.test/spaces/u/m",
    "u/..",
    "https://user:pass@huggingface.co/spaces/u/m",
  ])
    assert.throws(() => validateSpace(url));
});

test("real FLUX schema generates a ready text-to-image configuration and model defaults", () => {
  const result = analyzeSpaceApi(fixture("flux-api"), "black-forest-labs/FLUX.1-schnell");
  assert.equal(result.ready, true);
  assert.equal(result.supportsGenerate, true);
  assert.equal(result.supportsEdit, false);
  assert.equal(result.endpoint, "/infer");
  assert.equal(result.template.prompt, "{{prompt}}");
  assert.equal(result.template.randomize_seed, false);
  assert.equal(result.defaults.generate.steps, 4);
  assert.equal(result.outputPath, "0");
});

test("real Qwen Edit schema is recognized as edit-only and preserves nonstandard defaults", () => {
  const result = analyzeSpaceApi(fixture("qwen-edit-api"), "Qwen/Qwen-Image-Edit");
  assert.equal(result.ready, true);
  assert.equal(result.supportsGenerate, false);
  assert.equal(result.supportsEdit, true);
  assert.equal(result.endpoint, "");
  assert.equal(result.editEndpoint, "/infer");
  assert.equal(result.editTemplate.image, "{{image}}");
  assert.equal(result.editTemplate.true_guidance_scale, "{{guidance}}");
  assert.equal(result.editTemplate.rewrite_prompt, true);
  assert.deepEqual(result.defaults.edit, { guidance: 4, steps: 50 });
});

test("detects separate outputs, optional image inputs, galleries and image editors", () => {
  const api = {
    named_endpoints: {
      "/generate": endpoint([parameter("prompt")], [{ component: "Number" }, image]),
      "/edit": endpoint(
        [parameter("instruction"), parameter("image", "ImageEditor")],
        [{ component: "Number" }, { component: "Textbox" }, image],
      ),
    },
  };
  const result = analyzeSpaceApi(api, "owner/space");
  assert.equal(result.outputPath, "1");
  assert.equal(result.editOutputPath, "2");
  assert.deepEqual(result.editTemplate.image, {
    background: "{{image}}",
    layers: [],
    composite: "{{image}}",
  });
  const optional = analyzeSpaceApi(
    {
      named_endpoints: {
        "/predict": endpoint([
          parameter("prompt"),
          parameter("images", "Gallery", { parameter_has_default: true, parameter_default: null }),
        ]),
      },
    },
    "owner/space",
  );
  assert.equal(optional.supportsGenerate, true);
  assert.equal(optional.template.images, null);
  assert.deepEqual(optional.editTemplate.images, [{ image: "{{image}}", caption: null }]);
});

test("unknown required parameters, extra required images and OAuth requirements need review", () => {
  const api = {
    named_endpoints: {
      "/infer": endpoint([
        parameter("prompt"),
        parameter("image", "Image"),
        parameter("image2", "Image"),
        parameter("lora_choice", "Dropdown"),
      ]),
    },
  };
  const result = analyzeSpaceApi(api, "owner/space");
  assert.equal(result.ready, false);
  assert.ok(result.warnings.some((w) => w.includes("image2")));
  assert.ok(result.warnings.some((w) => w.includes("lora_choice")));
  const oauth = analyzeSpaceApi(
    {
      named_endpoints: {
        "/infer": { ...endpoint([parameter("prompt")]), oauth_token: "required" },
      },
    },
    "owner/space",
  );
  assert.equal(oauth.ready, false);
  const notImage = analyzeSpaceApi(
    {
      named_endpoints: {
        "/caption": endpoint([parameter("image", "Image")], [{ component: "Textbox" }]),
      },
    },
    "owner/space",
  );
  assert.equal(notImage.ready, false);
});

test("AI can map unusual names but cannot invent endpoints, credentials, parameters or required values", () => {
  const api = {
    named_endpoints: { "/render": endpoint([parameter("request"), parameter("canvas", "Image")]) },
  };
  const suggestion = {
    generate: null,
    edit: { endpoint: "/render", template: { request: "{{prompt}}", canvas: "{{image}}" } },
  };
  assert.equal(analyzeSpaceApi(api, "owner/space").ready, false);
  assert.equal(applyAiConfiguration(api, "owner/space", suggestion).ready, true);
  assert.throws(
    () =>
      applyAiConfiguration(api, "owner/space", {
        edit: { ...suggestion.edit, endpoint: "/invented" },
      }),
    /不存在/,
  );
  assert.throws(
    () =>
      applyAiConfiguration(api, "owner/space", {
        edit: { ...suggestion.edit, template: { ...suggestion.edit.template, api_key: "secret" } },
      }),
    /凭据参数/,
  );
  assert.throws(
    () =>
      applyAiConfiguration(api, "owner/space", {
        edit: { ...suggestion.edit, template: { request: "{{prompt}}", canvas: "{{unknown}}" } },
      }),
    /占位符/,
  );
  const unknown = {
    named_endpoints: { "/infer": endpoint([parameter("prompt"), parameter("required_mode")]) },
  };
  assert.throws(
    () =>
      applyAiConfiguration(unknown, "owner/space", {
        generate: {
          endpoint: "/infer",
          template: { prompt: "{{prompt}}", required_mode: "invented" },
        },
      }),
    /未声明的固定值/,
  );
});

test("AI sees schema only, secret defaults are redacted, and errors fall back to local detection", async () => {
  const api = fixture("flux-api");
  api.named_endpoints["/infer"].parameters.push(
    parameter("api_token", "Textbox", {
      parameter_has_default: true,
      parameter_default: "hf_privateToken123",
    }),
  );
  assert.doesNotMatch(JSON.stringify(aiSchema(api)), /hf_privateToken123/);
  let requests = 0;
  const settings = {
    ai: { baseUrl: "https://ai.example.com/v1", model: "config-model", key: "sk-config-secret" },
    transport: async (url, options) => {
      requests++;
      assert.equal(url, "https://ai.example.com/v1/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer sk-config-secret");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "config-model");
      assert.doesNotMatch(options.body.toString(), /hf_privateToken123|sk-config-secret/);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                generate: {
                  endpoint: "/infer",
                  template: {
                    prompt: "{{prompt}}",
                    seed: "{{seed}}",
                    randomize_seed: false,
                    width: "{{width}}",
                    height: "{{height}}",
                    num_inference_steps: "{{steps}}",
                  },
                },
                edit: null,
              }),
            },
          },
        ],
      };
    },
  };
  const result = await discoverConfiguration(api, "owner/space", settings);
  assert.equal(requests, 1);
  assert.equal(result.source, "ai");
  assert.equal(result.ready, true);
  const failed = await discoverConfiguration(api, "owner/space", {
    ...settings,
    transport: async () => {
      throw new Error("sk-config-secret");
    },
  });
  assert.equal(failed.source, "schema");
  assert.equal(failed.ready, true);
  assert.doesNotMatch(JSON.stringify(failed), /sk-config-secret|hf_privateToken123/);
});

test("edit inference uses its own output path instead of the generation path", async () => {
  const provider = {
    editEndpoint: "/edit",
    editTemplate: { image: "{{image}}", prompt: "{{prompt}}" },
    outputPath: "0",
    editOutputPath: "1",
  };
  const connector = async () => ({
    config: { root: "https://a.hf.space" },
    close() {},
    submit() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "data", data: [123, { url: "https://a.hf.space/result.png" }] };
        },
        cancel() {},
      };
    },
  });
  const images = await runSpace(
    provider,
    "",
    { mode: "edit", count: 1, prompt: "blue", seed: 1 },
    Buffer.from("image"),
    null,
    new AbortController().signal,
    connector,
  );
  assert.equal(images[0].url, "https://a.hf.space/result.png");
});

test("AI cannot substitute text into numeric parameters or hide mandatory multiple-image requirements", () => {
  const api = {
    named_endpoints: {
      "/edit": endpoint([
        parameter("prompt"),
        parameter("image", "Image"),
        parameter("image2", "Image"),
        parameter("steps", "Slider", {
          type: { type: "number" },
          parameter_has_default: true,
          parameter_default: 4,
        }),
      ]),
    },
  };
  const selection = {
    edit: {
      endpoint: "/edit",
      template: {
        prompt: "{{prompt}}",
        image: "{{image}}",
        image2: "{{image}}",
        steps: "{{steps}}",
      },
    },
  };
  assert.equal(applyAiConfiguration(api, "owner/space", selection).ready, false);
  selection.edit.template.steps = "{{prompt}}";
  assert.throws(() => applyAiConfiguration(api, "owner/space", selection), /数字参数/);
});
