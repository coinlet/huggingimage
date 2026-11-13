import { useEffect, useRef, useState } from "react";
import {
  Folder,
  File,
  Upload,
  FolderPlus,
  RefreshCw,
  Settings2,
  ChevronRight,
  Download,
  ImagePlus,
  Save,
  LoaderCircle,
} from "lucide-react";
import {
  api,
  json,
  type AssetLibrary,
  type AssetEntry,
  type AssetListing,
  type ImageItem,
} from "./types";
import { Modal } from "./Modal";
const prettySize = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;
export function AssetBrowser({
  image,
  onSaved,
  onUse,
  onManage,
  useLabel = "编辑这张图片",
}: {
  image?: ImageItem;
  onSaved?: () => void;
  onUse?: (image: ImageItem) => void;
  onManage: () => void;
  useLabel?: string;
}) {
  const [libraries, setLibraries] = useState<AssetLibrary[]>([]);
  const [libraryId, setLibraryId] = useState(
    () => localStorage.getItem("imagine-asset-library") || "local",
  );
  const [folder, setFolder] = useState("");
  const [listing, setListing] = useState<AssetListing>({ path: "", entries: [], nextCursor: null });
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0),
    [libraryRevision, setLibraryRevision] = useState(0);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [preview, setPreview] = useState<AssetEntry | null>(null);
  const [filename, setFilename] = useState(image ? `${image.id}.png` : "");
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestVersion = useRef(0);
  const library = libraries.find((item) => item.id === libraryId);
  useEffect(() => {
    const changed = () => setLibraryRevision((n) => n + 1);
    window.addEventListener("asset-libraries-changed", changed);
    return () => window.removeEventListener("asset-libraries-changed", changed);
  }, []);
  useEffect(() => {
    let active = true;
    api<AssetLibrary[]>("/libraries")
      .then((data) => {
        if (!active) return;
        setLibraries(data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [libraryRevision]);
  useEffect(() => {
    if (libraries.length && !libraries.some((item) => item.id === libraryId)) {
      setLibraryId(libraries[0].id);
      setFolder("");
    }
  }, [libraries, libraryId]);
  useEffect(() => {
    localStorage.setItem("imagine-asset-library", libraryId);
  }, [libraryId]);
  useEffect(() => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    setListing({ path: folder, entries: [], nextCursor: null });
    api<AssetListing>(
      `/libraries/${libraryId}/entries?path=${encodeURIComponent(folder)}&refresh=1`,
    )
      .then((data) => {
        if (requestVersion.current === version) setListing(data);
      })
      .catch((e) => {
        if (requestVersion.current === version) setError(e.message);
      })
      .finally(() => {
        if (requestVersion.current === version) setLoading(false);
      });
    return () => {
      requestVersion.current++;
    };
  }, [libraryId, folder, revision, libraryRevision]);
  useEffect(() => {
    setOperationError("");
    setMessage("");
  }, [libraryId, folder]);
  const refresh = () => setRevision((n) => n + 1);
  async function loadMore() {
    if (!listing.nextCursor || loading) return;
    const version = requestVersion.current;
    setLoading(true);
    try {
      const next = await api<AssetListing>(
        `/libraries/${libraryId}/entries?path=${encodeURIComponent(folder)}&cursor=${encodeURIComponent(listing.nextCursor)}`,
      );
      if (requestVersion.current === version)
        setListing((previous) => ({ ...next, entries: [...previous.entries, ...next.entries] }));
    } catch (e) {
      if (requestVersion.current === version) setError((e as Error).message);
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setOperationError("");
    setMessage("");
    const errors: string[] = [];
    let success = 0;
    for (const file of Array.from(files)) {
      try {
        if (file.size > 12 * 1024 * 1024) throw new Error("超过 12MB 限制");
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("读取文件失败"));
          reader.readAsDataURL(file);
        });
        await api(
          `/libraries/${libraryId}/upload`,
          json("POST", { path: folder, name: file.name, data }),
        );
        success++;
      } catch (e) {
        errors.push(`${file.name}：${(e as Error).message}`);
      }
    }
    setMessage(`已上传 ${success} 个文件`);
    setOperationError(errors.join("\n"));
    setBusy(false);
    refresh();
  }
  async function createFolder() {
    if (!newFolder?.trim()) return;
    setBusy(true);
    setOperationError("");
    try {
      await api(
        `/libraries/${libraryId}/folders`,
        json("POST", { path: folder, name: newFolder.trim() }),
      );
      setNewFolder(null);
      refresh();
    } catch (e) {
      setOperationError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveImage() {
    if (!image) return;
    setBusy(true);
    setOperationError("");
    try {
      await api(
        `/libraries/${libraryId}/from-image`,
        json("POST", { imageId: image.id, path: folder, name: filename }),
      );
      setMessage("图片已保存到素材库");
      onSaved?.();
      refresh();
    } catch (e) {
      setOperationError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function useImage(entry: AssetEntry) {
    setBusy(true);
    setOperationError("");
    try {
      const imported = await api<ImageItem>(
        `/libraries/${libraryId}/import`,
        json("POST", { path: entry.path }),
      );
      setPreview(null);
      onUse?.(imported);
    } catch (e) {
      setOperationError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const displayedError = [error, operationError].filter(Boolean).join("\n");
  return (
    <section className={`asset-browser ${image ? "asset-destination" : ""}`}>
      <div className="asset-heading">
        <div>
          <span className="eyebrow">YOUR ASSETS</span>
          <h2>{image ? "选择保存位置" : "素材库"}</h2>
          <p>
            {image
              ? "将当前版本以 PNG 文件保存到所选目录。"
              : "按来源目录浏览图片和文件，也可以上传自己的素材。"}
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={onManage}>
          <Settings2 size={16} />
          管理素材库
        </button>
      </div>
      <div className="asset-toolbar">
        <label>
          素材来源
          <select
            aria-label="素材库来源"
            value={libraryId}
            disabled={busy}
            onChange={(e) => {
              setLibraryId(e.target.value);
              setFolder("");
              setMessage("");
              setNewFolder(null);
            }}
          >
            {libraries.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.type === "local" ? "本地" : item.type.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <div className="asset-toolbar-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !library}
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={16} />
            上传文件
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !library}
            onClick={() => setNewFolder("")}
          >
            <FolderPlus size={16} />
            新建文件夹
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="刷新素材目录"
            onClick={() => {
              setOperationError("");
              refresh();
            }}
            disabled={busy || loading}
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </div>
      <nav className="asset-breadcrumb" aria-label="素材文件夹">
        <button type="button" disabled={busy} onClick={() => setFolder("")}>
          <Folder size={15} />
          根目录
        </button>
        {folder
          .split("/")
          .filter(Boolean)
          .map((part, index, parts) => (
            <span key={index}>
              <ChevronRight size={14} />
              <button
                type="button"
                disabled={busy}
                onClick={() => setFolder(parts.slice(0, index + 1).join("/"))}
              >
                {part}
              </button>
            </span>
          ))}
      </nav>
      {newFolder !== null && (
        <form
          className="asset-new-folder"
          onSubmit={(e) => {
            e.preventDefault();
            void createFolder();
          }}
        >
          <input
            aria-label="新文件夹名称"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            placeholder="文件夹名称"
            maxLength={150}
            required
          />
          <button className="primary-button" disabled={busy}>
            创建
          </button>
          <button type="button" className="text-button" onClick={() => setNewFolder(null)}>
            取消
          </button>
        </form>
      )}
      {displayedError && (
        <p className="inline-error asset-error" role="alert">
          {displayedError}
        </p>
      )}
      {message && (
        <p className="asset-message" role="status">
          {message}
        </p>
      )}
      {busy && (
        <p className="asset-progress" role="status">
          <LoaderCircle size={16} className="spin" />
          正在处理，请稍候…
        </p>
      )}
      <div className="asset-grid" aria-busy={loading}>
        {listing.entries.map((entry) => (
          <button
            type="button"
            key={entry.path}
            className={`asset-tile ${entry.type}`}
            disabled={busy}
            onClick={() =>
              entry.type === "directory"
                ? (setFolder(entry.path), setNewFolder(null))
                : (setPreviewFailed(false), setPreview(entry))
            }
          >
            <div className="asset-tile-preview">
              {entry.type === "directory" ? (
                <Folder size={42} />
              ) : entry.previewUrl ? (
                <>
                  <File size={38} />
                  <img
                    src={`${entry.previewUrl}&thumbnail=1`}
                    loading="lazy"
                    alt={entry.name}
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                </>
              ) : (
                <File size={38} />
              )}
            </div>
            <strong title={entry.name}>{entry.name}</strong>
            <small>{entry.type === "directory" ? "文件夹" : prettySize(entry.size)}</small>
          </button>
        ))}
      </div>
      {loading && (
        <p className="asset-progress" role="status">
          <LoaderCircle size={18} className="spin" />
          读取目录中…
        </p>
      )}
      {!loading && !error && !listing.entries.length && (
        <div className="asset-empty">
          <Folder size={42} />
          <p>当前目录为空</p>
          <span>上传文件或创建文件夹开始整理素材。</span>
        </div>
      )}
      {listing.nextCursor && (
        <button
          type="button"
          className="secondary-button asset-load-more"
          onClick={loadMore}
          disabled={loading}
        >
          加载更多
        </button>
      )}
      <input
        hidden
        ref={fileInput}
        type="file"
        multiple
        onChange={(e) => {
          void upload(e.target.files);
          e.target.value = "";
        }}
      />
      {image && (
        <div className="asset-save-bar">
          <label>
            文件名
            <input
              aria-label="保存的素材文件名"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="image.png"
            />
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !library || !filename.trim()}
            onClick={saveImage}
          >
            <Save size={16} />
            保存到此目录
          </button>
        </div>
      )}
      {preview && (
        <Modal
          title={preview.name}
          className="asset-preview-modal"
          onClose={() => setPreview(null)}
        >
          {preview.previewUrl && !previewFailed ? (
            <img
              className="asset-full-preview"
              src={preview.previewUrl}
              alt={preview.name}
              onError={() => setPreviewFailed(true)}
            />
          ) : (
            <div className="asset-file-preview">
              <File size={64} />
              <p>{previewFailed ? "预览失败，可下载原文件查看" : "此文件不提供图片预览"}</p>
            </div>
          )}
          {displayedError && (
            <p className="inline-error asset-error" role="alert">
              {displayedError}
            </p>
          )}
          <div className="asset-preview-actions">
            <span>{prettySize(preview.size)}</span>
            <a
              className="secondary-button"
              href={`/api/libraries/${libraryId}/file?path=${encodeURIComponent(preview.path)}`}
              download
            >
              <Download size={16} />
              下载原文件
            </a>
            {preview.image && onUse && (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => useImage(preview)}
              >
                <ImagePlus size={16} />
                {useLabel}
              </button>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
