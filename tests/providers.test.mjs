import test from "node:test";
import assert from "node:assert/strict";
import { mapTemplate, extractImages, atPath, validateSpace } from "../server/providers.mjs";
import { validateUrl } from "../server/network.mjs";
import { createStore, publicProvider } from "../server/store.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("Gradio template preserves numeric values, nested image editor inputs and positional arrays", () => {
  const context = { prompt: "a forest", seed: 42, image: { path: "uploaded.png" }, mask: null };
  assert.deepEqual(
    mapTemplate(
      {
        prompt: "{{prompt}}",
        seed: "{{seed}}",
        image: { background: "{{image}}", layers: [], composite: "{{image}}" },
        label: "Render {{prompt}}",
      },
      context,
    ),
    {
      prompt: "a forest",
      seed: 42,
      image: { background: context.image, layers: [], composite: context.image },
      label: "Render a forest",
    },
  );
  assert.deepEqual(mapTemplate(["{{prompt}}", "{{seed}}", false], context), [
    "a forest",
    42,
    false,
  ]);
  assert.throws(() => mapTemplate("{{unknown}}", context), /未知参数/);
});
test("extracts Gradio Image, Gallery and OpenAI images with explicit output paths", () => {
  const data = [
    [{ image: { url: "https://a.hf.space/gradio_api/file=x.png" }, caption: "forest" }],
    42,
  ];
  assert.deepEqual(extractImages(atPath(data, "0")), ["https://a.hf.space/gradio_api/file=x.png"]);
  assert.deepEqual(extractImages([{ b64_json: "YWJj" }]), ["data:image/png;base64,YWJj"]);
  assert.deepEqual(extractImages("/tmp/private/image.png"), []);
  assert.equal(atPath(data, "0.0.image.url"), "https://a.hf.space/gradio_api/file=x.png");
});
test("resource URLs accept HTTP(S) addresses and Space identifiers normalize correctly", () => {
  for (const host of ["127.0.0.1", "192.168.0.1", "198.18.6.38", "localhost"])
    assert.equal(validateUrl(`http://${host}/api`).hostname, host);
  assert.throws(() => validateUrl("file:///etc/passwd"), /HTTP/);
  assert.equal(validateSpace("owner/model-space"), "owner/model-space");
  assert.equal(validateSpace("https://owner-model.hf.space"), "https://owner-model.hf.space");
  assert.throws(() => validateSpace("https://evil.test"), /Space/);
});
test("secrets are encrypted on disk and absent from provider API representation", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imagine-store-test-"));
  try {
    const store = createStore(dir);
    const secret = store.seal("sk-test-sensitive");
    assert.equal(store.open(secret), "sk-test-sensitive");
    store.state.providers.push({ id: "test", name: "test", secret });
    store.save();
    assert.equal(
      readFileSync(path.join(dir, "workspace.sqlite"), "utf8").includes("sk-test-sensitive"),
      false,
    );
    assert.deepEqual(publicProvider(store.state.providers[0]), {
      id: "test",
      name: "test",
      hasKey: true,
    });
    assert.equal(createStore(dir).open(secret), "sk-test-sensitive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gradio adapter submits mapped endpoints and sequential seeds, extracts Gallery results and closes client", async () => {
  const { runSpace } = await import("../server/providers.mjs");
  const calls = [];
  let closed = false;
  const fakeClient = {
    config: { root: "https://owner-space.hf.space/" },
    submit(endpoint, parameters) {
      calls.push({ endpoint, parameters });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "status", stage: "pending" };
          yield {
            type: "data",
            data: [
              [
                {
                  image: {
                    url: `https://owner-space.hf.space/gradio_api/file=${parameters.seed}.png`,
                  },
                },
              ],
              "ignored metadata",
            ],
          };
        },
        cancel() {},
      };
    },
    close() {
      closed = true;
    },
  };
  const provider = {
    endpoint: "/infer",
    editEndpoint: "/edit",
    template: { prompt: "{{prompt}}", seed: "{{seed}}", width: "{{width}}" },
    editTemplate: { prompt: "{{prompt}}", image: "{{image}}", seed: "{{seed}}" },
    outputPath: "0",
  };
  const job = {
    mode: "generate",
    count: 2,
    prompt: "a forest",
    negativePrompt: "",
    width: 1024,
    height: 1024,
    seed: 42,
    steps: 28,
    guidance: 3.5,
  };
  const results = await runSpace(
    provider,
    "",
    job,
    null,
    null,
    new AbortController().signal,
    async () => fakeClient,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].endpoint, "/infer");
  assert.equal(calls[0].parameters.seed, 42);
  assert.equal(calls[1].parameters.seed, 43);
  assert.equal(typeof calls[0].parameters.width, "number");
  assert.deepEqual(
    results,
    [42, 43].map((seed) => ({
      url: `https://owner-space.hf.space/gradio_api/file=${seed}.png`,
      authOrigin: "https://owner-space.hf.space",
    })),
  );
  assert.equal(closed, true);
  calls.length = 0;
  await runSpace(
    provider,
    "",
    { ...job, mode: "edit", count: 1 },
    Buffer.from("fake image bytes"),
    null,
    new AbortController().signal,
    async () => fakeClient,
  );
  assert.equal(calls[0].endpoint, "/edit");
  assert.ok(calls[0].parameters.image);
  assert.notEqual(typeof calls[0].parameters.image, "string");
});

