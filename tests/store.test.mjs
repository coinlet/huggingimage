import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../server/store.mjs";

const directory = () => mkdtempSync(path.join(os.tmpdir(), "imagine-sqlite-"));
test("SQLite migrates legacy data, recovers edit branches, preserves keys and never reimports stale JSON", () => {
  const dir = directory();
  let store;
  try {
    const legacy = {
      providers: [{ id: "provider", name: "private" }],
      jobs: [
        { id: "edit1", sourceId: "original", status: "succeeded" },
        { id: "edit2", sourceId: "blue", status: "running" },
        { id: "branch", sourceId: "original", status: "queued" },
      ],
      images: [
        { id: "blue", jobId: "edit1", prompt: "blue" },
        { id: "sun", jobId: "edit2", prompt: "sun" },
        { id: "red", jobId: "branch", prompt: "red" },
        { id: "original", kind: "upload" },
        { id: "unrelated", kind: "generated" },
      ],
    };
    const original = JSON.stringify(legacy);
    writeFileSync(path.join(dir, "workspace.json"), original);
    store = createStore(dir);
    assert.equal(
      readFileSync(path.join(dir, "workspace.sqlite")).subarray(0, 16).toString(),
      "SQLite format 3\0",
    );
    assert.equal(readFileSync(path.join(dir, "workspace.json"), "utf8"), original);
    assert.equal(store.state.images.find((i) => i.id === "sun").parentId, "blue");
    assert.ok(store.state.images.slice(0, 4).every((i) => i.threadId === "original"));
    assert.equal(store.state.images[4].threadId, "unrelated");
    assert.equal(store.state.jobs[1].status, "failed");
    assert.equal(store.state.jobs[2].status, "failed");
    const secret = store.seal("hf-private-token");
    store.state.providers[0].secret = secret;
    store.state.images[0].favorite = true;
    store.state.images = store.state.images.filter((i) => i.id !== "red");
    store.save();
    store.close();
    store = createStore(dir);
    assert.equal(store.open(store.state.providers[0].secret), "hf-private-token");
    assert.equal(store.state.images.length, 4);
    assert.equal(store.state.images[0].favorite, true);
    assert.equal(store.state.images[1].parentId, "blue");
    const db = new DatabaseSync(path.join(dir, "workspace.sqlite"), { readOnly: true });
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM images WHERE thread_id=?").get("original").count,
      3,
    );
    assert.equal(
      db.prepare("SELECT payload FROM providers").get().payload.includes("hf-private-token"),
      false,
    );
    db.close();
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed SQLite save rolls back all tables and can be retried", () => {
  const dir = directory();
  const store = createStore(dir);
  try {
    store.state.providers.push({ id: "first", name: "before" });
    store.save();
    store.state.providers[0].name = "after";
    store.state.images.push({ id: null, threadId: "invalid" });
    // Undefined cannot bind to SQLite, after the provider update has already executed.
    store.state.images[0].id = undefined;
    assert.throws(() => store.save());
    const db = new DatabaseSync(path.join(dir, "workspace.sqlite"), { readOnly: true });
    assert.equal(
      JSON.parse(db.prepare("SELECT payload FROM providers").get().payload).name,
      "before",
    );
    db.close();
    store.state.images = [];
    store.save();
    const read = new DatabaseSync(path.join(dir, "workspace.sqlite"), { readOnly: true });
    assert.equal(
      JSON.parse(read.prepare("SELECT payload FROM providers").get().payload).name,
      "after",
    );
    read.close();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid legacy data is preserved and can be repaired before retrying migration", () => {
  const dir = directory();
  try {
    writeFileSync(path.join(dir, "workspace.json"), '{"providers":');
    assert.throws(() => createStore(dir));
    assert.equal(readFileSync(path.join(dir, "workspace.json"), "utf8"), '{"providers":');
    writeFileSync(
      path.join(dir, "workspace.json"),
      JSON.stringify({ providers: [], jobs: [], images: [] }),
    );
    const store = createStore(dir);
    assert.equal(store.state.images.length, 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart marks unfinished image slots failed and retains their IDs and prompts", () => {
  const dir = directory();
  const store = createStore(dir);
  store.state.jobs.push({ id: "interrupted", status: "running", slotIds: ["reserved"] });
  store.state.images.push({
    id: "reserved",
    jobId: "interrupted",
    threadId: "reserved",
    prompt: "keep this idea",
    status: "running",
    url: "",
  });
  store.save();
  store.close();
  const restarted = createStore(dir);
  try {
    assert.equal(restarted.state.images[0].id, "reserved");
    assert.equal(restarted.state.images[0].prompt, "keep this idea");
    assert.equal(restarted.state.images[0].status, "failed");
    assert.match(restarted.state.images[0].error, /重启/);
  } finally {
    restarted.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
