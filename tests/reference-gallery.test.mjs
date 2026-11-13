import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import {
  loadReferenceCatalog,
  normalizeGalleryRecipe,
  resolveGalleryFile,
} from "../server/reference-gallery.mjs";
import {
  buildGalleryPrompt,
  emptyGalleryRecipe,
  randomGalleryRecipe,
  recipeReferences,
} from "../shared/gallery-recipe.mjs";
import { createApp } from "../server/app.mjs";
import { dispatch } from "./request.mjs";

const catalog = loadReferenceCatalog();
const pick = (kind, sensitive = false) =>
  catalog.items.find((item) => item.kind === kind && item.sensitive === sensitive);
const selection = (item, other = {}) => ({
  id: item.id,
  variant: item.variants[0].id,
  depth: false,
  ...other,
});

test("catalog snapshots preserve all six collections, unique identifiers, source attribution, viewpoints and depth paths", () => {
  assert.equal(catalog.items.length, 6162);
  assert.equal(catalog.byId.size, 6162);
  for (const [kind, count] of [
    ["pose", 1439],
    ["costume", 3224],
    ["portrait", 1499],
  ])
    assert.equal(catalog.items.filter((item) => item.kind === kind).length, count);
  const historic = catalog.items.find((item) => item.source === "shisei");
  assert.ok(historic.variants.length > 1);
  const pose = pick("pose");
  assert.match(catalog.files.get(`${pose.id}|depth`).original, /^img\/depth\/.+\.webp$/);
  assert.match(pose.depth.url, /variant=depth/);
  assert.ok(catalog.items.some((item) => item.source === "charadb"));
  assert.ok(catalog.items.some((item) => item.source === "gia-anime"));
  assert.ok(
    catalog.items.every(
      (item) =>
        item.sourceUrl.startsWith("https://") &&
        item.variants.every((v) => v.url.startsWith("/api/reference-gallery/items/")),
    ),
  );
});

test("recipe validation rejects unknown records, wrong slots, arbitrary URLs and invalid viewpoints, and safety clears sensitive choices", () => {
  const valid = {
    ...emptyGalleryRecipe(),
    portrait: selection(pick("portrait")),
    costume: selection(pick("costume")),
    pose: selection(pick("pose"), { depth: true }),
    style: "film",
    notes: "night scene",
    locked: ["portrait"],
  };
  assert.deepEqual(normalizeGalleryRecipe(valid, catalog), valid);
  for (const value of [
    null,
    [],
    { style: "unknown" },
    { notes: 5 },
    { notes: "x".repeat(6001) },
    { locked: ["unknown"] },
    { portrait: { id: "https://evil.test/image" } },
    { pose: selection(pick("portrait")) },
    { pose: selection(pick("pose"), { variant: "missing" }) },
  ])
    assert.throws(() => normalizeGalleryRecipe(value, catalog));
  const sensitive = selection(pick("pose", true));
  assert.equal(
    normalizeGalleryRecipe({ ...emptyGalleryRecipe(), pose: sensitive }, catalog).pose,
    null,
  );
  assert.deepEqual(
    normalizeGalleryRecipe({ ...emptyGalleryRecipe(), safeMode: false, pose: sensitive }, catalog)
      .pose,
    sensitive,
  );
});

test("prompt numbering follows actual reference order, selected costume view and depth without empty-slot gaps", () => {
  const costume = catalog.items.find((item) => item.source === "shisei");
  const recipe = {
    ...emptyGalleryRecipe(),
    costume: selection(costume, { variant: costume.variants[1].id }),
    pose: selection(pick("pose"), { depth: true }),
    style: "film",
    notes: "雨夜街道",
  };
  const refs = recipeReferences(recipe, catalog.byId);
  assert.deepEqual(
    refs.map((ref) => [ref.slot, ref.number]),
    [
      ["costume", 1],
      ["pose", 2],
    ],
  );
  assert.equal(refs[0].image.id, costume.variants[1].id);
  assert.equal(refs[1].image.id, "depth");
  const prompt = buildGalleryPrompt(recipe, catalog.byId);
  assert.match(prompt, /服装参考 Image 1/);
  assert.match(prompt, /姿势参考 Image 2/);
  assert.match(prompt, /深度图/);
  assert.match(prompt, /35mm/);
  assert.match(prompt, /雨夜街道/);
  assert.doesNotMatch(prompt, /Image 3/);
  assert.equal(buildGalleryPrompt(emptyGalleryRecipe(), catalog.items), "");
});

