import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
  FolderPlus,
  MoreHorizontal,
} from "lucide-react";
import { Modal } from "./Modal";
import { ImagePlaceholder } from "./ImagePlaceholder";
import { ImageZoomViewer } from "./ImageZoomViewer";
import { ReferenceImages } from "./ReferenceImages";
import { AssetBrowser } from "./AssetBrowser";
import { ImagePress } from "../shared/image-press.mjs";
import { applyInputReplacements, replacementSlotId } from "../shared/input-replacements.mjs";
import { validateReferences } from "../shared/references.mjs";
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
  initialDraft?: { sourceId: string; prompt: string; images: ImageItem[] };
  onSizeSettings: (value: SizeSettings) => void;
  followJob?: string;
  onProvider: (id: string) => void;
  onClose: () => void;
  onRetry: (image: ImageItem) => Promise<Job>;
  onEdit: (image: ImageItem, prompt: string, settings: CreationSettings) => Promise<Job>;
  onFavorite: (image: ImageItem) => Promise<void>;
  onCancel: (job: Job) => Promise<void>;
  onSettings: () => void;
  onSaveToLibrary: (image: ImageItem) => void;
  onUsePrompt: (image: ImageItem) => void;
  onAdvanced: (image: ImageItem) => void;
  onDelete: (image: ImageItem) => Promise<void>;
};

