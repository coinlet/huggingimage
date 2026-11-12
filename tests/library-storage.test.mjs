import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createLibraryStorage, libraryPath } from "../server/library-storage.mjs";
const reply = (status, text = "") => ({ status, bytes: Buffer.from(text), headers: {} });

test("local libraries retain directory structure, refuse overwrites and exclude symlink escapes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "imagine-library-fs-"));
  const storage = createLibraryStorage(dir),
    library = { id: "local", type: "local" };
  try {
    assert.deepEqual((await storage.list(library, {})).entries, []);
    await storage.mkdir(library, {}, "参考图");
    await storage.write(library, {}, "参考图/a.png", Buffer.from("image"));
    assert.equal((await storage.list(library, {})).entries[0].type, "directory");
    const listed = await storage.list(library, {}, "参考图");
    assert.equal(listed.entries[0].path, "参考图/a.png");
    assert.equal((await storage.read(library, {}, "参考图/a.png")).toString(), "image");
    await assert.rejects(
      storage.write(library, {}, "参考图/a.png", Buffer.from("overwrite")),
      (error) => error.status === 409,
    );
    await writeFile(path.join(dir, "secret"), "private");
    await symlink(path.join(dir, "secret"), path.join(dir, "assets/local/link.png"));
    assert.equal(
      (await storage.list(library, {})).entries.some((e) => e.name === "link.png"),
      false,
    );
    await assert.rejects(storage.read(library, {}, "link.png"), /符号链接/);
    await symlink(dir, path.join(dir, "assets/local/outside"));
    await assert.rejects(
      storage.write(library, {}, "outside/created", Buffer.from("bad")),
      /符号链接/,
    );
    assert.equal((await readFile(path.join(dir, "secret"))).toString(), "private");
    for (const bad of ["../secret", "a/../secret", "/etc/passwd", "a\\b", "a/./b", "a\0b"])
      assert.throws(() => libraryPath(bad));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S3 directory browsing and uploads use signed scoped requests and opaque pagination tokens", async () => {
  const calls = [];
  const storage = createLibraryStorage("/tmp/unused-library", async (url, options) => {
    calls.push({ url: new URL(url), ...options });
    if (options.method === "GET" && new URL(url).searchParams.has("list-type"))
      return reply(
        200,
        `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>true</IsTruncated><NextContinuationToken>a+b/==</NextContinuationToken><CommonPrefixes><Prefix>photos/旅行/</Prefix></CommonPrefixes><Contents><Key>photos/a &amp; b.png</Key><Size>5</Size><LastModified>2026-11-12T00:00:00Z</LastModified></Contents><Contents><Key>outside/private.png</Key><Size>5</Size></Contents></ListBucketResult>`,
      );
    return reply(200, "image");
  });
  const library = {
    id: "remote",
    type: "s3",
    endpoint: "https://s3.example.test",
    bucket: "bucket",
    region: "us-east-1",
    prefix: "photos",
    pathStyle: true,
  };
  const credentials = {
    accessKeyId: "TESTACCESSKEY",
    secretAccessKey: "test-secret-access-key",
    sessionToken: "temporary-session-token",
  };
  const listing = await storage.list(library, credentials);
  assert.deepEqual(
    listing.entries.map((e) => e.path),
    ["旅行", "a & b.png"],
  );
  assert.equal(listing.nextCursor, "a+b/==");
  assert.equal(calls[0].url.searchParams.get("prefix"), "photos/");
  assert.equal(calls[0].url.searchParams.get("delimiter"), "/");
  const headers = new Headers(calls[0].headers);
  assert.match(headers.get("authorization"), /AWS4-HMAC-SHA256 Credential=TESTACCESSKEY\//);
  assert.match(headers.get("authorization"), /us-east-1\/s3\/aws4_request/);
  assert.equal(headers.get("x-amz-security-token"), credentials.sessionToken);
  assert.equal(calls[0].followRedirects, false);
  await storage.list(library, credentials, "", listing.nextCursor);
  assert.equal(calls[1].url.searchParams.get("continuation-token"), "a+b/==");
  await storage.write(library, credentials, "旅行/中文 +?#.png", Buffer.from("new"), "image/png");
  assert.equal(decodeURIComponent(calls[2].url.pathname), "/bucket/photos/旅行/中文 +?#.png");
  assert.equal(new Headers(calls[2].headers).get("if-none-match"), "*");
  assert.equal(calls[2].body.toString(), "new");
  await storage.read({ ...library, pathStyle: false }, credentials, "a.png");
  assert.equal(calls[3].url.hostname, "bucket.s3.example.test");
  assert.equal(calls[3].url.pathname, "/photos/a.png");
});

test("WebDAV PROPFIND preserves encoded names, directories and Basic authentication", async () => {
  const calls = [];
  const storage = createLibraryStorage("/tmp/unused-library", async (url, options) => {
    calls.push({ url: new URL(url), ...options });
    if (options.method === "PROPFIND")
      return reply(
        207,
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:status>HTTP/1.1 200 OK</d:status><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/folder/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/dav/%E4%B8%AD%E6%96%87%20%26%20a.png</d:href><d:propstat><d:prop><d:getcontentlength>42</d:getcontentlength><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/outside/private.png</d:href></d:response></d:multistatus>`,
      );
    return reply(201);
  });
  const library = { id: "dav", type: "webdav", endpoint: "https://dav.example.test/dav/" },
    credentials = { username: "alice", password: "secret:password" };
  const result = await storage.list(library, credentials);
  assert.deepEqual(
    result.entries.map((e) => [e.name, e.type]),
    [
      ["folder", "directory"],
      ["中文 & a.png", "file"],
    ],
  );
  assert.equal(
    calls[0].headers.Authorization,
    `Basic ${Buffer.from("alice:secret:password").toString("base64")}`,
  );
  assert.equal(calls[0].headers.Depth, "1");
  await storage.mkdir(library, credentials, "新目录");
  assert.equal(calls[1].method, "MKCOL");
  assert.equal(decodeURIComponent(calls[1].url.pathname), "/dav/新目录/");
  await storage.write(library, credentials, "中文 & a.png", Buffer.from("test"));
  assert.equal(calls[2].headers["If-None-Match"], "*");
  assert.equal(decodeURIComponent(calls[2].url.pathname), "/dav/中文 & a.png");
});

test("remote conflicts, XML DTD and error responses do not expose response bodies", async () => {
  const library = { id: "dav", type: "webdav", endpoint: "https://dav.example.test/" };
  await assert.rejects(
    createLibraryStorage("/tmp/unused", async () => reply(412)).write(
      library,
      {},
      "file",
      Buffer.from("x"),
    ),
    (e) => e.status === 409,
  );
  await assert.rejects(
    createLibraryStorage("/tmp/unused", async () =>
      reply(207, '<!DOCTYPE x [<!ENTITY private SYSTEM "file:///etc/passwd">]><multistatus/>'),
    ).list(library, {}),
    /DTD/,
  );
  await assert.rejects(
    createLibraryStorage("/tmp/unused", async () => reply(403, "secret-server-body")).list(
      library,
      {},
    ),
    (e) => /HTTP 403/.test(e.message) && !e.message.includes("secret-server-body"),
  );
});
