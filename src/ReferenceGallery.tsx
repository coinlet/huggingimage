import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Dices,
  Lock,
  Unlock,
  Search,
  X,
  Plus,
  Eye,
  Upload,
  RefreshCw,
  LoaderCircle,
} from "lucide-react";
import { Modal } from "./Modal";
import { ImageZoomViewer } from "./ImageZoomViewer";
import { api, json, type ImageItem } from "./types";
import {
  STYLE_PRESETS,
  RECIPE_SLOTS,
  SLOT_LABELS,
  emptyGalleryRecipe,
  recipeReferences,
  buildGalleryPrompt,
  randomGalleryRecipe,
  type GalleryKind,
  type GalleryItem,
  type GalleryRecipe,
  type GalleryImage,
} from "../shared/gallery-recipe.mjs";

type Catalog = {
  items: GalleryItem[];
  localAvailable: boolean;
  counts: Record<GalleryKind, number>;
};
type Preview = { items: GalleryItem[]; index: number; variant: string; depth: boolean };
const kinds: GalleryKind[] = ["pose", "costume", "portrait"];

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function viewImage(item: GalleryItem, variant: string, depth: boolean): GalleryImage {
  return depth && item.depth
    ? item.depth
    : item.variants.find((image) => image.id === variant) || item.variants[0];
}

