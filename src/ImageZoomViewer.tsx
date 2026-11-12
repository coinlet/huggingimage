import { useEffect, useRef, useState, type PointerEvent } from "react";
import { LoaderCircle, Minus, Plus, RotateCcw, X } from "lucide-react";
import { Modal } from "./Modal";
import { ImageGesture, MAX_IMAGE_SCALE } from "../shared/image-gestures.mjs";
import type { ImageItem } from "./types";

export function ImageZoomViewer({ image, onClose }: { image: ImageItem; onClose: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const engine = useRef<ImageGesture | null>(null);
  if (!engine.current) engine.current = new ImageGesture();
  const gesture = engine.current;
  const dimensions = useRef({ width: image.width, height: image.height });
  const [transform, setTransform] = useState(gesture.transform);
  const [loaded, setLoaded] = useState(false),
    [failed, setFailed] = useState(false);
  function measure() {
    const rect = stage.current?.getBoundingClientRect();
    if (rect)
      setTransform(
        gesture.setBounds({
          viewportWidth: rect.width,
          viewportHeight: rect.height,
          imageWidth: dimensions.current.width,
          imageHeight: dimensions.current.height,
        }),
      );
  }
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      const factor = Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002);
      setTransform(
        gesture.zoom(gesture.transform.scale * factor, {
          x: event.clientX - rect.left - rect.width / 2,
          y: event.clientY - rect.top - rect.height / 2,
        }),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", wheel);
    };
  }, []);
  function point(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    };
  }
  return (
    <Modal
      title="图片全屏预览"
      className="image-zoom-modal"
      backdropClassName="image-zoom-backdrop"
      hideHeader
      onClose={onClose}
    >
      <div
        ref={stage}
        className="image-zoom-stage"
        role="button"
        tabIndex={0}
        aria-label="全屏图片，轻点返回创作界面；支持双指缩放和拖动"
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          gesture.start(event.pointerId, point(event));
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => setTransform(gesture.move(event.pointerId, point(event)))}
        onPointerUp={(event) => {
          const result = gesture.end(event.pointerId, point(event));
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          setTransform(result.transform);
          if (result.close) onClose();
        }}
        onPointerCancel={(event) => setTransform(gesture.cancel(event.pointerId))}
        onLostPointerCapture={(event) => setTransform(gesture.cancel(event.pointerId))}
        onClick={(event) => {
          if (event.detail === 0) onClose();
        }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (["Enter", " "].includes(event.key)) {
            event.preventDefault();
            onClose();
          } else if (["+", "="].includes(event.key)) {
            event.preventDefault();
            setTransform(gesture.zoom(gesture.transform.scale * 1.4));
          } else if (event.key === "-") {
            event.preventDefault();
            setTransform(gesture.zoom(gesture.transform.scale / 1.4));
          } else if (event.key === "0") {
            event.preventDefault();
            setTransform(gesture.reset());
          } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            setTransform(
              gesture.pan(
                event.key === "ArrowLeft" ? 40 : event.key === "ArrowRight" ? -40 : 0,
                event.key === "ArrowUp" ? 40 : event.key === "ArrowDown" ? -40 : 0,
              ),
            );
          }
        }}
      >
        <img
          src={image.url}
          alt={image.prompt || image.name || "预览图片"}
          draggable={false}
          style={{
            transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
          }}
          onLoad={(event) => {
            dimensions.current = {
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            };
            measure();
            setLoaded(true);
          }}
          onError={() => {
            setFailed(true);
            setLoaded(false);
          }}
        />
        {!loaded && (
          <div className="image-zoom-status" role="status">
            {failed ? (
              "图片加载失败，轻点返回"
            ) : (
              <>
                <LoaderCircle size={28} className="spin" />
                <span>正在加载原图…</span>
              </>
            )}
          </div>
        )}
      </div>
      <div className="image-zoom-toolbar">
        <div>
          <button
            type="button"
            aria-label="缩小图片"
            disabled={!loaded || transform.scale <= 1}
            onClick={() => setTransform(gesture.zoom(gesture.transform.scale / 1.4))}
          >
            <Minus size={20} />
          </button>
          <span aria-label="缩放比例">{Math.round(transform.scale * 100)}%</span>
          <button
            type="button"
            aria-label="放大图片"
            disabled={!loaded || transform.scale >= MAX_IMAGE_SCALE}
            onClick={() => setTransform(gesture.zoom(gesture.transform.scale * 1.4))}
          >
            <Plus size={20} />
          </button>
        </div>
        <div>
          <button
            type="button"
            className="image-zoom-reset"
            aria-label="恢复适应屏幕"
            disabled={!loaded}
            onClick={() => setTransform(gesture.reset())}
          >
            <RotateCcw size={17} />
            <span>适应</span>
          </button>
          <button type="button" aria-label="退出图片全屏预览" onClick={onClose}>
            <X size={24} />
          </button>
        </div>
      </div>
      <p className="image-zoom-hint">双指缩放 · 放大后拖动 · 轻点返回</p>
    </Modal>
  );
}
