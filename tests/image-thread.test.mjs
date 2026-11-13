import test from "node:test";
import assert from "node:assert/strict";
import { imageThread } from "../server/image-thread.mjs";

test("thread view includes references in task order, preserving their original group and excluding unrelated history", () => {
  const a = { id: "a", threadId: "a", kind: "upload" };
  const b = { id: "b", threadId: "other", kind: "generated", prompt: "other prompt" };
  const state = {
    images: [
      a,
      b,
      { id: "other-edit", threadId: "other" },
      { id: "c", threadId: "c", kind: "upload" },
      { id: "r1", threadId: "a", jobId: "j1" },
      { id: "r2", threadId: "a", jobId: "j2" },
    ],
    jobs: [
      { id: "j1", referenceIds: ["c", "b"], prompt: "first combine" },
      { id: "j2", referenceIds: ["b", "missing", "a"], prompt: "second combine" },
    ],
  };
  const before = structuredClone(state);
  const result = imageThread(state, a);
  assert.deepEqual(
    result.map((i) => i.id),
    ["a", "c", "b", "r1", "r2"],
  );
  assert.deepEqual(result[1].referenceContext, {
    jobId: "j1",
    resultId: "r1",
    number: 2,
    prompt: "first combine",
  });
  assert.equal(result[2].referenceContext.number, 3);
  assert.equal(result[2].threadId, "other");
  assert.equal(result[2].prompt, "other prompt");
  assert.deepEqual(state, before);
  assert.deepEqual(
    imageThread(state, b).map((i) => i.id),
    ["b", "other-edit"],
  );
});

test("single-image threads and legacy roots stay unchanged; pending, failed and retried slots include input references", () => {
  const a = { id: "a", kind: "upload" };
  const b = { id: "b", threadId: "b" };
  const state = {
    images: [a, b, { id: "slot", threadId: "a", jobId: "job", status: "running" }],
    jobs: [{ id: "job", referenceIds: ["b"], prompt: "combine" }],
  };
  assert.deepEqual(imageThread({ images: [a, b], jobs: [] }, a), [a]);
  for (const status of ["running", "failed", "succeeded"]) {
    state.images[2].status = status;
    const result = imageThread(state, a);
    assert.deepEqual(
      result.map((i) => i.id),
      ["a", "b", "slot"],
    );
    assert.equal(result[1].referenceContext.resultId, "slot");
  }
  state.images = state.images.filter((i) => i.id !== "b");
  assert.deepEqual(
    imageThread(state, a).map((i) => i.id),
    ["a", "slot"],
  );
});