test("random recipe respects safety and locks and does not get stuck when only one candidate exists", () => {
  const portrait = selection(pick("portrait"));
  const recipe = { ...emptyGalleryRecipe(), portrait, locked: ["portrait"] };
  const next = randomGalleryRecipe(recipe, catalog.items, () => 0.5);
  assert.deepEqual(next.portrait, portrait);
  assert.ok(next.costume && next.pose);
  assert.ok(recipeReferences(next, catalog.items).every((ref) => !ref.item.sensitive));
  const pool = [pick("pose")];
  const selected = { ...emptyGalleryRecipe(), pose: selection(pool[0]) };
  assert.deepEqual(randomGalleryRecipe(selected, pool, () => 0, "pose").pose, selected.pose);
  assert.deepEqual(
    randomGalleryRecipe(recipe, [], () => 0),
    recipe,
  );
});

test("local images are scoped to img/thumbs and cannot follow symlinks outside the mounted root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-outside-"));
  try {
    fs.mkdirSync(path.join(root, "img"));
    fs.writeFileSync(path.join(root, "img", "test.png"), "test");
    fs.writeFileSync(path.join(outside, "secret.png"), "secret");
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(root, "img", "link.png"));
    assert.equal(resolveGalleryFile(root, "img/test.png"), path.join(root, "img", "test.png"));
    for (const value of [
      "../secret",
      "img/../../secret",
      "img\\secret",
      "/etc/passwd",
      "data/pose-zh.json",
      "img/link.png",
    ])
      assert.throws(() => resolveGalleryFile(root, value));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

async function fixture({ protected: protect = false, remote, runCompatible } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-api-"));
  const root = path.join(dir, "pack");
  fs.mkdirSync(path.join(root, "img"), { recursive: true });
  fs.mkdirSync(path.join(root, "thumbs"));
  const image = await sharp({ create: { width: 24, height: 32, channels: 3, background: "green" } })
    .png()
    .toBuffer();
  const local = pick("pose");
  for (const name of [local.variants[0].id, "depth"]) {
    const locations = catalog.files.get(`${local.id}|${name}`);
    for (const relative of Object.values(locations)) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), image);
    }
  }
  const options = {
    dataDir: path.join(dir, "data"),
    adminToken: protect ? "test-token" : "",
    referenceGalleryDir: root,
    referenceTransport: remote || (async () => ({ status: 200, bytes: image })),
    runCompatible,
  };
  let workspace = createApp(options);
  const call = (route, method = "GET", body, authorized = true) =>
    dispatch(workspace.app, route, {
      method,
      body,
      headers: protect && authorized ? { authorization: "Bearer test-token" } : {},
    });
  return {
    call,
    local,
    image,
    dir,
    root,
    restart() {
      workspace.close();
      workspace = createApp(options);
    },
    close() {
      workspace.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("catalog, recipes and images share workspace authentication; image endpoints serve exact registered sources only", async () => {
  const fx = await fixture({ protected: true });
  try {
    assert.equal(
      (await fx.call("/api/reference-gallery/catalog", "GET", undefined, false)).status,
      401,
    );
    assert.equal((await fx.call(fx.local.variants[0].url, "GET", undefined, false)).status, 401);
    const result = await fx.call("/api/reference-gallery/catalog");
    assert.equal(result.status, 200);
    assert.equal(result.data.localAvailable, true);
    assert.equal(result.data.counts.pose, 1439);
    for (const url of [
      fx.local.variants[0].url,
      fx.local.variants[0].thumbnail,
      fx.local.depth.url,
    ]) {
      const response = await fx.call(url);
      assert.equal(response.status, 200);
      assert.deepEqual(response.bytes, fx.image);
    }
    assert.equal((await fx.call("/api/reference-gallery/items/missing/image")).status, 404);
    assert.equal(
      (
        await fx.call(
          `${fx.local.variants[0].url.replace("variant=default", "variant=..%2Fsecret")}`,
        )
      ).status,
      404,
    );
    assert.equal((await fx.call("/api/reference-gallery/notices/NOTICE.md")).status, 200);
    assert.equal((await fx.call("/api/reference-gallery/notices/store.mjs")).status, 404);
  } finally {
    fx.close();
  }
});

test("recipe selection and settings survive SQLite restart; invalid imports do not overwrite the saved recipe or providers", async () => {
  const fx = await fixture();
  try {
    const provider = (
      await fx.call("/api/providers", "POST", {
        type: "openai",
        name: "existing",
        baseUrl: "https://api.test/v1",
        model: "existing",
      })
    ).data;
    const recipe = {
      ...emptyGalleryRecipe(),
      pose: selection(fx.local, { depth: true }),
      style: "anime",
      notes: "背景为城市",
      locked: ["pose"],
    };
    assert.equal((await fx.call("/api/reference-gallery/recipe", "PUT", recipe)).status, 200);
    fx.restart();
    assert.deepEqual((await fx.call("/api/reference-gallery/recipe")).data, recipe);
    assert.equal(
      (await fx.call("/api/reference-gallery/recipe", "PUT", { portrait: { id: "missing" } }))
        .status,
      400,
    );
    assert.deepEqual((await fx.call("/api/reference-gallery/recipe")).data, recipe);
    assert.equal((await fx.call("/api/providers")).data[0].id, provider.id);
    assert.deepEqual((await fx.call("/api/jobs")).data, []);
  } finally {
    fx.close();
  }
});

test("remote image reads use catalog URLs, cache validated images and reject non-image responses", async () => {
  let called = 0;
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } })
    .webp()
    .toBuffer();
  const fx = await fixture({
    remote: async (url) => {
      called++;
      assert.ok(url.startsWith("https://charadb-2fi.pages.dev/"));
      return { status: 200, bytes };
    },
  });
  try {
    const item = catalog.items.find((item) => item.source === "charadb");
    for (let i = 0; i < 2; i++) {
      const response = await fx.call(item.variants[0].url);
      assert.equal(response.status, 200);
      assert.deepEqual(response.bytes, bytes);
    }
    assert.equal(called, 1);
    assert.equal(
      (await fx.call(`${item.variants[0].url}&url=https://evil.test/steal`)).status,
      200,
    );
    assert.equal(called, 1);
  } finally {
    fx.close();
  }
  const broken = await fixture({
    remote: async () => ({ status: 200, bytes: Buffer.from("<html>error</html>") }),
  });
  try {
    assert.equal(
      (await broken.call(catalog.items.find((item) => item.source === "charadb").variants[0].url))
        .status,
      502,
    );
  } finally {
    broken.close();
  }
});

