import http from "node:http";
import https from "node:https";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";

export function validateUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("请输入有效的 HTTP(S) 地址");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
    throw new Error("地址仅允许 HTTP(S)，且不能包含用户名或密码");
  return url;
}
// Bodies are already buffered. Send their exact length so multipart uploads do not
// unnecessarily use chunked transfer through API gateways.
export function buildRequestHeaders(headers = {}, body) {
  const result = new Headers(headers);
  if (!result.has("accept")) result.set("accept", "*/*");
  if (!result.has("accept-encoding")) result.set("accept-encoding", "identity");
  if (body != null) {
    result.set("content-length", String(Buffer.byteLength(body)));
    result.delete("transfer-encoding");
  }
  return Object.fromEntries(result);
}

// Use Node's default networking and the host environment to fetch resources.
export async function requestBytes(value, options = {}, redirects = 0) {
  const {
    signal,
    method = "GET",
    headers = {},
    body,
    maxBytes = 32 * 1024 * 1024,
    timeout = 180000,
  } = options;
  const url = validateUrl(value);
  const response = await new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method,
        headers: buildRequestHeaders(headers, body),
        signal,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy(new Error("响应超过 32MB 限制"));
          } else chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error("提供商响应超时，请稍后重试")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
    if (redirects >= 4) throw new Error("上游重定向过多");
    if (method !== "GET") throw new Error("API 地址发生重定向，请填写最终 API 地址");
    const target = new URL(response.headers.location, url);
    const nextHeaders = { ...headers };
    if (target.origin !== url.origin) {
      for (const name of Object.keys(nextHeaders))
        if (["authorization", "x-api-key", "api-key"].includes(name.toLowerCase()))
          delete nextHeaders[name];
    }
    return requestBytes(target.href, { ...options, headers: nextHeaders }, redirects + 1);
  }
  return response;
}
function redactDiagnostic(value, options = {}) {
  let text = String(value);
  const authorization = new Headers(options.headers).get("authorization");
  if (authorization) {
    text = text.split(authorization).join("[已隐藏]");
    const token = authorization.replace(/^Bearer\s+/i, "");
    if (token) text = text.split(token).join("[已隐藏]");
  }
  return text
    .replace(/Bearer\s+[^\s<>"']+/gi, "Bearer [已隐藏]")
    .replace(/(?:sk-|hf_)[A-Za-z0-9_-]+/g, "[已隐藏]")
    .replace(/data:image\/[^\s<>"']+/gi, "[图片数据已隐藏]")
    .replace(/[A-Za-z0-9+/=_-]{120,}/g, "[长数据已隐藏]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function diagnosticContext(url, result, options) {
  const target = new URL(url);
  // Exclude query strings and credentials from diagnostics.
  const endpoint = `${options.method || "GET"} ${target.origin}${target.pathname}`;
  const type = String(result.headers?.["content-type"] || "未提供 Content-Type").split(";")[0];
  const trace =
    result.headers?.["eo-log-uuid"] ||
    result.headers?.["x-oneapi-request-id"] ||
    result.headers?.["cf-ray"];
  return `${endpoint}；响应类型：${type}${trace ? `；请求标识：${String(trace).slice(0, 90)}` : ""}`;
}

export function parseJsonResponse(result, url, options = {}) {
  const failed = result.status < 200 || result.status >= 300;
  const edgeOne = Boolean(result.headers?.["eo-log-uuid"] || result.headers?.["eo-cache-status"]);
  // These codes are EdgeOne-specific only when the response carries its markers.
  const edgeTimeout = edgeOne && [524, 554].includes(result.status);
  const context = diagnosticContext(url, result, options);
  const timeoutHint = edgeTimeout
    ? "EdgeOne 回源等待超时。图片生成/编辑可能尚未完成；请在提供商域名的 EdgeOne 配置中提高 HTTP 应答超时，或使用提供商提供的不经该 CDN 的 API 地址。增加本应用等待时间无法改变 CDN 超时。"
    : "";
  let bytes = result.bytes;
  let text;
  try {
    const encoding = String(result.headers?.["content-encoding"] || "").toLowerCase();
    const decompress = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[
      encoding
    ];
    if (decompress) bytes = decompress(bytes, { maxOutputLength: 32 * 1024 * 1024 });
    text = bytes.toString("utf8").replace(/^\uFEFF/, "");
  } catch {
    throw new Error(
      redactDiagnostic(
        `提供商 HTTP ${result.status}：${timeoutHint}响应解压失败；${context}`,
        options,
      ),
    );
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Prefer the HTML page title, not scripts or an echoed request body.
    const title =
      text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
      text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    const summary = (
      title ||
      text
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    ).replace(/<[^>]*>/g, " ");
    const safeSummary = redactDiagnostic(summary.slice(0, 4000), options).slice(0, 150);
    const hint =
      timeoutHint ||
      (result.status === 554
        ? "上游返回非标准状态码，请根据响应摘要检查提供商网关或 CDN。"
        : result.status === 413
          ? "图片上传被上游大小限制拒绝。"
          : "请检查上游 API 或网关响应。");
    throw new Error(
      redactDiagnostic(
        `提供商 HTTP ${result.status}：${hint}非 JSON 响应${safeSummary ? `（${safeSummary}）` : "（空响应）"}；${context}`,
        options,
      ),
    );
  }
  if (failed) {
    const detail =
      data?.error?.message ||
      (typeof data?.error === "string" ? data.error : null) ||
      data?.detail ||
      data?.message ||
      "请求失败";
    const safeDetail = redactDiagnostic(
      typeof detail === "string" ? detail : JSON.stringify(detail),
      options,
    ).slice(0, 200);
    throw new Error(
      redactDiagnostic(
        `提供商 HTTP ${result.status}：${timeoutHint}${safeDetail}；${context}`,
        options,
      ),
    );
  }
  if (!data || typeof data !== "object")
    throw new Error(`提供商未返回有效的 JSON 对象；${context}`);
  return data;
}

export async function requestJson(url, options = {}) {
  const headers = new Headers(options.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const requestOptions = { ...options, headers: Object.fromEntries(headers) };
  return parseJsonResponse(await requestBytes(url, requestOptions), url, requestOptions);
}
