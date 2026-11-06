import { variables } from "./providers.mjs";
import { encodedImageVariable, usesSourceImage } from "./gradio-images.mjs";

const normalized = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
const secretName = /(?:api.?key|token|password|secret|credential|authorization)/i;
const roles = {
  aspect_ratio: ["aspectratio", "outputratio", "画面比例"],
  negative_prompt: ["negativeprompt", "negative", "negprompt", "反向提示词", "负面提示词"],
  prompt: [
    "prompt",
    "positiveprompt",
    "textprompt",
    "inputprompt",
    "instruction",
    "instructions",
    "editinstruction",
    "editprompt",
    "description",
    "caption",
    "text",
    "提示词",
    "提示",
    "编辑指令",
  ],
  seed: ["seed", "randomseed", "随机种子"],
  width: ["width", "imagewidth", "outputwidth", "宽度"],
  height: ["height", "imageheight", "outputheight", "高度"],
  steps: ["numinferencesteps", "inferencesteps", "numsteps", "steps", "samplingsteps", "推理步数"],
  guidance: [
    "guidancescale",
    "trueguidancescale",
    "truecfgscale",
    "cfgscale",
    "guidance",
    "cfg",
    "引导系数",
  ],
};
function role(parameter) {
  for (const name of [parameter.parameter_name, parameter.label]) {
    const n = normalized(name);
    for (const [key, names] of Object.entries(roles)) if (names.includes(n)) return key;
  }
  return null;
}
function isImage(parameter) {
  const component = normalized(parameter.component);
  return (
    encodedImageVariable(parameter.parameter_name) ||
    ["image", "imageeditor", "imageupload", "gallery", "multimage"].includes(component) ||
    (component === "file" &&
      /image|photo|picture|图片|照片/i.test(`${parameter.parameter_name} ${parameter.label}`)) ||
    /ImageData|ImageEditorData|GalleryData/i.test(JSON.stringify(parameter.type || ""))
  );
}
function imageValue(parameter, placeholder) {
  const encoded = encodedImageVariable(parameter.parameter_name);
  if (encoded) return `{{${encoded}}}`;
  if (/imageeditor/i.test(parameter.component || ""))
    return { background: placeholder, layers: [], composite: placeholder };
  if (/gallery/i.test(parameter.component || "")) return [{ image: placeholder, caption: null }];
  const type = parameter.type;
  if (
    (typeof type === "object" && type?.type === "array") ||
    (typeof type === "string" && /\[\]|array|list</i.test(type))
  )
    return [placeholder];
  return placeholder;
}
function isImageOutput(parameter) {
  return (
    /^(image|gallery|imageeditor)$/i.test(parameter.component || "") ||
    /ImageData|GalleryData/i.test(JSON.stringify(parameter.type || "")) ||
    Boolean(parameter.type?.properties?.image || parameter.type?.properties?.images)
  );
}
function nullable(parameter) {
  return (
    /\bnull\b/.test(JSON.stringify(parameter.type || "")) ||
    /None/.test(parameter.python_type?.type || "")
  );
}
function choices(parameter) {
  const schema = parameter.type;
  if (!schema || typeof schema !== "object") return [];
  return (
    schema.enum ||
    schema.anyOf?.filter((item) => Object.hasOwn(item, "const")).map((item) => item.const) ||
    []
  );
}
function describeBounds(parameter) {
  const description = `${parameter.description || ""} ${parameter.type?.description || ""}`;
  const bounds = description.match(/between\s+(-?[\d.]+)\s+and\s+(-?[\d.]+)/i);
  return bounds ? { min: Number(bounds[1]), max: Number(bounds[2]) } : {};
}
function includesVariable(value, name) {
  return JSON.stringify(value).includes(`{{${name}}}`);
}