export function ReferenceGallery({
  active,
  onTransfer,
}: {
  active: boolean;
  onTransfer: (images: ImageItem[], prompt: string) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [recipe, setRecipe] = useState<GalleryRecipe>(emptyGalleryRecipe);
  const [kind, setKind] = useState<GalleryKind>("pose");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [source, setSource] = useState("");
  const [system, setSystem] = useState("");
  const [angle, setAngle] = useState("");
  const [hair, setHair] = useState("");
  const [portraitSet, setPortraitSet] = useState("");
  const [grouped, setGrouped] = useState(true),
    [depth, setDepth] = useState(false);
  const [shown, setShown] = useState(60);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [saveState, setSaveState] = useState(""),
    [savingError, setSavingError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [zoom, setZoom] = useState<ImageItem | null>(null);
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [poseChoices, setPoseChoices] = useState<Record<string, string>>({});
  const [recipeOpen, setRecipeOpen] = useState(false),
    [exporting, setExporting] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const alive = useRef(true),
    loaded = useRef(false);
  const latest = useRef(recipe),
    pending = useRef<GalleryRecipe | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef(Promise.resolve());
  const importInput = useRef<HTMLInputElement>(null);

  function flush() {
    clearTimeout(timer.current);
    const value = pending.current;
    if (!value) return queue.current;
    pending.current = null;
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        try {
          await api("/reference-gallery/recipe", { ...json("PUT", value), keepalive: true });
          if (alive.current && latest.current === value) {
            setSaveState("已保存到工作区");
            setSavingError("");
          }
        } catch (e) {
          if (!pending.current) pending.current = latest.current;
          if (alive.current) {
            setSavingError((e as Error).message);
            setSaveState("保存失败");
          }
        }
      });
    return queue.current;
  }
  function update(next: GalleryRecipe) {
    latest.current = next;
    pending.current = next;
    setRecipe(next);
    setSaveState("正在保存…");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 300);
  }
  useEffect(() => {
    alive.current = true;
    const hide = () => {
      void flush();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive.current = false;
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", visibility);
      void flush();
    };
  }, []);
  useEffect(() => {
    if (!active || loaded.current) return;
    let disposed = false;
    setLoading(true);
    setError("");
    Promise.all([
      api<Catalog>("/reference-gallery/catalog"),
      api<GalleryRecipe>("/reference-gallery/recipe"),
    ])
      .then(([data, saved]) => {
        if (disposed) return;
        setCatalog(data);
        setRecipe(saved);
        latest.current = saved;
        loaded.current = true;
        setSaveState("已保存到工作区");
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [active, attempt]);
  useEffect(() => {
    setShown(60);
  }, [kind, query, category, source, system, angle, hair, portraitSet, grouped, recipe.safeMode]);
  const items = catalog?.items || [];
  const lookup = useMemo(() => new Map(items.map((item) => [item.id, item])), [catalog]);
  const references = useMemo(() => recipeReferences(recipe, lookup), [recipe, lookup]);
  const prompt = useMemo(() => buildGalleryPrompt(recipe, lookup), [recipe, lookup]);
  const pool = useMemo(
    () => items.filter((item) => item.kind === kind && (!recipe.safeMode || !item.sensitive)),
    [catalog, kind, recipe.safeMode],
  );
  const categories = [
    ...new Set(
      pool.filter((item) => !system || item.system === system).map((item) => item.category),
    ),
  ];
  const sources = [...new Map(pool.map((item) => [item.source, item.sourceLabel])).entries()];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pool.filter(
      (item) =>
        (!q || `${item.title} ${item.search} ${item.id}`.toLowerCase().includes(q)) &&
        (!category || item.category === category) &&
        (!source || item.source === source) &&
        (!system || item.system === system) &&
        (!angle || item.angle === angle) &&
        (!hair || item.hair === hair) &&
        (!portraitSet || (portraitSet === "featured" ? item.featured : item.popular)),
    );
  }, [pool, query, category, source, system, angle, hair, portraitSet]);
  const rows = useMemo(() => {
    if (kind !== "pose" || !grouped)
      return filtered.map((item) => ({ key: item.id, entries: [item] }));
    const groups = new Map<string, GalleryItem[]>();
    for (const item of filtered) {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group)!.push(item);
    }
    return [...groups].map(([key, entries]) => ({ key, entries }));
  }, [filtered, kind, grouped]);
  const selectedPreview = preview && preview.items[preview.index];
  const previewImage =
    selectedPreview && viewImage(selectedPreview, preview!.variant, preview!.depth);

  function switchKind(value: GalleryKind) {
    setKind(value);
    setQuery("");
    setCategory("");
    setSource("");
    setSystem("");
    setAngle("");
    setHair("");
    setPortraitSet("");
  }
  function select(item: GalleryItem, variant: string, useDepth: boolean) {
    update({
      ...recipe,
      [item.kind]: { id: item.id, variant, depth: item.kind === "pose" && useDepth },
    });
    setNotice(`已加入${SLOT_LABELS[item.kind]}参考`);
  }
  function toggleSafe(value: boolean) {
    const next = { ...recipe, safeMode: value };
    if (value)
      for (const slot of RECIPE_SLOTS)
        if (next[slot] && lookup.get(next[slot]!.id)?.sensitive) next[slot] = null;
    setPreview(null);
    update(next);
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setNotice("提示词已复制");
    } catch {
      setNotice("无法访问剪贴板，请在提示词框中手动选择并复制");
    }
  }
  async function transfer() {
    if (transferring || !references.length) return;
    setTransferring(true);
    setNotice("正在读取参考原图并带入工作台…");
    try {
      const imported = await api<{ images: ImageItem[]; prompt: string }>(
        "/reference-gallery/workbench",
        json("POST", recipe),
      );
      setRecipeOpen(false);
      setNotice("");
      onTransfer(imported.images, imported.prompt);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setTransferring(false);
    }
  }
  async function exportSheet() {
    if (!references.length || exporting) return;
    setExporting(true);
    setNotice("");
    try {
      const images = await Promise.all(
        references.map(
          (ref) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
              const image = new Image();
              image.onload = () => resolve(image);
              image.onerror = () =>
                reject(new Error(`无法加载${SLOT_LABELS[ref.slot]}原图，请检查本地素材或远程来源`));
              image.src = ref.image.url;
            }),
        ),
      );
      const canvas = document.createElement("canvas");
      canvas.width = references.length * 600;
      canvas.height = 1200;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("浏览器无法创建参考拼图");
      ctx.fillStyle = "#f4f3ed";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      images.forEach((image, index) => {
        const scale = Math.min(560 / image.naturalWidth, 1060 / image.naturalHeight),
          width = image.naturalWidth * scale,
          height = image.naturalHeight * scale;
        ctx.drawImage(
          image,
          index * 600 + (600 - width) / 2,
          70 + (1060 - height) / 2,
          width,
          height,
        );
        ctx.fillStyle = "#24301e";
        ctx.font = "24px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(
          `Image ${index + 1} · ${SLOT_LABELS[references[index].slot]}`,
          index * 600 + 300,
          43,
        );
        ctx.font = "18px sans-serif";
        ctx.fillText(references[index].item.title, index * 600 + 300, 1170, 560);
      });
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error("导出拼图失败"))),
          "image/png",
        ),
      );
      downloadBlob(blob, "角色参考拼图.png");
      setNotice("参考拼图已导出");
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  async function importRecipe(file?: File) {
    if (!file) return;
    try {
      if (file.size > 64 * 1024) throw new Error("配方文件不能超过 64KB");
      const parsed = JSON.parse(await file.text());
      if (parsed?.recipe && parsed.version !== 1) throw new Error("不支持的配方文件版本");
      const candidate = parsed.recipe || parsed;
      await flush();
      const next = await api<GalleryRecipe>("/reference-gallery/recipe", json("PUT", candidate));
      pending.current = null;
      latest.current = next;
      setRecipe(next);
      setSaveState("已保存到工作区");
      setSavingError("");
      setNotice("配方已导入");
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  function openZoom(item: GalleryItem, image: GalleryImage) {
    setZoom({
      id: `${item.id}:${image.id}`,
      url: image.url,
      thumbnail: image.thumbnail,
      prompt: item.title,
      createdAt: "",
      width: 0,
      height: 0,
      favorite: false,
    });
  }
  const recipePanel = (
    <>
      <div className="rg-panel-heading">
        <div>
          <span className="eyebrow">CHARACTER RECIPE</span>
          <h2>角色合成配方</h2>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() => update(randomGalleryRecipe(recipe, items))}
        >
          <Dices size={16} /> 随机组合
        </button>
      </div>
      <div className="rg-slots">
        {RECIPE_SLOTS.map((slot) => {
          const selection = recipe[slot],
            item = selection && lookup.get(selection.id),
            image = item && viewImage(item, selection!.variant, selection!.depth);
          const number = references.find((ref) => ref.slot === slot)?.number;
          return (
            <section className={`rg-slot ${item ? "filled" : ""}`} key={slot}>
              <div className="rg-slot-heading">
                <strong>
                  {SLOT_LABELS[slot]}
                  {number ? ` · Image ${number}` : ""}
                </strong>
                <div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${recipe.locked.includes(slot) ? "解锁" : "锁定"}${SLOT_LABELS[slot]}`}
                    aria-pressed={recipe.locked.includes(slot)}
                    onClick={() =>
                      update({
                        ...recipe,
                        locked: recipe.locked.includes(slot)
                          ? recipe.locked.filter((value) => value !== slot)
                          : [...recipe.locked, slot],
                      })
                    }
                  >
                    {recipe.locked.includes(slot) ? <Lock size={14} /> : <Unlock size={14} />}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`随机${SLOT_LABELS[slot]}`}
                    onClick={() => update(randomGalleryRecipe(recipe, items, Math.random, slot))}
                  >
                    <Dices size={14} />
                  </button>
                  {item && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`移除${SLOT_LABELS[slot]}`}
                      onClick={() => update({ ...recipe, [slot]: null })}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
              {item && image ? (
                <>
                  <button
                    type="button"
                    className="rg-slot-image"
                    onClick={() => openZoom(item, image)}
                  >
                    <img src={image.thumbnail} alt={item.title} loading="lazy" />
                  </button>
                  <p>{item.title}</p>
                  {item.variants.length > 1 && (
                    <select
                      aria-label={`${SLOT_LABELS[slot]}配方视角`}
                      value={selection!.variant}
                      onChange={(e) =>
                        update({ ...recipe, [slot]: { ...selection!, variant: e.target.value } })
                      }
                    >
                      {item.variants.map((view) => (
                        <option key={view.id} value={view.id}>
                          {view.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {slot === "pose" && (
                    <label className="rg-check">
                      <input
                        type="checkbox"
                        checked={selection!.depth}
                        onChange={(e) =>
                          update({ ...recipe, pose: { ...selection!, depth: e.target.checked } })
                        }
                      />{" "}
                      使用深度图
                    </label>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="rg-slot-empty"
                  onClick={() => {
                    switchKind(slot);
                    setRecipeOpen(false);
                  }}
                >
                  <Plus size={22} />
                  <span>选择{SLOT_LABELS[slot]}</span>
                </button>
              )}
            </section>
          );
        })}
      </div>
      <label className="field">
        画风预设
        <select value={recipe.style} onChange={(e) => update({ ...recipe, style: e.target.value })}>
          {Object.entries(STYLE_PRESETS).map(([id, style]) => (
            <option key={id} value={id}>
              {style.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        补充要求
        <textarea
          rows={3}
          maxLength={6000}
          value={recipe.notes}
          onChange={(e) => update({ ...recipe, notes: e.target.value })}
          placeholder="补充场景、光线、背景等要求…"
        />
      </label>
      <label className="field">
        合成提示词
        <textarea
          className="rg-prompt"
          rows={8}
          readOnly
          value={prompt}
          placeholder="从图库选择参考图后自动整理提示词"
        />
      </label>
      <div className="rg-actions">
        <button
          type="button"
          className="primary-button"
          disabled={!references.length || transferring}
          onClick={() => void transfer()}
        >
          {transferring ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}{" "}
          {transferring ? "正在带入…" : "带入工作台"}
        </button>
      </div>
      <div className="rg-actions">
        <button
          type="button"
          className="primary-button"
          disabled={!prompt}
          onClick={() => void copy()}
        >
          <Copy size={16} />
          复制提示词
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={!references.length || exporting}
          onClick={() => void exportSheet()}
        >
          {exporting ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
          导出参考拼图
        </button>
      </div>
      <div className="rg-actions">
        <button
          type="button"
          className="text-button"
          onClick={() =>
            downloadBlob(
              new Blob([JSON.stringify({ version: 1, recipe }, null, 2)], {
                type: "application/json",
              }),
              "角色合成配方.json",
            )
          }
        >
          <Download size={14} />
          导出配方
        </button>
        <button type="button" className="text-button" onClick={() => importInput.current?.click()}>
          <Upload size={14} />
          导入配方
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            update({ ...emptyGalleryRecipe(), safeMode: recipe.safeMode });
            setNotice("配方已清空");
          }}
        >
          清空配方
        </button>
      </div>
      <small className="rg-save-status" role="status">
        {saveState}
      </small>
      {savingError && (
        <div role="alert" className="inline-error">
          {savingError}
          <button type="button" onClick={() => void flush()}>
            重试保存
          </button>
        </div>
      )}
      <p className="rg-help">
        配方自动保存到当前工作区。图片顺序为人像、服装、姿势；导出 JSON
        只包含选择与设置，不包含图片。“带入工作台”会载入所选原图与提示词，确认后再执行编辑。
      </p>
    </>
  );
  return (
    <section
      className="reference-gallery"
      style={active ? undefined : { display: "none" }}
      aria-label="角色参考图库"
    >
      <header className="rg-heading">
        <div>
          <span className="eyebrow">REFERENCE & RECIPE</span>
          <h1>从参考开始，组合角色。</h1>
          <p>挑选人像、服装与姿势，整理自己的合成配方。</p>
        </div>
        <div className="rg-heading-actions">
          <label className="rg-check">
            <input
              type="checkbox"
              checked={recipe.safeMode}
              disabled={!catalog}
              onChange={(e) => toggleSafe(e.target.checked)}
            />
            安全模式
          </label>
          <button type="button" className="text-button" onClick={() => setCreditsOpen(true)}>
            素材来源
          </button>
        </div>
      </header>
      {loading && (
        <p role="status">
          <LoaderCircle className="spin" size={18} /> 正在加载参考图库…
        </p>
      )}
      {error && (
        <div role="alert" className="inline-error">
          {error}
          <button
            type="button"
            className="text-button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw size={14} />
            重新加载
          </button>
        </div>
      )}
      {catalog && (
        <>
          {!catalog.localAvailable && (
            <p className="rg-warning">
              本地图片目录尚未挂载，部分预览暂不可用。请配置 REFERENCE_GALLERY_DIR
              或挂载素材目录；远程来源仍可浏览。
            </p>
          )}
          <div className="rg-layout">
            <div className="rg-browser">
              <nav className="rg-tabs" aria-label="参考图库分类">
                {kinds.map((value) => (
                  <button
                    type="button"
                    key={value}
                    className={kind === value ? "active" : ""}
                    aria-pressed={kind === value}
                    onClick={() => switchKind(value)}
                  >
                    {SLOT_LABELS[value]}库 <span>{catalog.counts[value]}</span>
                  </button>
                ))}
              </nav>
              <div className="rg-filters">
                <label className="rg-search">
                  <Search size={17} />
                  <input
                    aria-label="搜索参考图库"
                    placeholder="搜索名称、标签、关键词…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <select
                  aria-label="参考图分类"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">全部分类</option>
                  {categories.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
                {kind === "costume" && (
                  <select
                    aria-label="服装来源"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                  >
                    <option value="">全部来源</option>
                    {sources.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                {kind === "pose" && (
                  <>
                    <select
                      aria-label="姿势体系"
                      value={system}
                      onChange={(e) => {
                        setSystem(e.target.value);
                        setCategory("");
                      }}
                    >
                      <option value="">全部体系</option>
                      {[...new Set(pool.map((item) => item.system))].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                    <select
                      aria-label="姿势角度"
                      value={angle}
                      onChange={(e) => setAngle(e.target.value)}
                    >
                      <option value="">全部角度</option>
                      {[...new Set(pool.map((item) => item.angle))].filter(Boolean).map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </>
                )}
                {kind === "portrait" && (
                  <>
                    <select
                      aria-label="发长"
                      value={hair}
                      onChange={(e) => setHair(e.target.value)}
                    >
                      <option value="">全部发长</option>
                      {[...new Set(pool.map((item) => item.hair))].filter(Boolean).map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                    <select
                      aria-label="人像题集"
                      value={portraitSet}
                      onChange={(e) => setPortraitSet(e.target.value)}
                    >
                      <option value="">全部人像</option>
                      <option value="featured">精选</option>
                      <option value="popular">热门</option>
                    </select>
                  </>
                )}
              </div>
              <div className="rg-results">
                <span>
                  {rows.length} {kind === "pose" && grouped ? "组姿势" : "条参考"}
                  {recipe.safeMode ? " · 安全模式" : ""}
                </span>
                {kind === "pose" && (
                  <div>
                    <label className="rg-check">
                      <input
                        type="checkbox"
                        checked={grouped}
                        onChange={(e) => setGrouped(e.target.checked)}
                      />
                      按姿势分组
                    </label>
                    <label className="rg-check">
                      <input
                        type="checkbox"
                        checked={depth}
                        onChange={(e) => setDepth(e.target.checked)}
                      />
                      深度图
                    </label>
                  </div>
                )}
              </div>
              <div className="rg-grid">
                {rows.slice(0, shown).map((row) => {
                  const item =
                    row.entries.find((item) => item.id === poseChoices[row.key]) || row.entries[0];
                  const variant = variants[item.id] || item.variants[0].id;
                  const image = viewImage(item, variant, kind === "pose" && depth);
                  const selected = recipe[item.kind]?.id === item.id;
                  return (
                    <article className={`rg-card ${selected ? "selected" : ""}`} key={row.key}>
                      <button
                        type="button"
                        className="rg-card-image"
                        aria-label={`预览${item.title}`}
                        onClick={() =>
                          setPreview({
                            items: row.entries,
                            index: row.entries.indexOf(item),
                            variant,
                            depth: kind === "pose" && depth,
                          })
                        }
                      >
                        <img
                          src={image.thumbnail}
                          alt={item.title}
                          loading="lazy"
                          decoding="async"
                          onError={(e) => {
                            e.currentTarget.style.visibility = "hidden";
                            e.currentTarget.parentElement?.setAttribute("data-image-error", "true");
                          }}
                          onLoad={(e) => {
                            e.currentTarget.style.visibility = "visible";
                            e.currentTarget.parentElement?.removeAttribute("data-image-error");
                          }}
                        />
                        {selected && (
                          <span className="rg-selected">
                            <Check size={14} /> 已选
                          </span>
                        )}
                      </button>
                      <div className="rg-card-info">
                        <h3 title={item.title}>{item.title}</h3>
                        <small>
                          {item.category} · {item.angle || item.sourceLabel}
                        </small>
                        {row.entries.length > 1 && (
                          <select
                            aria-label={`${item.title}的姿势角度`}
                            value={item.id}
                            onChange={(e) =>
                              setPoseChoices({ ...poseChoices, [row.key]: e.target.value })
                            }
                          >
                            {row.entries.map((entry) => (
                              <option key={entry.id} value={entry.id}>
                                {entry.angle || entry.title}
                              </option>
                            ))}
                          </select>
                        )}
                        {item.variants.length > 1 && (
                          <select
                            aria-label={`${item.title}的服装视角`}
                            value={variant}
                            onChange={(e) =>
                              setVariants({ ...variants, [item.id]: e.target.value })
                            }
                          >
                            {item.variants.map((view) => (
                              <option key={view.id} value={view.id}>
                                {view.label}
                              </option>
                            ))}
                          </select>
                        )}
                        <button
                          type="button"
                          className="rg-add"
                          onClick={() => select(item, variant, kind === "pose" && depth)}
                        >
                          {selected ? <Check size={15} /> : <Plus size={15} />}加入
                          {SLOT_LABELS[item.kind]}配方
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
              {!rows.length && (
                <p className="rg-empty">没有找到匹配的参考图，试试其他关键词或分类。</p>
              )}
              {rows.length > shown && (
                <button
                  type="button"
                  className="secondary-button rg-more"
                  onClick={() => setShown((value) => value + 60)}
                >
                  加载更多（已显示 {Math.min(shown, rows.length)} / {rows.length}）
                </button>
              )}
            </div>
            <aside className="rg-recipe-desktop">{recipePanel}</aside>
          </div>
          <button
            type="button"
            className="rg-mobile-recipe primary-button"
            onClick={() => setRecipeOpen(true)}
          >
            <Eye size={18} />
            查看合成配方 · {references.length} 张
          </button>
          {notice && (
            <p className="rg-notice" role="status">
              {notice}
              <button
                type="button"
                className="icon-button"
                aria-label="关闭提示"
                onClick={() => setNotice("")}
              >
                <X size={14} />
              </button>
            </p>
          )}
        </>
      )}
      <input
        ref={importInput}
        type="file"
        className="visually-hidden"
        accept="application/json,.json"
        aria-label="导入角色配方 JSON"
        onChange={(e) => {
          void importRecipe(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {recipeOpen && (
        <Modal
          title="角色合成配方"
          className="rg-recipe-modal"
          onClose={() => setRecipeOpen(false)}
        >
          {recipePanel}
        </Modal>
      )}
      {preview && selectedPreview && previewImage && (
        <Modal
          title={selectedPreview.title}
          className="rg-preview-modal"
          onClose={() => setPreview(null)}
        >
          <div className="rg-preview-layout">
            <button
              type="button"
              className="rg-preview-image"
              aria-label="放大参考图片"
              onClick={() => openZoom(selectedPreview, previewImage)}
            >
              <img src={previewImage.url} alt={selectedPreview.title} />
            </button>
            <div className="rg-preview-info">
              <p>
                {selectedPreview.category} · {selectedPreview.sourceLabel}
              </p>
              <p>{selectedPreview.tags.join(" · ")}</p>
              {preview.items.length > 1 && (
                <div className="rg-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="上一个姿势角度"
                    onClick={() =>
                      setPreview({
                        ...preview,
                        index: (preview.index + preview.items.length - 1) % preview.items.length,
                      })
                    }
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <span>
                    {selectedPreview.angle} · {preview.index + 1}/{preview.items.length}
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="下一个姿势角度"
                    onClick={() =>
                      setPreview({ ...preview, index: (preview.index + 1) % preview.items.length })
                    }
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              )}
              {selectedPreview.variants.length > 1 && (
                <select
                  aria-label="预览视角"
                  value={preview.variant}
                  onChange={(e) => setPreview({ ...preview, variant: e.target.value })}
                >
                  {selectedPreview.variants.map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.label}
                    </option>
                  ))}
                </select>
              )}
              {selectedPreview.depth && (
                <label className="rg-check">
                  <input
                    type="checkbox"
                    checked={preview.depth}
                    onChange={(e) => setPreview({ ...preview, depth: e.target.checked })}
                  />
                  查看深度图
                </label>
              )}
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  select(selectedPreview, preview.variant, preview.depth);
                  setPreview(null);
                }}
              >
                <Plus size={16} />
                加入{SLOT_LABELS[selectedPreview.kind]}配方
              </button>
              <a className="secondary-button" href={`${previewImage.url}&download=1`} download>
                <Download size={16} />
                下载原图
              </a>
              <a
                className="text-button"
                href={selectedPreview.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                查看素材来源
              </a>
            </div>
          </div>
        </Modal>
      )}
      {zoom && <ImageZoomViewer image={zoom} onClose={() => setZoom(null)} />}
      {creditsOpen && (
        <Modal title="图库来源与说明" onClose={() => setCreditsOpen(false)}>
          <div className="rg-credits">
            <p>
              图库与配方样式整合自 Anhao 维护的 ai-pose-gallery-zh。姿势、写实服装及人像来源于
              ギア；动漫服装另含 ギア 动漫库和 たき AI 的 CharaDB；中国历代服装来自 Shisei。
            </p>
            <p>
              原项目代码使用 MIT 协议，图片与目录数据的授权因来源而异，不统一适用 MIT。Shisei
              的服装图片使用 CC0；这些图是 AI 参考，不是专业历史服饰复原。
            </p>
            <p>
              安全模式默认隐藏原图库标注的敏感分类；开启时也会移除配方中的对应参考。远程来源需要网络，本地图片需挂载素材目录。
            </p>
            <a href="/api/reference-gallery/notices/NOTICE.md" target="_blank" rel="noreferrer">
              查看完整来源说明
            </a>
            <a
              href="/api/reference-gallery/notices/LICENSE-upstream.txt"
              target="_blank"
              rel="noreferrer"
            >
              原项目授权与素材范围
            </a>
            <a
              href="/api/reference-gallery/notices/LICENSE-shisei-images.txt"
              target="_blank"
              rel="noreferrer"
            >
              Shisei 图片授权
            </a>
          </div>
        </Modal>
      )}
    </section>
  );
}
