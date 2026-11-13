import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { referenceInputView } from "./image-thread.mjs";
import { requestBytes } from "./network.mjs";
import {
  emptyGalleryRecipe,
  RECIPE_SLOTS,
  STYLE_PRESETS,
  recipeReferences,
  buildGalleryPrompt,
} from "../shared/gallery-recipe.mjs";

const dataDirectory = fileURLToPath(new URL("./reference-data/", import.meta.url));
const sources = {
  gia: { label: "ギア · 写实", url: "https://ai-costume-gallery.pages.dev/" },
  "gia-anime": { label: "ギア · 动漫", url: "https://ai-costume-anime-gallery.pages.dev/" },
  charadb: { label: "たき AI · CharaDB", url: "https://charadb-2fi.pages.dev/" },
  shisei: { label: "Shisei · 中国历代", url: "https://github.com/wquguru/shisei" },
};
const sensitiveSystems = new Set(["全身单人・性感系", "双人缠绵"]);
const sensitiveCategories = new Set(["内衣・睡衣", "性感穿搭"]);
let cachedCatalog;

export function loadReferenceCatalog(directory = dataDirectory) {
  if (directory === dataDirectory && cachedCatalog) return cachedCatalog;
  const entries = [],
    files = new Map();
  for (const [kind, filename] of [
    ["pose", "pose-zh.json"],
    ["costume", "costume-zh.json"],
    ["costume", "costume-anime-zh.json"],
    ["costume", "costume-gia-anime-zh.json"],
    ["costume", "costume-shisei-zh.json"],
    ["portrait", "portrait-zh.json"],
  ]) {
    for (const row of JSON.parse(fs.readFileSync(path.join(directory, filename), "utf8"))) {
      const id = `${kind}:${row.id}`;
      function image(variant, label, original, thumbnail) {
        const key = `${id}|${variant}`;
        files.set(key, { original, thumbnail });
        const base = `/api/reference-gallery/items/${encodeURIComponent(id)}/image?variant=${encodeURIComponent(variant)}`;
        return { id: variant, label, url: base, thumbnail: `${base}&thumbnail=1` };
      }
      const variants = row.views?.length
        ? row.views.map((view) => image(view.id, view.label, view.原图, view.缩略图))
        : [image("default", row.角度 || "原图", row.原图, row.缩略图)];
      const sourceId = row.source || "gia";
      const source = sources[sourceId] || sources.gia;
      const item = {
        id,
        kind,
        title: row.姿势名称 || row.服装名称 || row.标题 || row.id,
        category: row.分类 || row.分区 || "其他",
        source: sourceId,
        sourceLabel: kind === "costume" ? source.label : "ギア",
        sourceUrl:
          kind === "pose"
            ? "https://ai-pose-gallery.pages.dev/"
            : kind === "portrait"
              ? "https://ai-portrait-gallery.pages.dev/"
              : source.url,
        sensitive: Boolean(
          row.敏感 || sensitiveSystems.has(row.体系) || sensitiveCategories.has(row.分类),
        ),
        search:
          `${row.检索 || ""} ${row.关键词 || ""} ${row.发型名称 || ""} ${row.服装名称 || ""} ${row.姿势名称 || ""}`.toLowerCase(),
        system: row.体系 || "",
        angle: row.角度 || "",
        group: kind === "pose" ? `${row.体系}:${row.姿势编号 || row.id}` : id,
        hair: row.发长 || "",
        partition: row.分区 || "",
        featured: Boolean(row.精选),
        popular: Boolean(row.热门),
        tags: row.标签 || [],
        variants,
      };
      if (kind === "pose")
        item.depth = image(
          "depth",
          "深度图",
          row.原图.replace(/^img\//, "img/depth/").replace(/\.(png|jpe?g)$/i, ".webp"),
          row.缩略图.replace(/^thumbs\//, "thumbs/depth/").replace(/\.(png|jpe?g)$/i, ".webp"),
        );
      entries.push(item);
    }
  }
  const catalog = { items: entries, byId: new Map(entries.map((item) => [item.id, item])), files };
  if (directory === dataDirectory) cachedCatalog = catalog;
  return catalog;
}

export function normalizeGalleryRecipe(value, catalog) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("配方必须为 JSON 对象");
  const next = emptyGalleryRecipe();
  if (value.style !== undefined && !Object.hasOwn(STYLE_PRESETS, value.style))
    throw new Error("未知的画风预设");
  next.style = value.style || "none";
  next.safeMode = value.safeMode !== false;
  if (value.notes !== undefined && (typeof value.notes !== "string" || value.notes.length > 6000))
    throw new Error("补充要求最多 6000 字");
  next.notes = value.notes || "";
  if (
    value.locked !== undefined &&
    (!Array.isArray(value.locked) || value.locked.some((slot) => !RECIPE_SLOTS.includes(slot)))
  )
    throw new Error("无效的配方锁定项");
  next.locked = [...new Set(value.locked || [])];
  for (const slot of RECIPE_SLOTS) {
    const selected = value[slot];
    if (selected == null) continue;
    const item = catalog.byId.get(selected.id);
    if (!item || item.kind !== slot) throw new Error(`配方中的${slot}参考条目不存在或类型错误`);
    const variant = selected.variant || item.variants[0].id;
    if (!item.variants.some((image) => image.id === variant))
      throw new Error("配方中的图片视角不存在");
    if (next.safeMode && item.sensitive) continue;
    next[slot] = {
      id: item.id,
      variant,
      depth: slot === "pose" && Boolean(selected.depth && item.depth),
    };
  }
  return next;
}

export function resolveGalleryFile(root, relative) {
  if (
    typeof relative !== "string" ||
    !/^(img|thumbs)\//.test(relative) ||
    relative.includes("\\") ||
    relative.split("/").includes("..")
  )
    throw new Error("无效的参考图片路径");
  if (!root) throw new Error("本地参考图库尚未挂载，请设置 REFERENCE_GALLERY_DIR");
  const base = fs.realpathSync(root),
    target = fs.realpathSync(path.resolve(base, relative));
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error("参考图片路径超出素材目录");
  if (!fs.statSync(target).isFile()) throw new Error("参考图片不存在");
  return target;
}

export function mountReferenceGallery(
  app,
  { store, root, catalog = loadReferenceCatalog(), transport = requestBytes, saveImage } = {},
) {
  const candidates =
    root !== undefined
      ? [root]
      : [
          process.env.REFERENCE_GALLERY_DIR,
          path.resolve(store.directory, "reference-gallery"),
          path.resolve("../ai-pose-gallery-zh"),
        ];
  const directory = candidates
    .filter(Boolean)
    .map((value) => path.resolve(value))
    .find(
      (value) =>
        fs.existsSync(path.join(value, "img")) && fs.existsSync(path.join(value, "thumbs")),
    );
  app.get("/api/reference-gallery/catalog", (_req, res) =>
    res.json({
      items: catalog.items,
      localAvailable: Boolean(directory),
      counts: Object.fromEntries(
        RECIPE_SLOTS.map((slot) => [
          slot,
          catalog.items.filter((item) => item.kind === slot).length,
        ]),
      ),
    }),
  );
  app.get("/api/reference-gallery/recipe", (_req, res) =>
    res.json(store.getSetting("reference-gallery-recipe") || emptyGalleryRecipe()),
  );
  app.put("/api/reference-gallery/recipe", (req, res) => {
    const recipe = normalizeGalleryRecipe(req.body, catalog);
    store.setSetting("reference-gallery-recipe", recipe);
    res.json(recipe);
  });
  app.post("/api/reference-gallery/workbench", async (req, res) => {
    const recipe = normalizeGalleryRecipe(req.body, catalog);
    const references = recipeReferences(recipe, catalog.byId);
    if (!references.length) return res.status(400).json({ error: "请先选择至少一张参考图" });
    const prompt = buildGalleryPrompt(recipe, catalog.byId);
    if (prompt.length > 6000)
      return res.status(400).json({ error: "合成提示词超过工作台的 6000 字限制，请缩短补充要求" });
    // Read and decode every original before writing records, so a missing view
    // cannot leave a partially imported recipe in the workspace.
    const prepared = [];
    for (const ref of references) {
      const location = catalog.files.get(`${ref.item.id}|${ref.image.id}`)?.original;
      if (!location) throw new Error("所选参考图不存在");
      let bytes;
      if (/^https:\/\//i.test(location)) {
        const response = await transport(location, { timeout: 30000, maxBytes: 32 * 1024 * 1024 });
        if (response.status !== 200) throw new Error(`参考图来源返回 HTTP ${response.status}`);
        bytes = response.bytes;
      } else {
        let filename;
        try {
          filename = resolveGalleryFile(directory, location);
        } catch (error) {
          if (error.code === "ENOENT" || !directory)
            throw new Error("本地参考原图不存在，请检查素材目录或所选视角");
          throw error;
        }
        if (fs.statSync(filename).size > 32 * 1024 * 1024)
          throw new Error("参考原图超过 32MB 限制");
        bytes = await fs.promises.readFile(filename);
      }
      if (bytes.length > 32 * 1024 * 1024) throw new Error("参考原图超过 32MB 限制");
      prepared.push(
        await sharp(bytes, { limitInputPixels: 40_000_000, animated: false })
          .rotate()
          .png()
          .toBuffer(),
      );
    }
    const ids = references.map(() => randomUUID());
    try {
      const images = [];
      for (let index = 0; index < references.length; index++) {
        const ref = references[index];
        images.push(
          await saveImage(prepared[index], {
            id: ids[index],
            threadId: ids[0],
            kind: "upload",
            name: ref.item.title,
            prompt,
            referenceInput: {
              number: index + 1,
              slot: ref.slot,
              catalogId: ref.item.id,
              variant: ref.image.id,
            },
          }),
        );
      }
      res.status(201).json({ images: images.map(referenceInputView), prompt });
    } catch (error) {
      store.state.images = store.state.images.filter((image) => !ids.includes(image.id));
      for (const id of ids)
        for (const ext of ["png", "webp"])
          fs.rmSync(path.join(store.directory, "media", `${id}.${ext}`), { force: true });
      store.save();
      throw error;
    }
  });
  app.get("/api/reference-gallery/notices/:name", (req, res) => {
    if (
      ![
        "NOTICE.md",
        "LICENSE-upstream.txt",
        "LICENSE-shisei-images.txt",
        "NOTICE-shisei.txt",
      ].includes(req.params.name)
    )
      return res.status(404).json({ error: "说明文件不存在" });
    res.type("text/plain; charset=utf-8").sendFile(path.join(dataDirectory, req.params.name));
  });
  // Remote images are fetched only from catalog entries; this is not a generic URL proxy.
  const cache = new Map();
  let cachedBytes = 0;
  app.get("/api/reference-gallery/items/:id/image", async (req, res) => {
    const variant = typeof req.query.variant === "string" ? req.query.variant : "default";
    const selected = catalog.files.get(`${req.params.id}|${variant}`);
    if (!selected) return res.status(404).json({ error: "参考图片或视角不存在" });
    const location = req.query.thumbnail === "1" ? selected.thumbnail : selected.original;
    try {
      if (!/^https:\/\//i.test(location)) {
        const filename = resolveGalleryFile(directory, location);
        res.setHeader("Cache-Control", "private, max-age=3600");
        if (req.query.download === "1") res.attachment(path.basename(filename));
        return res.sendFile(filename);
      }
      let entry = cache.get(location);
      if (!entry || entry.expires < Date.now()) {
        if (entry) {
          cachedBytes -= entry.bytes.length;
          cache.delete(location);
        }
        const result = await transport(location, { timeout: 30000, maxBytes: 32 * 1024 * 1024 });
        if (result.status !== 200) throw new Error(`图片来源返回 HTTP ${result.status}`);
        const metadata = await sharp(result.bytes, { limitInputPixels: 40_000_000 }).metadata();
        if (!["jpeg", "png", "webp"].includes(metadata.format))
          throw new Error("来源未返回支持的图片格式");
        entry = {
          bytes: result.bytes,
          mime: `image/${metadata.format}`,
          expires: Date.now() + 3600000,
        };
        if (cache.has(location)) {
          cachedBytes -= cache.get(location).bytes.length;
          cache.delete(location);
        }
        while (cache.size && cachedBytes + entry.bytes.length > 32 * 1024 * 1024) {
          const key = cache.keys().next().value;
          cachedBytes -= cache.get(key).bytes.length;
          cache.delete(key);
        }
        cache.set(location, entry);
        cachedBytes += entry.bytes.length;
      }
      res.setHeader("Cache-Control", "private, max-age=3600");
      if (req.query.download === "1")
        res.attachment(
          `${req.params.id.replace(/[^a-z0-9_-]/gi, "_")}.` + entry.mime.split("/")[1],
        );
      res.type(entry.mime).send(entry.bytes);
    } catch (error) {
      const missing = !directory || error.code === "ENOENT";
      res.status(missing ? 404 : 502).json({
        error: missing ? "本地参考图片不存在，请挂载完整的 img 和 thumbs 素材目录" : error.message,
      });
    }
  });
}
