import { resolveResolution, type SizeSettings } from "../shared/resolution.mjs";
import type { Provider } from "./types";

export function ResolutionControl({
  value,
  onChange,
  ratio,
  provider,
  compact = false,
}: {
  value: SizeSettings;
  onChange: (value: SizeSettings) => void;
  ratio: string;
  provider?: Provider;
  compact?: boolean;
}) {
  const xai = provider?.type === "xai";
  const selected =
    xai && !["default", "1024", "2048"].includes(value.resolution) ? "default" : value.resolution;
  let description = "";
  try {
    const size = resolveResolution({ ...value, resolution: selected, ratio }, provider?.type);
    description = xai
      ? "实际像素尺寸由 xAI 按所选比例和档位确定"
      : `请求尺寸：${size.width} × ${size.height}`;
  } catch (e) {
    description = (e as Error).message;
  }
  return (
    <fieldset className={`resolution-control ${compact ? "compact" : ""}`}>
      <legend>图片分辨率</legend>
      <label>
        <span className="section-label">分辨率</span>
        <select
          aria-label="图片分辨率"
          value={selected}
          onChange={(e) => onChange({ ...value, resolution: e.target.value })}
        >
          <option value="default">默认尺寸</option>
          {!xai && <option value="512">512 px · 长边</option>}
          <option value="1024">1K{xai ? "" : " · 长边 1024"}</option>
          <option value="2048">2K{xai ? "" : " · 长边 2048"}</option>
          {!xai && <option value="custom">自定义宽高</option>}
        </select>
      </label>
      {selected === "custom" && (
        <div className="resolution-dimensions">
          <label>
            <span className="section-label">宽度（px）</span>
            <input
              aria-label="图片宽度"
              type="number"
              min={64}
              max={4096}
              step={8}
              value={value.width || ""}
              onChange={(e) => onChange({ ...value, width: Number(e.target.value) })}
            />
          </label>
          <span aria-hidden="true">×</span>
          <label>
            <span className="section-label">高度（px）</span>
            <input
              aria-label="图片高度"
              type="number"
              min={64}
              max={4096}
              step={8}
              value={value.height || ""}
              onChange={(e) => onChange({ ...value, height: Number(e.target.value) })}
            />
          </label>
        </div>
      )}
      <p className="help-text">
        {description}
        {!xai && "；需模型支持该尺寸"}
      </p>
      {provider?.type === "gradio" && (
        <p className="help-text">
          Space 模板通过 {"{{width}}"} / {"{{height}}"}{" "}
          接收宽高；未提供这些参数的模型会使用自身尺寸。
        </p>
      )}
    </fieldset>
  );
}
