export function referenceSupport(provider) {
  const template = JSON.stringify(provider?.editTemplate || {});
  if (provider?.type !== "gradio" || !provider.supportsEdit) return { max: 1, swap: false };
  return {
    max: /\{\{(?:images|gallery_images|images_b64_json)\}\}/.test(template)
      ? 6
      : /\{\{image2\}\}/.test(template)
        ? 2
        : 1,
    swap: template.includes("{{edit_mode}}") && template.includes("{{image2}}"),
  };
}

export function validateReferences(provider, sourceId, ids = [], mode = "reference") {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id) || ids.length > 5)
    throw new Error("附加参考图必须为图片标识数组，最多 5 张");
  const all = [sourceId, ...ids];
  if (new Set(all).size !== all.length) throw new Error("参考图片不能重复");
  const support = referenceSupport(provider);
  if (all.length > support.max)
    throw new Error(`当前提供商最多支持 ${support.max} 张参考图，请调整图片或重新读取 Space 配置`);
  if (
    provider?.type === "gradio" &&
    JSON.stringify(provider.editTemplate).includes("{{image2}}") &&
    !JSON.stringify(provider.editTemplate).includes("{{edit_mode}}") &&
    all.length !== 2
  )
    throw new Error("当前提供商的模板需要恰好两张参考图");
  if (!["reference", "swap"].includes(mode)) throw new Error("未知的多图编辑模式");
  if (mode === "swap" && (!support.swap || all.length !== 2))
    throw new Error("变换与合成模式需要支持此功能的提供商和恰好两张参考图");
  return all;
}
