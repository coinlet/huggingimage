import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { referenceSupport, validateReferences } from "../shared/references.mjs";
import { analyzeSpaceApi } from "../server/space-config.mjs";
import { runSpace } from "../server/providers.mjs";
import { createApp } from "../server/app.mjs";
import { dispatch } from "./request.mjs";

const schema = JSON.parse(readFileSync(new URL("./fixtures/qwen-aio-api.json", import.meta.url)));
const provider = { ...analyzeSpaceApi(schema, "owner/model"), type: "gradio" };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("reference validation enforces provider capability, ordering, uniqueness and swap count", () => {
  assert.deepEqual(referenceSupport(provider), { max: 6, swap: true });
  assert.deepEqual(validateReferences(provider, "a", ["c", "b"], "reference"), ["a", "c", "b"]);
  assert.deepEqual(validateReferences(provider, "a", ["b"], "swap"), ["a", "b"]);
  assert.throws(() => validateReferences(provider, "a", ["a"]), /重复/);
  assert.throws(() => validateReferences(provider, "a", ["b", "b"]), /重复/);
  assert.throws(() => validateReferences(provider, "a", {}), /数组/);
  assert.throws(() => validateReferences(provider, "a", ["b", "c", "d", "e", "f", "g"]), /最多 5/);
  assert.throws(() => validateReferences(provider, "a", [], "swap"), /恰好两张/);
  assert.throws(() => validateReferences(provider, "a", ["b", "c"], "swap"), /恰好两张/);
  assert.throws(() => validateReferences(provider, "a", [], "madeup"), /未知/);
  assert.throws(
    () => validateReferences({ type: "openai", supportsEdit: true }, "a", ["b"]),
    /最多支持 1/,
  );
  const custom = {
    type: "gradio",
    supportsEdit: true,
    editTemplate: { first: "{{image}}", second: "{{image2}}" },
  };
  assert.throws(() => validateReferences(custom, "a"), /恰好两张/);
  assert.deepEqual(validateReferences(custom, "a", ["b"]), ["a", "b"]);
});

test("Qwen AIO sends ordered Gallery blobs for six references and separate blobs for swap", async () => {
  const bytes = [0, 1, 2, 3, 4, 5].map((n) => Buffer.from(`image-${n}`));
  for (const referenceMode of ["reference", "swap"]) {
    const expected = referenceMode === "swap" ? bytes.slice(0, 2) : bytes;
    let parameters;
    const connector = async () => ({
      config: { root: "https://example-model.hf.space" },
      api_prefix: "/gradio_api",
      fetch: async () => Response.json(schema),
      close() {},
      submit(_endpoint, value) {
        parameters = value;
        return {
          cancel() {},
          async *[Symbol.asyncIterator]() {
            yield { type: "data", data: [{ url: "https://example-model.hf.space/out.png" }] };
          },
        };
      },
    });
    await runSpace(
      provider,
      "",
      {
        mode: "edit",
        referenceMode,
        count: 1,
        prompt: "combine Image 1 and Image 2",
        seed: 1,
        ratio: "1:1",
      },
      expected[0],
      null,
      new AbortController().signal,
      connector,
      expected.slice(1),
    );
    assert.equal(await parameters.ref_image_1.text(), "image-0");
    if (referenceMode === "swap") {
      assert.equal(parameters.mode, "Transform & Swap (2 Refs)");
      assert.equal(await parameters.ref_image_2.text(), "image-1");
      assert.deepEqual(parameters.multi_refs, []);
    } else {
      assert.equal(parameters.mode, "Multi-Image Reference (1-6 Refs)");
      assert.equal(parameters.ref_image_2, null);
      assert.deepEqual(
        await Promise.all(parameters.multi_refs.map(({ image }) => image.text())),
        expected.map((b) => b.toString()),
      );
      assert.ok(parameters.multi_refs.every(({ caption }) => caption === null));
    }
  }
});

test("custom Gradio file-array and encoded-image mappings retain all images in order", async () => {
  for (const template of [
    { prompt: "{{prompt}}", files: "{{images}}" },
    { prompt: "{{prompt}}", gallery: "{{gallery_images}}" },
    { prompt: "{{prompt}}", images_b64_json: "{{images_b64_json}}" },
  ]) {
    let sent;
    await runSpace(
      { editEndpoint: "/infer", editTemplate: template, editOutputPath: "0" },
      "",
      { mode: "edit", count: 1, prompt: "combine", seed: 1 },
      Buffer.from("first"),
      null,
      new AbortController().signal,
      async () => ({
        config: { root: "https://example-model.hf.space" },
        close() {},
        submit(_endpoint, value) {
          sent = value;
          return {
            cancel() {},
            async *[Symbol.asyncIterator]() {
              yield { type: "data", data: [{ url: "https://example-model.hf.space/out.png" }] };
            },
          };
        },
      }),
      [Buffer.from("second")],
    );
    if (sent.files)
      assert.deepEqual(await Promise.all(sent.files.map((file) => file.text())), [
        "first",
        "second",
      ]);
    else if (sent.gallery)
      assert.deepEqual(await Promise.all(sent.gallery.map(({ image }) => image.text())), [
        "first",
        "second",
      ]);
    else
      assert.deepEqual(
        JSON.parse(sent.images_b64_json),
        ["first", "second"].map(
          (v) => `data:image/png;base64,${Buffer.from(v).toString("base64")}`,
        ),
      );
  }
});

