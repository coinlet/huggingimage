import { useState } from "react";
import { Sparkles } from "lucide-react";
import { api, json, type Provider, type McpDiscovery, type McpTool } from "./types";

type McpForm = Pick<
  Provider,
  | "defaults"
  | "baseUrl"
  | "mcpTransport"
  | "mcpAuth"
  | "endpoint"
  | "editEndpoint"
  | "supportsGenerate"
  | "supportsEdit"
  | "outputPath"
  | "editOutputPath"
> & {
  id?: string;
  hasKey?: boolean;
  apiKey: string;
  clearKey?: boolean;
  templateText: string;
  editTemplateText: string;
};
export function McpConfiguration({
  value,
  onChange,
  onBusy,
  onError,
}: {
  value: McpForm;
  onChange: (patch: Partial<McpForm>) => void;
  onBusy: (value: boolean) => void;
  onError: (message: string) => void;
}) {
  const [discovery, setDiscovery] = useState<McpDiscovery | null>(null);
  async function discover() {
    onBusy(true);
    onError("");
    try {
      const result = await api<McpDiscovery>(
        "/mcp/discover",
        json("POST", {
          baseUrl: value.baseUrl,
          mcpTransport: value.mcpTransport,
          mcpAuth: value.mcpAuth,
          apiKey: value.apiKey,
          providerId: value.hasKey ? value.id : undefined,
          clearKey: value.clearKey,
        }),
      );
      setDiscovery(result);
      const patch: Partial<McpForm> = { defaults: result.defaults };
      if (!value.endpoint && result.endpoint)
        Object.assign(patch, {
          endpoint: result.endpoint,
          templateText: JSON.stringify(result.template, null, 2),
          supportsGenerate: true,
        });
      if (!value.editEndpoint && result.editEndpoint)
        Object.assign(patch, {
          editEndpoint: result.editEndpoint,
          editTemplateText: JSON.stringify(result.editTemplate, null, 2),
          supportsEdit: true,
        });
      onChange(patch);
      if (!result.tools.length) onError("MCP 服务未提供工具，请确认连接的是图片 MCP 服务");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      onBusy(false);
    }
  }
  function chooseTool(name: string, edit: boolean) {
    const tool = discovery?.tools.find((t) => t.name === name);
    onChange(
      edit
        ? {
            editEndpoint: name,
            ...(tool
              ? {
                  editTemplateText: JSON.stringify(tool.template, null, 2),
                  defaults: { ...value.defaults, edit: tool.defaults },
                }
              : {}),
          }
        : {
            endpoint: name,
            ...(tool ? { templateText: JSON.stringify(tool.generateTemplate, null, 2) } : {}),
            ...(tool ? { defaults: { ...value.defaults, generate: tool.defaults } } : {}),
          },
    );
  }
  function schema(tool?: McpTool) {
    if (!tool) return null;
    return (
      <div className="mcp-tool-schema">
        <p className="help-text">{tool.description}</p>
        {!!tool.missing.length && (
          <p className="inline-error">请在模板中填写这些必填参数：{tool.missing.join("、")}</p>
        )}
        <details>
          <summary>查看工具参数定义</summary>
          <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
        </details>
      </div>
    );
  }
  return (
    <section className="mcp-configuration">
      <div className="space-autofill">
        <div>
          <Sparkles size={18} />
          <div>
            <strong>读取第三方 MCP 图片工具</strong>
            <p>只读取工具定义，不会调用生图或编辑。选择工具后自动填入可识别的参数。</p>
          </div>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={discover}
          disabled={!value.baseUrl?.trim()}
        >
          <Sparkles size={15} /> 读取工具并填写
        </button>
        {discovery && (
          <p className="help-text">
            已通过 {discovery.transport} 读取 {discovery.tools.length}{" "}
            个工具；无法自动识别时可手动填写工具名和模板。
          </p>
        )}
      </div>
      <datalist id="mcp-image-tools">
        {discovery?.tools.map((t) => (
          <option key={t.name} value={t.name}>
            {t.description.slice(0, 100)}
          </option>
        ))}
      </datalist>
      <label className="capability">
        <div>
          <strong>启用图片生成</strong>
          <p>通过 MCP 工具从提示词生成图片</p>
        </div>
        <input
          type="checkbox"
          checked={value.supportsGenerate !== false}
          onChange={(e) => onChange({ supportsGenerate: e.target.checked })}
        />
      </label>
      {value.supportsGenerate !== false && (
        <>
          <label className="field">
            生成工具名称
            <input
              value={value.endpoint || ""}
              list="mcp-image-tools"
              onChange={(e) => chooseTool(e.target.value, false)}
              placeholder="generate_image"
            />
          </label>
          {schema(discovery?.tools.find((t) => t.name === value.endpoint))}
          <label className="field">
            生成参数模板 · JSON 对象
            <textarea
              className="code-input"
              rows={6}
              value={value.templateText}
              onChange={(e) => onChange({ templateText: e.target.value })}
              spellCheck={false}
            />
          </label>
          <label className="field">
            生成输出路径
            <input
              value={value.outputPath || ""}
              onChange={(e) => onChange({ outputPath: e.target.value })}
              placeholder="留空自动读取全部结果"
            />
            <small>
              例如 structuredContent.images.0 或 content.0；默认自动识别图片、JSON 和资源。
            </small>
          </label>
        </>
      )}
      <label className="capability">
        <div>
          <strong>启用图片编辑</strong>
          <p>将当前图片和编辑提示词交给 MCP 工具</p>
        </div>
        <input
          type="checkbox"
          checked={value.supportsEdit}
          onChange={(e) => onChange({ supportsEdit: e.target.checked })}
        />
      </label>
      {value.supportsEdit && (
        <>
          <label className="field">
            编辑工具名称
            <input
              value={value.editEndpoint || ""}
              list="mcp-image-tools"
              onChange={(e) => chooseTool(e.target.value, true)}
              placeholder="edit_image"
            />
          </label>
          {schema(discovery?.tools.find((t) => t.name === value.editEndpoint))}
          <label className="field">
            编辑参数模板 · JSON 对象
            <textarea
              className="code-input"
              rows={6}
              value={value.editTemplateText}
              onChange={(e) => onChange({ editTemplateText: e.target.value })}
              spellCheck={false}
            />
          </label>
          <label className="field">
            编辑输出路径
            <input
              value={value.editOutputPath || ""}
              onChange={(e) => onChange({ editOutputPath: e.target.value })}
              placeholder="留空自动读取全部结果"
            />
          </label>
        </>
      )}
      <div className="variable-help">
        可用变量：
        <code>
          {
            "{{prompt}} {{negative_prompt}} {{image}} {{image_data_uri}} {{image_base64}} {{images_b64_json}} {{mask}} {{mask_base64}} {{width}} {{height}} {{size}} {{aspect_ratio}} {{seed}} {{steps}} {{guidance}} {{model}} {{count}}"
          }
        </code>
        <p>
          image / mask 是 PNG data URI；image_base64 / mask_base64 是纯
          Base64。工具需支持这种输入格式，不能直接读取本服务的磁盘路径。每次工具调用取一张图，批量生成逐次调用。
        </p>
      </div>
    </section>
  );
}
