import { DEFAULT_SIZES, type SizeSettings } from "../shared/resolution.mjs";
import { ResolutionControl } from "./ResolutionControl";
import type { CreationSettings, Provider } from "./types";

export function validateCreationSettings(value: CreationSettings) {
  if (!Number.isInteger(value.count) || value.count < 1 || value.count > 4)
    throw new Error("生成张数需为 1–4");
  if (!Number.isInteger(value.steps) || value.steps < 1 || value.steps > 100)
    throw new Error("步数需为 1–100 之间的整数");
  if (!Number.isFinite(value.guidance) || value.guidance < 0 || value.guidance > 30)
    throw new Error("引导系数需为 0–30");
  if (
    value.seed.trim() !== "" &&
    Number(value.seed) !== -1 &&
    (!Number.isInteger(Number(value.seed)) ||
      Number(value.seed) < 0 ||
      Number(value.seed) > 2147483647)
  )
    throw new Error("种子需为空、-1 或 0–2147483647 之间的整数");
}

export function CreationOptions({
  providers,
  providerId,
  onProvider,
  settings,
  onChange,
  size,
  onSize,
  onProvidersSettings,
  expanded = false,
}: {
  providers: Provider[];
  providerId: string;
  onProvider: (id: string) => void;
  settings: CreationSettings;
  onChange: (settings: CreationSettings) => void;
  size: SizeSettings;
  onSize: (size: SizeSettings) => void;
  onProvidersSettings: () => void;
  expanded?: boolean;
}) {
  const provider = providers.find((p) => p.id === providerId);
  const ratios = provider?.type === "openai" ? ["1:1", "3:2", "2:3"] : Object.keys(DEFAULT_SIZES);
  const advanced = (
    <>
      <div className="field-pair">
        <label className="field">
          图片比例
          <select
            aria-label="创作图片比例"
            value={size.resolution === "custom" ? "custom" : settings.ratio}
            disabled={size.resolution === "custom"}
            onChange={(e) => onChange({ ...settings, ratio: e.target.value })}
          >
            {size.resolution === "custom" && <option value="custom">由自定义宽高决定</option>}
            {ratios.map((ratio) => (
              <option key={ratio}>{ratio}</option>
            ))}
          </select>
          {size.resolution === "custom" && <small>自定义宽高决定比例</small>}
        </label>
        <label className="field">
          生成张数
          <select
            aria-label="创作生成张数"
            value={settings.count}
            onChange={(e) => onChange({ ...settings, count: Number(e.target.value) })}
          >
            {[1, 2, 3, 4].map((count) => (
              <option key={count} value={count}>
                {count} 张
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field-pair">
        <label className="field">
          推理步数
          <input
            aria-label="创作推理步数"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            step={1}
            required
            value={settings.steps || ""}
            onChange={(e) => onChange({ ...settings, steps: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          引导系数
          <input
            aria-label="创作引导系数"
            type="number"
            inputMode="decimal"
            min={0}
            max={30}
            step="any"
            required
            value={settings.guidance}
            onChange={(e) => onChange({ ...settings, guidance: Number(e.target.value) })}
          />
        </label>
      </div>
      <label className="field">
        随机种子
        <input
          aria-label="创作随机种子"
          type="number"
          inputMode="numeric"
          min={-1}
          max={2147483647}
          step={1}
          value={settings.seed}
          placeholder="留空或 -1 使用随机种子"
          onChange={(e) => onChange({ ...settings, seed: e.target.value })}
        />
      </label>
      <label className="field">
        负向提示词
        <textarea
          aria-label="创作负向提示词"
          rows={3}
          maxLength={3000}
          value={settings.negativePrompt}
          placeholder="不希望出现的内容（模型支持时生效）"
          onChange={(e) => onChange({ ...settings, negativePrompt: e.target.value })}
        />
      </label>
    </>
  );
  return (
    <div className="creation-options">
      <label className="field">
        编辑模型
        <select
          aria-label="编辑模型"
          value={providerId}
          onChange={(e) => onProvider(e.target.value)}
        >
          {(!provider?.supportsEdit || !provider.enabled) && (
            <option value={providerId}>请选择支持编辑的模型</option>
          )}
          {providers
            .filter((p) => p.enabled && p.supportsEdit)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </label>
      <button type="button" className="text-button" onClick={onProvidersSettings}>
        管理模型与提供商
      </button>
      <ResolutionControl
        value={size}
        onChange={onSize}
        ratio={settings.ratio}
        provider={provider}
      />
      {expanded ? (
        <section className="creation-advanced-options">
          <h3>更多参数</h3>
          {advanced}
        </section>
      ) : (
        <details className="creation-advanced-options">
          <summary>更多生成参数</summary>
          {advanced}
        </details>
      )}
      <p className="help-text">参数是否生效取决于所选模型；原位重试仍使用该任务原来的参数。</p>
    </div>
  );
}
