export const DEFAULT_SIZES = {
  "1:1": [1024, 1024],
  "3:2": [1536, 1024],
  "2:3": [1024, 1536],
  "16:9": [1536, 864],
  "9:16": [864, 1536],
  "4:3": [1280, 960],
  "3:4": [960, 1280],
};
export function resolveResolution(input = {}, providerType) {
  const ratio = Object.hasOwn(DEFAULT_SIZES, input.ratio) ? input.ratio : "1:1";
  const resolution = input.resolution ?? "default";
  if (!["default", "512", "1024", "2048", "custom"].includes(resolution))
    throw new Error("请选择有效的分辨率");
  if (providerType === "xai" && !["default", "1024", "2048"].includes(resolution))
    throw new Error("xAI 支持默认、1K 和 2K 分辨率档位");
  let [width, height] = DEFAULT_SIZES[ratio];
  let outputRatio = ratio;
  if (resolution === "custom") {
    width = Number(input.width);
    height = Number(input.height);
    if (![width, height].every((n) => Number.isInteger(n) && n >= 64 && n <= 4096 && n % 8 === 0))
      throw new Error("自定义宽高需为 64–4096 之间的整数，且为 8 的倍数");
    let a = width,
      b = height;
    while (b) [a, b] = [b, a % b];
    outputRatio = `${width / a}:${height / a}`;
  } else if (resolution !== "default") {
    const scale = Number(resolution) / Math.max(width, height);
    width = Math.max(64, Math.round((width * scale) / 8) * 8);
    height = Math.max(64, Math.round((height * scale) / 8) * 8);
  }
  return { resolution, ratio: outputRatio, width, height };
}
