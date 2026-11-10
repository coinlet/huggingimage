import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  Compass,
  Download,
  Heart,
  History,
  Image as ImageIcon,
  ImagePlus,
  Layers2,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
  RefreshCw,
  CircleHelp,
  PanelLeftClose,
  AlertCircle,
} from "lucide-react";
import { api, json, type Provider, type ImageItem, type Job, type CreationInput } from "./types";
import { EXAMPLES } from "./examples";
import { Settings } from "./Settings";
import { Modal } from "./Modal";
import { ImageThread } from "./ImageThread";
import { ImagePlaceholder } from "./ImagePlaceholder";
import { newImageId } from "./image-id";

type View = "explore" | "library" | "favorites" | "history";
const viewLabels = {
  explore: "灵感广场",
  library: "我的作品",
  favorites: "我的收藏",
  history: "生成记录",
};
const styles = ["全部", "自然", "摄影", "梦境", "建筑"];
const statusLabels = {
  queued: "排队中",
  running: "创作中",
  succeeded: "已完成",
  failed: "生成失败",
  cancelled: "已取消",
};
const formatDate = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="logo">
      <svg width="31" height="34" viewBox="0 0 64 64" aria-hidden="true">
        <path d="M10 49 39 8h12L22 49zm14 8L53 16v16L36 57z" fill="currentColor" />
      </svg>
      {!compact && (
        <span>
          imagine<span className="logo-dot">.</span>
        </span>
      )}
    </div>
  );
}
export default function App() {
  const [session, setSession] = useState<{ authenticated: boolean; protected: boolean } | null>(
    null,
  );
  const [providers, setProviders] = useState<Provider[]>([]),
    [images, setImages] = useState<ImageItem[]>([]),
    [jobs, setJobs] = useState<Job[]>([]);
  const [view, setView] = useState<View>("explore"),
    [category, setCategory] = useState("全部"),
    [search, setSearch] = useState(""),
    [showSearch, setShowSearch] = useState(false);
  const [settings, setSettings] = useState(false),
    [help, setHelp] = useState(false),
    [toast, setToast] = useState(""),
    [sidebar, setSidebar] = useState(false);
  const [providerId, setProviderId] = useState(
    () => localStorage.getItem("imagine-provider") || "",
  );
  const [prompt, setPrompt] = useState(""),
    [mode, setMode] = useState<"generate" | "edit">("generate"),
    [ratio, setRatio] = useState("1:1"),
    [count, setCount] = useState(1);
  const [advanced, setAdvanced] = useState(false),
    [negativePrompt, setNegativePrompt] = useState(""),
    [seed, setSeed] = useState(""),
    [steps, setSteps] = useState(28),
    [guidance, setGuidance] = useState(3.5);
  const [source, setSource] = useState<ImageItem | null>(null),
    [mask, setMask] = useState<ImageItem | null>(null);
  const [uploading, setUploading] = useState(false),
    [submitting, setSubmitting] = useState(false),
    [submitError, setSubmitError] = useState("");
  const [threadJob, setThreadJob] = useState("");
  const [focusImageId, setFocusImageId] = useState("");
  const draftRequests = useRef(new Map<string, CreationInput>());
  const [detail, setDetail] = useState<ImageItem | null>(null),
    [deleteId, setDeleteId] = useState<string | null>(null),
    [detailBusy, setDetailBusy] = useState(false);
  const [localFavorites, setLocalFavorites] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("imagine-inspiration-favorites") || "[]");
    } catch {
      return [];
    }
  });
  const textarea = useRef<HTMLTextAreaElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    maskInput = useRef<HTMLInputElement>(null);
  const notify = useCallback((message: string) => setToast(message), []);
  const refreshProviders = useCallback(async () => {
    const data = await api<Provider[]>("/providers");
    setProviders(data);
  }, []);
  const refreshWork = useCallback(async () => {
    const [nextImages, nextJobs] = await Promise.all([
      api<ImageItem[]>("/images"),
      api<Job[]>("/jobs"),
    ]);
    setImages((all) => [
      ...all.filter(
        (image) =>
          draftRequests.current.has(image.id) && !nextImages.some((next) => next.id === image.id),
      ),
      ...nextImages,
    ]);
    setJobs(nextJobs);
  }, []);
  const loadSession = useCallback(() => {
    api<{ authenticated: boolean; protected: boolean }>("/session")
      .then(setSession)
      .catch((e) => notify(e.message));
  }, [notify]);
  useEffect(() => {
    loadSession();
    const expired = () =>
      setSession((s) =>
        s ? { ...s, authenticated: false } : { authenticated: false, protected: true },
      );
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, [loadSession]);
  useEffect(() => {
    if (!session?.authenticated) return;
    void Promise.all([refreshProviders(), refreshWork()]).catch((e) => notify(e.message));
  }, [session?.authenticated, refreshProviders, refreshWork, notify]);
  const active = jobs.filter((j) => j.status === "running" || j.status === "queued");
  useEffect(() => {
    if (!session?.authenticated || !active.length) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (!stopped) refreshWork().catch((e) => notify(e.message));
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [session?.authenticated, active.length, refreshWork, notify]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!providers.length) return;
    const enabled = providers.filter((p) => p.enabled);
    if (!enabled.some((p) => p.id === providerId)) setProviderId(enabled[0]?.id || "");
  }, [providers, providerId]);
  useEffect(() => {
    localStorage.setItem("imagine-provider", providerId);
  }, [providerId]);
  const provider = providers.find((p) => p.id === providerId);
  useEffect(() => {
    if (provider?.supportsGenerate === false && provider.supportsEdit) setMode("edit");
    else if (provider && !provider.supportsEdit) setMode("generate");
  }, [providerId, provider?.supportsGenerate, provider?.supportsEdit]);
  const defaults = provider?.defaults?.[mode];
  useEffect(() => {
    setSteps(defaults?.steps ?? 28);
    setGuidance(defaults?.guidance ?? 3.5);
  }, [providerId, mode, defaults?.steps, defaults?.guidance]);
  const availableRatios =
    provider?.type === "openai"
      ? ["1:1", "3:2", "2:3"]
      : ["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4"];
  useEffect(() => {
    if (provider?.type === "openai" && !["1:1", "3:2", "2:3"].includes(ratio)) setRatio("1:1");
  }, [provider?.type, ratio]);
  const go = (next: View) => {
    setView(next);
    setSidebar(false);
    setSearch("");
    setCategory("全部");
  };
  const favorite = async (image: ImageItem) => {
    if (image.example) {
      const next = localFavorites.includes(image.id)
        ? localFavorites.filter((id) => id !== image.id)
        : [...localFavorites, image.id];
      setLocalFavorites(next);
      localStorage.setItem("imagine-inspiration-favorites", JSON.stringify(next));
      return;
    }
    try {
      const saved = await api<ImageItem>(
        `/images/${image.id}`,
        json("PATCH", { favorite: !image.favorite }),
      );
      setImages((all) => all.map((i) => (i.id === saved.id ? saved : i)));
      if (detail?.id === saved.id) setDetail(saved);
    } catch (e) {
      notify((e as Error).message);
    }
  };
  const isFavorite = (image: ImageItem) =>
    image.example ? localFavorites.includes(image.id) : image.favorite;
  const usePrompt = (image: ImageItem) => {
    setPrompt(image.prompt);
    setDetail(null);
    textarea.current?.focus();
    notify("提示词已放入创作框");
  };
  const editImage = (image: ImageItem) => {
    setThreadJob("");
    setFocusImageId(image.id);
    setDetail(image);
  };
  async function submitCreation(input: CreationInput, openPage: boolean, reference?: ImageItem) {
    const selectedProvider = providers.find((p) => p.id === input.providerId);
    if (!selectedProvider) throw new Error("请先配置模型提供商");
    const ids = input.slotIds || Array.from({ length: input.count }, () => newImageId());
    const request = { ...input, slotIds: ids };
    const parent =
      reference ||
      images.find((i) => i.id === input.sourceId) ||
      (source?.id === input.sourceId ? source : null);
    const threadId =
      images.find((i) => i.id === ids[0])?.threadId ||
      (input.mode === "edit" ? parent?.threadId || parent?.id || ids[0] : ids[0]);
    const [rw, rh] = input.ratio.split(":").map(Number);
    const drafts: ImageItem[] = ids.map((id) => ({
      id,
      url: "",
      thumbnail: "",
      kind: "generated",
      status: "submitting",
      localDraft: true,
      prompt: input.prompt,
      providerName: selectedProvider.name,
      model: selectedProvider.model,
      mode: input.mode,
      threadId,
      parentId: input.mode === "edit" ? input.sourceId : undefined,
      width: Math.round((1024 * (rw || 1)) / (rh || 1)),
      height: 1024,
      favorite: false,
      createdAt: images.find((i) => i.id === id)?.createdAt || new Date().toISOString(),
    }));
    for (const id of ids) draftRequests.current.set(id, request);
    setImages((all) => [...drafts, ...all.filter((i) => !ids.includes(i.id))]);
    setFocusImageId(ids[0]);
    if (openPage) {
      setDetail(drafts[0]);
      setThreadJob("");
    }
    setView("library");
    setSearch("");
    try {
      const job = await api<Job>("/jobs", json("POST", request));
      setJobs((all) => [job, ...all]);
      for (const id of ids) draftRequests.current.delete(id);
      setImages((all) =>
        all.map((i) =>
          ids.includes(i.id) ? { ...i, localDraft: false, status: "queued", jobId: job.id } : i,
        ),
      );
      if (openPage) setThreadJob(job.id);
      void refreshWork().catch((e) => notify(e.message));
      return job;
    } catch (error) {
      // The request may have reached the server even if its response was lost.
      try {
        const savedJobs = await api<Job[]>("/jobs");
        const accepted = savedJobs.find((job) => job.slotIds?.includes(ids[0]));
        if (accepted) {
          for (const id of ids) draftRequests.current.delete(id);
          setJobs(savedJobs);
          await refreshWork();
          return accepted;
        }
      } catch {
        /* Keep the local failure available for retry when offline. */
      }
      setImages((all) =>
        all.map((i) =>
          ids.includes(i.id) ? { ...i, status: "failed", error: (error as Error).message } : i,
        ),
      );
      throw error;
    }
  }
  async function retryImage(image: ImageItem) {
    const draft = draftRequests.current.get(image.id);
    if (draft) return submitCreation({ ...draft, count: 1, slotIds: [image.id] }, false);
    const job = await api<Job>(`/images/${image.id}/retry`, json("POST"));
    setJobs((all) => [job, ...all]);
    setFocusImageId(image.id);
    await refreshWork();
    return job;
  }
  async function editInThread(image: ImageItem, editPrompt: string) {
    if (!provider?.enabled || !provider.supportsEdit) throw new Error("请选择支持图片编辑的模型");
    return submitCreation(
      {
        providerId,
        prompt: editPrompt,
        mode: "edit",
        sourceId: image.id,
        ratio,
        count,
        negativePrompt,
        seed,
        steps: provider.defaults?.edit?.steps ?? steps,
        guidance: provider.defaults?.edit?.guidance ?? guidance,
      },
      false,
      image,
    );
  }
  async function upload(file: File | undefined, isMask = false) {
    if (!file) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 12 * 1024 * 1024
    )
      return notify("请上传 12MB 以内的 PNG、JPEG 或 WebP 图片");
    setUploading(true);
    setSubmitError("");
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const image = await api<ImageItem>("/uploads", json("POST", { data, name: file.name }));
      if (isMask) {
        if (!source || source.width !== image.width || source.height !== image.height)
          throw new Error("蒙版的像素尺寸必须与参考图片一致");
        setMask(image);
      } else {
        setSource(image);
        setMask(null);
        setMode("edit");
      }
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  async function generate(event?: FormEvent) {
    event?.preventDefault();
    setSubmitError("");
    if (!provider) {
      setSettings(true);
      return;
    }
    if (!prompt.trim()) {
      textarea.current?.focus();
      return;
    }
    if (mode === "generate" && provider.supportsGenerate === false)
      return setSubmitError("此 Space 仅支持图片编辑，请切换到图片编辑并上传参考图");
    if (mode === "edit" && !provider.supportsEdit)
      return setSubmitError("当前提供商尚未启用图片编辑，请切换模型或在后台配置");
    if (mode === "edit" && !source) {
      fileInput.current?.click();
      return;
    }
    setSubmitting(true);
    try {
      await submitCreation(
        {
          providerId,
          prompt: prompt.trim(),
          mode,
          ratio,
          count,
          sourceId: mode === "edit" ? source?.id : undefined,
          maskId: mode === "edit" ? mask?.id : undefined,
          negativePrompt,
          seed,
          steps,
          guidance,
        },
        true,
      );
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }
  async function cancel(job: Job) {
    try {
      await api(`/jobs/${job.id}/cancel`, json("POST"));
      await refreshWork();
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function deleteImage() {
    if (!deleteId) return;
    setDetailBusy(true);
    try {
      await api(`/images/${deleteId}`, json("DELETE"));
      if (source?.id === deleteId) {
        setSource(null);
        setMask(null);
      }
      setDetail(null);
      setDeleteId(null);
      await refreshWork();
      notify("图片已删除");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setDetailBusy(false);
    }
  }
  const baseImages =
    view === "explore"
      ? EXAMPLES
      : view === "favorites"
        ? [
            ...images.filter((i) => i.favorite),
            ...EXAMPLES.filter((i) => localFavorites.includes(i.id)),
          ]
        : images;
  const visible = baseImages.filter(
    (i) =>
      (category === "全部" || i.category === category) &&
      (!search || `${i.prompt} ${i.name || ""}`.toLowerCase().includes(search.toLowerCase())),
  );
  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebar ? "open" : ""}`}>
        <div className="sidebar-top">
          <Logo />
          <button
            className="icon-button sidebar-close"
            aria-label="关闭导航"
            onClick={() => setSidebar(false)}
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        <button
          className="new-creation"
          onClick={() => {
            setPrompt("");
            setSource(null);
            setMask(null);
            setMode("generate");
            go("explore");
            textarea.current?.focus();
          }}
        >
          <Plus size={18} /> 新的创作 <span>⌘ K</span>
        </button>
        <p className="nav-label">创作空间</p>
        <nav aria-label="主导航">
          {(
            [
              ["explore", Compass],
              ["library", ImageIcon],
              ["favorites", Heart],
              ["history", History],
            ] as const
          ).map(([key, Icon]) => (
            <button
              key={key}
              className={`nav-item ${view === key ? "active" : ""}`}
              onClick={() => go(key)}
            >
              <Icon size={18} />
              <span>{viewLabels[key]}</span>
              {key === "library" && images.length > 0 && <small>{images.length}</small>}
              {key === "history" && active.length > 0 && <span className="activity-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-card">
            <div className="connection-card-icon">
              <Layers2 size={18} />
              <span className={provider ? "status-dot online" : "status-dot"} />
            </div>
            <strong>你的模型，你的想象</strong>
            <p>
              连接 xAI、OpenAI 或<br />
              Hugging Face Spaces
            </p>
            <button onClick={() => setSettings(true)}>
              管理模型连接 <ArrowUpRight size={14} />
            </button>
          </div>
          <button className="nav-item" onClick={() => setSettings(true)}>
            <Settings2 size={18} /> 提供商设置
          </button>
          <button className="nav-item" onClick={() => setHelp(true)}>
            <CircleHelp size={18} /> 使用指南
          </button>
          <div className="workspace-profile">
            <div className="avatar">I</div>
            <div>
              <strong>个人工作区</strong>
              <span>{session?.protected ? "已启用访问保护" : "本地创作 · 自由想象"}</span>
            </div>
            {session?.protected ? (
              <button
                className="icon-button"
                aria-label="退出登录"
                onClick={() =>
                  api("/session", json("DELETE"))
                    .then(loadSession)
                    .catch((e) => notify(e.message))
                }
              >
                <LogOut size={16} />
              </button>
            ) : (
              <button className="icon-button" aria-label="工作区说明" onClick={() => setHelp(true)}>
                <MoreHorizontal size={18} />
              </button>
            )}
          </div>
        </div>
      </aside>
      {sidebar && <div className="sidebar-scrim" onClick={() => setSidebar(false)} />}
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setSidebar(true)}
            >
              <Menu size={20} />
            </button>
            <span>创作空间</span>
            <span className="breadcrumb-slash">/</span>
            <strong>{viewLabels[view]}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-badge">
              <span className="status-dot online" /> 个人工作区
            </span>
            <button
              className="icon-button"
              title="提供商设置"
              aria-label="提供商设置"
              onClick={() => setSettings(true)}
            >
              <Settings2 size={18} />
            </button>
            <div className="avatar small">I</div>
          </div>
        </header>
        <div className="main-content">
          <section className="hero">
            <div className="hero-eyebrow">
              <span className="tiny-star">✳</span> A LITTLE PROMPT. ENDLESS POSSIBILITIES.
            </div>
            <h1>
              {view === "explore" ? (
                <>
                  让想象，<span>自由生长。</span>
                </>
              ) : view === "library" ? (
                <>
                  每个灵感，<span>都有回响。</span>
                </>
              ) : view === "favorites" ? (
                <>
                  把喜欢的，<span>留在这里。</span>
                </>
              ) : (
                <>
                  创作的每一步，<span>都算数。</span>
                </>
              )}
            </h1>
            <p>
              {view === "explore"
                ? "从一个念头开始。描述、生成、编辑，创造属于你的画面。"
                : view === "library"
                  ? "你创造的独特画面。选择一张图片，继续探索新的可能。"
                  : view === "favorites"
                    ? "收藏自己的作品或灵感参考，让美好的想法随时可见。"
                    : "查看任务进度、重新使用提示词，让创作继续。"}
            </p>
            <div className="hero-decoration" aria-hidden="true">
              <span />
              <span />
              <span />
              <Sparkles size={25} />
            </div>
          </section>
          <div className="gallery-toolbar">
            <div className="gallery-tabs">
              {view === "explore" ? (
                styles.map((style) => (
                  <button
                    key={style}
                    onClick={() => setCategory(style)}
                    className={category === style ? "active" : ""}
                  >
                    {style === "全部" && <Compass size={14} />} {style}
                  </button>
                ))
              ) : (
                <span className="collection-title">
                  {viewLabels[view]}{" "}
                  <span>{view === "history" ? jobs.length : baseImages.length}</span>
                </span>
              )}
            </div>
            <div className="gallery-tools">
              {showSearch && (
                <input
                  className="search-input"
                  autoFocus
                  aria-label="搜索提示词"
                  placeholder="搜索提示词…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              )}
              <button
                className={`icon-button ${showSearch ? "selected" : ""}`}
                aria-label="搜索图片"
                onClick={() => {
                  setShowSearch((s) => !s);
                  setSearch("");
                }}
              >
                <Search size={17} />
              </button>
              <span className="toolbar-divider" />
              <button
                className="sort-button"
                onClick={() => {
                  if (view === "explore") notify("灵感广场展示精选摄影参考");
                  else
                    refreshWork()
                      .then(() => notify("作品库已刷新"))
                      .catch((e) => notify(e.message));
                }}
              >
                {view === "explore" ? "精选灵感" : "刷新"}
                {view === "explore" ? <Sparkles size={13} /> : <RefreshCw size={13} />}
              </button>
            </div>
          </div>
          {view === "history" ? (
            <div className="jobs-list">
              {jobs
                .filter((j) => !search || j.prompt.includes(search))
                .map((job) => (
                  <article className="job-row" key={job.id}>
                    <div className={`job-icon ${job.status}`}>
                      {["running", "queued"].includes(job.status) ? (
                        <LoaderCircle size={20} className="spin" />
                      ) : job.status === "succeeded" ? (
                        <Check size={20} />
                      ) : (
                        <ImageIcon size={20} />
                      )}
                    </div>
                    <div className="job-info">
                      <strong>{job.prompt}</strong>
                      <span>
                        {job.providerName} · {job.mode === "edit" ? "图片编辑" : "图片生成"} ·{" "}
                        {job.count} 张 · {formatDate(job.createdAt)}
                      </span>
                      {job.error && <p className="job-error">{job.error}</p>}
                    </div>
                    <span className={`job-status ${job.status}`}>{statusLabels[job.status]}</span>
                    {["queued", "running"].includes(job.status) ? (
                      <button className="secondary-button" onClick={() => cancel(job)}>
                        取消
                      </button>
                    ) : (
                      <button
                        className="icon-button"
                        title="复用提示词"
                        aria-label="复用提示词"
                        onClick={() => {
                          setPrompt(job.prompt);
                          textarea.current?.focus();
                        }}
                      >
                        <RefreshCw size={16} />
                      </button>
                    )}
                  </article>
                ))}
              {!jobs.length && <Empty view="history" onAction={() => textarea.current?.focus()} />}
            </div>
          ) : (
            <>
              {view === "library" && active.length > 0 && (
                <div className="active-jobs">
                  {active.map((job) => (
                    <div className="active-job" key={job.id}>
                      <div className="generating-orb">
                        <Sparkles size={20} />
                      </div>
                      <div>
                        <strong>
                          {job.status === "queued" ? "好想法值得等待" : "正在让想象成形…"}
                        </strong>
                        <p>{job.prompt}</p>
                        <span>
                          {job.providerName} · {job.count} 张 · {statusLabels[job.status]}
                        </span>
                      </div>
                      <button
                        className="icon-button"
                        aria-label="取消任务"
                        onClick={() => cancel(job)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {visible.length > 0 ? (
                <div className="image-grid">
                  {visible.map((image, index) => (
                    <article
                      key={image.id}
                      className="image-card"
                      style={{ animationDelay: `${Math.min(index, 7) * 45}ms` }}
                    >
                      <button
                        className="image-open"
                        aria-label={`查看${image.name || image.prompt}`}
                        onClick={() => {
                          setFocusImageId(image.id);
                          setThreadJob("");
                          setDetail(image);
                          setDeleteId(null);
                        }}
                      >
                        {image.status && image.status !== "succeeded" ? (
                          <ImagePlaceholder image={image} compact />
                        ) : (
                          <img
                            src={image.thumbnail}
                            alt={image.name || image.prompt}
                            loading={index < 4 ? "eager" : "lazy"}
                          />
                        )}
                      </button>
                      <div className="card-top">
                        <span className="image-label">
                          {image.example
                            ? image.category
                            : image.mode === "edit"
                              ? "图片编辑"
                              : "AI 创作"}
                        </span>
                        <button
                          className={`favorite-button ${isFavorite(image) ? "favorited" : ""}`}
                          onClick={() => favorite(image)}
                          title="收藏图片"
                          aria-label={isFavorite(image) ? "取消收藏" : "收藏图片"}
                        >
                          <Heart size={16} fill={isFavorite(image) ? "currentColor" : "none"} />
                        </button>
                      </div>
                      <div className="card-bottom">
                        <div>
                          <h3>{image.name || image.prompt}</h3>
                          <span>{image.example ? "灵感参考 · 摄影作品" : image.providerName}</span>
                        </div>
                        <button
                          className="remix-button"
                          onClick={() => usePrompt(image)}
                          aria-label="使用提示词"
                        >
                          <ArrowUpRight size={17} />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty
                  view={search ? "search" : view}
                  onAction={() => {
                    if (view === "favorites") go("explore");
                    else textarea.current?.focus();
                  }}
                />
              )}
              {view === "library" && jobs.some((j) => j.status === "failed") && (
                <div className="recent-error">
                  <AlertCircle size={16} />
                  <span>最近有任务未完成，查看生成记录了解原因。</span>
                  <button onClick={() => go("history")}>
                    查看记录 <ArrowUpRight size={13} />
                  </button>
                </div>
              )}
              {view === "explore" && (
                <p className="gallery-caption">
                  <span /> 灵感没有边界，下一张由你创造。
                  <span />
                </p>
              )}
            </>
          )}
        </div>
        <div className="composer-dock">
          <form
            className={`composer ${mode === "edit" ? "editing" : ""}`}
            onSubmit={generate}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void upload(e.dataTransfer.files[0]);
            }}
          >
            <div className="composer-mode">
              <button
                type="button"
                className={mode === "generate" ? "active" : ""}
                onClick={() => {
                  setMode("generate");
                  setSubmitError("");
                }}
              >
                <Sparkles size={14} /> 图片生成
              </button>
              <button
                type="button"
                className={mode === "edit" ? "active" : ""}
                onClick={() => {
                  setMode("edit");
                  setSubmitError("");
                }}
              >
                <WandSparkles size={14} /> 图片编辑
              </button>
              <span className="composer-mode-caption">
                {uploading
                  ? "正在上传图片…"
                  : mode === "edit"
                    ? "用文字，赋予画面新的可能"
                    : "把脑海中的画面，变成眼前的真实"}
              </span>
            </div>
            {mode === "edit" && (
              <div className="reference-row">
                {source ? (
                  <div className="reference-chip">
                    <img src={source.thumbnail} alt="参考图片" />
                    <div>
                      <strong>参考图片</strong>
                      <small>
                        {source.width} × {source.height}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="移除参考图"
                      onClick={() => {
                        setSource(null);
                        setMask(null);
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="reference-upload"
                    onClick={() => fileInput.current?.click()}
                    disabled={uploading}
                  >
                    <ImagePlus size={18} /> 上传参考图片 <small>或拖放到这里</small>
                  </button>
                )}
                {source && provider?.type !== "xai" && (
                  <button
                    type="button"
                    className="mask-button"
                    onClick={() => (mask ? setMask(null) : maskInput.current?.click())}
                  >
                    {mask ? "移除蒙版" : "＋ 上传蒙版（可选）"}
                  </button>
                )}
                {mask && (
                  <span className="mask-indicator">
                    <Check size={12} /> 蒙版已就绪
                  </span>
                )}
              </div>
            )}
            <div className="prompt-row">
              <textarea
                ref={textarea}
                rows={2}
                maxLength={6000}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={
                  mode === "edit"
                    ? "描述你想改变什么，例如：将背景换成日落时分的海边…"
                    : "尽管想象。你想创造怎样的画面？"
                }
                aria-label="创作提示词"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void generate();
                  }
                }}
              />
            </div>
            {advanced && (
              <div className="advanced-panel">
                <div className="advanced-heading">
                  <strong>
                    <SlidersHorizontal size={14} /> 创作参数
                  </strong>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="关闭参数面板"
                    onClick={() => setAdvanced(false)}
                  >
                    <X size={15} />
                  </button>
                </div>
                {provider?.type === "gradio" ? (
                  <>
                    <label className="field">
                      反向提示词
                      <input
                        value={negativePrompt}
                        onChange={(e) => setNegativePrompt(e.target.value)}
                        placeholder="不希望出现的内容（由 Space 模板决定是否使用）"
                      />
                    </label>
                    <div className="advanced-fields">
                      <label className="field">
                        随机种子
                        <input
                          type="number"
                          min={-1}
                          max={2147483647}
                          value={seed}
                          onChange={(e) => setSeed(e.target.value)}
                          placeholder="随机"
                        />
                      </label>
                      <label className="field">
                        推理步数
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={steps}
                          onChange={(e) => setSteps(Number(e.target.value))}
                        />
                      </label>
                      <label className="field">
                        引导系数
                        <input
                          type="number"
                          min={0}
                          max={30}
                          step={0.1}
                          value={guidance}
                          onChange={(e) => setGuidance(Number(e.target.value))}
                        />
                      </label>
                    </div>
                  </>
                ) : (
                  <p className="help-text">
                    当前接口使用提示词、比例和张数。更多模型参数可在「提供商设置 →
                    扩展请求参数」配置。种子、反向提示词和步数仅用于 Gradio Space。
                  </p>
                )}
              </div>
            )}
            {submitError && (
              <div className="composer-error" role="alert">
                <AlertCircle size={14} />
                {submitError}
              </div>
            )}
            <div className="composer-bottom">
              <div className="composer-options">
                <button
                  type="button"
                  className="icon-button upload-button"
                  onClick={() => fileInput.current?.click()}
                  disabled={uploading}
                  title="上传参考图片"
                  aria-label="上传参考图片"
                >
                  {uploading ? (
                    <LoaderCircle size={18} className="spin" />
                  ) : (
                    <ImagePlus size={18} />
                  )}
                </button>
                <span className="composer-separator" />
                <label className="select-wrap ratio-select">
                  <span className="ratio-icon" style={{ aspectRatio: ratio.replace(":", " / ") }} />
                  <select
                    aria-label="图片比例"
                    value={ratio}
                    onChange={(e) => setRatio(e.target.value)}
                  >
                    {availableRatios.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                  <ChevronDown size={11} />
                </label>
                <label className="select-wrap count-select">
                  <Layers2 size={14} />
                  <select
                    aria-label="生成张数"
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4].map((n) => (
                      <option value={n} key={n}>
                        {n} 张
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={11} />
                </label>
                <button
                  className={`icon-button advanced-toggle ${advanced ? "selected" : ""}`}
                  type="button"
                  onClick={() => setAdvanced((s) => !s)}
                  title="创作参数"
                  aria-label="创作参数"
                >
                  <SlidersHorizontal size={16} />
                </button>
              </div>
              <div className="generation-actions">
                <label className="select-wrap model-select">
                  <span className={`model-dot ${provider ? "ready" : ""}`} />
                  <select
                    aria-label="选择模型提供商"
                    value={providerId}
                    onChange={(e) => setProviderId(e.target.value)}
                  >
                    <option value="" disabled>
                      连接你的模型
                    </option>
                    {providers
                      .filter((p) => p.enabled)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.supportsGenerate === false
                            ? "（仅编辑）"
                            : !p.supportsEdit
                              ? "（仅生成）"
                              : ""}
                        </option>
                      ))}
                  </select>
                  <ChevronDown size={11} />
                </label>
                <button
                  className="generate-button"
                  type="submit"
                  disabled={submitting || uploading || (Boolean(provider) && !prompt.trim())}
                >
                  {submitting ? <LoaderCircle size={17} className="spin" /> : <ArrowUp size={18} />}
                  <span>{provider ? "开始创作" : "连接模型"}</span>
                </button>
              </div>
            </div>
          </form>
          <div className="composer-footnote">
            <span>想象由你掌控，模型由你选择。</span>
            <span>Ctrl / ⌘ + Enter 生成</span>
          </div>
        </div>
      </main>
      <input
        hidden
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        hidden
        ref={maskInput}
        type="file"
        accept="image/png"
        onChange={(e) => {
          void upload(e.target.files?.[0], true);
          e.target.value = "";
        }}
      />
      {settings && (
        <Settings
          providers={providers}
          onClose={() => setSettings(false)}
          onRefresh={refreshProviders}
          notify={notify}
        />
      )}
      {detail && !detail.example && (
        <ImageThread
          key={detail.id}
          image={detail}
          images={images}
          focusImageId={focusImageId}
          jobs={jobs}
          providers={providers}
          providerId={providerId}
          followJob={threadJob}
          onProvider={setProviderId}
          onClose={() => {
            setDetail(null);
            setThreadJob("");
          }}
          onEdit={editInThread}
          onRetry={retryImage}
          onFavorite={favorite}
          onCancel={cancel}
          onSettings={() => setSettings(true)}
          onUsePrompt={usePrompt}
          onAdvanced={(image) => {
            setSource(image);
            setMask(null);
            setMode("edit");
            setPrompt("");
            setAdvanced(true);
            setDetail(null);
            setThreadJob("");
            textarea.current?.focus();
          }}
          onDelete={async (image) => {
            if (draftRequests.current.has(image.id)) {
              draftRequests.current.delete(image.id);
              setImages((all) => all.filter((i) => i.id !== image.id));
            } else await api(`/images/${image.id}`, json("DELETE"));
            if (source?.id === image.id) {
              setSource(null);
              setMask(null);
            }
            setDetail(null);
            setThreadJob("");
            await refreshWork();
            notify("图片已删除，其他版本已保留");
          }}
        />
      )}
      {detail?.example && (
        <Modal
          title={detail.example ? detail.name || "灵感参考" : "作品详情"}
          onClose={() => setDetail(null)}
          className="image-modal"
        >
          <div className="image-detail-layout">
            <div className="detail-image">
              <img src={detail.url} alt={detail.prompt} />
            </div>
            <div className="detail-info">
              <span className="eyebrow">{detail.example ? "INSPIRATION" : "YOUR CREATION"}</span>
              <h3>{detail.example ? "好画面，从一个想法开始" : "你的想象，已然成形"}</h3>
              <label className="section-label">提示词</label>
              <p className="detail-prompt">{detail.prompt}</p>
              <div className="detail-metadata">
                <span>
                  尺寸
                  <strong>
                    {detail.width} × {detail.height}
                  </strong>
                </span>
                <span>
                  {detail.example ? "类型" : "模型"}
                  <strong>{detail.example ? "摄影参考" : detail.providerName}</strong>
                </span>
                {!detail.example && (
                  <>
                    <span>
                      创建时间<strong>{formatDate(detail.createdAt)}</strong>
                    </span>
                    <span>
                      随机种子<strong>{detail.seed ?? "—"}</strong>
                    </span>
                  </>
                )}
              </div>
              {detail.example && (
                <p className="help-text">
                  灵感广场为 Unsplash 摄影参考，并非此工作区生成的图片。可复用提示词创作自己的版本。
                </p>
              )}
              <button className="primary-button full-width" onClick={() => usePrompt(detail)}>
                <WandSparkles size={16} /> 使用此提示词
              </button>
              {!detail.example && (
                <button className="secondary-button full-width" onClick={() => editImage(detail)}>
                  <ImagePlus size={16} /> 编辑这张图片
                </button>
              )}
              <div className="detail-actions">
                <button
                  className={`secondary-button ${isFavorite(detail) ? "selected" : ""}`}
                  onClick={() => favorite(detail)}
                >
                  <Heart size={15} fill={isFavorite(detail) ? "currentColor" : "none"} />
                  {isFavorite(detail) ? "已收藏" : "收藏"}
                </button>
                {!detail.example && (
                  <>
                    <a className="secondary-button" href={`${detail.url}?download=1`} download>
                      <Download size={15} />
                      下载
                    </a>
                    <button
                      className="icon-button danger"
                      aria-label="删除图片"
                      onClick={() => setDeleteId(detail.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </div>
              {deleteId === detail.id && (
                <div className="delete-confirm">
                  <p>永久删除这张图片？</p>
                  <button className="danger-button" disabled={detailBusy} onClick={deleteImage}>
                    确认删除
                  </button>
                  <button className="text-button" onClick={() => setDeleteId(null)}>
                    取消
                  </button>
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}
      {help && (
        <Modal title="从想象到画面" onClose={() => setHelp(false)} className="help-modal">
          <div className="help-content">
            <div className="help-step">
              <span>01</span>
              <div>
                <h3>连接你的模型</h3>
                <p>
                  在「提供商设置」选择 xAI、OpenAI 兼容服务或 Hugging Face Space，填写 API
                  地址、模型 ID 和密钥。保存并测试连接。
                </p>
              </div>
            </div>
            <div className="help-step">
              <span>02</span>
              <div>
                <h3>用文字描绘画面</h3>
                <p>
                  描述主体、环境、光线与风格，选择比例和生成张数。作品自动保存在服务端，可在作品库下载或收藏。
                </p>
              </div>
            </div>
            <div className="help-step">
              <span>03</span>
              <div>
                <h3>让图片继续生长</h3>
                <p>
                  切换「图片编辑」，上传参考图，或从作品详情选择「编辑这张图片」。用文字说明修改内容。编辑能力取决于所选模型。
                </p>
              </div>
            </div>
            <div className="help-callout">
              <strong>接入 Hugging Face Spaces</strong>
              <p>
                填写 Space URL 和
                Token，点击「自动读取并填写」即可生成配置。生成与编辑可以使用不同连接。免费 Space
                的休眠、排队和 GPU 配额由 Hugging Face 决定。
              </p>
            </div>
            <p className="help-text">
              这是单用户工作区：同一服务实例共享配置与作品。对外部署请在 .env 设置
              ADMIN_TOKEN，并通过 HTTPS 反向代理访问。当前版本聚焦图片生成和图片编辑。
            </p>
          </div>
        </Modal>
      )}
      {session && !session.authenticated && <Login onSuccess={loadSession} />}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
          <button className="icon-button" onClick={() => setToast("")} aria-label="关闭提示">
            <X size={13} />
          </button>
        </div>
      )}
      <KeyboardShortcut
        onNew={() => {
          setPrompt("");
          setSource(null);
          setMode("generate");
          textarea.current?.focus();
        }}
      />
    </div>
  );
}
function KeyboardShortcut({ onNew }: { onNew: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "k" &&
        !document.querySelector('[role="dialog"]')
      ) {
        e.preventDefault();
        onNew();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onNew]);
  return null;
}
function Empty({ view, onAction }: { view: string; onAction: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        {view === "favorites" ? (
          <Heart size={27} />
        ) : view === "history" ? (
          <History size={27} />
        ) : view === "search" ? (
          <Search size={27} />
        ) : (
          <ImageIcon size={27} />
        )}
      </div>
      <h3>
        {view === "favorites"
          ? "为喜欢的画面留一个位置"
          : view === "history"
            ? "你的创作故事，即将开始"
            : view === "search"
              ? "还没有找到相关画面"
              : "第一张作品，从这里开始"}
      </h3>
      <p>
        {view === "favorites"
          ? "点击图片上的爱心，把灵感与作品收藏到这里。"
          : view === "search"
            ? "换一个关键词，探索更多可能。"
            : "在下方描述想要的画面，让你的想象成为现实。"}
      </p>
      {view !== "search" && (
        <button className="secondary-button" onClick={onAction}>
          {view === "favorites" ? "探索灵感" : "开始创作"}
          <ArrowUpRight size={14} />
        </button>
      )}
    </div>
  );
}
function Login({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="欢迎回到 Imagine" className="login-modal">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api("/session", json("POST", { token }));
            onSuccess();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="help-text">输入此工作区的访问令牌（ADMIN_TOKEN）。</p>
        <label className="field">
          访问令牌
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoFocus
          />
        </label>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary-button full-width" disabled={busy}>
          {busy && <LoaderCircle size={15} className="spin" />}进入创作空间
          <ArrowUpRight size={16} />
        </button>
      </form>
    </Modal>
  );
}
