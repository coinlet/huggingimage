import fs from "node:fs";
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
  const filename = path.join(directory, "workspace.json");
  const state = fs.existsSync(filename)
    ? JSON.parse(fs.readFileSync(filename, "utf8"))
    : { providers: [], jobs: [], images: [] };
  function save() {
    fs.writeFileSync(filename + ".tmp", JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(filename + ".tmp", filename);
  }
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
    }
  save();
  return { state, save, seal, open, directory };
}
export function publicProvider(provider) {
  const { secret, ...safe } = provider;
  return { ...safe, hasKey: Boolean(secret) };
}
