import { Client, handle_file } from "@gradio/client";
import { requestJson, validateUrl } from "./network.mjs";
import { closeGradioClient } from "./gradio-client-lifecycle.mjs";
import { readSpaceSchema, mapAspectRatio } from "./gradio-schema.mjs";
import {
  encodedImageVariable,
  usesSourceImage,
  extractGradioImages,
  selectGradioOutput,
  outputShape,
  noChangeUpdate,
  gradioError,
} from "./gradio-images.mjs";

export const variables = [
  "prompt",
  "negative_prompt",
  "width",
  "height",
  "seed",
  "steps",
  "guidance",
  "aspect_ratio",
  "image",
  "image_base64",
  "image_data_uri",
  "images_b64_json",
  "mask",
];
export function mapTemplate(value, context) {
  if (typeof value === "string") {
    const match = value.match(/^\{\{(\w+)\}\}$/);
    if (match) {
      if (!(match[1] in context)) throw new Error(`未知参数变量：${match[1]}`);
      return context[match[1]];
    }
    return value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (!(key in context)) throw new Error(`未知参数变量：${key}`);
      return String(context[key] ?? "");
    });
  }
  if (Array.isArray(value)) return value.map((item) => mapTemplate(item, context));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapTemplate(item, context)]),
    );
  return value;
}
export function validateSpace(space) {
  const value = String(space || "").trim();
  const validId = (id) =>
    /^[\w.-]+\/[\w.-]+$/.test(id) && id.split("/").every((part) => part !== "." && part !== "..");
  if (validId(value)) return value;
  const url = validateUrl(value);
  if (url.protocol === "https:" && url.hostname === "huggingface.co" && !url.port) {
    const match = url.pathname.match(/^\/spaces\/([\w.-]+\/[\w.-]+)\/?$/);
    if (match && validId(match[1])) return match[1];
  }
  if (
    url.protocol !== "https:" ||
    !/^[\w-]+\.hf\.space$/.test(url.hostname) ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("请填写 Hugging Face Space 页面链接、owner/space-name 或 https://xxx.hf.space");
  return url.origin;
}
export async function connectSpace(provider, key) {
  return Client.connect(validateSpace(provider.space), {
    ...(key ? { token: key } : {}),
    events: ["data", "status"],
  });
}
export async function inspectSpace(provider, key) {
  const controller = new AbortController();
  let client,
    expired = false,
    timer;
  const work = (async () => {
    let primaryError;
    try {
      client = await connectSpace(provider, key);
      if (expired) throw new Error("Space API 读取超时");
      return await readSpaceSchema(client, key, controller.signal);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await closeGradioClient(client, { primaryError });
    }
  })();
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          controller.abort();
          const timeoutError = new Error(
            "读取 Space API 超过 45 秒，请检查访问权限或稍后重试；休眠 Space 可能需要先在 HF 页面启动",
          );
          void closeGradioClient(client, { primaryError: timeoutError });
          reject(timeoutError);
        }, 45000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function atPath(value, path) {
  if (!path?.trim()) return value;
  return path.split(".").reduce((current, key) => current?.[key], value);
}
export function extractImages(value) {
  if (!value) return [];
  if (typeof value === "string") return /^(https?:\/\/|data:image\/)/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(extractImages);
  if (typeof value === "object") {
    if (value.b64_json) return [`data:image/png;base64,${value.b64_json}`];
    if (value.url) return extractImages(value.url);
    if (value.image) return extractImages(value.image);
    return [];
  }
  return [];
}
export async function runCompatible(
  provider,
  key,
  job,
  source,
  mask,
  signal,
  transport = requestJson,
) {
  const base = provider.baseUrl.replace(/\/+$/, "");
  const editing = job.mode === "edit";
  const common = {
    ...(provider.extra || {}),
    model: provider.model,
    prompt: job.prompt,
    n: job.count,
  };
  let body,
    headers = key ? { Authorization: `Bearer ${key}` } : {};
  if (provider.type === "xai") {
    common.aspect_ratio = job.ratio;
    if (["1024", "2048"].includes(job.resolution))
      common.resolution = job.resolution === "2048" ? "2k" : "1k";
    if (editing)
      common.image = {
        url: `data:image/png;base64,${source.toString("base64")}`,
        type: "image_url",
      };
    body = Buffer.from(JSON.stringify(common));
    headers["Content-Type"] = "application/json";
  } else {
    common.size = `${job.width}x${job.height}`;
    if (editing) {
      const form = new FormData();
      for (const [key, value] of Object.entries(common))
        form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
      form.set("image", new Blob([source], { type: "image/png" }), "image.png");
      if (mask) form.set("mask", new Blob([mask], { type: "image/png" }), "mask.png");
      const req = new Request("http://localhost", { method: "POST", body: form });
      headers["Content-Type"] = req.headers.get("content-type");
      body = Buffer.from(await req.arrayBuffer());
    } else {
      body = Buffer.from(JSON.stringify(common));
      headers["Content-Type"] = "application/json";
    }
  }
  const data = await transport(`${base}/images/${editing ? "edits" : "generations"}`, {
    method: "POST",
    headers,
    body,
    signal,
  });
  const images = extractImages(data.data);
  if (!images.length) throw new Error("提供商未返回图片，请确认所选模型支持图片接口");
  return images.slice(0, job.count);
}
export async function runSpace(provider, key, job, source, mask, signal, connector = connectSpace) {
  const editing = job.mode === "edit";
  const endpoint = editing ? provider.editEndpoint : provider.endpoint;
  const template = editing ? provider.editTemplate : provider.template;
  if (!endpoint || !template) throw new Error("请先为此 Space 配置相应的端点和参数映射");
  const encodedInputs = Object.keys(template).filter((name) => encodedImageVariable(name));
  if ((encodedInputs.length || usesSourceImage(template)) && (!editing || !source))
    throw new Error(
      "此 Space 需要参考图片，请使用图片编辑模式并上传原图；不能以空图片列表进行文生图",
    );
  const client = await connector(provider, key);
  const imageOptions = { root: client.config?.root, apiPrefix: client.api_prefix };
  const outputPath =
    (editing ? provider.editOutputPath : provider.outputPath) ?? provider.outputPath ?? "0";
  let submission;
  const cancel = () => {
    try {
      submission?.cancel();
    } catch {}
  };
  signal.addEventListener("abort", cancel);
  let primaryError;
  try {
    const ratioFields = Object.entries(template).filter(
      ([, value]) => value === "{{aspect_ratio}}",
    );
    const api = ratioFields.length ? await readSpaceSchema(client, key, signal) : null;
    const results = [];
    for (let i = 0; i < job.count; i++) {
      signal.throwIfAborted();
      const context = {
        prompt: job.prompt,
        negative_prompt: job.negativePrompt,
        width: job.width,
        height: job.height,
        seed: job.seed + i,
        steps: job.steps,
        guidance: job.guidance,
        aspect_ratio: job.ratio,
        image_base64: source ? source.toString("base64") : null,
        image_data_uri: source ? `data:image/png;base64,${source.toString("base64")}` : null,
        images_b64_json: JSON.stringify(
          source ? [`data:image/png;base64,${source.toString("base64")}`] : [],
        ),
        image: source ? handle_file(new Blob([source], { type: "image/png" })) : null,
        mask: mask ? handle_file(new Blob([mask], { type: "image/png" })) : null,
      };
      const parameters = mapTemplate(template, context);
      for (const [name] of ratioFields) {
        const parameter = api?.named_endpoints?.[endpoint]?.parameters?.find(
          (p) => p.parameter_name === name,
        );
        if (parameter) parameters[name] = mapAspectRatio(job.ratio, parameter);
      }
      for (const name of encodedInputs)
        if (parameters[name] == null || parameters[name] === "" || parameters[name] === "[]")
          parameters[name] = context[encodedImageVariable(name)];
      submission = client.submit(endpoint, parameters);
      let output, selected;
      let images = [];
      for await (const message of submission) {
        signal.throwIfAborted();
        if (
          message.type === "status" &&
          (message.stage === "error" || (message.stage === "complete" && message.success === false))
        )
          throw new Error(gradioError(message));
        if (message.type === "data") {
          output = message.data;
          selected = selectGradioOutput(output, outputPath);
          const found = extractGradioImages(selected, imageOptions);
          if (found.length || !noChangeUpdate(selected)) images = found;
        }
      }
      if (!images.length)
        throw new Error(
          `Space ${endpoint} 未返回可读取的图片。读取路径 ${outputPath || "(全部)"}；返回结构：${outputShape(output)}；选中内容：${outputShape(selected)}。请检查端点是否执行成功及 API 返回格式`,
        );
      results.push({
        url: images[0],
        authOrigin: client.config?.root ? new URL(client.config.root).origin : "",
      });
    }
    return results;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    await closeGradioClient(client, { primaryError });
  }
}
