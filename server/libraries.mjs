import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { validateUrl } from "./network.mjs";
import {
  createLibraryStorage,
  libraryPath,
  fileName,
  isImage,
  failure,
  MAX_UPLOAD,
} from "./library-storage.mjs";

export function publicLibrary(library) {
  const { secret, ...safe } = library;
  return { ...safe, hasCredentials: Boolean(secret), isDefault: library.id === "local" };
}
export function mountLibraries(app, { store, saveImage, transport }) {
  const { state, save } = store;
  const storage = createLibraryStorage(store.directory, transport);
  const credentials = (library) => (library.secret ? JSON.parse(store.open(library.secret)) : {});
  const cache = new Map();
  const find = (id) => {
    const library = state.libraries.find((l) => l.id === id);
    if (!library) throw failure("素材库不存在", 404);
    return library;
  };
  const route = (callback) => async (req, res) => {
    try {
      await callback(req, res);
    } catch (error) {
      let message = error.message || "素材库操作失败";
      for (const library of state.libraries) {
        let values = {};
        try {
          values = credentials(library);
        } catch {}
        for (const value of Object.values(values))
          if (value) message = message.split(value).join("[已隐藏]");
      }
      res
        .status(error.status || (error.code === "ENOENT" ? 404 : 400))
        .json({ error: error.code === "ENOENT" ? "目录或文件不存在" : message.slice(0, 500) });
    }
  };
  function validate(body, previous) {
    if (!["local", "s3", "webdav"].includes(body.type))
      throw failure("请选择本地、S3 或 WebDAV 来源");
    if (previous && previous.type !== body.type) throw failure("修改来源类型请新建素材库");
    const name = String(body.name || "")
      .trim()
      .slice(0, 80);
    if (!name) throw failure("请输入素材库名称");
    const library = {
      id: previous?.id || randomUUID(),
      name,
      type: body.type,
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (body.type !== "local") {
      const endpoint = validateUrl(body.endpoint);
      if (endpoint.search || endpoint.hash)
        throw failure("素材库地址不能包含查询参数或锚点，请将凭证填写在专用字段中");
      library.endpoint = endpoint.href.replace(/\/+$/, "") + (body.type === "webdav" ? "/" : "");
      const supplied = body.credentials || {};
      const changedOrigin =
        previous?.secret && new URL(previous.endpoint).origin !== endpoint.origin;
      const requiredCredentials =
        body.type === "s3" ? ["accessKeyId", "secretAccessKey"] : ["username", "password"];
      if (
        changedOrigin &&
        !body.clearCredentials &&
        !requiredCredentials.every(
          (key) => typeof supplied[key] === "string" && supplied[key] !== "",
        )
      )
        throw failure("来源地址已改变，请重新填写完整凭证");
      const secret =
        previous && !body.clearCredentials && !changedOrigin ? credentials(previous) : {};
      const keys =
        body.type === "s3"
          ? ["accessKeyId", "secretAccessKey", "sessionToken"]
          : ["username", "password"];
      for (const key of keys)
        if (typeof supplied[key] === "string" && supplied[key] !== "") secret[key] = supplied[key];
      if (body.type === "s3") {
        library.bucket = String(body.bucket || "").trim();
        if (!/^[a-z0-9][a-z0-9._-]{0,254}$/i.test(library.bucket)) throw failure("Bucket 名称无效");
        library.region = String(body.region || "us-east-1").trim();
        if (!/^[a-z0-9-]+$/i.test(library.region)) throw failure("S3 Region 无效");
        library.prefix = libraryPath(String(body.prefix || "").trim());
        library.pathStyle = body.pathStyle !== false;
        if (Boolean(secret.accessKeyId) !== Boolean(secret.secretAccessKey))
          throw failure("Access Key ID 和 Secret Access Key 需一起填写");
      } else if (secret.password && !secret.username) throw failure("请填写 WebDAV 用户名");
      library.secret = Object.values(secret).some(Boolean)
        ? store.seal(JSON.stringify(secret))
        : "";
    }
    return library;
  }
  app.get("/api/libraries", (_req, res) => res.json(state.libraries.map(publicLibrary)));
  app.post(
    "/api/libraries",
    route((req, res) => {
      const library = validate(req.body);
      state.libraries.push(library);
      save();
      res.status(201).json(publicLibrary(library));
    }),
  );
  app.put(
    "/api/libraries/:id",
    route((req, res) => {
      const library = validate(req.body, find(req.params.id));
      state.libraries[state.libraries.findIndex((l) => l.id === library.id)] = library;
      save();
      res.json(publicLibrary(library));
    }),
  );
  app.delete(
    "/api/libraries/:id",
    route((req, res) => {
      const library = find(req.params.id);
      if (library.id === "local") throw failure("默认本地素材库不能移除", 409);
      state.libraries = state.libraries.filter((l) => l.id !== library.id);
      save();
      res.json({ ok: true, message: "已移除素材库配置，来源中的文件仍保留" });
    }),
  );
  app.post(
    "/api/libraries/:id/test",
    route(async (req, res) => {
      const library = find(req.params.id);
      const result = await storage.list(library, credentials(library));
      res.json({ ok: true, message: `连接成功，当前目录读取到 ${result.entries.length} 项` });
    }),
  );
  app.get(
    "/api/libraries/:id/entries",
    route(async (req, res) => {
      const library = find(req.params.id);
      if (req.query.refresh === "1")
        for (const key of cache.keys()) if (key.startsWith(`${library.id}:`)) cache.delete(key);
      const result = await storage.list(
        library,
        credentials(library),
        req.query.path || "",
        req.query.cursor,
      );
      res.json({
        ...result,
        entries: result.entries.map((entry) => ({
          ...entry,
          image: entry.type === "file" && isImage(entry.name),
          previewUrl:
            entry.type === "file" && isImage(entry.name)
              ? `/api/libraries/${library.id}/preview?path=${encodeURIComponent(entry.path)}`
              : null,
        })),
      });
    }),
  );
  let previewActive = 0;
  const previewQueue = [];
  async function imageSlot(callback) {
    if (previewActive >= 2) {
      if (previewQueue.length >= 32) throw failure("图片预览繁忙，请稍后刷新", 429);
      await new Promise((resolve) => previewQueue.push(resolve));
    } else previewActive++;
    try {
      return await callback();
    } finally {
      const next = previewQueue.shift();
      if (next) next();
      else previewActive--;
    }
  }
  app.get(
    "/api/libraries/:id/preview",
    route(async (req, res) => {
      const library = find(req.params.id),
        relative = libraryPath(req.query.path || "");
      if (!isImage(relative)) throw failure("此文件类型不支持图片预览");
      const thumbnail = req.query.thumbnail === "1",
        key = `${library.id}:${relative}:${library.updatedAt || ""}`;
      let bytes = thumbnail && cache.get(key)?.expires > Date.now() ? cache.get(key).bytes : null;
      if (!bytes)
        bytes = await imageSlot(async () => {
          const original = await storage.read(library, credentials(library), relative);
          const result = await sharp(original, { limitInputPixels: 40000000, animated: false })
            .rotate()
            .resize({
              width: thumbnail ? 480 : 1920,
              height: thumbnail ? 480 : 1920,
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: thumbnail ? 75 : 88 })
            .toBuffer();
          if (thumbnail) {
            if (cache.size >= 100) cache.delete(cache.keys().next().value);
            cache.set(key, { bytes: result, expires: Date.now() + 60000 });
          }
          return result;
        });
      res.type("image/webp").send(bytes);
    }),
  );
  app.get(
    "/api/libraries/:id/file",
    route(async (req, res) => {
      const library = find(req.params.id),
        relative = libraryPath(req.query.path || "");
      const bytes = await storage.read(library, credentials(library), relative);
      const name = encodeURIComponent(path.posix.basename(relative)).replace(
        /['()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16)}`,
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="asset"; filename*=UTF-8''${name}`,
      );
      res.type("application/octet-stream").send(bytes);
    }),
  );
  app.post(
    "/api/libraries/:id/upload",
    route(async (req, res) => {
      const library = find(req.params.id),
        folder = libraryPath(req.body.path || ""),
        name = fileName(req.body.name);
      const match =
        typeof req.body.data === "string" &&
        req.body.data.match(/^data:([\w.+/-]+)?;base64,([A-Za-z0-9+/=\s]*)$/);
      if (!match) throw failure("文件上传格式无效");
      const bytes = Buffer.from(match[2], "base64");
      if (bytes.length > MAX_UPLOAD) throw failure("单个文件不能超过 12MB", 413);
      res
        .status(201)
        .json(
          await storage.write(
            library,
            credentials(library),
            [folder, name].filter(Boolean).join("/"),
            bytes,
            match[1] || "application/octet-stream",
          ),
        );
    }),
  );
  app.post(
    "/api/libraries/:id/folders",
    route(async (req, res) => {
      const library = find(req.params.id),
        folder = libraryPath(req.body.path || ""),
        name = fileName(req.body.name);
      res
        .status(201)
        .json(
          await storage.mkdir(
            library,
            credentials(library),
            [folder, name].filter(Boolean).join("/"),
          ),
        );
    }),
  );
  app.post(
    "/api/libraries/:id/from-image",
    route(async (req, res) => {
      const library = find(req.params.id),
        image = state.images.find((i) => i.id === req.body.imageId);
      if (!image || (image.status && image.status !== "succeeded"))
        throw failure("图片尚未生成或已删除", 409);
      const folder = libraryPath(req.body.path || ""),
        name = fileName(req.body.name || `${image.id}.png`);
      if (!name.toLowerCase().endsWith(".png"))
        throw failure("工作台图片以 PNG 保存，请使用 .png 文件名");
      const bytes = fs.readFileSync(path.join(store.directory, "media", `${image.id}.png`));
      res
        .status(201)
        .json(
          await storage.write(
            library,
            credentials(library),
            [folder, name].filter(Boolean).join("/"),
            bytes,
            "image/png",
          ),
        );
    }),
  );
  app.post(
    "/api/libraries/:id/import",
    route(async (req, res) => {
      const library = find(req.params.id),
        relative = libraryPath(req.body.path || "");
      if (!isImage(relative)) throw failure("请选择可预览的图片文件");
      const bytes = await storage.read(library, credentials(library), relative);
      res
        .status(201)
        .json(
          await saveImage(bytes, {
            kind: "upload",
            name: path.posix.basename(relative),
            libraryId: library.id,
            libraryPath: relative,
          }),
        );
    }),
  );
}
