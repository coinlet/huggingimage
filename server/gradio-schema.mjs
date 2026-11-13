// view_api() simplifies JSON Schema types to JavaScript strings, losing enums.
// Keep the original definition for discovery and constrained parameter mapping.
export async function readSpaceSchema(client, key, signal) {
  if (!client.config?.root || typeof client.fetch !== "function") return client.view_api();
  const root = client.config.root.replace(/\/+$/, "");
  const prefix = (client.api_prefix || "").replace(/^\/+|\/+$/g, "");
  const url = `${root}/${prefix ? `${prefix}/` : ""}info`;
  const response = await client.fetch(url, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal,
  });
  if (!response.ok) throw new Error(`读取 Space API 定义失败（HTTP ${response.status}）`);
  const body = await response.json();
  const api = body.api || body;
  if (!api.named_endpoints || typeof api.named_endpoints !== "object")
    throw new Error("Space 未提供可读取的 Gradio API 定义");
  return api;
}

export function parameterChoices(parameter) {
  const schema = parameter.type;
  if (!schema || typeof schema !== "object") return [];
  return (
    schema.enum ||
    schema.anyOf?.filter((item) => Object.hasOwn(item, "const")).map((item) => item.const) ||
    []
  );
}

export function mapAspectRatio(ratio, parameter) {
  const choices = parameterChoices(parameter);
  if (!choices.length || choices.includes(ratio)) return ratio;
  const match = choices.find(
    (choice) =>
      typeof choice === "string" &&
      choice.match(/\b\d+\s*:\s*\d+\b/)?.[0].replace(/\s/g, "") === ratio,
  );
  if (match) return match;
  throw new Error(`此 Space 不支持比例 ${ratio}，可选：${choices.join("、")}`);
}

// Recognize this API family by its contract, not by its Space owner or URL.
export function isQwenAioEndpoint(info) {
  const params = info?.parameters || [];
  const names = new Set(params.map((p) => p.parameter_name));
  const modes = parameterChoices(params.find((p) => p.parameter_name === "mode") || {});
  return (
    modes.includes("Text to Image") &&
    modes.includes("Edit Image (1 Ref)") &&
    ["ref_image_1", "ref_image_2", "multi_refs", "lora_1", "enhance_mode", "pe_api_key"].every(
      (name) => names.has(name),
    )
  );
}