export function spaceCandidates(api) {
  if (!api || typeof api.named_endpoints !== "object" || !api.named_endpoints)
    throw new Error("Space 未提供可读取的 Gradio API 定义");
  const entries = Object.entries(api.named_endpoints);
  if (entries.length > 200) throw new Error("Space 端点过多，请手动选择需要的端点");
  return entries
    .filter(
      ([endpoint, info]) =>
        endpoint.startsWith("/") && Array.isArray(info?.parameters) && Array.isArray(info?.returns),
    )
    .map(([endpoint, info]) => {
      const template = {},
        missing = [],
        warnings = [],
        defaults = {};
      let promptCount = 0,
        imageCount = 0,
        optionalImageCount = 0;
      for (const parameter of info.parameters) {
        const name = parameter.parameter_name;
        if (
          typeof name !== "string" ||
          !name ||
          ["__proto__", "constructor", "prototype"].includes(name)
        ) {
          missing.push("无法识别的参数名");
          continue;
        }
        if (secretName.test(name)) {
          if (!parameter.parameter_has_default) missing.push(name);
          warnings.push(`参数 ${name} 涉及凭据，未自动填写`);
          continue;
        }
        const mapped = role(parameter);
        if (mapped) {
          template[name] = `{{${mapped}}}`;
          if (mapped === "prompt") promptCount++;
          if (
            ["steps", "guidance"].includes(mapped) &&
            Number.isFinite(parameter.parameter_default)
          )
            defaults[mapped] = parameter.parameter_default;
          const bounds = describeBounds(parameter);
          if (bounds.min != null)
            warnings.push(`${name} 允许 ${bounds.min}–${bounds.max}，创作参数请保持在此范围`);
        } else if (isImage(parameter)) {
          const mask = /mask|蒙版|遮罩/i.test(`${name} ${parameter.label}`);
          if (mask) template[name] = imageValue(parameter, "{{mask}}");
          else if (imageCount === 0) {
            template[name] = imageValue(parameter, "{{image}}");
            imageCount++;
            if (
              !encodedImageVariable(parameter.parameter_name) &&
              parameter.parameter_has_default &&
              parameter.parameter_default == null
            )
              optionalImageCount++;
          } else if (parameter.parameter_has_default) template[name] = parameter.parameter_default;
          else {
            missing.push(name);
            warnings.push(`端点 ${endpoint} 需要多张参考图；当前工作台仅提供一张`);
          }
        } else if (["randomizeseed", "randomseed", "randomize"].includes(normalized(name)))
          template[name] = false;
        else if (
          ["numimages", "numimagesperprompt", "batchsize", "numberofimages", "nimages"].includes(
            normalized(name),
          )
        )
          template[name] = 1;
        else if (parameter.parameter_has_default && parameter.parameter_default !== undefined)
          template[name] = parameter.parameter_default;
        else if (choices(parameter).length === 1) template[name] = choices(parameter)[0];
        else if (nullable(parameter)) template[name] = null;
        else missing.push(name);
      }
      let outputIndex = info.returns.findIndex(isImageOutput);
      if (
        outputIndex < 0 &&
        info.parameters.some((p) => encodedImageVariable(p.parameter_name)) &&
        /infer|predict|edit/i.test(endpoint)
      ) {
        outputIndex = info.returns.findIndex((p) => /^json$/i.test(p.component || ""));
        if (outputIndex >= 0)
          warnings.push("此端点通过 JSON 返回结果，将从 image、images、result 等字段提取图片。");
      }
      const hasOutput = outputIndex >= 0;
      if (info.oauth_token === "required")
        missing.push("Space 要求额外 OAuth 授权，HF 访问 Token 不会自动作为 OAuth 凭据传入");
      let generateTemplate = null;
      if (imageCount === 0) generateTemplate = { ...template };
      else if (imageCount === optionalImageCount) {
        warnings.push("此端点的图片输入可选，已推测支持无参考图生成，实际能力仍需模型验证。");
        generateTemplate = Object.fromEntries(
          Object.entries(template).map(([key, value]) => [
            key,
            usesSourceImage(value) ? null : value,
          ]),
        );
      }
      const score =
        100 + (/infer|predict|generate|edit/i.test(endpoint) ? 15 : 0) - missing.length * 30;
      return {
        endpoint,
        template,
        generateTemplate,
        parameters: info.parameters,
        outputPath: hasOutput ? String(outputIndex) : "",
        promptCount,
        imageCount,
        hasOutput,
        missing,
        warnings,
        defaults,
        score,
      };
    });
}

