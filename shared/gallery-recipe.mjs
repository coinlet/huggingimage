// Adapted from ai-pose-gallery-zh, Copyright (c) 2026 Anhao (MIT).
// Full license and asset scope: server/reference-data/LICENSE-upstream.txt
export const STYLE_PRESETS = {
  none: {
    label: "无预设（跟随参考图）",
    prompt: "",
  },
  realistic: {
    label: "写实人像写真",
    prompt:
      "写实商业摄影级质感，85mm 人像镜头，自然柔和光影，真实肌肤纹理与织物细节，8k 高清画质。",
  },
  fashion: {
    label: "日韩杂志画报",
    prompt: "日韩时尚穿搭杂志画报风格，干净极简摄影棚背景，高级色调，突出人物颜值与服装剪裁。",
  },
  film: {
    label: "复古胶片写真",
    prompt: "35mm 富士胶片摄影质感，轻微胶片颗粒，柔和复古暖调，自然街拍光影与电影呼吸感。",
  },
  semi_real: {
    label: "2.5D 游戏原画立绘",
    prompt: "2.5D 半写实高精度游戏角色原画，唯美厚涂光影，精致五官与华丽布料金属质感。",
  },
  anime: {
    label: "日系二次元插画",
    prompt: "日系精致二次元插画风格，细腻赛璐璐与厚涂光影过渡，动漫角色立绘质感，色彩通透干净。",
  },
  cel_anime: {
    label: "新海诚感动画电影",
    prompt: "动画电影级画面质感，清澈高饱和光影，细腻体积光与发丝高光，干净唯美的动漫色彩。",
  },
  manga: {
    label: "日式黑白漫画网点",
    prompt: "日本黑白漫画原稿风格，利落精准的G笔线稿，细腻漫画网点纸阴影与层次对比。",
  },
  render3d: {
    label: "3D 次世代角色渲染",
    prompt:
      "Unreal Engine 5 / Octane Render 次世代 3D 角色渲染，细腻次表面散射肌肤材质，电影级布光。",
  },
  chibi_box: {
    label: "3D 潮玩手办质感",
    prompt: "高品质 PVC 涂装完成品手办质感，柔和摄影棚柔光箱布光，精致材质高光与微距景深。",
  },
  cyberpunk: {
    label: "赛博朋克霓虹",
    prompt: "赛博朋克科幻视觉风格，雨夜霓虹冷暖双色轮廓光，未来感材质反光与电影级氛围。",
  },
  concept_sheet: {
    label: "角色设定集立绘（纯白底）",
    prompt:
      "标准角色设定集全身立绘，纯白干净无杂物背景，均匀漫反射布光，清晰展示全身服装结构与配饰细节。",
  },
};

export const RECIPE_SLOTS = ["portrait", "costume", "pose"];
export const SLOT_LABELS = { portrait: "人像", costume: "服装", pose: "姿势" };
export function emptyGalleryRecipe() {
  return {
    portrait: null,
    costume: null,
    pose: null,
    style: "none",
    notes: "",
    safeMode: true,
    locked: [],
  };
}

export function recipeReferences(recipe, items) {
  const lookup = items instanceof Map ? items : new Map(items.map((item) => [item.id, item]));
  return RECIPE_SLOTS.flatMap((slot) => {
    const selection = recipe[slot];
    const item = selection && lookup.get(selection.id);
    if (!item || item.kind !== slot) return [];
    const variant = item.variants.find((v) => v.id === selection.variant) || item.variants[0];
    const image = slot === "pose" && selection.depth && item.depth ? item.depth : variant;
    return [{ slot, item, selection, image, number: 0 }];
  }).map((reference, index) => ({ ...reference, number: index + 1 }));
}

export function buildGalleryPrompt(recipe, items) {
  const refs = recipeReferences(recipe, items);
  if (!refs.length) return recipe.notes.trim();
  const lines = [`请结合以下 ${refs.length} 张参考图，创作一张完整的人物图像：`];
  for (const ref of refs) {
    const name = `Image ${ref.number}`;
    if (ref.slot === "portrait")
      lines.push(
        `人物参考 ${name}：保持人物的脸型、五官、发型与发色一致，所有可见皮肤的肤色与脸部统一。`,
      );
    if (ref.slot === "costume")
      lines.push(
        `服装参考 ${name}：让人物穿上这张图中的整套服装与配饰，保留每件单品的颜色、款式和面料。参考名称：${ref.item.title}。`,
      );
    if (ref.slot === "pose")
      lines.push(
        `姿势参考 ${name}：按照图中的动作、镜头角度与构图摆姿势（${ref.item.title}，${ref.item.angle || "所选视角"}）。${ref.selection.depth ? "这是一张深度图，仅参考空间关系与动作。" : "仅参考动作与构图，不复制素体模型的外观、服装或灰白材质。"}`,
      );
  }
  const style = STYLE_PRESETS[recipe.style];
  if (style?.prompt) lines.push(`画风要求：${style.prompt}`);
  if (recipe.notes.trim()) lines.push(`补充要求：${recipe.notes.trim()}`);
  lines.push("人物比例协调，手部自然，光影统一；画面中不添加文字、标志或水印。");
  return lines.join("\n");
}

export function randomGalleryRecipe(recipe, items, random = Math.random, onlySlot) {
  const next = structuredClone(recipe);
  for (const slot of RECIPE_SLOTS) {
    if ((onlySlot && slot !== onlySlot) || (!onlySlot && recipe.locked.includes(slot))) continue;
    const pool = items.filter(
      (item) => item.kind === slot && (!recipe.safeMode || !item.sensitive),
    );
    const alternatives = pool.filter((item) => item.id !== recipe[slot]?.id);
    const choices = alternatives.length ? alternatives : pool;
    if (!choices.length) continue;
    const item =
      choices[Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)))];
    next[slot] = {
      id: item.id,
      variant: item.variants[0].id,
      depth: slot === "pose" && Boolean(recipe.pose?.depth && item.depth),
    };
  }
  return next;
}
