export class ImagePress {
  constructor(schedule = setTimeout, clear = clearTimeout) {
    this.schedule = schedule;
    this.clear = clear;
    this.timer = null;
    this.pointer = null;
    this.blocked = false;
  }
  start(id, point, onHold) {
    this.stop();
    this.blocked = false;
    this.pointer = { id, ...point };
    this.timer = this.schedule(() => {
      this.timer = null;
      this.blocked = true;
      onHold();
    }, 550);
  }
  move(id, point) {
    if (
      this.pointer?.id === id &&
      Math.hypot(point.x - this.pointer.x, point.y - this.pointer.y) > 8
    )
      this.cancel();
  }
  stop() {
    if (this.timer !== null) this.clear(this.timer);
    this.timer = null;
    this.pointer = null;
  }
  get active() {
    return this.pointer !== null;
  }
  cancel() {
    this.stop();
    this.blocked = true;
    this.pointer = null;
  }
}
