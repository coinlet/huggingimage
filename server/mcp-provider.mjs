import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { validateUrl } from "./network.mjs";
import { mapTemplate, atPath } from "./providers.mjs";
import { usesSourceImage } from "./gradio-images.mjs";
import { suggestMcpTool } from "./mcp-config.mjs";

export function mcpAuthHeaders(provider, key) {
  return key
    ? provider.mcpAuth === "x-api-key"
      ? { "X-API-Key": key }
      : { Authorization: `Bearer ${key}` }
    : {};
}

export async function connectMcp(provider, key, signal, fetchImpl = fetch) {
  const url = validateUrl(provider.baseUrl);
  const modes =
    provider.mcpTransport === "auto" || !provider.mcpTransport
      ? ["streamable-http", "sse"]
      : [provider.mcpTransport];
  for (let index = 0; index < modes.length; index++) {
    signal.throwIfAborted();
    const client = new Client({ name: "huggingimage", version: "1.0.0" }, { capabilities: {} });
    const scopedFetch = (input, init = {}) => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
      const target = new URL(input instanceof Request ? input.url : input);
      if (target.origin !== url.origin) {
        headers.delete("Authorization");
        headers.delete("X-API-Key");
      }
      const signals = [init.signal, signal].filter(Boolean);
      if (init.method === "DELETE") signals.push(AbortSignal.timeout(3000));
      return fetchImpl(input, { ...init, headers, signal: AbortSignal.any(signals) });
    };
    const options = { requestInit: { headers: mcpAuthHeaders(provider, key) }, fetch: scopedFetch };
    const transport =
      modes[index] === "sse"
        ? new SSEClientTransport(url, options)
        : new StreamableHTTPClientTransport(url, options);
    const abort = () => {
      void client.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    const close = async () => {
      signal.removeEventListener("abort", abort);
      try {
        if (!signal.aborted && transport.sessionId) await transport.terminateSession();
      } catch {
        /* Session cleanup must not replace an inference result. */
      }
      await client.close().catch(() => {});
    };
    try {
      await client.connect(transport, { signal, timeout: 30000 });
      return { client, close, transport: modes[index] };
    } catch (error) {
      await close();
      const fallback =
        [404, 405, 406, 415, 501].includes(error.code) ||
        /content.type|text\/event-stream/i.test(error.message);
      if (signal.aborted || index === modes.length - 1 || !fallback) throw error;
    }
  }
}

export async function inspectMcp(provider, key, connector = connectMcp) {
  const signal = AbortSignal.timeout(30000);
  const connection = await connector(provider, key, signal);
  try {
    const tools = [],
      cursors = new Set();
    let cursor;
    do {
      const page = await connection.client.listTools(cursor ? { cursor } : {}, {
        signal,
        timeout: 30000,
      });
      tools.push(...page.tools.map(suggestMcpTool));
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("MCP 工具列表分页异常");
      if (cursor) cursors.add(cursor);
      if (tools.length > 200) throw new Error("MCP 工具过多，请使用提供图片工具的专用服务");
    } while (cursor);
    const generate = tools.find((t) => t.canGenerate && !t.missing.length);
    const edit =
      tools.find((t) => t.canEdit && !t.missing.length && /edit|inpaint|img2img/i.test(t.name)) ||
      tools.find((t) => t.canEdit && !t.missing.length);
    return {
      transport: connection.transport,
      tools,
      endpoint: generate?.name || "",
      editEndpoint: edit?.name || "",
      template: generate?.generateTemplate || {},
      defaults: { generate: generate?.defaults || {}, edit: edit?.defaults || {} },
      editTemplate: edit?.template || {},
      supportsGenerate: Boolean(generate),
      supportsEdit: Boolean(edit),
    };
  } finally {
    await connection.close();
  }
}

