import test from "node:test";
import assert from "node:assert/strict";
import { applyInputReplacements, replacementSlotId } from "../shared/input-replacements.mjs";
import { ImagePress } from "../shared/image-press.mjs";

test("replacement inputs keep slot order and role metadata without modifying original images", () => {
  const original = [
    { id: "a", url: "original-a", threadId: "a" },
    {
      id: "b",
      url: "original-b",
      threadId: "b",
      referenceInput: { number: 2, slot: "costume", catalogId: "catalog-b", variant: "back" },
      referenceContext: { jobId: "j1", resultId: "result", number: 2, prompt: "combine" },
    },
    { id: "result", url: "result" },
  ];
  const before = structuredClone(original);
  const replacement = {
    id: "new-b",
    url: "replacement",
    thumbnail: "replacement-thumb",
    threadId: "new-b",
    width: 512,
    height: 768,
  };
  const next = applyInputReplacements(original, { b: replacement });
  assert.deepEqual(
    next.map((image) => image.id),
    ["a", "new-b", "result"],
  );
  assert.equal(next[1].url, "replacement");
  assert.equal(next[1].width, 512);
  assert.deepEqual(next[1].referenceContext, original[1].referenceContext);
  assert.equal(next[1].referenceInput.number, 2);
  assert.equal(next[1].referenceInput.slot, "costume");
  assert.equal(next[1].referenceInput.catalogId, "");
  assert.deepEqual(original, before);
  assert.equal(replacement.threadId, "new-b");
});

test("replacing the main image and replacing a slot twice retains one displayed input, even while a server refresh returns the new ID", () => {
  const original = [
    { id: "a", threadId: "a" },
    { id: "b", threadId: "a" },
    { id: "new-a", threadId: "different" },
  ];
  const replacements = { a: { id: "new-a", url: "new" } };
  assert.equal(replacementSlotId(replacements, "new-a"), "a");
  assert.equal(replacementSlotId(replacements, "b"), "b");
  assert.deepEqual(
    applyInputReplacements(original, replacements).map((image) => image.id),
    ["new-a", "b"],
  );
  replacements[replacementSlotId(replacements, "new-a")] = { id: "newer-a", url: "newer" };
  assert.deepEqual(
    applyInputReplacements(original.slice(0, 2), replacements).map((image) => image.id),
    ["newer-a", "b"],
  );
});

function clock() {
  let now = 0,
    sequence = 0;
  const timers = new Map();
  return {
    schedule(fn, delay) {
      const id = ++sequence;
      timers.set(id, { fn, due: now + delay });
      return id;
    },
    clear(id) {
      timers.delete(id);
    },
    tick(ms) {
      now += ms;
      for (const [id, timer] of [...timers])
        if (timer.due <= now) {
          timers.delete(id);
          timer.fn();
        }
    },
  };
}

test("short taps still open preview; a held pointer opens actions once and suppresses the following click", () => {
  const time = clock();
  let holds = 0;
  const press = new ImagePress(time.schedule, time.clear);
  press.start(1, { x: 10, y: 20 }, () => holds++);
  time.tick(100);
  press.stop();
  time.tick(1000);
  assert.equal(holds, 0);
  assert.equal(press.blocked, false);
  assert.equal(press.active, false);
  press.start(2, { x: 10, y: 20 }, () => holds++);
  time.tick(549);
  assert.equal(holds, 0);
  time.tick(1);
  assert.equal(holds, 1);
  assert.equal(press.blocked, true);
  press.stop();
  time.tick(1000);
  assert.equal(holds, 1);
});

test("swipes, cancellation, multitouch and leaving the picture cancel the pending long press", () => {
  const time = clock();
  let holds = 0;
  const press = new ImagePress(time.schedule, time.clear);
  press.start(1, { x: 0, y: 0 }, () => holds++);
  press.move(1, { x: 20, y: 0 });
  time.tick(700);
  assert.equal(holds, 0);
  assert.equal(press.blocked, true);
  press.start(2, { x: 0, y: 0 }, () => holds++);
  press.cancel();
  time.tick(700);
  assert.equal(holds, 0);
  press.start(3, { x: 0, y: 0 }, () => holds++);
  press.start(4, { x: 0, y: 0 }, () => holds++);
  time.tick(550);
  assert.equal(holds, 1);
  press.cancel();
  assert.equal(press.active, false);
});
