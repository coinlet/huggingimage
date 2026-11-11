import test from "node:test";
import assert from "node:assert/strict";
import { connectMcp, inspectMcp, runMcp, extractMcpImages } from "../server/mcp-provider.mjs";
import { suggestMcpTool } from "../server/mcp-config.mjs";
const signal = () => new AbortController().signal;
const tools = [
  {
    name: "generate_image",
    description: "Create an image",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
        steps: { type: "number", default: 4 },
        image_url: { type: "string" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_image",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, image_base64: { type: "string" } },
      required: ["prompt", "image_base64"],
    },
  },
];

function httpFixture({ session = true, status, toolResult } = {}) {
  const requests = [];
  const fetch = async (input, init) => {
    const headers = new Headers(init.headers);
    const message = init.body ? JSON.parse(init.body) : null;
    requests.push({ url: String(input), method: init.method, headers, message });
    if (status) return new Response("Unauthorized", { status });
    if (init.method === "GET") return new Response(null, { status: 405 });
    if (init.method === "DELETE" || message?.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    let result;
    if (message.method === "initialize")
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "image-mcp", version: "1.0" },
      };
    if (message.method === "tools/list") result = { tools };
    if (message.method === "tools/call")
      result = toolResult || {
        content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
      };
    if (message.method === "resources/read")
      result = { contents: [{ uri: message.params.uri, mimeType: "image/png", blob: "aW1hZ2U=" }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
      headers: {
        "content-type": "application/json",
        ...(session && message.method === "initialize" ? { "mcp-session-id": "test-session" } : {}),
      },
    });
  };
  return { requests, fetch };
}

test("MCP discovery uses the real SDK handshake and lists tools without invoking inference", async () => {
  const fixture = httpFixture();
  const result = await inspectMcp(
    { baseUrl: "https://mcp.example.com/mcp", mcpTransport: "auto" },
    "private-key",
    (p, k, s) => connectMcp(p, k, s, fixture.fetch),
  );
  assert.equal(result.transport, "streamable-http");
  assert.equal(result.endpoint, "generate_image");
  assert.equal(result.editEndpoint, "edit_image");
  assert.equal(result.template.prompt, "{{prompt}}");
  assert.equal(result.template.image_url, undefined);
  assert.equal(result.editTemplate.image_base64, "{{image_base64}}");
  assert.equal(result.defaults.generate.steps, 4);
  assert.equal(
    fixture.requests.some((r) => r.message?.method === "tools/call"),
    false,
  );
  assert.ok(fixture.requests.some((r) => r.method === "DELETE"));
  assert.ok(fixture.requests.every((r) => r.headers.get("authorization") === "Bearer private-key"));
});

test("tool schema inference marks required unknown parameters for review", () => {
  const tool = suggestMcpTool({
    name: "render_image",
    inputSchema: {
      type: "object",
      properties: { prompt: { type: "string" }, model: { type: "string" } },
      required: ["prompt", "model"],
    },
  });
  assert.deepEqual(tool.missing, ["model"]);
  assert.equal(tool.template.model, null);
  const edit = suggestMcpTool(tools[1]);
  assert.equal(edit.canGenerate, false);
  assert.equal(edit.canEdit, true);
});

test("generation and editing call configured tools with numeric sizes, encoded input and sequential seeds", async () => {
  const fixture = httpFixture();
  const provider = {
    baseUrl: "http://mcp.local/mcp",
    mcpTransport: "streamable-http",
    mcpAuth: "x-api-key",
    endpoint: "generate_image",
    editEndpoint: "edit_image",
    template: { prompt: "{{prompt}}", width: "{{width}}", height: "{{height}}", seed: "{{seed}}" },
    editTemplate: { prompt: "{{prompt}}", image_base64: "{{image_base64}}", mask: "{{mask}}" },
  };
  const connector = (p, k, s) => connectMcp(p, k, s, fixture.fetch);
  const job = {
    mode: "generate",
    prompt: "forest",
    width: 2048,
    height: 1152,
    ratio: "16:9",
    seed: 42,
    count: 2,
  };
  const generated = await runMcp(provider, "private-key", job, null, null, signal(), connector);
  assert.equal(generated.length, 2);
  assert.equal(generated[0].url, "data:image/png;base64,aW1hZ2U=");
  assert.equal(generated[0].authOrigin, "http://mcp.local");
  const generateCalls = fixture.requests.filter((r) => r.message?.method === "tools/call");
  assert.deepEqual(
    generateCalls.map((r) => r.message.params.arguments.seed),
    [42, 43],
  );
  assert.equal(generateCalls[0].message.params.arguments.width, 2048);
  assert.equal(generateCalls[0].headers.get("x-api-key"), "private-key");
  await runMcp(
    provider,
    "private-key",
    { ...job, mode: "edit", count: 1 },
    Buffer.from("source"),
    null,
    signal(),
    connector,
  );
  const edited = fixture.requests.filter((r) => r.message?.method === "tools/call").at(-1)
    .message.params;
  assert.equal(edited.name, "edit_image");
  assert.equal(edited.arguments.image_base64, Buffer.from("source").toString("base64"));
  assert.equal(edited.arguments.mask, undefined);
});

