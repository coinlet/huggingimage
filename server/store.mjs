import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export function createStore(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(directory, "media"), { recursive: true, mode: 0o700 });
  const keyFile = path.join(directory, ".encryption-key");
  if (!process.env.ENCRYPTION_KEY && !fs.existsSync(keyFile))
    fs.writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
  const key = Buffer.from(
    process.env.ENCRYPTION_KEY || fs.readFileSync(keyFile, "utf8").trim(),
    "base64",
  );
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  const filename = path.join(directory, "workspace.sqlite");
  const legacy = path.join(directory, "workspace.json");
  const db = new DatabaseSync(filename);
  fs.chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS libraries (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, thread_id TEXT, parent_id TEXT, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS images_thread ON images(thread_id);`);
  const tables = ["providers", "jobs", "images", "libraries"];
  const initialized = db.prepare("SELECT value FROM metadata WHERE key='initialized'").get();
  let state;
  try {
    state =
      !initialized && fs.existsSync(legacy)
        ? JSON.parse(fs.readFileSync(legacy, "utf8"))
        : Object.fromEntries(
            tables.map((table) => [
              table,
              db
                .prepare(`SELECT payload FROM ${table} ORDER BY rowid`)
                .all()
                .map((row) => JSON.parse(row.payload)),
            ]),
          );
    state.libraries ??= [];
    if (!state.libraries.some((library) => library.id === "local"))
      state.libraries.unshift({
        id: "local",
        name: "本地素材库",
        type: "local",
        createdAt: new Date().toISOString(),
      });
    for (const table of tables) {
      if (!Array.isArray(state[table]) || state[table].some((row) => !row.id))
        throw new Error(`Invalid workspace data: ${table}`);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  const snapshots = Object.fromEntries(
    tables.map((table) => [
      table,
      new Map(
        db
          .prepare(`SELECT id, payload FROM ${table}`)
          .all()
          .map((row) => [row.id, row.payload]),
      ),
    ]),
  );
  function save() {
    db.exec("BEGIN IMMEDIATE");
    const next = {};
    try {
      for (const table of tables) {
        next[table] = new Map();
        const upsert = db.prepare(
          table === "images"
            ? "INSERT INTO images(id,thread_id,parent_id,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET thread_id=excluded.thread_id,parent_id=excluded.parent_id,payload=excluded.payload"
            : `INSERT INTO ${table}(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`,
        );
        for (const row of state[table]) {
          const payload = JSON.stringify(row);
          next[table].set(row.id, payload);
          if (snapshots[table].get(row.id) === payload) continue;
          if (table === "images")
            upsert.run(row.id, row.threadId || row.id, row.parentId || null, payload);
          else upsert.run(row.id, payload);
        }
        const remove = db.prepare(`DELETE FROM ${table} WHERE id=?`);
        for (const id of snapshots[table].keys()) if (!next[table].has(id)) remove.run(id);
      }
      db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('initialized','1')").run();
      db.exec("COMMIT");
      Object.assign(snapshots, next);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  // Recover existing edit chains using the source recorded on each legacy job.
  const jobs = new Map(state.jobs.map((job) => [job.id, job]));
  const images = new Map(state.images.map((image) => [image.id, image]));
  function lineage(image, visiting = new Set()) {
    if (image.threadId) return image.threadId;
    if (visiting.has(image.id)) return image.id;
    visiting.add(image.id);
    const parentId = image.parentId || jobs.get(image.jobId)?.sourceId;
    const parent = images.get(parentId);
    if (parent && parent !== image) image.parentId = parent.id;
    image.threadId = parent && parent !== image ? lineage(parent, visiting) : image.id;
    return image.threadId;
  }
  for (const image of state.images) lineage(image);
  function seal(value) {
    if (!value) return "";
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString("base64")).join(".");
  }
  function open(value) {
    if (!value) return "";
    const [iv, tag, body] = value.split(".").map((x) => Buffer.from(x, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  }
  for (const job of state.jobs)
    if (["queued", "running"].includes(job.status)) {
      job.status = "failed";
      job.error = "服务重启中断了任务，请重试";
      for (const image of state.images)
        if (image.jobId === job.id && ["queued", "running"].includes(image.status)) {
          image.status = "failed";
          image.error = job.error;
        }
    }
  save();
  return { state, save, seal, open, directory, close: () => db.close() };
}
export function publicProvider(provider) {
  const { secret, ...safe } = provider;
  return { ...safe, hasKey: Boolean(secret) };
}
