import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.mjs";
import { dispatch } from "./request.mjs";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("local asset libraries support folders, arbitrary uploads, protected previews, workbench export and import", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imagine-assets-api-"));
  const png = await sharp({ create: { width: 48, height: 32, channels: 3, background: "green" } })
    .png()
    .toBuffer();
  const data = `data:image/png;base64,${png.toString("base64")}`;
  const workspace = createApp({
    dataDir: directory,
    adminToken: "test-admin",
    runCompatible: async (_p, _k, job) => Array.from({ length: job.count }, () => data),
  });
  const call = (route, method = "GET", body, auth = true) =>
    dispatch(workspace.app, route, {
      method,
      body,
      headers: auth ? { authorization: "Bearer test-admin" } : {},
    });
  const wait = async (id) => {
    for (let n = 0; n < 100; n++) {
      const job = (await call("/api/jobs")).data.find((j) => j.id === id);
      if (!["queued", "running"].includes(job.status)) return job;
      await delay(10);
    }
    throw new Error("timeout");
  };
  try {
    assert.equal((await call("/api/libraries", "GET", undefined, false)).status, 401);
    const libs = (await call("/api/libraries")).data;
    assert.equal(libs[0].id, "local");
    assert.equal(libs[0].isDefault, true);
    assert.equal((await call("/api/libraries/local", "DELETE")).status, 409);
    assert.equal(
      (await call("/api/libraries/local/folders", "POST", { name: "参考图" })).status,
      201,
    );
    assert.equal(
      (
        await call("/api/libraries/local/upload", "POST", {
          path: "参考图",
          name: "photo.png",
          data,
        })
      ).status,
      201,
    );
    const listing = (
      await call("/api/libraries/local/entries?path=" + encodeURIComponent("参考图"))
    ).data;
    assert.equal(listing.entries[0].path, "参考图/photo.png");
    assert.equal(listing.entries[0].image, true);
    const preview = await call(listing.entries[0].previewUrl + "&thumbnail=1");
    assert.equal(preview.status, 200);
    assert.equal((await sharp(preview.bytes).metadata()).format, "webp");
    assert.equal((await call(listing.entries[0].previewUrl, "GET", undefined, false)).status, 401);
    const original = await call(
      "/api/libraries/local/file?path=" + encodeURIComponent("参考图/photo.png"),
    );
    assert.deepEqual(original.bytes, png);
    assert.match(original.headers["content-disposition"], /attachment/);
    assert.equal(
      (
        await call("/api/libraries/local/upload", "POST", {
          name: "note.html",
          data:
            "data:text/html;base64," + Buffer.from("<script>alert(1)</script>").toString("base64"),
        })
      ).status,
      201,
    );
    const file = await call("/api/libraries/local/file?path=note.html");
    assert.match(file.headers["content-type"], /application\/octet-stream/);
    assert.equal((await call("/api/libraries/local/preview?path=note.html")).status, 400);
    assert.equal((await call("/api/libraries/local/file?path=..%2F.encryption-key")).status, 400);
    assert.equal(
      (
        await call("/api/libraries/local/upload", "POST", {
          path: "参考图",
          name: "photo.png",
          data,
        })
      ).status,
      409,
    );
    const imported = (
      await call("/api/libraries/local/import", "POST", { path: "参考图/photo.png" })
    ).data;
    assert.equal(imported.kind, "upload");
    assert.equal(imported.width, 48);
    const provider = (
      await call("/api/providers", "POST", {
        name: "test",
        type: "openai",
        baseUrl: "https://api.example.com/v1",
        model: "test",
        supportsEdit: true,
      })
    ).data;
    const batch = (
      await call("/api/jobs", "POST", { providerId: provider.id, prompt: "batch", count: 2 })
    ).data;
    await wait(batch.id);
    let groups = (await call("/api/image-groups")).data;
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, batch.slotIds[0]);
    assert.equal(groups[0].versionCount, 2);
    const edit = (
      await call("/api/jobs", "POST", {
        providerId: provider.id,
        prompt: "edited",
        mode: "edit",
        sourceId: imported.id,
      })
    ).data;
    const edited = await wait(edit.id);
    groups = (await call("/api/image-groups")).data;
    assert.equal(groups.length, 2);
    const cover = groups.find((g) => g.threadId === imported.id);
    assert.equal(cover.id, imported.id);
    assert.equal(cover.versionCount, 2);
    const again = (
      await call("/api/jobs", "POST", {
        providerId: provider.id,
        prompt: "edited again",
        mode: "edit",
        sourceId: edited.imageIds[0],
      })
    ).data;
    const last = await wait(again.id);
    groups = (await call("/api/image-groups")).data;
    assert.equal(groups.length, 2);
    assert.equal(groups.find((g) => g.threadId === imported.id).versionCount, 3);
    assert.equal(
      (
        await call("/api/libraries/local/from-image", "POST", {
          imageId: last.imageIds[0],
          path: "参考图",
          name: "edited.png",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await call("/api/libraries/local/from-image", "POST", {
          imageId: last.imageIds[0],
          path: "参考图",
          name: "edited.png",
        })
      ).status,
      409,
    );
    assert.deepEqual(
      (await call("/api/libraries/local/file?path=" + encodeURIComponent("参考图/edited.png")))
        .bytes,
      png,
    );
    assert.equal((await call(`/api/images/${imported.id}`, "DELETE")).status, 200);
    assert.equal(
      (await call("/api/image-groups")).data.find((g) => g.threadId === imported.id).id,
      edited.imageIds[0],
    );
  } finally {
    workspace.close();
    await delay(20);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("remote source credentials are encrypted, retained on edits, and removal never deletes source files", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "imagine-assets-credentials-"));
  const requests = [];
  const libraryRequest = async (url, options) => {
    requests.push({ url, ...options });
    return {
      status: 200,
      headers: {},
      bytes: Buffer.from("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"),
    };
  };
  let workspace = createApp({ dataDir: directory, adminToken: "", libraryRequest });
  const call = (route, method = "GET", body) => dispatch(workspace.app, route, { method, body });
  try {
    const payload = {
      type: "s3",
      name: "S3 assets",
      endpoint: "https://s3.example.test",
      bucket: "bucket",
      prefix: "photos",
      region: "us-east-1",
      credentials: { accessKeyId: "TESTACCESSKEY", secretAccessKey: "test-secret-access-key" },
    };
    const created = await call("/api/libraries", "POST", payload);
    assert.equal(created.status, 201);
    assert.equal(created.data.hasCredentials, true);
    assert.equal(created.data.secret, undefined);
    assert.equal(created.data.credentials, undefined);
    const db = new DatabaseSync(path.join(directory, "workspace.sqlite"), { readOnly: true });
    const disk = db
      .prepare("SELECT payload FROM libraries WHERE id=?")
      .get(created.data.id).payload;
    assert.equal(disk.includes(payload.credentials.secretAccessKey), false);
    assert.equal(disk.includes(payload.credentials.accessKeyId), false);
    db.close();
    const updated = await call(`/api/libraries/${created.data.id}`, "PUT", {
      ...created.data,
      name: "renamed",
      credentials: {},
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.hasCredentials, true);
    workspace.close();
    workspace = createApp({ dataDir: directory, adminToken: "", libraryRequest });
    assert.equal((await call(`/api/libraries/${created.data.id}/entries`)).status, 200);
    assert.match(new Headers(requests.at(-1).headers).get("authorization"), /TESTACCESSKEY/);
    assert.equal(
      (
        await call(`/api/libraries/${created.data.id}`, "PUT", {
          ...created.data,
          endpoint: "https://another.example.test",
          credentials: {},
        })
      ).status,
      400,
    );
    const count = requests.length;
    assert.equal((await call(`/api/libraries/${created.data.id}`, "DELETE")).status, 200);
    assert.equal(requests.length, count);
    assert.equal((await call(`/api/libraries/${created.data.id}/entries`)).status, 404);
  } finally {
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
