export class ImagePress {
  constructor();
  blocked: boolean;
  readonly active: boolean;
  start(id: number, point: { x: number; y: number }, onHold: () => void): void;
  move(id: number, point: { x: number; y: number }): void;
  stop(): void;
  cancel(): void;
}