test("missing local files return a helpful response instead of exposing filesystem paths", async () => {
  const fx = await fixture();
  try {
    fs.rmSync(path.join(fx.root, catalog.files.get(`${fx.local.id}|default`).original));
    const result = await fx.call(fx.local.variants[0].url);
    assert.equal(result.status, 404);
    assert.match(result.data.error, /本地参考图片不存在/);
    assert.ok(!result.data.error.includes(fx.root));
  } finally {
    fx.close();
  }
});

test("transferring a recipe imports ordered full-resolution inputs and prompt without generating images", async () => {
  const fx = await fixture({ protected: true });
  try {
    const portrait = pick("portrait"),
      costume = catalog.items.find((item) => item.source === "shisei");
    const recipe = {
      ...emptyGalleryRecipe(),
      portrait: selection(portrait),
      costume: selection(costume, { variant: costume.variants.at(-1).id }),
      pose: selection(fx.local, { depth: true }),
      notes: "保留服装细节",
    };
    const refs = recipeReferences(recipe, catalog.byId);
    const colors = ["red", "yellow", "blue"];
    for (const [index, ref] of refs.entries()) {
      const filename = path.join(
        fx.root,
        catalog.files.get(`${ref.item.id}|${ref.image.id}`).original,
      );
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(
        filename,
        await sharp({
          create: { width: 40 + index, height: 50 + index, channels: 3, background: colors[index] },
        })
          .png()
          .toBuffer(),
      );
    }
    assert.equal(
      (await fx.call("/api/reference-gallery/workbench", "POST", recipe, false)).status,
      401,
    );
    const response = await fx.call("/api/reference-gallery/workbench", "POST", recipe);
    assert.equal(response.status, 201);
    assert.equal(response.data.prompt, buildGalleryPrompt(recipe, catalog.byId));
    assert.deepEqual(
      response.data.images.map((image) => image.referenceInput.slot),
      ["portrait", "costume", "pose"],
    );
    assert.equal(response.data.images[1].referenceInput.variant, costume.variants.at(-1).id);
    assert.equal(response.data.images[2].referenceInput.variant, "depth");
    const root = response.data.images[0].id;
    for (const [index, image] of response.data.images.entries()) {
      assert.equal(image.width, 40 + index);
      assert.equal(image.height, 50 + index);
      assert.equal(image.threadId, root);
      const file = await fx.call(image.url);
      assert.equal(file.status, 200);
      const pixel = await sharp(file.bytes).raw().toBuffer();
      assert.deepEqual(
        [...pixel.subarray(0, 3)],
        [
          [255, 0, 0],
          [255, 255, 0],
          [0, 0, 255],
        ][index],
      );
    }
    assert.deepEqual((await fx.call("/api/jobs")).data, []);
    fx.restart();
    const history = (await fx.call(`/api/images/${root}/thread`)).data;
    assert.deepEqual(
      history.map((image) => image.id),
      response.data.images.map((image) => image.id),
    );
    assert.equal(history[1].referenceContext.resultId, root);
    assert.equal(history[2].referenceContext.number, 3);
  } finally {
    fx.close();
  }
});

