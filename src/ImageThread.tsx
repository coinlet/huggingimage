import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Heart,
  LoaderCircle,
  Sparkles,
  Trash2,
  Settings2,
  ImagePlus,
} from "lucide-react";
import { Modal } from "./Modal";
import { ImagePlaceholder } from "./ImagePlaceholder";
import { CreationOptions, validateCreationSettings } from "./CreationOptions";
import { useMobileScreen } from "./useMobileScreen";
import type { SizeSettings } from "../shared/resolution.mjs";
import { api, json, type CreationSettings, type ImageItem, type Job, type Provider } from "./types";

type Props = {
  image: ImageItem;
  images: ImageItem[];
  focusImageId: string;
  jobs: Job[];
  providers: Provider[];
  providerId: string;
  sizeSettings: SizeSettings;
  initialSettings: CreationSettings;
  onSizeSettings: (value: SizeSettings) => void;
  followJob?: string;
  onProvider: (id: string) => void;
  onClose: () => void;
  onRetry: (image: ImageItem) => Promise<Job>;
  onEdit: (image: ImageItem, prompt: string, settings: CreationSettings) => Promise<Job>;
  onFavorite: (image: ImageItem) => Promise<void>;
  onCancel: (job: Job) => Promise<void>;
  onSettings: () => void;
  onUsePrompt: (image: ImageItem) => void;
  onAdvanced: (image: ImageItem) => void;
  onDelete: (image: ImageItem) => Promise<void>;
};

