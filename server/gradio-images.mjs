// Some custom Gradio UIs hide image inputs in text fields instead of Image components.
export function encodedImageVariable(name) {
  const normalized = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (
    ["imagesb64json", "imagesbase64json", "inputimagesb64json", "imageb64json"].includes(normalized)
  )
    return "images_b64_json";
  if (["imagebase64", "imageb64", "inputimagebase64", "inputimageb64"].includes(normalized))
    return "image_base64";
  if (["imagedatauri", "inputimagedatauri"].includes(normalized)) return "image_data_uri";
  return null;
}
export function usesSourceImage(value) {
  return /\{\{(?:image|image2|images|gallery_images|image_base64|image_data_uri|images_b64_json)\}\}/.test(
    JSON.stringify(value),
  );
}
function emptyInput(value) {
  return value == null || value === "" || value === "[]";
}

// Repair only the legacy misclassification this application made for edit Spaces.
// Keep custom templates and existing edit connections untouched.
export function repairEncodedEditProvider(provider) {
  if (
    provider.type !== "gradio" ||
    !/edit/i.test(provider.space || "") ||
    !provider.endpoint ||
    provider.editEndpoint ||
    provider.supportsEdit ||
    !provider.template ||
    Array.isArray(provider.template)
  )
    return false;
  const encoded = Object.entries(provider.template).filter(([name]) => encodedImageVariable(name));
  if (!encoded.length || encoded.some(([, value]) => !emptyInput(value) && !usesSourceImage(value)))
    return false;
  const template = { ...provider.template };
  for (const [name] of encoded) template[name] = `{{${encodedImageVariable(name)}}}`;
  provider.supportsGenerate = false;
  provider.supportsEdit = true;
  provider.editEndpoint = provider.endpoint;
  provider.editTemplate = template;
  provider.editOutputPath = provider.outputPath ?? "0";
  provider.endpoint = "";
  provider.template = {};
  provider.defaults = {
    ...provider.defaults,
    edit:
      provider.defaults?.edit && Object.keys(provider.defaults.edit).length
        ? provider.defaults.edit
        : provider.defaults?.generate || {},
  };
  return true;
}

function spaceRoot(root) {
  if (!root) return null;
  try {
    const url = new URL(root);
    return url.protocol === "https:" &&
      url.hostname.endsWith(".hf.space") &&
      !url.username &&
      !url.password &&
      !url.port
      ? url
      : null;
  } catch {
    return null;
  }
}
function fileUrl(path, options) {
  const root = spaceRoot(options.root);
  if (!root || typeof path !== "string" || !path || path.includes("\0")) return null;
  const prefix = options.apiPrefix ?? "/gradio_api";
  const base = root.href.replace(/\/+$/, "");
  return `${base}${prefix ? "/" + prefix.replace(/^\/+|\/+$/g, "") : ""}/file=${encodeURIComponent(path)}`;
}
function imageUrl(value, options) {
  if (/^(https?:\/\/|data:image\/)/i.test(value)) return value;
  const root = spaceRoot(options.root);
  if (root && /^(?:\/?(?:gradio_api\/)?file=|\/gradio_api\/file=)/.test(value))
    return new URL(value, root.href.endsWith("/") ? root.href : root.href + "/").href;
  return null;
}
export function extractGradioImages(value, options = {}, depth = 0) {
  if (value == null || depth > 12) return [];
  if (typeof value === "string") {
    const url = imageUrl(value, options);
    if (url) return [url];
    if (value.length < 32 * 1024 * 1024 && /^[\s]*[\[{]/.test(value)) {
      try {
        return extractGradioImages(JSON.parse(value), options, depth + 1);
      } catch {}
    }
    return [];
  }
  if (Array.isArray(value))
    return value.flatMap((item) => extractGradioImages(item, options, depth + 1));
  if (typeof value !== "object") return [];
  if (value.mime_type && !String(value.mime_type).startsWith("image/")) return [];
  for (const key of ["b64_json", "image_base64", "image_b64", "base64"]) {
    if (typeof value[key] === "string" && value[key]) {
      const data = value[key];
      return [/^data:image\//i.test(data) ? data : `data:image/png;base64,${data}`];
    }
  }
  if (typeof value.url === "string" && value.url) {
    const direct = imageUrl(value.url, options);
    if (direct) return [direct];
  }
  // Resolve server paths only through the connected Space's download API.
  // Never access a returned path on this application's filesystem.
  if (
    typeof value.path === "string" &&
    (value.meta?._type === "gradio.FileData" ||
      Object.hasOwn(value, "url") ||
      value.orig_name ||
      value.mime_type ||
      /\.(?:png|jpe?g|webp|gif|avif)$/i.test(value.path))
  ) {
    const direct = fileUrl(value.path, options);
    if (direct) return [direct];
  }
  const result = [];
  for (const key of [
    "image",
    "images",
    "result",
    "results",
    "output",
    "outputs",
    "data",
    "value",
    "gallery",
    "composite",
  ]) {
    if (Object.hasOwn(value, key))
      result.push(...extractGradioImages(value[key], options, depth + 1));
  }
  return [...new Set(result)];
}
export function selectGradioOutput(output, path) {
  if (!path?.trim()) return output;
  // Gradio Server endpoints can return an object directly rather than a tuple.
  if (
    path === "0" &&
    output &&
    !Array.isArray(output) &&
    typeof output === "object" &&
    !Object.hasOwn(output, "0")
  )
    return output;
  return path.split(".").reduce((current, key) => current?.[key], output);
}
export function outputShape(value, depth = 0) {
  if (value === null) return "null";
  if (value === undefined) return "undefined（无此字段或未收到数据）";
  if (typeof value === "string") return `字符串(${value.length}字符)`;
  if (Array.isArray(value))
    return depth >= 2
      ? `数组(${value.length}项)`
      : `数组[${value
          .slice(0, 5)
          .map((item) => outputShape(item, depth + 1))
          .join(", ")}]`;
  if (typeof value === "object")
    return `对象{${Object.keys(value)
      .slice(0, 10)
      .map((key) => (/^[a-z_][a-z0-9_]{0,40}$/i.test(key) ? key : "其他字段"))
      .join(", ")}}`;
  return typeof value;
}
export function noChangeUpdate(value) {
  return (
    value &&
    typeof value === "object" &&
    value.__type__ === "update" &&
    !Object.hasOwn(value, "value")
  );
}
export function gradioError(message) {
  const error = message?.message;
  if (typeof error === "string" && error.trim()) return error;
  if (Array.isArray(error))
    return (
      error
        .map((e) => (typeof e === "string" ? e : e?.msg || e?.message || ""))
        .filter(Boolean)
        .join("; ") || "Space 推理失败"
    );
  return "Space 推理失败，请检查输入图片、GPU 配额或 Space 日志";
}