test("automatically mapped Gallery accepts a single image as well as multiple images", async () => {
  const schema = {
    named_endpoints: {
      "/edit": {
        parameters: [
          { parameter_name: "prompt", component: "Textbox", type: { type: "string" } },
          { parameter_name: "refs", component: "Gallery", type: { type: "array" } },
        ],
        returns: [{ component: "Image" }],
      },
    },
  };
  const configured = { ...analyzeSpaceApi(schema, "owner/gallery"), type: "gradio" };
  assert.equal(configured.editTemplate.refs, "{{gallery_images}}");
  assert.equal(referenceSupport(configured).max, 6);
  let sent;
  await runSpace(
    configured,
    "",
    { mode: "edit", count: 1, prompt: "edit", seed: 1 },
    Buffer.from("single"),
    null,
    new AbortController().signal,
    async () => ({
      config: { root: "https://example-model.hf.space" },
      close() {},
      submit(_endpoint, params) {
        sent = params;
        return {
          cancel() {},
          async *[Symbol.asyncIterator]() {
            yield { type: "data", data: [{ url: "https://example-model.hf.space/out.png" }] };
          },
        };
      },
    }),
  );
  assert.equal(sent.refs.length, 1);
  assert.equal(await sent.refs[0].image.text(), "single");
});