function assemble(space, candidates, selected, source = "schema", moreWarnings = []) {
  const generation = selected.generate,
    editing = selected.edit;
  const warnings = [...moreWarnings];
  for (const candidate of [generation, editing])
    if (candidate)
      warnings.push(
        ...candidate.warnings,
        ...candidate.missing.map((name) => `${candidate.endpoint} 必填参数尚待配置：${name}`),
      );
  const available = candidates.filter((c) => c.hasOutput && c.promptCount > 0);
  if (!generation && !editing) {
    warnings.push("未能可靠识别可调用的图片端点，请展开高级配置核对 API。");
    for (const candidate of available)
      warnings.push(
        ...candidate.missing.map((name) => `${candidate.endpoint} 必填参数尚待配置：${name}`),
      );
  }
  const capabilities = { generate: Boolean(generation), edit: Boolean(editing) };
  const ready =
    Boolean(generation || editing) &&
    [generation, editing].filter(Boolean).every((c) => !c.missing.length);
  return {
    source,
    ready,
    name: space.startsWith("https://")
      ? new URL(space).hostname.split(".")[0]
      : space.split("/").at(-1),
    space,
    supportsGenerate: capabilities.generate,
    supportsEdit: capabilities.edit,
    endpoint: generation?.endpoint || "",
    template: generation?.generateTemplate || generation?.template || {},
    editEndpoint: editing?.endpoint || "",
    editTemplate: editing?.template || {},
    outputPath: generation?.outputPath || "0",
    editOutputPath: editing?.outputPath || "0",
    defaults: { generate: generation?.defaults || {}, edit: editing?.defaults || {} },
    warnings: [...new Set(warnings)],
    candidates: available.map((c) => ({
      endpoint: c.endpoint,
      canGenerate: Boolean(c.generateTemplate),
      canEdit: c.imageCount > 0,
      outputPath: c.outputPath,
      missing: c.missing,
      template: c.template,
    })),
  };
}

export function analyzeSpaceApi(api, space) {
  const candidates = spaceCandidates(api).filter((c) => c.hasOutput && c.promptCount > 0);
  const ranked = [...candidates].sort(
    (a, b) =>
      a.missing.length - b.missing.length ||
      b.score - a.score ||
      a.endpoint.localeCompare(b.endpoint),
  );
  const generators = ranked.filter((c) => c.generateTemplate),
    editors = ranked.filter((c) => c.imageCount > 0);
  const warnings = [];
  if (generators.length > 1)
    warnings.push(
      `发现 ${generators.length} 个生成端点，已优先选择 ${generators[0].endpoint}，可在高级配置中切换。`,
    );
  if (editors.length > 1)
    warnings.push(
      `发现 ${editors.length} 个编辑端点，已优先选择 ${editors[0].endpoint}，可在高级配置中切换。`,
    );
  return assemble(
    space,
    candidates,
    { generate: generators[0], edit: editors[0] },
    "schema",
    warnings,
  );
}

