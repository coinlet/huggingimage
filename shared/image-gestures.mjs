export const MAX_IMAGE_SCALE = 8;
const identity = () => ({ scale: 1, x: 0, y: 0 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const positive = (n) => (Number.isFinite(n) && n > 0 ? n : 1);

export function clampImageTransform(transform, bounds) {
  const scale = Math.min(MAX_IMAGE_SCALE, Math.max(1, transform.scale));
  const width = positive(bounds.viewportWidth),
    height = positive(bounds.viewportHeight);
  const fit = Math.min(width / positive(bounds.imageWidth), height / positive(bounds.imageHeight));
  const maxX = Math.max(0, (positive(bounds.imageWidth) * fit * scale - width) / 2);
  const maxY = Math.max(0, (positive(bounds.imageHeight) * fit * scale - height) / 2);
  return {
    scale,
    x: Math.max(-maxX, Math.min(maxX, transform.x)) || 0,
    y: Math.max(-maxY, Math.min(maxY, transform.y)) || 0,
  };
}
export function zoomImageAt(transform, scale, point, bounds) {
  const nextScale = Math.min(MAX_IMAGE_SCALE, Math.max(1, scale));
  return clampImageTransform(
    {
      scale: nextScale,
      x: point.x - ((point.x - transform.x) * nextScale) / transform.scale,
      y: point.y - ((point.y - transform.y) * nextScale) / transform.scale,
    },
    bounds,
  );
}

// Screen points are relative to the viewport centre. A pinch/drag never becomes a close tap.
export class ImageGesture {
  constructor(bounds = { viewportWidth: 1, viewportHeight: 1, imageWidth: 1, imageHeight: 1 }) {
    this.bounds = bounds;
    this.transform = identity();
    this.pointers = new Map();
    this.tap = null;
    this.baseline = null;
  }
  rebase() {
    const points = [...this.pointers.values()];
    this.baseline = points.length
      ? {
          transform: { ...this.transform },
          point: points[0],
          mid: points.length > 1 ? middle(points[0], points[1]) : null,
          distance: points.length > 1 ? distance(points[0], points[1]) : 0,
        }
      : null;
  }
  start(id, point, time = Date.now()) {
    if (!this.pointers.size) this.tap = { id, point, time, moved: 0, valid: true };
    this.pointers.set(id, point);
    if (this.pointers.size > 1 && this.tap) this.tap.valid = false;
    this.rebase();
  }
  move(id, point) {
    if (!this.pointers.has(id)) return this.transform;
    this.pointers.set(id, point);
    if (this.tap?.id === id)
      this.tap.moved = Math.max(this.tap.moved, distance(this.tap.point, point));
    const points = [...this.pointers.values()],
      baseline = this.baseline;
    if (!baseline) return this.transform;
    if (points.length > 1 && baseline.mid && baseline.distance > 0) {
      const mid = middle(points[0], points[1]);
      const scale = Math.min(
        MAX_IMAGE_SCALE,
        Math.max(
          1,
          (baseline.transform.scale * distance(points[0], points[1])) / baseline.distance,
        ),
      );
      this.transform = clampImageTransform(
        {
          scale,
          x: mid.x - ((baseline.mid.x - baseline.transform.x) * scale) / baseline.transform.scale,
          y: mid.y - ((baseline.mid.y - baseline.transform.y) * scale) / baseline.transform.scale,
        },
        this.bounds,
      );
    } else if (points.length === 1) {
      this.transform = clampImageTransform(
        {
          ...baseline.transform,
          x: baseline.transform.x + point.x - baseline.point.x,
          y: baseline.transform.y + point.y - baseline.point.y,
        },
        this.bounds,
      );
    }
    return this.transform;
  }
  end(id, point, time = Date.now()) {
    if (!this.pointers.has(id)) return { transform: this.transform, close: false };
    this.move(id, point);
    const close = Boolean(
      this.tap?.valid &&
      this.tap.id === id &&
      this.pointers.size === 1 &&
      this.tap.moved <= 8 &&
      time - this.tap.time <= 450,
    );
    this.pointers.delete(id);
    if (!this.pointers.size) this.tap = null;
    this.rebase();
    return { transform: this.transform, close };
  }
  cancel(id) {
    if (!this.pointers.has(id)) return this.transform;
    this.pointers.delete(id);
    if (this.tap) this.tap.valid = false;
    if (!this.pointers.size) this.tap = null;
    this.rebase();
    return this.transform;
  }
  setBounds(bounds) {
    this.bounds = bounds;
    this.pointers.clear();
    this.tap = null;
    this.baseline = null;
    this.transform = clampImageTransform(this.transform, bounds);
    return this.transform;
  }
  zoom(scale, point = { x: 0, y: 0 }) {
    this.transform = zoomImageAt(this.transform, scale, point, this.bounds);
    this.rebase();
    return this.transform;
  }
  pan(x, y) {
    this.transform = clampImageTransform(
      { ...this.transform, x: this.transform.x + x, y: this.transform.y + y },
      this.bounds,
    );
    this.rebase();
    return this.transform;
  }
  reset() {
    this.pointers.clear();
    this.tap = null;
    this.baseline = null;
    this.transform = identity();
    return this.transform;
  }
}