async function fixture(runner) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imagine-refs-"));
  let workspace = createApp({ dataDir: dir, adminToken: "", runSpace: runner });
  const call = (route, method = "GET", body) => dispatch(workspace.app, route, { method, body });
  const connection = await call("/api/providers", "POST", { ...provider, name: "Qwen multi" });
  assert.equal(connection.status, 201);
  const uploads = [];
  for (const color of ["red", "green", "blue"]) {
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: color } })
      .png()
      .toBuffer();
    const uploaded = await call("/api/uploads", "POST", {
      data: `data:image/png;base64,${bytes.toString("base64")}`,
      name: `${color}.png`,
    });
    assert.equal(uploaded.status, 201);
    uploads.push(uploaded.data);
  }
  const wait = async (id) => {
    for (let i = 0; i < 100; i++) {
      const job = (await call("/api/jobs")).data.find((j) => j.id === id);
      if (!["queued", "running"].includes(job.status)) return job;
      await delay(10);
    }
    throw new Error("job timed out");
  };
  return {
    call,
    uploads,
    wait,
    provider: connection.data,
    restart() {
      workspace.close();
      workspace = createApp({ dataDir: dir, adminToken: "", runSpace: runner });
    },
    async close() {
      workspace.close();
      await delay(30);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("jobs retain reference order through SQLite restart and retry, protect active inputs and keep group parent", async () => {
  let fail;
  let calls = 0;
  const observed = [];
  const fx = await fixture(
    async (_provider, _key, job, source, _mask, _signal, _connector, refs) => {
      observed.push({ ids: job.referenceIds, mode: job.referenceMode, source, refs });
      if (++calls === 1)
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      return [`data:image/png;base64,${source.toString("base64")}`];
    },
  );
  try {
    const [a, b, c] = fx.uploads;
    const submitted = await fx.call("/api/jobs", "POST", {
      providerId: fx.provider.id,
      mode: "edit",
      sourceId: a.id,
      referenceIds: [c.id, b.id],
      referenceMode: "reference",
      prompt: "combine in order",
    });
    assert.equal(submitted.status, 202);
    for (let i = 0; i < 50 && !fail; i++) await delay(5);
    assert.equal((await fx.call(`/api/images/${c.id}`, "DELETE")).status, 409);
    fail(new Error("temporary GPU failure"));
    assert.equal((await fx.wait(submitted.data.id)).status, "failed");
    fx.restart();
    const retried = await fx.call(`/api/images/${submitted.data.slotIds[0]}/retry`, "POST");
    assert.equal(retried.status, 202);
    assert.deepEqual(retried.data.referenceIds, [c.id, b.id]);
    assert.equal((await fx.wait(retried.data.id)).status, "succeeded");
    assert.deepEqual(observed[1].ids, [c.id, b.id]);
    assert.deepEqual(observed[1].refs, observed[0].refs);
    assert.equal(observed[1].refs.length, 2);
    const versions = (await fx.call(`/api/images/${a.id}/thread`)).data;
    const result = versions.find((i) => i.id === submitted.data.slotIds[0]);
    assert.deepEqual(
      versions.map((i) => i.id),
      [a.id, c.id, b.id, result.id],
    );
    assert.equal(versions[1].referenceContext.number, 2);
    assert.equal(versions[2].referenceContext.number, 3);
    assert.equal(versions[1].referenceContext.resultId, result.id);
    assert.equal(versions[1].referenceContext.prompt, "combine in order");
    const groups = (await fx.call("/api/image-groups")).data;
    assert.equal(groups.find((group) => group.id === a.id).versionCount, 2);
    assert.equal(result.parentId, a.id);
    assert.equal(result.threadId, a.threadId || a.id);
  } finally {
    await fx.close();
  }
});

test("job API rejects invalid references and retry fails clearly when a reference was deleted", async () => {
  const fx = await fixture(async () => {
    throw new Error("retry later");
  });
  try {
    const [a, b, c] = fx.uploads;
    const base = { providerId: fx.provider.id, mode: "edit", sourceId: a.id, prompt: "combine" };
    for (const extra of [
      { referenceIds: [a.id] },
      { referenceIds: [b.id, b.id] },
      { referenceIds: ["missing"] },
      { referenceIds: {} },
      { referenceMode: "swap" },
      { referenceIds: [b.id, c.id], referenceMode: "swap" },
      { referenceIds: [b.id], maskId: c.id },
      { mode: "generate", referenceIds: [b.id] },
    ])
      assert.equal(
        (await fx.call("/api/jobs", "POST", { ...base, ...extra })).status,
        400,
        JSON.stringify(extra),
      );
    const job = (
      await fx.call("/api/jobs", "POST", { ...base, referenceIds: [b.id], referenceMode: "swap" })
    ).data;
    assert.equal((await fx.wait(job.id)).status, "failed");
    assert.equal((await fx.call(`/api/images/${b.id}`, "DELETE")).status, 200);
    const retry = await fx.call(`/api/images/${job.slotIds[0]}/retry`, "POST");
    assert.equal(retry.status, 400);
    assert.match(retry.data.error, /参考图片已删除/);
  } finally {
    await fx.close();
  }
});

test("replaced main inputs and edits of imported references stay in the workbench group through retry", async () => {
  let replacementAttempts = 0;
  const received = [];
  const fx = await fixture(
    async (_provider, _key, job, source, _mask, _signal, _connector, refs) => {
      received.push({ prompt: job.prompt, source, refs });
      if (job.prompt === "replacement" && replacementAttempts++ === 0)
        throw new Error("temporary failure");
      return [`data:image/png;base64,${source.toString("base64")}`];
    },
  );
  try {
    const [a, b, c] = fx.uploads;
    const original = (
      await fx.call("/api/jobs", "POST", {
        providerId: fx.provider.id,
        mode: "edit",
        sourceId: a.id,
        referenceIds: [b.id],
        prompt: "original",
      })
    ).data;
    assert.equal((await fx.wait(original.id)).status, "succeeded");
    const other = (
      await fx.call("/api/jobs", "POST", {
        providerId: fx.provider.id,
        mode: "edit",
        sourceId: c.id,
        prompt: "other history",
      })
    ).data;
    assert.equal((await fx.wait(other.id)).status, "succeeded");
    const before = (await fx.call(a.url)).bytes;
    const replaced = await fx.call("/api/jobs", "POST", {
      providerId: fx.provider.id,
      mode: "edit",
      sourceId: c.id,
      referenceIds: [b.id],
      threadAnchorId: a.id,
      prompt: "replacement",
    });
    assert.equal(replaced.status, 202);
    assert.equal((await fx.wait(replaced.data.id)).status, "failed");
    fx.restart();
    const retry = (await fx.call(`/api/images/${replaced.data.slotIds[0]}/retry`, "POST")).data;
    assert.equal(retry.threadAnchorId, a.id);
    assert.equal(retry.sourceId, c.id);
    assert.equal((await fx.wait(retry.id)).status, "succeeded");
    const history = (await fx.call(`/api/images/${a.id}/thread`)).data;
    const result = history.find((image) => image.id === retry.slotIds[0]);
    assert.equal(result.threadId, a.id);
    assert.equal(result.parentId, c.id);
    assert.equal(history.find((image) => image.id === c.id).referenceContext.number, 1);
    assert.ok(history.some((image) => image.id === original.slotIds[0]));
    assert.ok(!history.some((image) => image.id === other.slotIds[0]));
    assert.deepEqual((await fx.call(a.url)).bytes, before);
    assert.deepEqual(received[2].source, received[3].source);
    assert.deepEqual(received[2].refs, received[3].refs);
    const bad = await fx.call("/api/jobs", "POST", {
      providerId: fx.provider.id,
      mode: "edit",
      sourceId: a.id,
      threadAnchorId: "missing",
      prompt: "invalid",
    });
    assert.equal(bad.status, 400);
    assert.equal(
      (
        await fx.call("/api/jobs", "POST", {
          providerId: fx.provider.id,
          threadAnchorId: a.id,
          prompt: "invalid",
        })
      ).status,
      400,
    );
  } finally {
    await fx.close();
  }
});
