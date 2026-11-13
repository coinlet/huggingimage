import { useEffect, useRef, useState } from "react";
import { ImagePlus, LoaderCircle, X } from "lucide-react";
import { referenceSupport } from "../shared/references.mjs";
import { api, json, type ImageItem, type Provider } from "./types";

export function ReferenceImages({
  source,
  provider,
  images,
  value,
  onChange,
  mode,
  onMode,
  onBusy,
  onReplace,
}: {
  source: ImageItem;
  provider?: Provider;
  images: ImageItem[];
  value: ImageItem[];
  onChange: (value: ImageItem[]) => void;
  mode: "reference" | "swap";
  onMode: (value: "reference" | "swap") => void;
  onBusy: (value: boolean) => void;
  onReplace?: (image: ImageItem) => void;
}) {
  const support = referenceSupport(provider);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onBusy(false);
    };
  }, []);
  const limit = mode === "swap" ? 2 : support.max;
  const count = value.length + 1;
  async function upload(files: File[]) {
    if (!files.length || busy) return;
    setError("");
    if (count + files.length > limit) {
      setError(`当前模式最多 ${limit} 张图片（含当前图）`);
      return;
    }
    if (
      files.some(
        (f) =>
          !["image/png", "image/jpeg", "image/webp"].includes(f.type) || f.size > 12 * 1024 * 1024,
      )
    ) {
      setError("请上传 12MB 以内的 PNG、JPEG 或 WebP 图片");
      return;
    }
    setBusy(true);
    onBusy(true);
    const added: ImageItem[] = [];
    try {
      for (const file of files) {
        if (!mounted.current) break;
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("读取参考图片失败"));
          reader.readAsDataURL(file);
        });
        added.push(await api<ImageItem>("/uploads", json("POST", { data, name: file.name })));
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) {
        onChange([...value, ...added]);
        setBusy(false);
        onBusy(false);
      }
    }
  }
  if (support.max === 1 && !value.length) return null;
  return (
    <section className="reference-images" aria-label="多图编辑参考图片">
      <label className="section-label">
        参考图片 · {count} / {limit}
      </label>
      {support.swap && (
        <label className="reference-mode">
          编辑方式
          <select
            value={mode}
            onChange={(e) => onMode(e.target.value as "reference" | "swap")}
            disabled={busy}
          >
            <option value="reference">多图参考（1–6 张）</option>
            <option value="swap">双图变换与合成（2 张）</option>
          </select>
        </label>
      )}
      {!support.swap && mode === "swap" && (
        <button type="button" onClick={() => onMode("reference")}>
          切换为普通参考模式
        </button>
      )}
      <div className="reference-images-list">
        {[source, ...value].map((image, index) => (
          <div className="reference-image-tile" key={image.id}>
            <img src={image.thumbnail || image.url} alt={`Image ${index + 1}`} />
            <span>
              Image {index + 1}
              {index === 0 ? " · 当前图" : ""}
            </span>
            {onReplace && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onReplace(image)}
                aria-label={`替换 Image ${index + 1}`}
              >
                替换
              </button>
            )}
            {index > 0 && (
              <div>
                {index > 1 && (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`将 Image ${index + 1} 前移`}
                    onClick={() => {
                      const next = [...value];
                      [next[index - 2], next[index - 1]] = [next[index - 1], next[index - 2]];
                      onChange(next);
                    }}
                  >
                    ←
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`移除 Image ${index + 1}`}
                  onClick={() => onChange(value.filter((i) => i.id !== image.id))}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {count > limit && <p role="alert">图片数量超过当前提供商或模式上限，请移除多余图片。</p>}
      {count < limit && (
        <div className="reference-image-add">
          <label className="secondary-button">
            {busy ? <LoaderCircle size={16} className="spin" /> : <ImagePlus size={16} />}
            {busy ? "正在上传…" : "添加参考图"}
            <input
              type="file"
              className="visually-hidden"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={busy}
              aria-label="添加多张参考图片"
              onChange={(e) => {
                void upload(Array.from(e.target.files || []));
                e.target.value = "";
              }}
            />
          </label>
          <select
            aria-label="从已有作品选择参考图"
            value=""
            disabled={busy}
            onChange={(e) => {
              const image = images.find((i) => i.id === e.target.value);
              if (image) onChange([...value, image]);
            }}
          >
            <option value="">从已有作品选择…</option>
            {images
              .filter(
                (i) =>
                  i.id !== source.id &&
                  !value.some((v) => v.id === i.id) &&
                  (!i.status || i.status === "succeeded") &&
                  !i.localDraft &&
                  !i.example,
              )
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.prompt?.slice(0, 35) || i.name || i.id}
                </option>
              ))}
          </select>
        </div>
      )}
      <small>
        {mode === "swap"
          ? "Image 1 是当前底图，Image 2 是人物、姿势等参考图；需恰好两张。"
          : "当前图片为 Image 1，附加图片按顺序编号；可在提示词中引用 Image 1、Image 2 等。"}
      </small>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
