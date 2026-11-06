import { useState } from "react";
import {
  Plus,
  ArrowUpRight,
  Check,
  LoaderCircle,
  Trash2,
  Plug,
  ShieldCheck,
  ChevronRight,
  Eye,
  EyeOff,
  Save,
  ExternalLink,
  Sparkles,
} from "lucide-react";
import { Modal } from "./Modal";
import { api, json, type Provider, type SpaceDiscovery } from "./types";

type Draft = Omit<Provider, "id" | "hasKey" | "template" | "editTemplate" | "extra"> & {
  id?: string;
  hasKey?: boolean;
  apiKey: string;
  templateText: string;
  editTemplateText: string;
  extraText: string;
  clearKey?: boolean;
};
const defaultTemplate = {
  prompt: "{{prompt}}",
  seed: "{{seed}}",
  randomize_seed: false,
  width: "{{width}}",
  height: "{{height}}",
  num_inference_steps: "{{steps}}",
  guidance_scale: "{{guidance}}",
};
const defaultEdit = {
  image: "{{image}}",
  prompt: "{{prompt}}",
  seed: "{{seed}}",
  num_inference_steps: "{{steps}}",
};
function blank(type: Provider["type"] = "xai"): Draft {
  return {
    type,
    name:
      type === "xai"
        ? "xAI · Grok Imagine"
        : type === "gradio"
          ? "Hugging Face Space"
          : "OpenAI 兼容服务",
    enabled: true,
    supportsEdit: type !== "gradio",
    supportsGenerate: type !== "gradio",
    model: type === "xai" ? "grok-imagine-image-2.0" : type === "openai" ? "gpt-image-1" : "",
    baseUrl: type === "xai" ? "https://api.x.ai/v1" : "https://api.openai.com/v1",
    space: "",
    endpoint: "",
    editEndpoint: "",
    editOutputPath: "0",
    outputPath: "0",
    apiKey: "",
    templateText: JSON.stringify(defaultTemplate, null, 2),
    editTemplateText: JSON.stringify(defaultEdit, null, 2),
    extraText: "{}",
  };
}
function draft(p: Provider): Draft {
  return {
    ...p,
    apiKey: "",
    templateText: JSON.stringify(p.template || defaultTemplate, null, 2),
    editTemplateText: JSON.stringify(p.editTemplate || defaultEdit, null, 2),
    extraText: JSON.stringify(p.extra || {}, null, 2),
  };
}
export function Settings({
  providers,
  onClose,
  onRefresh,
  notify,
}: {
  providers: Provider[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [form, setForm] = useState<Draft>(() => (providers[0] ? draft(providers[0]) : blank()));
  const [busy, setBusy] = useState(false);
  const [discovery, setDiscovery] = useState<SpaceDiscovery | null>(null);
  const [spaceConfigured, setSpaceConfigured] = useState(
    Boolean(
      providers[0]?.type === "gradio" && (providers[0]?.endpoint || providers[0]?.editEndpoint),
    ),
  );
  const [manual, setManual] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    ok: boolean;
    api?: unknown;
    models?: string[];
    message?: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (key === "space" || key === "apiKey" || key === "clearKey") {
      setDiscovery(null);
      setSpaceConfigured(false);
    }
    setError("");
    setResult(null);
    setConfirmDelete(false);
  };
  const select = (value: Draft) => {
    setForm(value);
    setDiscovery(null);
    setSpaceConfigured(
      Boolean(value.type === "gradio" && value.id && (value.endpoint || value.editEndpoint)),
    );
    setManual(false);
    setAdvancedOpen(false);
    setError("");
    setResult(null);
    setConfirmDelete(false);
  };
  async function readSpace(current: Draft): Promise<Draft | null> {
    const detected = await api<SpaceDiscovery>(
      "/spaces/discover",
      json("POST", {
        space: current.space,
        apiKey: current.apiKey,
        providerId: current.hasKey ? current.id : undefined,
        clearKey: current.clearKey,
      }),
    );
    const next: Draft = {
      ...current,
      space: detected.space,
      name: !current.name || current.name === "Hugging Face Space" ? detected.name : current.name,
      supportsGenerate: detected.supportsGenerate,
      supportsEdit: detected.supportsEdit,
      endpoint: detected.endpoint,
      editEndpoint: detected.editEndpoint,
      outputPath: detected.outputPath,
      editOutputPath: detected.editOutputPath,
      templateText: JSON.stringify(detected.template, null, 2),
      editTemplateText: JSON.stringify(detected.editTemplate, null, 2),
      defaults: detected.defaults,
    };
    setForm(next);
    setDiscovery(detected);
    setSpaceConfigured(detected.ready);
    setManual(false);
    if (!detected.ready) {
      setAdvancedOpen(true);
      setError("已读取 API，但仍有必填参数或能力无法自动确定。请查看识别结果，或切换手动配置。");
      return null;
    }
    return next;
  }
  async function detectSpace() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      await readSpace(form);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(test = false) {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      let current = form;
      if (current.type === "gradio" && !spaceConfigured && !manual) {
        const detected = await readSpace(current);
        if (!detected) return;
        current = detected;
      }
      const payload = {
        ...current,
        template: JSON.parse(current.templateText),
        editTemplate: JSON.parse(current.editTemplateText),
        extra: JSON.parse(current.extraText),
      };
      const saved = await api<Provider>(
        current.id ? `/providers/${current.id}` : "/providers",
        json(current.id ? "PUT" : "POST", payload),
      );
      setForm(draft(saved));
      if (saved.type === "gradio") setSpaceConfigured(true);
      await onRefresh();
      if (test) setResult(await api(`/providers/${saved.id}/test`, json("POST")));
      else notify("提供商已保存");
    } catch (e) {
      setError(
        e instanceof SyntaxError
          ? "JSON 格式不正确，请检查参数模板或扩展参数"
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      await api(`/providers/${form.id}`, json("DELETE"));
      await onRefresh();
      select(blank());
      notify("提供商已删除");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="模型与提供商" onClose={onClose} className="settings-modal">
      <div className="settings-layout">
        <aside className="provider-sidebar">
          <p className="section-label">
            你的连接 <span>{providers.length}</span>
          </p>
          {providers.map((p) => (
            <button
              key={p.id}
              className={`provider-row ${form.id === p.id ? "selected" : ""}`}
              onClick={() => select(draft(p))}
              disabled={busy}
            >
              <span className={`provider-symbol ${p.type}`}>
                {p.type === "gradio" ? "🤗" : p.type === "xai" ? "𝕏" : "◈"}
              </span>
              <span>
                <strong>{p.name}</strong>
                <small>
                  {p.enabled ? (p.type === "gradio" ? "Hugging Face Space" : p.model) : "已停用"}
                </small>
              </span>
              <ChevronRight size={14} />
            </button>
          ))}
          <button className="add-provider" onClick={() => select(blank())} disabled={busy}>
            <Plus size={16} /> 添加提供商
          </button>
          <div className="security-note">
            <ShieldCheck size={20} />
            <strong>密钥留在服务端</strong>
            <p>API Key 加密保存，浏览器只显示配置状态。请求通过服务端转发。</p>
          </div>
        </aside>
        <section className="provider-form">
          <fieldset className="provider-fields" disabled={busy}>
            <div className="form-heading">
              <div>
                <h3>{form.id ? "连接设置" : "添加新连接"}</h3>
                <p>让你喜欢的模型，成为创作的一部分。</p>
              </div>
              <label className="switch-label">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => set("enabled", e.target.checked)}
                />
                启用
              </label>
            </div>
            <div className="provider-types">
              {(
                [
                  ["xai", "𝕏", "xAI"],
                  ["openai", "◈", "OpenAI 兼容"],
                  ["gradio", "🤗", "HF Spaces"],
                ] as const
              ).map(([type, icon, label]) => (
                <button
                  key={type}
                  className={form.type === type ? "active" : ""}
                  onClick={() => {
                    if (type !== form.type)
                      select({ ...blank(type), id: form.id, hasKey: form.hasKey });
                  }}
                  disabled={busy}
                >
                  <span>{icon}</span>
                  {label}
                  {form.type === type && <Check size={13} />}
                </button>
              ))}
            </div>
            <label className="field">
              连接名称
              <input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="给这个连接起个名字"
                maxLength={80}
              />
            </label>
            {form.type === "gradio" ? (
              <>
                <label className="field">
                  Space 地址
                  <input
                    value={form.space}
                    onChange={(e) => set("space", e.target.value)}
                    placeholder="https://huggingface.co/spaces/owner/space-name"
                  />
                  <small>
                    支持 HF 页面链接、owner/space-name 和 *.hf.space；公开 Space 可不填 Token。
                  </small>
                </label>
              </>
            ) : (
              <div className="field-pair">
                <label className="field">
                  API Base URL
                  <input
                    value={form.baseUrl}
                    onChange={(e) => set("baseUrl", e.target.value)}
                    placeholder="https://api.example.com/v1"
                  />
                  <small>填写包含 /v1 的 API 根地址。</small>
                </label>
                <label className="field">
                  模型 ID
                  <input
                    value={form.model}
                    onChange={(e) => set("model", e.target.value)}
                    placeholder="grok-imagine-image-2.0"
                  />
                </label>
              </div>
            )}
            <label className="field">
              {form.type === "gradio" ? "Hugging Face Token" : "API Key"}{" "}
              <span className="optional">
                {form.hasKey ? "已配置 · 留空保留" : "可选（取决于服务）"}
              </span>
              <div className="password-field">
                <input
                  type={showKey ? "text" : "password"}
                  value={form.apiKey}
                  onChange={(e) => set("apiKey", e.target.value)}
                  autoComplete="new-password"
                  placeholder={
                    form.hasKey ? "••••••••••••••••••••" : form.type === "gradio" ? "hf_…" : "sk-…"
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setShowKey((s) => !s)}
                  aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                >
                  {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>
            {form.hasKey && (
              <label className="checkbox-line">
                <input
                  type="checkbox"
                  checked={Boolean(form.clearKey)}
                  onChange={(e) => set("clearKey", e.target.checked)}
                />
                清除已保存的密钥
              </label>
            )}
            {form.type === "gradio" && (
              <div className="space-autofill">
                <div>
                  <Sparkles size={18} />
                  <div>
                    <strong>只填地址，自动生成配置</strong>
                    <p>读取 API 定义，识别端点、参数、默认值与图片输出，不会启动模型推理。</p>
                  </div>
                </div>
                <button
                  type="button"
                  className="primary-button"
                  onClick={detectSpace}
                  disabled={busy || !form.space?.trim()}
                >
                  {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}
                  自动读取并填写
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setManual(true);
                    setAdvancedOpen(true);
                  }}
                >
                  手动配置
                </button>
              </div>
            )}
            {discovery && (
              <div
                className={`space-discovery ${discovery.ready ? "ready" : "needs-review"}`}
                role="status"
              >
                <strong>
                  {discovery.ready ? "配置已生成" : "需要补充配置"} ·{" "}
                  {discovery.source === "ai" ? "AI 辅助识别" : "API 结构识别"}
                </strong>
                <div className="space-capabilities">
                  <span>
                    图片生成：{discovery.supportsGenerate ? discovery.endpoint : "未识别"}
                  </span>
                  <span>
                    图片编辑：{discovery.supportsEdit ? discovery.editEndpoint : "未识别"}
                  </span>
                </div>
                {discovery.warnings.length > 0 && (
                  <details>
                    <summary>{discovery.warnings.length} 条参数说明</summary>
                    <ul>
                      {discovery.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {!discovery.aiAvailable && (
                  <p>
                    当前使用 API 定义自动识别，无需额外 AI Key。复杂 Space 可由后台配置的 AI
                    模型辅助。
                  </p>
                )}
              </div>
            )}
            <details
              className="space-advanced"
              open={form.type !== "gradio" || advancedOpen}
              onToggle={(e) => {
                if (form.type === "gradio") setAdvancedOpen(e.currentTarget.open);
              }}
            >
              <summary hidden={form.type !== "gradio"}>
                高级配置 · {manual ? "手动模式" : "查看和调整自动生成的配置"}
              </summary>
              {form.type === "gradio" && (
                <>
                  <label className="capability">
                    <div>
                      <strong>启用图片生成</strong>
                      <p>编辑专用 Space 可以关闭此项</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={form.supportsGenerate !== false}
                      onChange={(e) => set("supportsGenerate", e.target.checked)}
                    />
                  </label>
                </>
              )}
              <label className="capability">
                <div>
                  <strong>启用图片编辑</strong>
                  <p>允许上传参考图片并通过提示词进行修改</p>
                </div>
                <input
                  type="checkbox"
                  checked={form.supportsEdit}
                  onChange={(e) => set("supportsEdit", e.target.checked)}
                />
              </label>
              {form.type === "gradio" ? (
                <>
                  <div className="form-divider" />
                  <div className="form-subheading">
                    <h4>端点与参数映射</h4>
                    <a
                      href="https://www.gradio.app/guides/getting-started-with-the-js-client"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Gradio 文档 <ArrowUpRight size={13} />
                    </a>
                  </div>
                  <p className="help-text">
                    配置可由上方按钮自动生成。需要自定义参数时，可在这里调整；编辑与生成可使用不同的输出路径。
                  </p>
                  <div className="field-pair">
                    <label className="field">
                      生成端点
                      <input
                        value={form.endpoint}
                        onChange={(e) => set("endpoint", e.target.value)}
                        placeholder="/infer"
                      />
                    </label>
                    <label className="field">
                      输出路径
                      <input
                        value={form.outputPath}
                        onChange={(e) => set("outputPath", e.target.value)}
                        placeholder="0"
                      />
                      <small>例如 0 或 0.0.image；留空读取全部输出。</small>
                    </label>
                  </div>
                  <label className="field">
                    生成参数模板 <span className="optional">JSON 对象或位置参数数组</span>
                    <textarea
                      className="code-input"
                      spellCheck={false}
                      rows={8}
                      value={form.templateText}
                      onChange={(e) => set("templateText", e.target.value)}
                    />
                  </label>
                  {form.supportsEdit && (
                    <>
                      <label className="field">
                        编辑端点
                        <input
                          value={form.editEndpoint}
                          onChange={(e) => set("editEndpoint", e.target.value)}
                          placeholder="/edit"
                        />
                      </label>
                      <label className="field">
                        编辑输出路径
                        <input
                          value={form.editOutputPath ?? form.outputPath}
                          onChange={(e) => set("editOutputPath", e.target.value)}
                          placeholder="0"
                        />
                      </label>
                      <label className="field">
                        编辑参数模板
                        <textarea
                          className="code-input"
                          rows={6}
                          spellCheck={false}
                          value={form.editTemplateText}
                          onChange={(e) => set("editTemplateText", e.target.value)}
                        />
                      </label>
                    </>
                  )}
                  <div className="variable-help">
                    可用变量：
                    <code>
                      {
                        "{{prompt}} {{negative_prompt}} {{image}} {{images_b64_json}} {{image_base64}} {{image_data_uri}} {{mask}} {{width}} {{height}} {{seed}} {{steps}} {{guidance}}"
                      }
                    </code>
                    <p>
                      image / mask 变量转为 Gradio 文件；images_b64_json 用于接收 Base64 图片列表
                      JSON 字符串的自定义 Space。ImageEditor 可使用 background / layers / composite
                      嵌套对象。
                    </p>
                  </div>
                </>
              ) : (
                <details className="advanced-details">
                  <summary>扩展请求参数</summary>
                  <p className="help-text">
                    为兼容服务添加 quality、response_format
                    等参数。尺寸、模型、提示词由工作台设置；服务不支持的尺寸会返回具体错误。
                  </p>
                  <label className="field">
                    JSON 参数
                    <textarea
                      className="code-input"
                      rows={5}
                      value={form.extraText}
                      onChange={(e) => set("extraText", e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                </details>
              )}
            </details>
            {error && (
              <div className="inline-error" role="alert">
                {error}
              </div>
            )}
            {result && (
              <div className="connection-result">
                <strong>
                  <Check size={15} /> 连接成功
                </strong>
                {result.message && <p>{result.message}</p>}
                {result.models && (
                  <p>
                    发现 {result.models.length} 个模型：{result.models.slice(0, 8).join("、")}
                  </p>
                )}
                {result.api != null && (
                  <>
                    <p>复制所需端点的参数名称到模板中。</p>
                    <pre>{JSON.stringify(result.api, null, 2)}</pre>
                  </>
                )}
              </div>
            )}
            <div className="form-actions">
              {form.id && (
                <button className="danger-button" onClick={remove} disabled={busy}>
                  <Trash2 size={15} />
                  {confirmDelete ? "确认删除" : "删除"}
                </button>
              )}
              <div className="action-spacer" />
              <button
                className="secondary-button"
                onClick={() => (form.type === "gradio" ? detectSpace() : save(true))}
                disabled={busy}
              >
                {busy ? <LoaderCircle size={15} className="spin" /> : <Plug size={15} />}{" "}
                {form.type === "gradio" ? "重新识别配置" : "保存并测试"}
              </button>
              <button className="primary-button" onClick={() => save()} disabled={busy}>
                <Save size={15} /> 保存连接
              </button>
            </div>
          </fieldset>
        </section>
      </div>
      <div className="settings-footer">
        <ShieldCheck size={13} /> 单用户工作区 · 所有提供商共享同一作品库{" "}
        <a href="https://huggingface.co/docs/hub/spaces" target="_blank" rel="noreferrer">
          了解 Spaces <ExternalLink size={12} />
        </a>
      </div>
    </Modal>
  );
}
