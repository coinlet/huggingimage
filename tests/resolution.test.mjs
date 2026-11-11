import test from "node:test";
import assert from "node:assert/strict";
import { resolveResolution } from "../shared/resolution.mjs";
import { runCompatible, runSpace } from "../server/providers.mjs";

test("resolution defaults retain existing dimensions and presets follow orientation", () => {
  assert.deepEqual(resolveResolution({ ratio: "3:2" }), {
    resolution: "default",
    ratio: "3:2",
    width: 1536,
    height: 1024,
  });
  const landscape = resolveResolution({ ratio: "16:9", resolution: "2048" });
  assert.equal(landscape.width, 2048);
  assert.equal(landscape.height, 1152);
  const portrait = resolveResolution({ ratio: "9:16", resolution: "512" });
  assert.equal(portrait.height, 512);
  assert.equal(portrait.width, 288);
  assert.deepEqual(resolveResolution({ resolution: "custom", width: 1280, height: 720 }), {
    resolution: "custom",
    ratio: "16:9",
    width: 1280,
    height: 720,
  });
  for (const width of [0, 63, 1025, 4097, NaN, Infinity])
    assert.throws(
      () => resolveResolution({ resolution: "custom", width, height: 1024 }),
      /自定义宽高/,
    );
  assert.throws(() => resolveResolution({ resolution: "unknown" }), /有效的分辨率/);
  assert.throws(
    () => resolveResolution({ resolution: "custom", width: 1024, height: 1024 }, "xai"),
    /xAI/,
  );
});

test("OpenAI generation and multipart editing carry the selected exact size, while xAI uses its resolution parameter", async () => {
  const provider = { type: "openai", model: "custom-model", baseUrl: "https://example.com/v1" };
  const job = {
    mode: "generate",
    count: 1,
    prompt: "forest",
    ratio: "16:9",
    width: 2048,
    height: 1152,
    resolution: "2048",
  };
  const payloads = [];
  const transport = async (_url, request) => {
    if (request.headers["Content-Type"].startsWith("multipart/")) {
      const form = await new Response(request.body, {
        headers: { "content-type": request.headers["Content-Type"] },
      }).formData();
      payloads.push({ size: form.get("size"), image: form.has("image") });
    } else payloads.push(JSON.parse(request.body.toString()));
    return { data: [{ url: "https://example.com/image.png" }] };
  };
  const signal = new AbortController().signal;
  await runCompatible(provider, "", job, null, null, signal, transport);
  assert.equal(payloads[0].size, "2048x1152");
  await runCompatible(
    provider,
    "",
    { ...job, mode: "edit" },
    Buffer.from("image"),
    null,
    signal,
    transport,
  );
  assert.deepEqual(payloads[1], { size: "2048x1152", image: true });
  await runCompatible({ ...provider, type: "xai" }, "", job, null, null, signal, transport);
  assert.equal(payloads[2].resolution, "2k");
  assert.equal(payloads[2].aspect_ratio, "16:9");
  assert.equal(payloads[2].size, undefined);
  await runCompatible(
    { ...provider, type: "xai" },
    "",
    { ...job, resolution: "default" },
    null,
    null,
    signal,
    transport,
  );
  assert.equal(payloads[3].resolution, undefined);
});

test("Hugging Face templates receive numeric requested width and height for generation and editing", async () => {
  const calls = [];
  const client = {
    config: { root: "https://owner-space.hf.space/" },
    submit(_endpoint, data) {
      calls.push(data);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "data", data: [{ url: "https://owner-space.hf.space/image.png" }] };
        },
        cancel() {},
      };
    },
    close() {},
  };
  const template = { width: "{{width}}", height: "{{height}}", prompt: "{{prompt}}" };
  const provider = {
    endpoint: "/generate",
    editEndpoint: "/edit",
    template,
    editTemplate: { ...template, image_base64: "{{image_base64}}" },
    outputPath: "0",
    editOutputPath: "0",
  };
  const job = {
    count: 1,
    prompt: "forest",
    width: 1280,
    height: 720,
    ratio: "16:9",
    seed: 1,
    steps: 4,
    guidance: 1,
  };
  for (const mode of ["generate", "edit"])
    await runSpace(
      provider,
      "",
      { ...job, mode },
      mode === "edit" ? Buffer.from("image") : null,
      null,
      new AbortController().signal,
      async () => client,
    );
  assert.deepEqual(
    calls.map((c) => [c.width, c.height]),
    [
      [1280, 720],
      [1280, 720],
    ],
  );
});
