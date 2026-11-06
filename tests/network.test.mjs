import test from "node:test";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { buildRequestHeaders, parseJsonResponse, requestBytes } from "../server/network.mjs";
const url = "https://api.example.com/v1/images/edits?token=private-query";
const response = (status, body, headers = {}) => ({ status, bytes: Buffer.from(body), headers });

test("buffered multipart upload uses exact Content-Length instead of chunked transfer", () => {
  const body = Buffer.from("image=中文 image bytes");
  const headers = buildRequestHeaders(
    {
      "Content-Type": "multipart/form-data; boundary=test",
      "Transfer-Encoding": "chunked",
      "Content-Length": "1",
      Authorization: "Bearer secret",
    },
    body,
  );
  assert.equal(headers["content-length"], String(body.length));
  assert.equal(headers["content-type"], "multipart/form-data; boundary=test");
  assert.equal(headers.authorization, "Bearer secret");
  assert.equal(headers["transfer-encoding"], undefined);
  assert.equal(headers["accept-encoding"], "identity");
  assert.equal(buildRequestHeaders()["content-length"], undefined);
  assert.equal(buildRequestHeaders({}, "中文")["content-length"], "6");
});

test("EdgeOne 554 explains origin timeout, includes endpoint and request trace, hides secrets", () => {
  const res = response(
    554,
    "<html><title>Origin timed out</title><script>secret script</script></html>",
    { "content-type": "text/html; charset=utf-8", "eo-log-uuid": "test-trace" },
  );
  assert.throws(
    () => parseJsonResponse(res, url, { method: "POST" }),
    (error) => {
      assert.match(error.message, /EdgeOne 回源等待超时/);
      assert.match(error.message, /HTTP 554/);
      assert.match(error.message, /POST https:\/\/api.example.com\/v1\/images\/edits/);
      assert.match(error.message, /Origin timed out/);
      assert.match(error.message, /test-trace/);
      assert.doesNotMatch(error.message, /private-query|secret script|<html>/);
      return true;
    },
  );
});

test("unknown 554 is not incorrectly attributed to EdgeOne", () => {
  assert.throws(
    () => parseJsonResponse(response(554, "Gateway failure"), url),
    (error) => {
      assert.match(error.message, /非标准状态码/);
      assert.doesNotMatch(error.message, /EdgeOne/);
      return true;
    },
  );
});

test("HTML and JSON upstream errors redact authorization keys before truncation", () => {
  const secret = "custom-secret-value";
  const options = { headers: { Authorization: `Bearer ${secret}` } };
  for (const body of [
    `<title>Denied ${secret} sk-test-abc hf_test123</title>`,
    JSON.stringify({ error: { message: `Denied ${secret}` } }),
  ]) {
    assert.throws(
      () => parseJsonResponse(response(401, body), url, options),
      (error) => {
        assert.doesNotMatch(
          error.message,
          /custom-secret-value|sk-test-abc|hf_test123|private-query/,
        );
        return true;
      },
    );
  }
});

test("JSON parsing handles BOM, compressed responses, invalid payloads and empty errors", () => {
  assert.deepEqual(parseJsonResponse(response(200, '\uFEFF{"data":[]}'), url), { data: [] });
  for (const [encoding, compress] of [
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ]) {
    const res = {
      status: 200,
      headers: { "content-encoding": encoding },
      bytes: compress(Buffer.from('{"data":[]}')),
    };
    assert.deepEqual(parseJsonResponse(res, url), { data: [] });
  }
  assert.throws(() => parseJsonResponse(response(200, "null"), url), /有效的 JSON 对象/);
  assert.throws(() => parseJsonResponse(response(502, ""), url), /空响应/);
  assert.throws(() => parseJsonResponse(response(413, "Payload too large"), url), /大小限制/);
});

test("resource downloads use default networking for both local and proxy-mapped addresses", async (t) => {
  const bytes = Buffer.from("downloaded image bytes");
  const visited = [];
  for (const transport of [http, https])
    t.mock.method(transport, "request", (target, options, onResponse) => {
      visited.push(target.href);
      assert.equal(options.lookup, undefined);
      assert.equal(options.family, undefined);
      assert.equal(options.autoSelectFamily, undefined);
      assert.equal(options.agent, undefined);
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.end = () =>
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.statusCode = 200;
          response.headers = { "content-type": "image/png" };
          onResponse(response);
          response.emit("data", bytes);
          response.emit("end");
        });
      return request;
    });
  for (const target of [
    "http://127.0.0.1/image.png",
    "http://192.168.1.20/image.png",
    "https://198.18.6.38/image.png",
    "https://model.hf.space/gradio_api/file=result.png",
  ]) {
    const result = await requestBytes(target);
    assert.equal(result.status, 200);
    assert.deepEqual(result.bytes, bytes);
  }
  assert.equal(visited.length, 4);
});
