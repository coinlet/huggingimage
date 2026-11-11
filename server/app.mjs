import express from "express";
import { resolveResolution } from "../shared/resolution.mjs";
import path from "node:path";
import fs from "node:fs";
import { randomUUID, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import sharp from "sharp";
import { createStore, publicProvider } from "./store.mjs";
import { validateUrl, requestBytes, requestJson } from "./network.mjs";
import { validateSpace, inspectSpace, runCompatible, runSpace } from "./providers.mjs";
import { discoverConfiguration } from "./space-discovery.mjs";
import { repairEncodedEditProvider } from "./gradio-images.mjs";

export function createApp(options = {}) {
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? "";
  const providerRequest = options.requestJson || requestJson;
  const compatibleRunner = options.runCompatible || runCompatible;
  const spaceRunner = options.runSpace || runSpace;
  const spaceInspector = options.inspectSpace || inspectSpace;
  const store = createStore(path.resolve(options.dataDir || process.env.DATA_DIR || "./data"));
  const { state, save } = store;
  let repaired = false;
  for (const provider of state.providers) if (repairEncodedEditProvider(provider)) repaired = true;
  if (repaired) save();
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });
  app.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
      let origin;
      try {
        origin = new URL(req.headers.origin);
      } catch {
        return res.status(403).json({ error: "无效的请求来源" });
      }
      if (origin.host !== req.headers.host)
        return res.status(403).json({ error: "不允许跨站请求" });
    }
    // Prevent DNS rebinding against the unprotected local-only workspace.
    if (
      !adminToken &&
      !["127.0.0.1", "localhost", "::1"].includes(
        (req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, ""),
      )
    )
      return res.status(403).json({ error: "本地模式仅接受 localhost 访问" });
    next();
  });
  app.use(express.json({ limit: "20mb" }));
  const sessionSecret = randomBytes(32);
  function equals(a, b) {
    const x = Buffer.from(a),
      y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }
  function signature(value) {
    return createHmac("sha256", sessionSecret).update(value).digest("hex");
  }
  function authorized(req) {
    if (!adminToken) return true;
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    if (bearer && equals(bearer, adminToken)) return true;
    const cookie = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("imagine_session="))
      ?.slice(16);
    if (!cookie) return false;
    const [expires, sig] = cookie.split(".");
    return Number(expires) > Date.now() && Boolean(sig) && equals(sig, signature(expires));
  }
  app.get("/api/session", (req, res) =>
    res.json({ authenticated: authorized(req), protected: Boolean(adminToken) }),
  );
  const attempts = new Map();
  app.post("/api/session", (req, res) => {
    const ip = req.socket.remoteAddress;
    const record = attempts.get(ip) || { count: 0, time: Date.now() };
    if (Date.now() - record.time > 60000) {
      record.count = 0;
      record.time = Date.now();
    }
    if (++record.count > 10) return res.status(429).json({ error: "尝试过于频繁，请一分钟后重试" });
    attempts.set(ip, record);
    if (adminToken && (typeof req.body.token !== "string" || !equals(req.body.token, adminToken)))
      return res.status(401).json({ error: "访问令牌不正确" });
    const expires = String(Date.now() + 7 * 86400000);
    res.setHeader(
      "Set-Cookie",
      `imagine_session=${expires}.${signature(expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${req.secure ? "; Secure" : ""}`,
    );
    res.json({ authenticated: true });
  });
  app.delete("/api/session", (_req, res) => {
    res.setHeader("Set-Cookie", "imagine_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    res.json({ ok: true });
  });
  app.use(["/api", "/media"], (req, res, next) => {
    if (!authorized(req)) return res.status(401).json({ error: "请先登录工作台" });
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/providers", (_req, res) => res.json(state.providers.map(publicProvider)));
  function string(value, max = 1000) {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
  }
  function validateProvider(body, previous) {
    const type = body.type;
    if (!["xai", "openai", "gradio"].includes(type)) throw new Error("请选择有效的提供商类型");
    const provider = {
      id: previous?.id || randomUUID(),
      type,
      name: string(body.name, 80),
      enabled: body.enabled !== false,
      supportsEdit: body.supportsEdit === true,
      supportsGenerate: body.supportsGenerate !== false,
      model: string(body.model, 200),
      secret: previous?.secret || "",
    };
    if (!provider.name) throw new Error("请填写提供商名称");
    if (typeof body.apiKey === "string" && body.apiKey.trim())
      provider.secret = store.seal(body.apiKey.trim());
    if (body.clearKey === true) provider.secret = "";
    if (type === "gradio") {
      provider.space = validateSpace(string(body.space));
      provider.endpoint = string(body.endpoint, 200);
      provider.editEndpoint = string(body.editEndpoint, 200);
      provider.template = body.template;
      provider.editTemplate = body.editTemplate;
      provider.outputPath = string(body.outputPath, 200);
      provider.editOutputPath =
        typeof body.editOutputPath === "string"
          ? string(body.editOutputPath, 200)
          : provider.outputPath;
      const defaults = {};
      for (const mode of ["generate", "edit"]) {
        const value = body.defaults?.[mode];
        defaults[mode] = {};
        if (Number.isFinite(value?.steps) && value.steps >= 1 && value.steps <= 100)
          defaults[mode].steps = value.steps;
        if (Number.isFinite(value?.guidance) && value.guidance >= 0 && value.guidance <= 30)
          defaults[mode].guidance = value.guidance;
      }
      provider.defaults = defaults;
      if (!provider.supportsGenerate && !provider.supportsEdit)
        throw new Error("至少需要一个可用的图片生成或编辑端点");
      if (provider.supportsGenerate && !provider.endpoint.startsWith("/"))
        throw new Error("生成端点必须以 / 开头");
      if (
        provider.supportsGenerate &&
        (!provider.template || typeof provider.template !== "object")
      )
        throw new Error("参数模板必须为 JSON 对象或数组");
      if (
        provider.supportsEdit &&
        (!provider.editEndpoint.startsWith("/") ||
          !provider.editTemplate ||
          typeof provider.editTemplate !== "object")
      )
        throw new Error("请配置编辑端点和编辑参数模板");
    } else {
      provider.baseUrl = validateUrl(string(body.baseUrl)).href.replace(/\/+$/, "");
      if (!provider.model) throw new Error("请填写模型 ID");
      if (body.extra && (typeof body.extra !== "object" || Array.isArray(body.extra)))
        throw new Error("扩展参数必须为 JSON 对象");
      provider.extra = body.extra || {};
    }
    return provider;
  }
  app.post("/api/providers", (req, res) => {
    const p = validateProvider(req.body);
    state.providers.push(p);
    save();
    res.status(201).json(publicProvider(p));
  });
  app.put("/api/providers/:id", (req, res) => {
    const index = state.providers.findIndex((p) => p.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: "提供商不存在" });
    const p = validateProvider(req.body, state.providers[index]);
    state.providers[index] = p;
    save();
    res.json(publicProvider(p));
  });
  app.delete("/api/providers/:id", (req, res) => {
    state.providers = state.providers.filter((p) => p.id !== req.params.id);
    save();
    res.json({ ok: true });
  });
  function safeError(error, key = "") {
    let message = String(error?.message || error || "未知错误");
    if (key) message = message.split(key).join("[已隐藏]");
    return message
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [已隐藏]")
      .replace(/hf_[A-Za-z0-9]+/g, "[已隐藏]")
      .slice(0, 600);
  }
  let discoveryRunning = 0;
  app.post("/api/spaces/discover", async (req, res) => {
    if (discoveryRunning >= 2)
      return res.status(429).json({ error: "最多同时识别两个 Space，请稍后重试" });
    const space = validateSpace(string(req.body.space));
    let key = typeof req.body.apiKey === "string" ? req.body.apiKey.trim() : "";
    if (req.body.providerId && !key && !req.body.clearKey) {
      const previous = state.providers.find(
        (p) => p.id === req.body.providerId && p.type === "gradio",
      );
      if (!previous) return res.status(404).json({ error: "原 Space 连接不存在" });
      if (previous.space !== space)
        return res
          .status(400)
          .json({ error: "Space 地址已改变，请重新填写 Token；不会自动将旧 Token 发送给新 Space" });
      key = store.open(previous.secret);
    }
    if (req.body.clearKey) key = "";
    discoveryRunning++;
    try {
      const api = await spaceInspector({ type: "gradio", space }, key);
      const result = await discoverConfiguration(api, space);
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: safeError(error, key) });
    } finally {
      discoveryRunning--;
    }
  });
  app.post("/api/providers/:id/test", async (req, res) => {
    const p = state.providers.find((p) => p.id === req.params.id);
    if (!p) return res.status(404).json({ error: "提供商不存在" });
    const key = store.open(p.secret);
    try {
      if (p.type === "gradio") {
        res.json({ ok: true, api: await spaceInspector(p, key) });
      } else {
        const data = await providerRequest(`${p.baseUrl}/models`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
          timeout: 20000,
        });
        res.json({
          ok: true,
          models: (data.data || []).map((m) => m.id),
          message: "连接成功。模型是否支持图片生成将由实际生成请求验证。",
        });
      }
    } catch (error) {
      res.status(400).json({ error: safeError(error, key) });
    }
  });
  app.get("/api/jobs", (_req, res) => res.json(state.jobs.slice().reverse()));
  app.get("/api/images", (_req, res) =>
    res.json(
      state.images
        .filter((i) => i.kind === "generated")
        .slice()
        .reverse(),
    ),
  );
  app.get("/api/images/:id/thread", (req, res) => {
    const image = state.images.find((i) => i.id === req.params.id);
    if (!image) return res.status(404).json({ error: "图片不存在" });
    res.json(state.images.filter((i) => i.threadId === image.threadId));
  });
  async function saveImage(bytes, metadata = {}) {
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error("图片为空或超过 32MB");
    const png = await sharp(bytes, { limitInputPixels: 40000000, animated: false })
      .rotate()
      .png()
      .toBuffer();
    const info = await sharp(png).metadata();
    const id = metadata.id || randomUUID();
    fs.writeFileSync(path.join(store.directory, "media", `${id}.png`), png, { mode: 0o600 });
    await sharp(png)
      .resize({ width: 640, height: 800, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(path.join(store.directory, "media", `${id}.webp`));
    const image = {
      id,
      url: `/media/${id}.png`,
      thumbnail: `/media/${id}.webp`,
      width: info.width,
      height: info.height,
      createdAt: new Date().toISOString(),
      favorite: false,
      ...metadata,
    };
    image.threadId ||= id;
    image.status = "succeeded";
    image.error = undefined;
    const existing = state.images.findIndex((i) => i.id === id);
    if (existing < 0) state.images.push(image);
    else state.images[existing] = image;
    save();
    return image;
  }
  app.post("/api/uploads", async (req, res) => {
    const match =
      typeof req.body.data === "string" &&
      req.body.data.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) return res.status(400).json({ error: "请选择 PNG、JPEG 或 WebP 图片" });
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > 12 * 1024 * 1024)
      return res.status(400).json({ error: "上传图片不能超过 12MB" });
    res
      .status(201)
      .json(await saveImage(bytes, { kind: "upload", name: string(req.body.name, 200) }));
  });
  app.patch("/api/images/:id", (req, res) => {
    const image = state.images.find((i) => i.id === req.params.id);
    if (!image) return res.status(404).json({ error: "图片不存在" });
    image.favorite = req.body.favorite === true;
    save();
    res.json(image);
  });
  app.delete("/api/images/:id", (req, res) => {
    const image = state.images.find((i) => i.id === req.params.id);
    if (!image) return res.status(404).json({ error: "图片不存在" });
    if (["queued", "running"].includes(image.status))
      return res.status(409).json({ error: "请先取消生成任务，再删除此图片" });
    if (
      state.jobs.some(
        (j) =>
          ["queued", "running"].includes(j.status) &&
          (j.sourceId === image.id || j.maskId === image.id),
      )
    )
      return res.status(409).json({ error: "此图片正用于生成任务，完成后可删除" });
    state.images = state.images.filter((i) => i.id !== image.id);
    for (const ext of ["png", "webp"])
      fs.rmSync(path.join(store.directory, "media", `${image.id}.${ext}`), { force: true });
    save();
    res.json({ ok: true });
  });
  app.get("/media/:file", (req, res) => {
    if (!/^[\da-f-]{36}\.(png|webp)$/.test(req.params.file)) return res.sendStatus(404);
    if (req.query.download)
      res.setHeader("Content-Disposition", 'attachment; filename="imagine.png"');
    res.sendFile(path.join(store.directory, "media", req.params.file));
  });
  const running = new Map();
  let closing = false;
  function integer(value, fallback, min, max) {
    const n = Number(value ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`参数必须为 ${min}–${max} 之间的整数`);
    return n;
  }
  app.post("/api/jobs", (req, res) => {
    const b = req.body,
      provider = state.providers.find((p) => p.id === b.providerId && p.enabled);
    if (!provider) return res.status(400).json({ error: "请先配置并选择可用的模型提供商" });
    if (state.jobs.filter((j) => ["queued", "running"].includes(j.status)).length >= 10)
      return res.status(429).json({ error: "最多可排队 10 个任务" });
    const prompt = string(b.prompt, 6000);
    if (!prompt) return res.status(400).json({ error: "请描述你想创作的画面" });
    const mode = b.mode === "edit" ? "edit" : "generate";
    if (mode === "generate" && provider.supportsGenerate === false)
      return res
        .status(400)
        .json({ error: "此 Space 仅支持图片编辑，请切换到图片编辑并上传参考图" });
    const source = state.images.find((i) => i.id === b.sourceId),
      mask = state.images.find((i) => i.id === b.maskId);
    if (
      mode === "edit" &&
      (!provider.supportsEdit || !source || (source.status && source.status !== "succeeded"))
    )
      return res.status(400).json({ error: "编辑需要参考图片，且提供商必须启用编辑能力" });
    if (
      b.maskId &&
      (!mask ||
        (mask.status && mask.status !== "succeeded") ||
        !source ||
        mask.width !== source.width ||
        mask.height !== source.height)
    )
      return res.status(400).json({ error: "蒙版尺寸必须与原图一致" });
    const { ratio, width, height, resolution } = resolveResolution(b, provider.type);
    const guidance = Number(b.guidance ?? 3.5);
    if (!Number.isFinite(guidance) || guidance < 0 || guidance > 30)
      throw new Error("引导系数必须为 0–30");
    const requestedCount = integer(b.count, 1, 1, 4);
    const slotIds = b.slotIds ?? Array.from({ length: requestedCount }, () => randomUUID());
    if (
      !Array.isArray(slotIds) ||
      slotIds.length !== requestedCount ||
      new Set(slotIds).size !== requestedCount ||
      slotIds.some(
        (id) =>
          typeof id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
      )
    )
      return res.status(400).json({ error: "图片标识无效" });
    if (slotIds.some((id) => state.images.some((image) => image.id === id)))
      return res.status(409).json({ error: "图片已存在，请刷新查看创作结果" });
    const job = {
      id: randomUUID(),
      providerId: provider.id,
      providerName: provider.name,
      model: provider.model || provider.space,
      prompt,
      negativePrompt: string(b.negativePrompt, 3000),
      mode,
      sourceId: mode === "edit" ? source?.id : undefined,
      maskId: mode === "edit" ? mask?.id : undefined,
      ratio,
      resolution,
      width,
      height,
      count: requestedCount,
      slotIds,
      seed:
        b.seed === "" || b.seed == null || Number(b.seed) === -1
          ? randomBytes(4).readUInt32LE() % 2147483647
          : integer(b.seed, 0, 0, 2147483647),
      steps: integer(b.steps, 28, 1, 100),
      guidance,
      status: "queued",
      createdAt: new Date().toISOString(),
      imageIds: [],
    };
    const threadId = mode === "edit" ? source.threadId || source.id : slotIds[0];
    for (const id of slotIds)
      state.images.push({
        id,
        kind: "generated",
        status: "queued",
        url: "",
        thumbnail: "",
        width,
        height,
        favorite: false,
        createdAt: job.createdAt,
        threadId,
        parentId: job.sourceId,
        jobId: job.id,
        prompt,
        providerName: job.providerName,
        model: job.model,
        mode,
      });
    state.jobs.push(job);
    save();
    res.status(202).json(job);
    queueMicrotask(pump);
  });
  app.post("/api/images/:id/retry", (req, res) => {
    const image = state.images.find((i) => i.id === req.params.id);
    if (!image) return res.status(404).json({ error: "图片不存在" });
    const previous = state.jobs.find((j) => j.id === image.jobId);
    if (!previous || !["failed", "cancelled"].includes(image.status))
      return res.status(409).json({ error: "仅失败或已取消的图片可以重试" });
    if (running.has(previous.id))
      return res.status(409).json({ error: "任务正在结束，请稍后重试" });
    if (state.jobs.filter((j) => ["queued", "running"].includes(j.status)).length >= 10)
      return res.status(429).json({ error: "最多可排队 10 个任务" });
    const provider = state.providers.find((p) => p.id === previous.providerId && p.enabled);
    if (!provider) return res.status(400).json({ error: "请恢复原模型提供商后重试" });
    if (
      previous.sourceId &&
      !state.images.some(
        (i) => i.id === previous.sourceId && (!i.status || i.status === "succeeded"),
      )
    )
      return res.status(400).json({ error: "参考图片已删除，无法重试" });
    if (previous.maskId && !state.images.some((i) => i.id === previous.maskId))
      return res.status(400).json({ error: "蒙版已删除，无法重试" });
    const job = {
      ...previous,
      id: randomUUID(),
      retryOf: previous.id,
      providerName: provider.name,
      model: provider.model || provider.space,
      status: "queued",
      count: 1,
      slotIds: [image.id],
      imageIds: [],
      seed: previous.seed + Math.max(0, previous.slotIds?.indexOf(image.id) ?? 0),
      createdAt: new Date().toISOString(),
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
    };
    Object.assign(image, { jobId: job.id, status: "queued", error: undefined });
    state.jobs.push(job);
    save();
    res.status(202).json(job);
    queueMicrotask(pump);
  });
  function updateSlots(job, status, error) {
    for (const id of job.slotIds || []) {
      const image = state.images.find((i) => i.id === id && i.jobId === job.id);
      if (image && image.status !== "succeeded") Object.assign(image, { status, error });
    }
  }
  app.post("/api/jobs/:id/cancel", (req, res) => {
    const job = state.jobs.find((j) => j.id === req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在" });
    if (["queued", "running"].includes(job.status)) {
      job.status = "cancelled";
      job.completedAt = new Date().toISOString();
      running.get(job.id)?.abort();
      updateSlots(job, "cancelled", "生成已取消，可以重试");
      save();
    }
    res.json(job);
  });
  function readImage(id) {
    return id ? fs.readFileSync(path.join(store.directory, "media", `${id}.png`)) : null;
  }
  async function execute(job) {
    const controller = new AbortController();
    running.set(job.id, controller);
    job.status = "running";
    job.startedAt = new Date().toISOString();
    updateSlots(job, "running");
    save();
    let key = "";
    const timeout = setTimeout(
      () => controller.abort(new Error("任务超过 10 分钟，请重试或检查 Space 队列")),
      600000,
    );
    try {
      const provider = state.providers.find((p) => p.id === job.providerId);
      if (!provider) throw new Error("提供商已删除");
      key = store.open(provider.secret);
      const source = readImage(job.sourceId),
        mask = readImage(job.maskId);
      const abortPromise = new Promise((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason || new Error("任务已取消")),
          { once: true },
        ),
      );
      const work =
        provider.type === "gradio"
          ? spaceRunner(provider, key, job, source, mask, controller.signal)
          : compatibleRunner(provider, key, job, source, mask, controller.signal);
      const urls = await Promise.race([work, abortPromise]);
      if (!Array.isArray(urls) || !urls.length) throw new Error("提供商未返回图片，请重试");
      for (const entry of urls.slice(0, job.count)) {
        const url = typeof entry === "string" ? entry : entry.url;
        controller.signal.throwIfAborted();
        let bytes;
        if (url.startsWith("data:image/")) {
          bytes = Buffer.from(url.split(",")[1], "base64");
        } else {
          const target = new URL(url);
          const headers = {};
          // Private Gradio files require the token, but never forward it to a different domain.
          if (
            provider.type === "gradio" &&
            key &&
            typeof entry === "object" &&
            target.origin === entry.authOrigin &&
            target.protocol === "https:" &&
            target.hostname.endsWith(".hf.space")
          )
            headers.Authorization = `Bearer ${key}`;
          let response;
          try {
            response = await requestBytes(url, {
              signal: controller.signal,
              headers,
            });
          } catch (error) {
            throw new Error(`图片已生成，但下载失败：${safeError(error, key)}`);
          }
          if (response.status !== 200) throw new Error(`下载生成图片失败：HTTP ${response.status}`);
          bytes = response.bytes;
        }
        const slot = state.images.find((i) => i.id === job.slotIds?.[job.imageIds.length]);
        if (job.status === "cancelled") break;
        const image = await saveImage(bytes, {
          id: slot?.id,
          createdAt: slot?.createdAt || new Date().toISOString(),
          favorite: slot?.favorite || false,
          kind: "generated",
          jobId: job.id,
          parentId: job.sourceId,
          threadId: slot?.threadId || state.images.find((i) => i.id === job.sourceId)?.threadId,
          prompt: job.prompt,
          providerName: job.providerName,
          model: job.model,
          mode: job.mode,
          seed: provider.type === "gradio" ? job.seed + job.imageIds.length : undefined,
        });
        job.imageIds.push(image.id);
      }
      if (job.status !== "cancelled") {
        if (job.imageIds.length < job.count)
          throw new Error("提供商返回图片数量不足，未完成的图片可以重试");
        job.status = "succeeded";
      }
    } catch (error) {
      if (job.status !== "cancelled") {
        job.status = "failed";
        job.error = safeError(error, key);
        updateSlots(job, "failed", job.error);
      }
    } finally {
      clearTimeout(timeout);
      job.completedAt = new Date().toISOString();
      running.delete(job.id);
      save();
      if (closing && !running.size) store.close();
      else pump();
    }
  }
  function pump() {
    if (closing) return;
    while (running.size < 2) {
      const job = state.jobs.find((j) => j.status === "queued");
      if (!job) break;
      void execute(job);
    }
  }
  const dist = path.resolve("dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get("/{*path}", (req, res, next) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/media/")) return next();
      res.sendFile(path.join(dist, "index.html"));
    });
  }
  app.use((req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use((error, _req, res, _next) => {
    if (error.type === "entity.too.large") return res.status(413).json({ error: "上传内容过大" });
    if (error instanceof SyntaxError) return res.status(400).json({ error: "JSON 格式不正确" });
    res.status(400).json({ error: safeError(error) });
  });
  return {
    app,
    close() {
      if (closing) return;
      closing = true;
      for (const controller of running.values()) controller.abort();
      if (!running.size) store.close();
    },
  };
}