test("transfer errors leave no partial imports and remote sources are loaded only from the catalog", async () => {
  let urls = [];
  const fx = await fixture({
    remote: async (url) => {
      urls.push(url);
      return { status: 503, bytes: Buffer.from("offline") };
    },
  });
  try {
    assert.equal(
      (await fx.call("/api/reference-gallery/workbench", "POST", emptyGalleryRecipe())).status,
      400,
    );
    const costume = catalog.items.find((item) => item.source === "charadb");
    const recipe = {
      ...emptyGalleryRecipe(),
      costume: selection(costume),
      pose: selection(fx.local),
    };
    const response = await fx.call("/api/reference-gallery/workbench", "POST", recipe);
    assert.equal(response.status, 400);
    assert.match(response.data.error, /HTTP 503/);
    assert.deepEqual(urls, [catalog.files.get(`${costume.id}|default`).original]);
    assert.deepEqual(fs.readdirSync(path.join(fx.dir, "data", "media")), []);
    const missing = { ...emptyGalleryRecipe(), pose: selection(fx.local, { depth: true }) };
    fs.rmSync(path.join(fx.root, catalog.files.get(`${fx.local.id}|depth`).original));
    const missingResponse = await fx.call("/api/reference-gallery/workbench", "POST", missing);
    assert.equal(missingResponse.status, 400);
    assert.match(missingResponse.data.error, /本地参考原图不存在/);
    assert.deepEqual(fs.readdirSync(path.join(fx.dir, "data", "media")), []);
  } finally {
    fx.close();
  }
});

test("an imported role reference can be edited individually inside its original workbench", async () => {
  let editedSource;
  const fx = await fixture({
    runCompatible: async (_provider, _key, job, source) => {
      editedSource = { id: job.sourceId, bytes: source };
      return [`data:image/png;base64,${source.toString("base64")}`];
    },
  });
  try {
    const costume = catalog.items.find((item) => item.source === "charadb");
    const imported = (
      await fx.call("/api/reference-gallery/workbench", "POST", {
        ...emptyGalleryRecipe(),
        costume: selection(costume),
        pose: selection(fx.local),
      })
    ).data;
    const [base, pose] = imported.images;
    assert.equal(pose.referenceContext.number, 2);
    const provider = (
      await fx.call("/api/providers", "POST", {
        type: "openai",
        name: "single edit",
        baseUrl: "https://example.test/v1",
        model: "image",
        supportsEdit: true,
      })
    ).data;
    const created = await fx.call("/api/jobs", "POST", {
      providerId: provider.id,
      mode: "edit",
      sourceId: pose.id,
      threadAnchorId: base.id,
      prompt: "调整这张姿势图的手臂",
    });
    assert.equal(created.status, 202);
    let job;
    for (let i = 0; i < 100; i++) {
      job = (await fx.call("/api/jobs")).data.find((job) => job.id === created.data.id);
      if (!["queued", "running"].includes(job.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.status, "succeeded");
    assert.equal(editedSource.id, pose.id);
    assert.deepEqual(editedSource.bytes, (await fx.call(pose.url)).bytes);
    const thread = (await fx.call(`/api/images/${base.id}/thread`)).data;
    const result = thread.find((image) => image.id === job.imageIds[0]);
    assert.equal(result.threadId, base.id);
    assert.equal(result.parentId, pose.id);
    assert.ok(thread.some((image) => image.id === pose.id));
  } finally {
    fx.close();
  }
});