test("Gradio adapter cancels submitted task when aborted and closes client", async () => {
  const { runSpace } = await import("../server/providers.mjs");
  const controller = new AbortController();
  let cancelled = false,
    closed = false;
  const fake = {
    config: { root: "https://a.hf.space" },
    submit() {
      return {
        cancel() {
          cancelled = true;
        },
        async *[Symbol.asyncIterator]() {
          controller.abort();
          yield { type: "status", stage: "pending" };
        },
      };
    },
    close() {
      closed = true;
    },
  };
  await assert.rejects(
    runSpace(
      { endpoint: "/infer", template: { prompt: "{{prompt}}" } },
      "",
      { mode: "generate", count: 1, prompt: "hello", seed: 0 },
      null,
      null,
      controller.signal,
      async () => fake,
    ),
  );
  assert.equal(cancelled, true);
  assert.equal(closed, true);
});

test("xAI adapter sends JSON edits; OpenAI sends multipart image and mask uploads", async () => {
  const { runCompatible } = await import("../server/providers.mjs");
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, ...options });
    return { data: [{ b64_json: "YWJj" }] };
  };
  const job = {
    mode: "edit",
    prompt: "blue background",
    count: 1,
    ratio: "3:2",
    width: 1536,
    height: 1024,
  };
  const source = Buffer.from("image bytes"),
    mask = Buffer.from("mask bytes"),
    signal = new AbortController().signal;
  await runCompatible(
    { type: "xai", baseUrl: "https://api.x.ai/v1", model: "test" },
    "secret",
    job,
    source,
    null,
    signal,
    transport,
  );
  const xai = calls[0];
  assert.equal(xai.url, "https://api.x.ai/v1/images/edits");
  assert.equal(xai.headers["Content-Type"], "application/json");
  assert.equal(xai.headers.Authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(xai.body).image, {
    url: `data:image/png;base64,${source.toString("base64")}`,
    type: "image_url",
  });
  assert.equal(JSON.parse(xai.body).aspect_ratio, "3:2");
  await runCompatible(
    { type: "openai", baseUrl: "https://api.example.com/v1", model: "test" },
    "secret",
    job,
    source,
    mask,
    signal,
    transport,
  );
  const openai = calls[1];
  assert.match(openai.headers["Content-Type"], /^multipart\/form-data; boundary=/);
  const form = await new Response(openai.body, {
    headers: { "Content-Type": openai.headers["Content-Type"] },
  }).formData();
  assert.equal(form.get("size"), "1536x1024");
  assert.equal(form.get("prompt"), "blue background");
  assert.equal(form.get("image").type, "image/png");
  assert.equal(await form.get("image").text(), "image bytes");
  assert.equal(await form.get("mask").text(), "mask bytes");
  await runCompatible(
    { type: "openai", baseUrl: "https://api.example.com/v1", model: "test" },
    "",
    { ...job, mode: "generate" },
    null,
    null,
    signal,
    transport,
  );
  assert.equal(calls[2].url, "https://api.example.com/v1/images/generations");
  assert.equal(JSON.parse(calls[2].body).size, "1536x1024");
  assert.equal(calls[2].headers.Authorization, undefined);
});
