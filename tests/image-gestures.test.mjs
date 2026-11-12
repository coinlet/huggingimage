import test from "node:test";
import assert from "node:assert/strict";
import { ImageGesture, clampImageTransform, zoomImageAt } from "../shared/image-gestures.mjs";

const bounds = { viewportWidth: 400, viewportHeight: 400, imageWidth: 1200, imageHeight: 1200 };
const p = (x, y = 0) => ({ x, y });

test("image pan respects fitted image edges, letterboxing and scale limits", () => {
  assert.deepEqual(clampImageTransform({ scale: 2, x: 900, y: -900 }, bounds), {
    scale: 2,
    x: 200,
    y: -200,
  });
  assert.deepEqual(
    clampImageTransform({ scale: 2, x: 900, y: -900 }, { ...bounds, imageHeight: 600 }),
    { scale: 2, x: 200, y: 0 },
  );
  assert.deepEqual(
    clampImageTransform({ scale: 2, x: 900, y: -900 }, { ...bounds, imageWidth: 600 }),
    { scale: 2, x: 0, y: -200 },
  );
  assert.deepEqual(clampImageTransform({ scale: 0.1, x: 90, y: 90 }, bounds), {
    scale: 1,
    x: 0,
    y: 0,
  });
  assert.equal(clampImageTransform({ scale: 90, x: 0, y: 0 }, bounds).scale, 8);
});

test("pointer anchored zoom retains the image point under the cursor", () => {
  const before = { scale: 2, x: 20, y: -30 },
    anchor = p(80, 40);
  const after = zoomImageAt(before, 3, anchor, bounds);
  assert.equal((anchor.x - after.x) / after.scale, (anchor.x - before.x) / before.scale);
  assert.equal((anchor.y - after.y) / after.scale, (anchor.y - before.y) / before.scale);
});

test("pinch keeps its focal point and transitions to one finger dragging without jumping", () => {
  const g = new ImageGesture(bounds);
  g.start(1, p(-50), 0);
  g.start(2, p(50), 0);
  g.move(1, p(-80, 20));
  assert.deepEqual(g.move(2, p(120, 20)), { scale: 2, x: 20, y: 20 });
  assert.equal(g.end(2, p(120, 20), 100).close, false);
  assert.deepEqual(g.move(1, p(-60, 30)), { scale: 2, x: 40, y: 30 });
  assert.equal(g.end(1, p(-60, 30), 150).close, false);
  g.start(3, p(0), 200);
  assert.equal(g.end(3, p(0), 300).close, true);
});

test("pinch never closes on release even without movement and clamps zoom", () => {
  const g = new ImageGesture(bounds);
  g.start(1, p(-10), 0);
  g.start(2, p(10), 0);
  assert.equal(g.end(1, p(-10), 20).close, false);
  assert.equal(g.end(2, p(10), 30).close, false);
  g.start(1, p(-10), 100);
  g.start(2, p(10), 100);
  assert.equal(g.move(2, p(1000)).scale, 8);
  assert.equal(g.move(2, p(-9)).scale, 1);
});

test("single taps close but drags, out-and-back movement and long presses do not", () => {
  const g = new ImageGesture(bounds);
  g.start(1, p(0), 0);
  assert.equal(g.end(1, p(4, 3), 120).close, true);
  g.start(1, p(0), 200);
  g.move(1, p(40));
  assert.equal(g.transform.x, 0);
  assert.equal(g.end(1, p(0), 300).close, false);
  g.start(1, p(0), 400);
  assert.equal(g.end(1, p(0), 1000).close, false);
});

test("cancelled pointers and viewport rotation cannot accidentally close the viewer", () => {
  const g = new ImageGesture(bounds);
  g.start(1, p(0), 0);
  g.cancel(1);
  assert.equal(g.end(1, p(0), 10).close, false);
  g.zoom(3);
  g.pan(400, 400);
  g.start(2, p(0), 20);
  const rotated = { ...bounds, viewportWidth: 800, viewportHeight: 300 };
  assert.deepEqual(g.setBounds(rotated), { scale: 3, x: 50, y: 300 });
  assert.equal(g.end(2, p(0), 30).close, false);
  assert.deepEqual(g.reset(), { scale: 1, x: 0, y: 0 });
});