export function ImageThread(props: Props) {
  const mobile = useMobileScreen();
  const provider = props.providers.find((p) => p.id === props.providerId);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionError, setOptionError] = useState("");
  const [uploadingMask, setUploadingMask] = useState(false);
  const [mask, setMask] = useState<{ sourceId: string; image: ImageItem } | null>(null);
  const [settings, setSettings] = useState<CreationSettings>(() => ({
    ...props.initialSettings,
    steps: provider?.defaults?.edit?.steps ?? props.initialSettings.steps,
    guidance: provider?.defaults?.edit?.guidance ?? props.initialSettings.guidance,
  }));
  useEffect(() => {
    setSettings((previous) => ({
      ...previous,
      steps: provider?.defaults?.edit?.steps ?? props.initialSettings.steps,
      guidance: provider?.defaults?.edit?.guidance ?? props.initialSettings.guidance,
      ratio:
        provider?.type === "openai" && !["1:1", "3:2", "2:3"].includes(previous.ratio)
          ? "1:1"
          : previous.ratio,
    }));
  }, [props.providerId, provider?.defaults?.edit?.steps, provider?.defaults?.edit?.guidance]);
  const [items, setItems] = useState<ImageItem[]>([props.image]);
  const [selected, setSelected] = useState(props.image.id);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingId, setPendingId] = useState(props.followJob || "");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!mobile) setOptionsOpen(false);
  }, [mobile]);
  const track = useRef<HTMLDivElement>(null);
  const focusSlide = useRef(props.image.id);
  const pending = props.jobs.find((j) => j.id === pendingId);
  const active = pending && ["queued", "running"].includes(pending.status);
  const index = Math.max(
    0,
    items.findIndex((i) => i.id === selected),
  );
  const current = items[index];
  const ready = !current.status || current.status === "succeeded";
  const failed = current.status === "failed" || current.status === "cancelled";
  const currentJob = props.jobs.find((j) => j.id === current.jobId);
  const currentActive = currentJob && ["queued", "running"].includes(currentJob.status);
  const position = useRef({ items, selected });
  position.current = { items, selected };
  useEffect(() => {
    setConfirmDelete(false);
    setMask(null);
    setOptionError("");
  }, [selected]);
  useEffect(() => {
    if (pendingId) return;
    const running = props.jobs.find(
      (job) =>
        ["queued", "running"].includes(job.status) &&
        items.some((image) => image.id === job.sourceId),
    );
    if (running) setPendingId(running.id);
  }, [props.jobs, items, pendingId]);

  useEffect(() => {
    let disposed = false;
    const anchor = props.images.find((i) => i.id === props.image.id) || props.image;
    const local = props.images.filter((i) => i.localDraft && i.threadId === anchor.threadId);
    const mergeLocal = (data: ImageItem[]) => [
      ...data.filter((i) => !local.some((d) => d.id === i.id)),
      ...local,
    ];
    setItems((previous) => mergeLocal(previous));
    if (!anchor.localDraft) {
      api<ImageItem[]>(`/images/${props.image.id}/thread`)
        .then((data) => {
          if (!disposed) setItems(mergeLocal(data));
        })
        .catch((e) => {
          if (!disposed) setError(e.message);
        });
    }
    if (pending && !["queued", "running"].includes(pending.status)) setPendingId("");
    return () => {
      disposed = true;
    };
  }, [props.image.id, props.images, props.jobs, pending, reload]);

  useEffect(() => {
    if (!props.focusImageId) return;
    const target = props.images.find((i) => i.id === props.focusImageId);
    if (target?.threadId !== props.image.threadId) return;
    focusSlide.current = props.focusImageId;
    setSelected(props.focusImageId);
  }, [props.focusImageId, props.image.threadId]);

  useEffect(() => {
    const target = items.findIndex((i) => i.id === focusSlide.current);
    if (target < 0 || !track.current) return;
    track.current.scrollTo({ left: track.current.clientWidth * target, behavior: "instant" });
    focusSlide.current = "";
  }, [items, props.focusImageId]);

  function navigate(next: number) {
    const slide = Math.max(0, Math.min(items.length - 1, next));
    setSelected(items[slide].id);
    track.current?.scrollTo({ left: track.current.clientWidth * slide, behavior: "smooth" });
  }
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    const observer = new ResizeObserver(() => {
      const selectedIndex = position.current.items.findIndex(
        (i) => i.id === position.current.selected,
      );
      element.scrollTo({
        left: element.clientWidth * Math.max(0, selectedIndex),
        behavior: "instant",
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || busy || uploadingMask || active || !ready) return;
    setBusy(true);
    setError("");
    try {
      validateCreationSettings(settings);
      const job = await props.onEdit(current, prompt.trim(), {
        ...settings,
        maskId: mask?.sourceId === current.id ? mask.image.id : undefined,
      });
      setPendingId(job.id);
      setPrompt("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    setBusy(true);
    setError("");
    try {
      const job = await props.onRetry(current);
      setPendingId(job.id);
    } catch (e) {
      setError((e as Error).message);
      setOptionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function uploadMask(file: File | undefined) {
    if (!file) return;
    if (file.type !== "image/png" || file.size > 12 * 1024 * 1024) {
      setOptionError("请上传 12MB 以内的 PNG 蒙版");
      return;
    }
    setUploadingMask(true);
    setOptionError("");
    const sourceImage = current;
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取蒙版失败"));
        reader.readAsDataURL(file);
      });
      const image = await api<ImageItem>("/uploads", json("POST", { data, name: file.name }));
      if (image.width !== sourceImage.width || image.height !== sourceImage.height)
        throw new Error("蒙版尺寸必须与当前图片一致");
      setMask({ sourceId: sourceImage.id, image });
    } catch (e) {
      setOptionError((e as Error).message);
    } finally {
      setUploadingMask(false);
    }
  }
  const thumbnails = (
    <div className="thread-thumbnails" aria-label="全部版本">
      {items.map((image, i) => (
        <button
          key={image.id}
          type="button"
          className={image.id === selected ? "active" : ""}
          onClick={() => {
            navigate(i);
            if (mobile) setOptionsOpen(false);
          }}
          aria-label={`查看第 ${i + 1} 张`}
          aria-pressed={image.id === selected}
        >
          {image.status && image.status !== "succeeded" ? (
            <span
              className={`thumbnail-state ${image.status === "failed" || image.status === "cancelled" ? "failed" : ""}`}
            >
              {image.status === "failed" || image.status === "cancelled" ? "!" : "…"}
            </span>
          ) : (
            <img src={image.thumbnail} alt="" />
          )}
          <span>{i === 0 ? "原图" : i}</span>
        </button>
      ))}
    </div>
  );
  const imageDetails = (
    <>
      <span className="eyebrow">YOUR CREATIVE JOURNEY</span>
      <h3>{current.kind === "upload" ? "从这张原图开始" : "每一步想象，都在这里"}</h3>
      <div className="thread-prompt" aria-live="polite">
        <label className="section-label">当前图片的提示词</label>
        <p>{current.prompt || "上传原图，尚未使用提示词"}</p>
        {current.prompt && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              if (mobile) {
                setPrompt(current.prompt);
                setOptionsOpen(false);
              } else props.onUsePrompt(current);
            }}
          >
            复用此提示词
          </button>
        )}
        {current.parentId && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              navigate(items.findIndex((i) => i.id === current.parentId));
              if (mobile) setOptionsOpen(false);
            }}
            disabled={!items.some((i) => i.id === current.parentId)}
          >
            查看编辑前的图片
          </button>
        )}
      </div>
      <div className="detail-metadata">
        <span>
          尺寸
          <strong>
            {current.width} × {current.height}
          </strong>
        </span>
        <span>
          模型<strong>{current.providerName || "本地上传"}</strong>
        </span>
        <span>
          创建时间<strong>{new Date(current.createdAt).toLocaleString("zh-CN")}</strong>
        </span>
        {current.seed !== undefined && (
          <span>
            随机种子<strong>{current.seed}</strong>
          </span>
        )}
      </div>
      {failed && (
        <button type="button" className="primary-button full-width" disabled={busy} onClick={retry}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />} 重试这张图片
        </button>
      )}
      {currentActive && (
        <button
          type="button"
          className="secondary-button"
          onClick={() => props.onCancel(currentJob)}
        >
          取消生成
        </button>
      )}
      <div className="detail-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={!ready}
          onClick={async () => {
            await props.onFavorite(current);
            setReload((n) => n + 1);
          }}
        >
          <Heart size={15} fill={current.favorite ? "currentColor" : "none"} />
          {current.favorite ? "已收藏" : "收藏"}
        </button>
        {ready && (
          <a className="secondary-button" href={`${current.url}?download=1`} download>
            <Download size={15} /> 下载
          </a>
        )}
        <button
          type="button"
          className="icon-button danger"
          disabled={!ready && !failed}
          aria-label="删除当前图片"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 size={16} />
        </button>
      </div>
      {confirmDelete && (
        <div className="delete-confirm">
          <p>永久删除当前图片？其他版本会保留。</p>
          <button
            type="button"
            className="danger-button"
            disabled={deleting}
            onClick={async () => {
              setDeleting(true);
              try {
                await props.onDelete(current);
              } catch (e) {
                setError((e as Error).message);
                setOptionError((e as Error).message);
              } finally {
                setDeleting(false);
              }
            }}
          >
            确认删除
          </button>
          <button type="button" className="text-button" onClick={() => setConfirmDelete(false)}>
            取消
          </button>
        </div>
      )}
    </>
  );
  const options = (
    <>
      <CreationOptions
        providers={props.providers}
        providerId={props.providerId}
        onProvider={props.onProvider}
        settings={settings}
        onChange={setSettings}
        size={props.sizeSettings}
        onSize={props.onSizeSettings}
        onProvidersSettings={props.onSettings}
        expanded={mobile}
      />
      {provider?.type !== "xai" && (
        <div className="thread-mask-settings">
          <label className="secondary-button">
            <ImagePlus size={16} />
            {uploadingMask ? "正在上传蒙版…" : "上传蒙版（可选）"}
            <input
              className="visually-hidden"
              type="file"
              accept="image/png"
              disabled={!ready || uploadingMask}
              aria-label="上传编辑蒙版"
              onChange={(e) => {
                void uploadMask(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          {mask?.sourceId === current.id && (
            <button type="button" className="text-button" onClick={() => setMask(null)}>
              移除蒙版
            </button>
          )}
          <p className="help-text">蒙版需与当前图片尺寸一致，且模型支持蒙版编辑。</p>
        </div>
      )}
      {optionError && (
        <p className="inline-error" role="alert">
          {optionError}
        </p>
      )}
      {!mobile && (
        <button
          type="button"
          className="text-button"
          disabled={!ready}
          onClick={() => props.onAdvanced(current)}
        >
          返回完整创作面板
        </button>
      )}
    </>
  );
  return (
    <>
      <Modal title="连续创作" className="thread-modal" onClose={props.onClose}>
        <div
          className="thread-layout"
          onKeyDown={(e) => {
            if ((e.target as HTMLElement).closest("input,textarea,select,button,a")) return;
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              navigate(index + (e.key === "ArrowLeft" ? -1 : 1));
            }
          }}
        >
          <div className="thread-gallery">
            <div
              className="thread-slides"
              ref={track}
              tabIndex={0}
              aria-label="图片版本，左右滑动或使用方向键切换"
              onScroll={(e) => {
                const el = e.currentTarget;
                const slide = Math.round(el.scrollLeft / el.clientWidth);
                if (items[slide]) setSelected(items[slide].id);
              }}
            >
              {items.map((image, i) => (
                <figure className="thread-slide" key={image.id}>
                  {image.status && image.status !== "succeeded" ? (
                    <ImagePlaceholder
                      image={image}
                      preview={items.find((i) => i.id === image.parentId)?.thumbnail}
                    />
                  ) : (
                    <img
                      src={image.url}
                      alt={image.prompt || image.name || "原始图片"}
                      draggable={false}
                    />
                  )}
                  <figcaption>
                    {image.kind === "upload"
                      ? "上传原图"
                      : image.parentId
                        ? `编辑版本 ${i}`
                        : "初始作品"}
                  </figcaption>
                </figure>
              ))}
            </div>
            <div className="thread-navigation">
              <button
                className="icon-button"
                aria-label="上一个版本"
                disabled={index === 0}
                onClick={() => navigate(index - 1)}
              >
                <ChevronLeft size={20} />
              </button>
              <span aria-live="polite">
                {index + 1} / {items.length} · 左右滑动查看
              </span>
              <button
                className="icon-button"
                aria-label="下一个版本"
                disabled={index === items.length - 1}
                onClick={() => navigate(index + 1)}
              >
                <ChevronRight size={20} />
              </button>
            </div>
            {!mobile && thumbnails}
          </div>
          <div className="thread-info">
            {!mobile && imageDetails}
            {mobile && (
              <p className="mobile-current-prompt" aria-live="polite">
                <span>当前提示词：</span>
                {current.prompt || "上传原图"}
              </p>
            )}
            <form className="thread-editor" onSubmit={submit}>
              <label className="section-label" htmlFor="thread-edit-prompt">
                基于当前第 {index + 1} 张继续编辑
                {mask?.sourceId === current.id ? " · 蒙版已启用" : ""}
              </label>
              <textarea
                id="thread-edit-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="描述你想修改的地方…"
                maxLength={6000}
                rows={mobile ? 2 : 4}
                required
                disabled={busy || uploadingMask || !!active || !ready}
              />
              {!mobile && options}
              {error && (
                <p className="thread-error" role="alert">
                  {error}
                </p>
              )}
              {active && (
                <div className="thread-progress" role="status">
                  <LoaderCircle size={16} className="spin" />
                  {pending.status === "queued"
                    ? "编辑任务排队中"
                    : "正在编辑，完成后自动显示新版本"}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => props.onCancel(pending)}
                  >
                    取消
                  </button>
                </div>
              )}
              <div className="thread-submit-bar">
                {mobile && (
                  <button
                    type="button"
                    className="secondary-button thread-options-button"
                    aria-label="创作设置"
                    aria-haspopup="dialog"
                    aria-expanded={optionsOpen}
                    onClick={() => {
                      setOptionError("");
                      setOptionsOpen(true);
                    }}
                  >
                    <Settings2 size={20} />
                    <span>设置</span>
                  </button>
                )}
                {mobile && (currentActive || active) && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => props.onCancel(currentActive ? currentJob : pending!)}
                  >
                    取消
                  </button>
                )}
                {mobile && failed ? (
                  <button
                    type="button"
                    className="primary-button full-width"
                    disabled={busy}
                    onClick={retry}
                  >
                    {busy ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{" "}
                    重试这张图片
                  </button>
                ) : (
                  <button
                    className="primary-button full-width"
                    disabled={
                      busy ||
                      uploadingMask ||
                      !!active ||
                      !ready ||
                      !prompt.trim() ||
                      !provider?.enabled ||
                      !provider.supportsEdit
                    }
                  >
                    {busy || currentActive ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <Sparkles size={16} />
                    )}{" "}
                    {currentActive ? "正在生成" : "继续编辑"}
                  </button>
                )}
              </div>
              <p className="help-text thread-editor-hint">
                所有版本都会保留，也可以切回之前的图片继续创作。
              </p>
            </form>
          </div>
        </div>
      </Modal>
      {mobile && optionsOpen && (
        <Modal
          title="创作设置"
          className="thread-settings-modal"
          backdropClassName="thread-settings-backdrop"
          onClose={() => setOptionsOpen(false)}
        >
          <form
            id="thread-settings-form"
            className="thread-settings-content"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                validateCreationSettings(settings);
                setOptionsOpen(false);
              } catch (e) {
                setOptionError((e as Error).message);
              }
            }}
          >
            {options}
            <details className="thread-image-details">
              <summary>当前图片与提示词</summary>
              {imageDetails}
            </details>
            <details className="thread-version-settings">
              <summary>全部版本（{items.length}）</summary>
              {thumbnails}
            </details>
          </form>
          <div className="thread-settings-footer">
            <button
              type="submit"
              form="thread-settings-form"
              className="primary-button full-width"
              disabled={uploadingMask}
            >
              完成设置
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