// A language model may interpret unusual parameter names, but it cannot invent
// endpoints, output locations, credentials, or unadvertised input fields.
export function applyAiConfiguration(api, space, suggestion) {
  const candidates = spaceCandidates(api);
  function validate(selection, mode) {
    if (selection == null) return undefined;
    const original = candidates.find((c) => c.endpoint === selection.endpoint && c.hasOutput);
    if (
      !original ||
      !selection.template ||
      Array.isArray(selection.template) ||
      typeof selection.template !== "object"
    )
      throw new Error("AI 返回了不存在的端点或无效参数模板");
    const parameterNames = new Set(original.parameters.map((p) => p.parameter_name));
    const template = selection.template;
    if (
      Object.keys(template).some(
        (key) =>
          !parameterNames.has(key) ||
          secretName.test(key) ||
          ["__proto__", "constructor", "prototype"].includes(key),
      )
    )
      throw new Error("AI 返回了未声明参数或凭据参数");
    const serialized = JSON.stringify(template);
    if (serialized.replace(/\{\{\w+\}\}/g, "").includes("{{"))
      throw new Error("AI 返回了无效占位符");
    for (const match of serialized.matchAll(/\{\{(.*?)\}\}/g))
      if (!variables.includes(match[1])) throw new Error("AI 返回了未知占位符");
    if (
      !includesVariable(template, "prompt") ||
      (mode === "edit" && !usesSourceImage(template)) ||
      (mode === "generate" &&
        (usesSourceImage(template) ||
          original.parameters.some((p) => encodedImageVariable(p.parameter_name))))
    )
      throw new Error("AI 返回的参数模板缺少必要的提示词或图片映射");
    const missing = original.parameters
      .filter((p) => !p.parameter_has_default && !Object.hasOwn(template, p.parameter_name))
      .map((p) => p.parameter_name);
    if (
      mode === "edit" &&
      original.parameters.filter(
        (p) => isImage(p) && !/mask/i.test(p.parameter_name) && !p.parameter_has_default,
      ).length > 1
    )
      missing.push("该端点需要多张参考图，当前工作台仅提供一张");
    for (const parameter of original.parameters) {
      const value = template[parameter.parameter_name];
      if (value === undefined) continue;
      if (JSON.stringify(value).includes("{{")) {
        const encoded = encodedImageVariable(parameter.parameter_name);
        if (encoded && value !== `{{${encoded}}}`)
          throw new Error("AI 返回的 Base64 图片编码与参数要求不匹配");
        if (usesSourceImage(value) && !isImage(parameter))
          throw new Error("AI 将图片映射到了不支持文件的参数");
        const type = typeof parameter.type === "object" ? parameter.type?.type : parameter.type;
        if (
          /^(number|integer|float|int)$/.test(type || "") &&
          (typeof value !== "string" || !/^\{\{(seed|width|height|steps|guidance)\}\}$/.test(value))
        )
          throw new Error("AI 为数字参数返回了不兼容的占位符");
        continue;
      }
      const allowed = choices(parameter);
      if (allowed.length && !allowed.includes(value))
        throw new Error(`AI 为 ${parameter.parameter_name} 返回了不支持的选项`);
      const declaredDefault =
        parameter.parameter_has_default &&
        JSON.stringify(value) === JSON.stringify(parameter.parameter_default);
      const special =
        (["randomizeseed", "randomize"].includes(normalized(parameter.parameter_name)) &&
          value === false) ||
        (["numimages", "numimagesperprompt", "batchsize", "numberofimages", "nimages"].includes(
          normalized(parameter.parameter_name),
        ) &&
          value === 1);
      if (
        !declaredDefault &&
        !allowed.includes(value) &&
        !special &&
        !(nullable(parameter) && value === null)
      )
        throw new Error(`AI 为 ${parameter.parameter_name} 提供了 API 未声明的固定值`);
    }
    if (original.missing.some((item) => String(item).includes("OAuth")))
      missing.push("Space 要求额外 OAuth 授权");
    return {
      ...original,
      template,
      generateTemplate: mode === "generate" ? template : null,
      missing,
      promptCount: 1,
      imageCount: mode === "edit" ? 1 : 0,
    };
  }
  return assemble(
    space,
    candidates,
    {
      generate: validate(suggestion.generate, "generate"),
      edit: validate(suggestion.edit, "edit"),
    },
    "ai",
  );
}

export function aiSchema(api) {
  const result = {
    named_endpoints: Object.fromEntries(
      Object.entries(api.named_endpoints || {}).map(([endpoint, info]) => [
        endpoint,
        {
          parameters: info.parameters?.map((p) => ({
            parameter_name: p.parameter_name,
            label: p.label,
            component: p.component,
            type: p.type,
            parameter_has_default: p.parameter_has_default,
            ...(!secretName.test(p.parameter_name)
              ? { parameter_default: p.parameter_default }
              : {}),
          })),
          returns: info.returns?.map((p) => ({ component: p.component, type: p.type })),
          oauth_token: info.oauth_token,
        },
      ]),
    ),
  };
  return JSON.parse(JSON.stringify(result).replace(/(?:hf_|sk-)[A-Za-z0-9_-]+/g, "[redacted]"));
}
