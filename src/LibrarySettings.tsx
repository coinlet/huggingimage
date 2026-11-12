import { useEffect, useState } from "react";
import { Folder, Plus, Save, Plug, Trash2, LoaderCircle } from "lucide-react";
import { api, json, type AssetLibrary } from "./types";
type Form = {
  id?: string;
  name: string;
  type: AssetLibrary["type"];
  endpoint: string;
  bucket: string;
  prefix: string;
  region: string;
  pathStyle: boolean;
  credentials: Record<string, string>;
  hasCredentials?: boolean;
  clearCredentials?: boolean;
  isDefault?: boolean;
};
const blank = (): Form => ({
  name: "",
  type: "s3",
  endpoint: "",
  bucket: "",
  prefix: "",
  region: "us-east-1",
  pathStyle: true,
  credentials: {},
});
export function LibrarySettings() {
  const [libraries, setLibraries] = useState<AssetLibrary[]>([]);
  const [form, setForm] = useState<Form>(blank);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = async () => setLibraries(await api<AssetLibrary[]>("/libraries"));
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  const change = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((old) => ({ ...old, [key]: value }));
    setError("");
    setMessage("");
    setConfirmDelete(false);
  };
  const credential = (key: string, value: string) =>
    change("credentials", { ...form.credentials, [key]: value });
  const select = (library: AssetLibrary) => {
    setForm({
      ...blank(),
      ...library,
      endpoint: library.endpoint || "",
      bucket: library.bucket || "",
      prefix: library.prefix || "",
      region: library.region || "us-east-1",
      pathStyle: library.pathStyle !== false,
      credentials: {},
    });
    setError("");
    setMessage("");
    setConfirmDelete(false);
  };
  async function save(test = false) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await api<AssetLibrary>(
        form.id ? `/libraries/${form.id}` : "/libraries",
        json(form.id ? "PUT" : "POST", form),
      );
      select(saved);
      await refresh();
      window.dispatchEvent(new Event("asset-libraries-changed"));
      if (test) {
        const result = await api<{ message: string }>(`/libraries/${saved.id}/test`, json("POST"));
        setMessage(result.message);
      } else setMessage("素材库已保存");
    } catch (e) {
      setError((e as Error).message);
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
    setError("");
    try {
      await api(`/libraries/${form.id}`, json("DELETE"));
      setForm(blank());
      setConfirmDelete(false);
      await refresh();
      window.dispatchEvent(new Event("asset-libraries-changed"));
      setMessage("已移除素材库连接，来源文件仍保留");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="library-settings">
      <aside className="library-settings-list">
        <p className="section-label">素材来源</p>
        {libraries.map((library) => (
          <button
            type="button"
            className={`library-source-row ${form.id === library.id ? "selected" : ""}`}
            key={library.id}
            disabled={busy}
            onClick={() => select(library)}
          >
            <Folder size={20} />
            <span>
              <strong>{library.name}</strong>
              <small>
                {library.type === "local" ? "本地存储" : library.type.toUpperCase()}
                {library.isDefault ? " · 默认" : ""}
              </small>
            </span>
          </button>
        ))}
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => {
            setForm(blank());
            setError("");
            setMessage("");
            setConfirmDelete(false);
          }}
        >
          <Plus size={16} />
          添加素材库
        </button>
      </aside>
      <form
        className="library-settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy} className="provider-fields">
          <h3>{form.id ? "素材库设置" : "添加素材库"}</h3>
          <label className="field">
            素材库名称
            <input
              value={form.name}
              maxLength={80}
              required
              onChange={(e) => change("name", e.target.value)}
              placeholder="例如：产品图片"
            />
          </label>
          <label className="field">
            来源类型
            <select
              value={form.type}
              disabled={Boolean(form.id)}
              onChange={(e) => change("type", e.target.value as Form["type"])}
            >
              <option value="local">本地存储</option>
              <option value="s3">S3 兼容存储</option>
              <option value="webdav">WebDAV</option>
            </select>
          </label>
          {form.type === "local" ? (
            <p className="help-text">
              文件保存在应用数据目录 assets/{form.id || "素材库 ID"}/ 中，沿用 Docker
              数据卷。可以在素材库中创建目录和上传文件。
            </p>
          ) : (
            <>
              <label className="field">
                {form.type === "s3" ? "S3 Endpoint" : "WebDAV 根地址"}
                <input
                  type="url"
                  required
                  value={form.endpoint}
                  onChange={(e) => change("endpoint", e.target.value)}
                  placeholder={
                    form.type === "s3"
                      ? "https://s3.example.com"
                      : "https://dav.example.com/remote.php/dav/files/user/"
                  }
                />
                <small>只填写服务地址，凭证填写在下方。</small>
              </label>
              {form.type === "s3" && (
                <>
                  <div className="field-pair">
                    <label className="field">
                      Bucket
                      <input
                        required
                        value={form.bucket}
                        onChange={(e) => change("bucket", e.target.value)}
                      />
                    </label>
                    <label className="field">
                      Region
                      <input
                        value={form.region}
                        onChange={(e) => change("region", e.target.value)}
                        placeholder="us-east-1 / auto"
                      />
                    </label>
                  </div>
                  <label className="field">
                    根目录前缀（可选）
                    <input
                      value={form.prefix}
                      onChange={(e) => change("prefix", e.target.value)}
                      placeholder="photos/references"
                    />
                  </label>
                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      checked={form.pathStyle}
                      onChange={(e) => change("pathStyle", e.target.checked)}
                    />
                    Path-style 路径访问（兼容 MinIO 等服务）
                  </label>
                </>
              )}
              <p className="help-text">
                {form.hasCredentials
                  ? "凭证已加密保存；以下字段留空将保留原值。"
                  : "凭证为空时匿名访问，需来源本身允许。"}
              </p>
              {form.type === "s3" ? (
                <>
                  <label className="field">
                    Access Key ID
                    <input
                      value={form.credentials.accessKeyId || ""}
                      autoComplete="off"
                      onChange={(e) => credential("accessKeyId", e.target.value)}
                      placeholder={form.hasCredentials ? "已配置 · 留空保留" : ""}
                    />
                  </label>
                  <label className="field">
                    Secret Access Key
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={form.credentials.secretAccessKey || ""}
                      onChange={(e) => credential("secretAccessKey", e.target.value)}
                      placeholder={form.hasCredentials ? "已配置 · 留空保留" : ""}
                    />
                  </label>
                  <label className="field">
                    Session Token（可选）
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={form.credentials.sessionToken || ""}
                      onChange={(e) => credential("sessionToken", e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="field">
                    用户名
                    <input
                      autoComplete="off"
                      value={form.credentials.username || ""}
                      onChange={(e) => credential("username", e.target.value)}
                      placeholder={form.hasCredentials ? "已配置 · 留空保留" : ""}
                    />
                  </label>
                  <label className="field">
                    密码 / 应用密码
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={form.credentials.password || ""}
                      onChange={(e) => credential("password", e.target.value)}
                      placeholder={form.hasCredentials ? "已配置 · 留空保留" : ""}
                    />
                  </label>
                </>
              )}
              {form.hasCredentials && (
                <label className="checkbox-line">
                  <input
                    type="checkbox"
                    checked={Boolean(form.clearCredentials)}
                    onChange={(e) => change("clearCredentials", e.target.checked)}
                  />
                  清除原有凭证（可同时填写新凭证）
                </label>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="asset-message">
              {message}
            </p>
          )}
          {confirmDelete && (
            <p className="help-text">仅移除本应用中的素材库配置，不删除本地目录或远程文件。</p>
          )}
          <div className="form-actions">
            {form.id && !form.isDefault && (
              <button type="button" className="danger-button" onClick={remove}>
                <Trash2 size={16} />
                {confirmDelete ? "确认移除" : "移除"}
              </button>
            )}
            <span className="action-spacer" />
            <button type="button" className="secondary-button" onClick={() => void save(true)}>
              <Plug size={16} />
              保存并测试
            </button>
            <button className="primary-button">
              {busy ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}保存素材库
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
