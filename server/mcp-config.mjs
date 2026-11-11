const aliases = {
  prompt: ["prompt", "text", "instruction", "instructions", "editprompt", "positiveprompt"],
  negative_prompt: ["negativeprompt", "negative"],
  width: ["width", "imagewidth"],
  height: ["height", "imageheight"],
  seed: ["seed", "randomseed"],
  steps: ["steps", "numinferencesteps", "numsteps"],
  guidance: ["guidance", "guidancescale", "cfgscale"],
  aspect_ratio: ["aspectratio", "ratio"],
  size: ["size", "imagesize"],
  image_data_uri: [
    "image",
    "imageurl",
    "inputimage",
    "inputimageurl",
    "sourceimage",
    "sourceimageurl",
    "imagedatauri",
    "images",
    "imageurls",
    "inputimages",
    "referenceimage",
    "referenceimages",
    "referenceimageurl",
  ],
  image_base64: ["imagebase64", "imageb64", "inputimagebase64"],
  mask: ["mask", "maskurl", "maskimage"],
};
export function suggestMcpTool(tool) {
  const properties = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  const template = {},
    missing = [],
    defaults = {};
  let hasPrompt = false,
    hasImage = false,
    imageRequired = false;
  for (const [name, schema] of Object.entries(properties)) {
    const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const variable = Object.keys(aliases).find((key) => aliases[key].includes(normalized));
    if (variable) {
      template[name] = schema.type === "array" ? [`{{${variable}}}`] : `{{${variable}}}`;
      if (["steps", "guidance"].includes(variable) && Number.isFinite(schema.default))
        defaults[variable] = schema.default;
      if (variable === "prompt") hasPrompt = true;
      if (["image_data_uri", "image_base64"].includes(variable)) {
        hasImage = true;
        imageRequired ||= required.has(name);
      }
    } else if (["n", "count", "numimages", "batchsize"].includes(normalized)) template[name] = 1;
    else if (Object.hasOwn(schema, "default")) template[name] = schema.default;
    else if (required.has(name)) {
      // Unknown required fields need a deliberate value, not a guessed model or file path.
      template[name] = null;
      missing.push(name);
    }
  }
  for (const name of required) if (!Object.hasOwn(properties, name)) missing.push(name);
  const canEdit = hasPrompt && hasImage;
  const canGenerate =
    hasPrompt &&
    !imageRequired &&
    /image|generat|render|draw|txt2img/i.test(tool.name) &&
    (!/edit|inpaint|img2img/i.test(tool.name) || /generat|txt2img/i.test(tool.name));
  return {
    name: tool.name,
    description: tool.description || "",
    inputSchema: tool.inputSchema || { type: "object", properties: {} },
    template,
    generateTemplate: Object.fromEntries(
      Object.entries(template).filter(
        ([, value]) =>
          !/\{\{(?:image|image_data_uri|image_base64|mask|mask_base64)\}\}/.test(
            JSON.stringify(value),
          ),
      ),
    ),
    defaults,
    missing,
    canGenerate,
    canEdit,
  };
}
