import { ImageOff, LoaderCircle } from "lucide-react";
import type { ImageItem } from "./types";

export function ImagePlaceholder({
  image,
  preview,
  compact = false,
}: {
  image: ImageItem;
  preview?: string;
  compact?: boolean;
}) {
  const failed = image.status === "failed" || image.status === "cancelled";
  return (
    <div
      className={`image-placeholder ${failed ? "is-failed" : "is-pending"} ${compact ? "is-compact" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div
        className="placeholder-blur"
        aria-hidden="true"
        style={preview ? { backgroundImage: `url(${JSON.stringify(preview)})` } : undefined}
      />
      <div className="placeholder-content">
        {failed ? (
          <ImageOff size={compact ? 26 : 38} />
        ) : (
          <LoaderCircle className="spin" size={compact ? 26 : 38} />
        )}
        <strong>
          {image.status === "failed"
            ? "生成失败"
            : image.status === "cancelled"
              ? "已取消生成"
              : image.status === "submitting"
                ? "正在提交创作"
                : image.status === "queued"
                  ? "等待生成"
                  : "正在生成图片"}
        </strong>
        {!compact && (
          <p>
            {failed
              ? image.error || "可以重试这张图片，或手动删除"
              : "让想象慢慢清晰，生成后会自动显示在这里"}
          </p>
        )}
      </div>
    </div>
  );
}
