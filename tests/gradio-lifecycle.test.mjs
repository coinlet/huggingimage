import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { Client } from "@gradio/client";
import { closeGradioClient } from "../server/gradio-client-lifecycle.mjs";
import { inspectSpace, runSpace } from "../server/providers.mjs";

const abort = () => new DOMException("This operation was aborted", "AbortError");
const endpoint = { endpoint: "/infer", template: { prompt: "{{prompt}}" }, outputPath: "0" };
const job = { mode: "generate", count: 1, prompt: "a forest", seed: 1 };
const messages = [{ type: "data", data: [{ url: "https://test-model.hf.space/result.png" }] }];
function fakeClient(close, events = messages) {
  return {
    config: { root: "https://test-model.hf.space" },
    close,
    submit() {
      return {
        cancel() {},
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
      };
    },
  };
}

// Exercise the installed SDK's real SSE reader and Client.close(), without
// opening a connection, generating an image or spending GPU quota.
function mockSdkStream(t) {
  const controllers = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (request) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controllers.push(controller);
            const onAbort = () => controller.error(request.signal.reason);
            if (request.signal.aborted) onAbort();
            else request.signal.addEventListener("abort", onAbort, { once: true });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const logs = [];
  t.mock.method(console, "error", (...values) => logs.push(values));
  const client = new Client("owner/test-model", { events: ["data", "status"] });
  client.config = { root: "https://test-model.hf.space", connect_heartbeat: true };
  return { client, logs, controllers };
}

test("real SDK stream shutdown aborts SSE and heartbeat without printing AbortError", async (t) => {
  const { client, logs } = mockSdkStream(t);
  client.open_heartbeat();
  const heartbeat = client.heartbeat_controller;
  client.heartbeat_event.onerror = (error) => console.error(error);
  await client.open_stream();
  const stream = client.abort_controller;
  await setImmediate();
  await closeGradioClient(client);
  await setImmediate();
  assert.equal(client.closed, true);
  assert.equal(stream.signal.aborted, true);
  assert.equal(heartbeat.signal.aborted, true);
  assert.deepEqual(logs, []);
});

test("real SDK network errors remain visible while the inference stream is active", async (t) => {
  const { client, logs, controllers } = mockSdkStream(t);
  await client.open_stream();
  await setImmediate();
  const failure = new Error("SSE connection lost during inference");
  controllers[0].error(failure);
  await setImmediate();
  assert.ok(logs.some((values) => values.includes(failure)));
  await closeGradioClient(client);
  await setImmediate();
});

test("cleanup ignores synchronous or asynchronous AbortError and closes a client only once", async () => {
  for (const close of [
    () => {
      throw abort();
    },
    async () => {
      throw abort();
    },
  ]) {
    let count = 0;
    const client = {
      close() {
        count++;
        return close();
      },
    };
    await Promise.all([closeGradioClient(client), closeGradioClient(client)]);
    await closeGradioClient(client);
    assert.equal(count, 1);
  }
});

test("cleanup does not suppress unexpected close failures or unrelated stream errors", async () => {
  const failure = new Error("unexpected cleanup failure");
  await assert.rejects(
    closeGradioClient({
      close() {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  let received;
  const stream = {
    onerror(error) {
      received = error;
    },
  };
  const client = {
    stream_instance: stream,
    close() {
      stream.onerror(failure);
    },
  };
  await closeGradioClient(client);
  assert.equal(received, failure);
});

test("successful inference keeps its result when closing raises AbortError", async () => {
  const client = fakeClient(async () => {
    throw abort();
  });
  const result = await runSpace(
    endpoint,
    "",
    job,
    null,
    null,
    new AbortController().signal,
    async () => client,
  );
  assert.equal(result[0].url, "https://test-model.hf.space/result.png");
});

test("inference errors stay primary when connection cleanup also fails", async () => {
  const cleanupFailure = new Error("cleanup also failed");
  const client = fakeClient(() => {
    throw cleanupFailure;
  }, [{ type: "status", stage: "error", message: "GPU quota exceeded" }]);
  await assert.rejects(
    runSpace(endpoint, "", job, null, null, new AbortController().signal, async () => client),
    (error) => {
      assert.equal(error.message, "GPU quota exceeded");
      assert.equal(error.cleanupError, cleanupFailure);
      return true;
    },
  );
});

test("API inspection uses the same close handling and does not replace its original failure", async (t) => {
  const api = { named_endpoints: {} };
  let closed = 0;
  const mocked = t.mock.method(Client, "connect", async () => ({
    view_api: async () => api,
    close() {
      closed++;
      throw abort();
    },
  }));
  assert.equal(await inspectSpace({ space: "owner/test-model" }, ""), api);
  assert.equal(closed, 1);
  mocked.mock.restore();
  const inspectionFailure = new Error("Space access denied");
  t.mock.method(Client, "connect", async () => ({
    view_api: async () => {
      throw inspectionFailure;
    },
    close() {
      throw new Error("close failed");
    },
  }));
  await assert.rejects(
    inspectSpace({ space: "owner/test-model" }, ""),
    (error) => error === inspectionFailure,
  );
});