export async function extractMcpImages(value, client, signal) {
  const images = new Set(),
    resources = new Set();
  let visited = 0;
  const add = (url) => {
    if (/^(https?:\/\/|data:image\/)/i.test(url)) images.add(url);
  };
  async function walk(item, depth = 0) {
    if (item == null || depth > 12 || ++visited > 2000) return;
    if (typeof item === "string") {
      const text = item.trim();
      if (/^(https?:\/\/[^\s]+|data:image\/[^\s]+)$/.test(text)) {
        add(text);
        return;
      }
      if (/^[\[{]/.test(text)) {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {}
        if (parsed !== undefined) {
          await walk(parsed, depth + 1);
          return;
        }
      }
      for (const match of text.matchAll(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g)) add(match[1]);
      if (/image|generated|download|图片|下载/i.test(text))
        for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g))
          add(match[0].replace(/[.,;]+$/, ""));
      return;
    }
    if (Array.isArray(item)) {
      for (const entry of item) await walk(entry, depth + 1);
      return;
    }
    if (typeof item !== "object") return;
    if (
      item.type === "image" &&
      typeof item.data === "string" &&
      item.mimeType?.startsWith("image/")
    ) {
      add(`data:${item.mimeType};base64,${item.data}`);
      return;
    }
    if (typeof item.blob === "string" && item.mimeType?.startsWith("image/")) {
      add(`data:${item.mimeType};base64,${item.blob}`);
      return;
    }
    if (item.type === "resource_link" && typeof item.uri === "string") {
      if (/^https?:\/\//.test(item.uri)) {
        add(item.uri);
        return;
      }
      if (resources.size >= 8 || resources.has(item.uri)) return;
      resources.add(item.uri);
      await walk(
        await client.readResource({ uri: item.uri }, { signal, timeout: 30000 }),
        depth + 1,
      );
      return;
    }
    for (const name of ["image_base64", "image_b64", "base64"])
      if (typeof item[name] === "string" && item[name]) {
        add(
          item[name].startsWith("data:image/")
            ? item[name]
            : `data:${item.mimeType || "image/png"};base64,${item[name]}`,
        );
        return;
      }
    if (item.b64_json) {
      add(`data:image/png;base64,${item.b64_json}`);
      return;
    }
    // URI/file paths are never treated as files on this application's host.
    for (const name of [
      "structuredContent",
      "content",
      "contents",
      "resource",
      "text",
      "data",
      "image",
      "images",
      "image_url",
      "imageUrl",
      "url",
      "urls",
      "result",
      "results",
      "output",
      "outputs",
      "artifacts",
    ])
      if (item[name] != null) await walk(item[name], depth + 1);
  }
  await walk(value);
  return [...images];
}

export async function runMcp(provider, key, job, source, mask, signal, connector = connectMcp) {
  const editing = job.mode === "edit";
  const tool = editing ? provider.editEndpoint : provider.endpoint;
  const template = editing ? provider.editTemplate : provider.template;
  if (!tool || !template) throw new Error("请配置 MCP 图片工具及参数模板");
  if (editing && !usesSourceImage(template))
    throw new Error(
      "MCP 编辑模板需包含 {{image}}、{{image_data_uri}} 或 {{image_base64}} 等参考图片变量",
    );
  if (usesSourceImage(template) && !source)
    throw new Error("此 MCP 工具需要参考图片，请使用图片编辑模式");
  const connection = await connector(provider, key, signal);
  try {
    const images = [];
    for (let index = 0; index < job.count; index++) {
      signal.throwIfAborted();
      const image = source ? `data:image/png;base64,${source.toString("base64")}` : null;
      const context = {
        prompt: job.prompt,
        negative_prompt: job.negativePrompt,
        width: job.width,
        height: job.height,
        size: `${job.width}x${job.height}`,
        seed: job.seed + index,
        steps: job.steps,
        guidance: job.guidance,
        aspect_ratio: job.ratio,
        model: provider.model,
        count: 1,
        image,
        image_data_uri: image,
        image_base64: source?.toString("base64") || null,
        images_b64_json: JSON.stringify(image ? [image] : []),
        mask: mask ? `data:image/png;base64,${mask.toString("base64")}` : null,
        mask_base64: mask?.toString("base64") || null,
      };
      const parameters = mapTemplate(template, context);
      for (const name of Object.keys(parameters))
        if (!mask && /\{\{(?:mask|mask_base64)\}\}/.test(JSON.stringify(template[name])))
          delete parameters[name];
      const result = await connection.client.callTool(
        { name: tool, arguments: parameters },
        undefined,
        { signal, timeout: 600000 },
      );
      if (result.isError)
        throw new Error(
          `MCP 工具失败：${
            result.content
              ?.filter((c) => c.type === "text")
              .map((c) => c.text)
              .join(" ")
              .slice(0, 500) || tool
          }`,
        );
      const outputPath = (editing ? provider.editOutputPath : provider.outputPath) || "";
      const selected = outputPath ? atPath(result, outputPath) : result;
      if (selected === undefined)
        throw new Error(`MCP 输出路径 ${outputPath} 不存在，请检查工具返回结构`);
      const found = await extractMcpImages(selected, connection.client, signal);
      if (!found.length)
        throw new Error(
          "MCP 工具未返回可读取的图片；请检查输出路径，工具需返回图片、图片 URL 或 MCP 图片资源，不能仅返回任务 ID 或远程文件路径",
        );
      images.push({ url: found[0], authOrigin: new URL(provider.baseUrl).origin });
    }
    return images;
  } finally {
    await connection.close();
  }
}
