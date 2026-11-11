import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";
import { dispatch } from "./request.mjs";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const makePng = async () =>
  `data:image/png;base64,${(
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "#b4d593" } })
      .png()
      .toBuffer()
  ).toString("base64")}`;

async function fixture(runCompatible) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "imagine-slots-"));
  let workspace = createApp({ dataDir: dir, adminToken: "", runCompatible });
  const call = (route, method = "GET", body) => dispatch(workspace.app, route, { method, body });
  const provider = (
    await call("/api/providers", "POST", {
      type: "openai",
      name: "Test",
      model: "model",
      baseUrl: "https://example.com/v1",
      supportsEdit: true,
    })
  ).data;
  async function waitJob(id) {
    for (let i = 0; i < 100; i++) {
      const job = (await call("/api/jobs")).data.find((j) => j.id === id);
      if (!["queued", "running"].includes(job.status)) return job;
      await delay(10);
    }
    throw new Error("Job timed out");
  }
  return {
    call,
    provider,
    waitJob,
    restart() {
      workspace.close();
      workspace = createApp({ dataDir: dir, adminToken: "", runCompatible });
    },
    async close() {
      workspace.close();
      await delay(30);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("an accepted prompt immediately reserves a persistent slot; failure and retry keep its ID", async () => {
  const png = await makePng();
  let rejectFirst;
  let calls = 0;
  const fx = await fixture(async () => {
    calls++;
    if (calls === 1)
      return new Promise((_resolve, reject) => {
        rejectFirst = reject;
      });
    return [png];
  });
  try {
    const id = randomUUID();
    const submitted = await fx.call("/api/jobs", "POST", {
      providerId: fx.provider.id,
      prompt: "mountains at sunrise",
      slotIds: [id],
    });
    assert.equal(submitted.status, 202);
    assert.deepEqual(submitted.data.slotIds, [id]);
    assert.deepEqual(submitted.data.imageIds, []);
    const slots = (await fx.call("/api/images")).data;
    assert.equal(slots.length, 1);
    assert.equal(slots[0].id, id);
    assert.equal(slots[0].prompt, "mountains at sunrise");
    assert.equal(slots[0].url, "");
    assert.ok(["queued", "running"].includes(slots[0].status));
    assert.equal((await fx.call(`/api/images/${id}/retry`, "POST")).status, 409);
    assert.equal((await fx.call(`/api/images/${id}`, "DELETE")).status, 409);
    assert.equal(
      (
        await fx.call("/api/jobs", "POST", {
          providerId: fx.provider.id,
          prompt: "edit",
          mode: "edit",
          sourceId: id,
        })
      ).status,
      400,
    );
    rejectFirst(new Error("GPU unavailable"));
    assert.equal((await fx.waitJob(submitted.data.id)).status, "failed");
    const failed = (await fx.call(`/api/images/${id}/thread`)).data;
    assert.equal(failed[0].status, "failed");
    assert.match(failed[0].error, /GPU unavailable/);
    fx.restart();
    assert.equal((await fx.call("/api/images")).data[0].status, "failed");
    const retried = await fx.call(`/api/images/${id}/retry`, "POST");
    assert.equal(retried.status, 202);
    assert.deepEqual(retried.data.slotIds, [id]);
    assert.equal(retried.data.prompt, submitted.data.prompt);
    assert.equal((await fx.waitJob(retried.data.id)).status, "succeeded");
    const ready = (await fx.call("/api/images")).data;
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, id);
    assert.equal(ready[0].status, "succeeded");
    assert.equal(ready[0].error, undefined);
    assert.equal(ready[0].createdAt, slots[0].createdAt);
    assert.equal(ready[0].threadId, id);
    assert.equal((await fx.call(ready[0].url)).status, 200);
    assert.equal((await fx.call(`/api/images/${id}/retry`, "POST")).status, 409);
  } finally {
    await fx.close();
  }
});

test("partial batches retain successful slots and only retry the selected failed image", async () => {
  const png = await makePng();
  let attempts = 0;
  const fx = await fixture(async (_provider, _key, job) => {
    attempts++;
    return attempts === 1 ? [png, "data:image/png;base64,YmFk"] : [png];
  });
  try {
    const job = (
      await fx.call("/api/jobs", "POST", { providerId: fx.provider.id, prompt: "batch", count: 2 })
    ).data;
    assert.equal((await fx.waitJob(job.id)).status, "failed");
    const before = (await fx.call(`/api/images/${job.slotIds[0]}/thread`)).data;
    assert.deepEqual(
      before.map((i) => i.status),
      ["succeeded", "failed"],
    );
    const retry = (await fx.call(`/api/images/${job.slotIds[1]}/retry`, "POST")).data;
    assert.equal(retry.count, 1);
    assert.equal((await fx.waitJob(retry.id)).status, "succeeded");
    const after = (await fx.call(`/api/images/${job.slotIds[0]}/thread`)).data;
    assert.deepEqual(
      after.map((i) => i.id),
      before.map((i) => i.id),
    );
    assert.deepEqual(
      after.map((i) => i.status),
      ["succeeded", "succeeded"],
    );
    assert.equal(after[0].jobId, before[0].jobId);
  } finally {
    await fx.close();
  }
});

test("empty results fail visibly; failed slots can be deleted and duplicate IDs are rejected", async () => {
  const fx = await fixture(async () => []);
  try {
    assert.equal(
      (
        await fx.call("/api/jobs", "POST", {
          providerId: fx.provider.id,
          prompt: "invalid",
          slotIds: ["bad"],
        })
      ).status,
      400,
    );
    assert.equal((await fx.call("/api/images")).data.length, 0);
    const job = (
      await fx.call("/api/jobs", "POST", { providerId: fx.provider.id, prompt: "empty" })
    ).data;
    assert.equal((await fx.waitJob(job.id)).status, "failed");
    const slot = (await fx.call("/api/images")).data[0];
    assert.equal(slot.status, "failed");
    assert.match(slot.error, /未返回图片/);
    assert.equal(
      (
        await fx.call("/api/jobs", "POST", {
          providerId: fx.provider.id,
          prompt: "duplicate",
          slotIds: [slot.id],
        })
      ).status,
      409,
    );
    assert.equal((await fx.call(`/api/images/${slot.id}`, "DELETE")).status, 200);
    assert.equal((await fx.call("/api/images")).data.length, 0);
  } finally {
    await fx.close();
  }
});

test("editing reserves a new version in the original thread, and retry keeps that version", async () => {
  const png = await makePng();
  let attempts = 0;
  const fx = await fixture(async () => {
    if (++attempts === 1) throw new Error("Space asleep");
    return [png];
  });
  try {
    const original = (await fx.call("/api/uploads", "POST", { data: png, name: "original.png" }))
      .data;
    const edit = (
      await fx.call("/api/jobs", "POST", {
        providerId: fx.provider.id,
        mode: "edit",
        sourceId: original.id,
        prompt: "make it blue",
      })
    ).data;
    assert.equal((await fx.waitJob(edit.id)).status, "failed");
    const versions = (await fx.call(`/api/images/${original.id}/thread`)).data;
    assert.equal(versions.length, 2);
    assert.equal(versions[1].parentId, original.id);
    assert.equal(versions[1].threadId, original.id);
    const retry = (await fx.call(`/api/images/${versions[1].id}/retry`, "POST")).data;
    assert.equal(retry.sourceId, original.id);
    assert.equal((await fx.waitJob(retry.id)).status, "succeeded");
    const after = (await fx.call(`/api/images/${original.id}/thread`)).data;
    assert.equal(after.length, 2);
    assert.equal(after[1].id, versions[1].id);
    assert.equal(after[1].prompt, "make it blue");
  } finally {
    await fx.close();
  }
});

test("cancelled image slots can be retried without adding another image", async () => {
  const png = await makePng();
  let calls = 0;
  const fx = await fixture(async () => {
    if (++calls === 1) return new Promise(() => {});
    return [png];
  });
  try {
    const job = (
      await fx.call("/api/jobs", "POST", {
        providerId: fx.provider.id,
        prompt: "cancel then retry",
      })
    ).data;
    await fx.call(`/api/jobs/${job.id}/cancel`, "POST");
    await delay(10);
    const slot = (await fx.call("/api/images")).data[0];
    assert.equal(slot.status, "cancelled");
    const retried = await fx.call(`/api/images/${slot.id}/retry`, "POST");
    assert.equal(retried.status, 202);
    assert.equal((await fx.waitJob(retried.data.id)).status, "succeeded");
    const after = (await fx.call("/api/images")).data;
    assert.equal(after.length, 1);
    assert.equal(after[0].id, slot.id);
  } finally {
    await fx.close();
  }
});

test("custom resolution is validated, persisted in a reserved slot, and reused on retry", async () => {
  const png = await makePng();
  const calls = [];
  const fx = await fixture(async (_provider, _key, job) => {
    calls.push({
      width: job.width,
      height: job.height,
      ratio: job.ratio,
      resolution: job.resolution,
    });
    if (calls.length === 1) throw new Error("temporary failure");
    return [png];
  });
  try {
    const invalid = await fx.call("/api/jobs", "POST", {
      providerId: fx.provider.id,
      prompt: "bad size",
      resolution: "custom",
      width: 4097,
      height: 1024,
    });
    assert.equal(invalid.status, 400);
    assert.equal((await fx.call("/api/images")).data.length, 0);
    const submitted = await fx.call("/api/jobs", "POST", {
      providerId: fx.provider.id,
      prompt: "forest",
      resolution: "custom",
      width: 1280,
      height: 720,
    });
    assert.equal(submitted.status, 202);
    assert.equal(submitted.data.ratio, "16:9");
    await fx.waitJob(submitted.data.id);
    const slot = (await fx.call("/api/images")).data[0];
    assert.equal(slot.width, 1280);
    assert.equal(slot.height, 720);
    fx.restart();
    const retry = (await fx.call(`/api/images/${slot.id}/retry`, "POST")).data;
    assert.equal(retry.resolution, "custom");
    assert.equal((await fx.waitJob(retry.id)).status, "succeeded");
    assert.deepEqual(
      calls,
      [0, 1].map(() => ({ width: 1280, height: 720, ratio: "16:9", resolution: "custom" })),
    );
    assert.equal((await fx.call("/api/images")).data[0].width, 32);
  } finally {
    await fx.close();
  }
});
