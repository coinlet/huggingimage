export type ImagePoint = { x: number; y: number };
export type ImageTransform = ImagePoint & { scale: number };
export type ImageBounds = {
  viewportWidth: number;
  viewportHeight: number;
  imageWidth: number;
  imageHeight: number;
};
export const MAX_IMAGE_SCALE: number;
export function clampImageTransform(transform: ImageTransform, bounds: ImageBounds): ImageTransform;
export function zoomImageAt(
  transform: ImageTransform,
  scale: number,
  point: ImagePoint,
  bounds: ImageBounds,
): ImageTransform;
export class ImageGesture {
  constructor(bounds?: ImageBounds);
  transform: ImageTransform;
  start(id: number, point: ImagePoint, time?: number): void;
  move(id: number, point: ImagePoint): ImageTransform;
  end(id: number, point: ImagePoint, time?: number): { transform: ImageTransform; close: boolean };
  cancel(id: number): ImageTransform;
  setBounds(bounds: ImageBounds): ImageTransform;
  zoom(scale: number, point?: ImagePoint): ImageTransform;
  pan(x: number, y: number): ImageTransform;
  reset(): ImageTransform;
}