export function ImageThread(props: Props) {
  const mobile = useMobileScreen();
  const [zoomedImage, setZoomedImage] = useState<ImageItem | null>(null);
  const zoomActive = useRef(false);
  zoomActive.current = Boolean(zoomedImage);
  const imagePress = useRef(new ImagePress());
  const [actionImage, setActionImage] = useState<ImageItem | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<ImageItem | null>(null);
  const [replacements, setReplacements] = useState<Record<string, ImageItem>>({});
  const [editingReference, setEditingReference] = useState<string | null>(null);
  const preserveSelection = useRef(false);
  const submittedReplacements = useRef<string | null>(null);
  useEffect(() => () => imagePress.current.cancel(), []);
  const provider = props.providers.find((p) => p.id === props.providerId);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionError, setOptionError] = useState("");
  const [uploadingMask, setUploadingMask] = useState(false);
  const [references, setReferences] = useState<ImageItem[]>(
    () => props.initialDraft?.images.slice(1) || [],
  );
  const compositionBase = useRef(props.image.id);
  const [uploadingReferences, setUploadingReferences] = useState(false);
  const [referenceMode, setReferenceMode] = useState<"reference" | "swap">("reference");
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
  const [threadItems, setItems] = useState<ImageItem[]>(
    () => props.initialDraft?.images || [props.image],
  );
  const items = useMemo(
    () => applyInputReplacements(threadItems, replacements),
    [threadItems, replacements],
  );
  const [selected, setSelected] = useState(props.image.id);
  const [prompt, setPrompt] = useState(props.initialDraft?.prompt || "");
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
  const referencePreview = Boolean(
    (current.referenceContext ||
      (current.id !== compositionBase.current &&
        references.some((image) => image.id === current.id))) &&
    editingReference !== current.id,
  );
  const visiblePrompt = current.referenceContext?.prompt || current.prompt;
  const ready = !current.status || current.status === "succeeded";
  const failed = current.status === "failed" || current.status === "cancelled";
  const currentJob = props.jobs.find((j) => j.id === current.jobId);
  const currentActive = currentJob && ["queued", "running"].includes(currentJob.status);
  const position = useRef({ items, selected });
  const previousSelection = useRef(selected);
  position.current = { items, selected };
  useEffect(() => {
    setConfirmDelete(false);
    setMask(null);
    if (previousSelection.current !== selected) {
      const draftInputIds = [compositionBase.current, ...references.map((image) => image.id)];
      const browsingDraftInputs =
        draftInputIds.includes(selected) && draftInputIds.includes(previousSelection.current);
      if (!browsingDraftInputs && !preserveSelection.current) {
        setReferences([]);
        setReferenceMode("reference");
        compositionBase.current = selected;
      }
      if (!preserveSelection.current) setEditingReference(null);
      preserveSelection.current = false;
      previousSelection.current = selected;
    }
    setOptionError("");
  }, [selected]);
  useEffect(() => {
    if (pendingId) return;
    const running = props.jobs.find(
      (job) =>
        ["queued", "running"].includes(job.status) &&
        items.some((image) => !image.referenceContext && image.id === job.sourceId),
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
          if (!disposed) {
            setItems(mergeLocal(data));
            if (
              submittedReplacements.current &&
              data.some((image) => image.jobId === submittedReplacements.current)
            ) {
              setReplacements({});
              submittedReplacements.current = null;
            }
          }
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
    if (!props.focusImageId || zoomActive.current) return;
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
  function openReplacement(image: ImageItem) {
    imagePress.current.cancel();
    setActionImage(null);
    setOptionsOpen(false);
    setReplaceTarget(image);
  }
  function replaceImage(target: ImageItem, replacement: ImageItem) {
    if (busy || active || currentActive || uploadingReferences || uploadingMask) {
      setError("请等待当前任务结束后再替换参考图");
      setReplaceTarget(null);
      return;
    }
    const slotId = replacementSlotId(replacements, target.id);
    const existingSlot = threadItems.some((image) => image.id === slotId);
    if (!existingSlot && !references.some((image) => image.id === target.id)) {
      setError("这张图片已不在当前工作台中，请重新选择");
      setReplaceTarget(null);
      return;
    }
    if (existingSlot) setReplacements((all) => ({ ...all, [slotId]: replacement }));
    if (compositionBase.current === target.id) compositionBase.current = replacement.id;
    setReferences((all) => all.map((image) => (image.id === target.id ? replacement : image)));
    setMask(null);
    setError("");
    setOptionError("");
    setReplaceTarget(null);
    if (selected === target.id) {
      preserveSelection.current = true;
      if (editingReference === target.id) setEditingReference(replacement.id);
      focusSlide.current = replacement.id;
      setSelected(replacement.id);
    }
  }
  function editReference(image: ImageItem) {
    if (busy || active || currentActive || uploadingReferences || uploadingMask) {
      setError("请等待当前任务结束后再编辑参考图");
      return;
    }
    imagePress.current.cancel();
    setActionImage(null);
    setOptionsOpen(false);
    preserveSelection.current = selected !== image.id;
    compositionBase.current = image.id;
    setEditingReference(image.id);
    setSelected(image.id);
    focusSlide.current = image.id;
    setReferences([]);
    setReferenceMode("reference");
    setMask(null);
    setPrompt("");
    setError("");
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
    if (
      !prompt.trim() ||
      busy ||
      uploadingMask ||
      uploadingReferences ||
      active ||
      !ready ||
      referencePreview
    )
      return;
    setBusy(true);
    setError("");
    try {
      validateCreationSettings(settings);
      validateReferences(
        provider,
        current.id,
        references.map((i) => i.id),
        referenceMode,
      );
      const job = await props.onEdit(current, prompt.trim(), {
        ...settings,
        threadAnchorId: props.image.id,
        referenceIds: references.map((i) => i.id),
        referenceMode,
        maskId: mask?.sourceId === current.id ? mask.image.id : undefined,
      });
      setPendingId(job.id);
      submittedReplacements.current = job.id;
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
  let versionNumber = -1;
  const versionNumbers = items.map((image) => (image.referenceContext ? -1 : ++versionNumber));
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
          <span>
            {image.referenceInput && image.referenceInput.number > 1
              ? `参${image.referenceInput.number}`
              : image.referenceContext
                ? `参${image.referenceContext.number}`
                : versionNumbers[i] === 0
                  ? "原图"
                  : versionNumbers[i]}
          </span>
        </button>
      ))}
    </div>
  );
  const imageDetails = (
    <>
      <span className="eyebrow">YOUR CREATIVE JOURNEY</span>
      <h3>
        {current.referenceContext
          ? `参考图 Image ${current.referenceContext.number}`
          : current.kind === "upload"
            ? "从这张原图开始"
            : "每一步想象，都在这里"}
      </h3>
      <div className="thread-prompt" aria-live="polite">
        <label className="section-label">
          {current.referenceContext ? "使用此参考图的编辑提示词" : "当前图片的提示词"}
        </label>
        <p>{current.referenceContext?.prompt || current.prompt || "上传原图，尚未使用提示词"}</p>
        {visiblePrompt && (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              if (mobile) {
                setPrompt(visiblePrompt);
                setOptionsOpen(false);
              } else props.onUsePrompt({ ...current, prompt: visiblePrompt });
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
          disabled={!ready || current.localDraft}
          onClick={() => props.onSaveToLibrary(current)}
        >
          <FolderPlus size={16} />
          保存到素材库
        </button>
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
      {ready && !referencePreview && (
        <ReferenceImages
          key={current.id}
          source={current}
          provider={provider}
          images={props.images}
          value={references}
          onChange={(value) => {
            setReferences(value);
            if (value.length) setMask(null);
          }}
          mode={referenceMode}
          onMode={setReferenceMode}
          onBusy={setUploadingReferences}
          onReplace={openReplacement}
        />
      )}
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
      {!referencePreview && !references.length && provider?.type !== "xai" && (
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
          {current.referenceContext ? "以此参考图开始新创作" : "返回完整创作面板"}
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
                    <>
                      <button
                        type="button"
                        className="thread-image-open"
                        aria-label="放大查看图片"
                        tabIndex={image.id === selected ? 0 : -1}
                        onPointerDown={(event) => {
                          if (event.pointerType === "mouse" && event.button !== 0) return;
                          if (event.isPrimary)
                            imagePress.current.start(
                              event.pointerId,
                              { x: event.clientX, y: event.clientY },
                              () => setActionImage(image),
                            );
                          else imagePress.current.cancel();
                        }}
                        onPointerMove={(event) => {
                          imagePress.current.move(event.pointerId, {
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                        onPointerUp={() => imagePress.current.stop()}
                        onPointerLeave={() => {
                          if (imagePress.current.active) imagePress.current.cancel();
                        }}
                        onPointerCancel={() => imagePress.current.cancel()}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          imagePress.current.cancel();
                          setActionImage(image);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            imagePress.current.stop();
                            imagePress.current.blocked = false;
                          }
                        }}
                        onClick={(event) => {
                          if (
                            actionImage ||
                            replaceTarget ||
                            (event.detail !== 0 && imagePress.current.blocked)
                          )
                            return;
                          setSelected(image.id);
                          const slide = items.findIndex((item) => item.id === image.id);
                          track.current?.scrollTo({
                            left: (track.current?.clientWidth || 0) * slide,
                            behavior: "instant",
                          });
                          setZoomedImage(image);
                        }}
                      >
                        <img
                          src={image.url}
                          alt={image.prompt || image.name || "原始图片"}
                          draggable={false}
                        />
                        <span className="thread-image-zoom-hint">轻点放大 · 长按操作</span>
                      </button>
                      <button
                        type="button"
                        className="thread-image-actions icon-button"
                        aria-label="图片操作：替换或编辑"
                        onClick={() => {
                          imagePress.current.cancel();
                          setActionImage(image);
                        }}
                      >
                        <MoreHorizontal size={20} />
                      </button>
                    </>
                  )}
                  <figcaption>
                    {image.referenceInput
                      ? `参考图 Image ${image.referenceInput.number}`
                      : image.referenceContext
                        ? `参考图 Image ${image.referenceContext.number}`
                        : image.kind === "upload"
                          ? "上传原图"
                          : image.parentId
                            ? `编辑版本 ${versionNumbers[i]}`
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
                {visiblePrompt || "上传原图"}
              </p>
            )}
            <form className="thread-editor" onSubmit={submit}>
              <label className="section-label" htmlFor="thread-edit-prompt">
                {referencePreview ? "正在查看参考输入" : `基于当前第 ${index + 1} 张继续编辑`}
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
                disabled={busy || uploadingMask || !!active || !ready || referencePreview}
              />
              {(current.referenceContext || referencePreview) && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    navigate(
                      items.findIndex(
                        (image) =>
                          image.id ===
                          (replacements[
                            current.referenceContext?.resultId || compositionBase.current
                          ]?.id ||
                            current.referenceContext?.resultId ||
                            compositionBase.current),
                      ),
                    )
                  }
                >
                  {current.referenceContext?.jobId ? "返回此任务的编辑结果" : "返回主参考图"}
                </button>
              )}
              {referencePreview && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || !!active}
                  onClick={() => editReference(current)}
                >
                  单独编辑这张参考图
                </button>
              )}
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
                    <span>{references.length ? `设置 · ${references.length + 1} 图` : "设置"}</span>
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
                      uploadingReferences ||
                      !!active ||
                      !ready ||
                      referencePreview ||
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
      {zoomedImage && (
        <ImageZoomViewer
          key={zoomedImage.id}
          image={zoomedImage}
          onClose={() => setZoomedImage(null)}
        />
      )}
      {actionImage && (
        <Modal
          title="图片操作"
          className="thread-image-menu"
          backdropClassName="thread-action-backdrop"
          onClose={() => setActionImage(null)}
        >
          <img
            src={actionImage.thumbnail || actionImage.url}
            alt={actionImage.name || "当前图片"}
          />
          <button
            type="button"
            className="primary-button"
            disabled={busy || !!active || !!currentActive || uploadingReferences || uploadingMask}
            onClick={() => openReplacement(actionImage)}
          >
            <ImagePlus size={18} />
            从素材库替换此图
          </button>
          {actionImage.referenceContext && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy || !!active}
              onClick={() => editReference(actionImage)}
            >
              单独编辑这张参考图
            </button>
          )}
          <p className="help-text">
            替换会用于下一次编辑，保留提示词及其他参考图；已生成的结果和原图记录会保留。
          </p>
        </Modal>
      )}
      {replaceTarget && (
        <Modal
          title="从素材库选择替换图片"
          className="thread-asset-picker"
          onClose={() => setReplaceTarget(null)}
        >
          <AssetBrowser
            useLabel="选择这张图片替换"
            onManage={props.onSettings}
            onUse={(image) => replaceImage(replaceTarget, image)}
          />
        </Modal>
      )}
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