test("MCP results support structured JSON, text, embedded images and resource links, never local file paths", async () => {
  const reads = [];
  const client = {
    readResource: async ({ uri }) => {
      reads.push(uri);
      return { contents: [{ uri, mimeType: "image/png", blob: "aW1hZ2U=" }] };
    },
  };
  assert.deepEqual(
    await extractMcpImages(
      {
        structuredContent: { images: [{ url: "https://cdn.example.com/image.png" }] },
        content: [{ type: "text", text: '{"image_base64":"Ynl0ZXM="}' }],
      },
      client,
      signal(),
    ),
    ["https://cdn.example.com/image.png", "data:image/png;base64,Ynl0ZXM="],
  );
  assert.deepEqual(
    await extractMcpImages(
      {
        content: [
          {
            type: "resource_link",
            uri: "image://generated/1",
            mimeType: "image/png",
            name: "result",
          },
        ],
      },
      client,
      signal(),
    ),
    ["data:image/png;base64,aW1hZ2U="],
  );
  assert.deepEqual(reads, ["image://generated/1"]);
  assert.deepEqual(
    await extractMcpImages(
      { content: [{ type: "resource", resource: { mimeType: "image/webp", blob: "Ynl0ZXM=" } }] },
      client,
      signal(),
    ),
    ["data:image/webp;base64,Ynl0ZXM="],
  );
  assert.deepEqual(
    await extractMcpImages(
      { content: [{ type: "text", text: "![Result](https://cdn.example.com/img?id=1)" }] },
      client,
      signal(),
    ),
    ["https://cdn.example.com/img?id=1"],
  );
  assert.deepEqual(
    await extractMcpImages(
      { result: "/tmp/private.png", image: "file:///etc/passwd" },
      client,
      signal(),
    ),
    [],
  );
});

test("tool errors, invalid output paths and image-less responses close the MCP connection", async () => {
  const provider = {
    baseUrl: "https://mcp.example.com/mcp",
    endpoint: "generate",
    template: { prompt: "{{prompt}}" },
  };
  const job = { mode: "generate", prompt: "forest", count: 1, seed: 1 };
  for (const [result, outputPath, pattern] of [
    [{ isError: true, content: [{ type: "text", text: "GPU quota exceeded" }] }, "", /GPU quota/],
    [{ content: [{ type: "text", text: "queued task 123" }] }, "", /不能仅返回任务 ID/],
    [{ content: [] }, "structuredContent.missing", /输出路径/],
  ]) {
    let closed = false;
    const connector = async () => ({
      client: { callTool: async () => result },
      close: async () => {
        closed = true;
      },
    });
    await assert.rejects(
      runMcp({ ...provider, outputPath }, "", job, null, null, signal(), connector),
      pattern,
    );
    assert.equal(closed, true);
  }
});

test("authentication failures do not trigger a second request with another transport", async () => {
  const fixture = httpFixture({ status: 401 });
  await assert.rejects(
    connectMcp(
      { baseUrl: "https://mcp.example.com/mcp", mcpTransport: "auto" },
      "private-key",
      signal(),
      fixture.fetch,
    ),
    (error) => error.code === 401,
  );
  assert.equal(fixture.requests.length, 1);
});

test("auto transport falls back to legacy SSE, initializes and closes its stream", async () => {
  const encoder = new TextEncoder();
  let streamController,
    cancelled = false;
  const methods = [];
  const fetch = async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/sse" && init.method === "POST")
      return new Response(null, { status: 405 });
    if (url.pathname === "/sse")
      return new Response(
        new ReadableStream({
          start(controller) {
            streamController = controller;
            init.signal.addEventListener("abort", () => {
              cancelled = true;
              try {
                controller.close();
              } catch {}
            });
            controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const message = JSON.parse(init.body);
    methods.push(message.method);
    if (message.id != null) {
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "legacy", version: "1" },
            }
          : { tools };
      streamController.enqueue(
        encoder.encode(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
        ),
      );
    }
    return new Response(null, { status: 202 });
  };
  const result = await inspectMcp(
    { baseUrl: "https://mcp.example.com/sse", mcpTransport: "auto" },
    "",
    (p, k, s) => connectMcp(p, k, s, fetch),
  );
  assert.equal(result.transport, "sse");
  assert.ok(methods.includes("tools/list"));
  assert.equal(cancelled, true);
});

test("aborting an MCP generation closes the active request without leaving it running locally", async () => {
  const fixture = httpFixture();
  const controller = new AbortController();
  let aborted = false;
  const fetch = async (input, init) => {
    const message = init.body ? JSON.parse(init.body) : null;
    if (message?.method === "tools/call")
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(init.signal.reason);
          },
          { once: true },
        );
        queueMicrotask(() => controller.abort(new Error("cancel MCP generation")));
      });
    return fixture.fetch(input, init);
  };
  await assert.rejects(
    runMcp(
      {
        baseUrl: "https://mcp.example.com/mcp",
        endpoint: "generate",
        template: { prompt: "{{prompt}}" },
      },
      "",
      { mode: "generate", prompt: "forest", count: 1, seed: 1 },
      null,
      null,
      controller.signal,
      (p, k, s) => connectMcp(p, k, s, fetch),
    ),
  );
  assert.equal(aborted, true);
});
