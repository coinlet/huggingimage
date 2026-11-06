const closingClients = new WeakMap();

function isAbortError(error) {
  return error?.name === "AbortError" || error?.error?.name === "AbortError";
}

function quietClosingStream(stream, client) {
  if (!stream || typeof stream.onerror !== "function") return;
  const original = stream.onerror;
  stream.onerror = function (error, ...args) {
    // @gradio/client forwards an intentional SSE abort to its async onerror
    // callback. A try/catch around client.close() cannot catch that callback.
    if (closingClients.has(client) && isAbortError(error)) return;
    return original.call(this, error, ...args);
  };
}

export async function closeGradioClient(client, { primaryError } = {}) {
  if (!client) return;
  let closing = closingClients.get(client);
  if (!closing) {
    closing = Promise.resolve().then(async () => {
      for (const stream of new Set([client.stream_instance, client.heartbeat_event])) {
        quietClosingStream(stream, client);
      }
      try {
        await client.close();
      } catch (error) {
        if (!isAbortError(error)) throw error;
      }
    });
    closingClients.set(client, closing);
  }
  try {
    await closing;
  } catch (error) {
    if (primaryError === undefined) throw error;
    // Keep the inference/API error as the primary failure if cleanup also fails.
    if (
      primaryError instanceof Error &&
      Object.isExtensible(primaryError) &&
      !Object.hasOwn(primaryError, "cleanupError")
    ) {
      Object.defineProperty(primaryError, "cleanupError", { value: error, configurable: true });
    }
  }
}
