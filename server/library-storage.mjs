import fs from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";
import { requestBytes, validateUrl } from "./network.mjs";
export const MAX_UPLOAD = 12 * 1024 * 1024;
export const isImage = (name) => /\.(png|jpe?g|webp|gif|avif|tiff?|bmp)$/i.test(name);
export function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function libraryPath(value = "") {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\\\0-\x1f\x7f]/.test(value) ||
    value.startsWith("/")
  )
    throw failure("素材路径无效");
  const parts = value.replace(/\/+$/, "").split("/");
  if (parts.some((part) => part === "." || part === ".." || (part === "" && value !== "")))
    throw failure("素材路径无效");
  return parts.filter(Boolean).join("/");
}
export function fileName(value) {
  const name = libraryPath(value);
  if (!name || name.includes("/") || Buffer.byteLength(name) > 240)
    throw failure("文件名不能为空，且不能包含路径分隔符");
  return name;
}
const array = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const xmlText = (value) =>
  String(value ?? "").replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity) => {
    const standard = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (standard[entity]) return standard[entity];
    const code = entity[1] === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
function parseXml(bytes) {
  const text = bytes.toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw failure("素材库 XML 响应不允许包含 DTD");
  return new XMLParser({
    removeNSPrefix: true,
    parseTagValue: false,
    ignoreAttributes: true,
    processEntities: false,
  }).parse(text);
}
function pageEntries(entries, cursor) {
  if (cursor && !/^\d{1,7}$/.test(cursor)) throw failure("分页参数无效");
  const start = Number(cursor || 0);
  const sorted = entries.sort(
    (a, b) =>
      (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1) ||
      a.name.localeCompare(b.name, "zh-CN", { numeric: true }),
  );
  return {
    entries: sorted.slice(start, start + 200),
    nextCursor: start + 200 < sorted.length ? String(start + 200) : null,
  };
}
export function createLibraryStorage(directory, transport = requestBytes) {
  const localBase = path.resolve(directory, "assets");
  async function localPath(library, relative) {
    const root = path.join(localBase, library.id);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const resolvedRoot = await fs.realpath(root);
    const expectedBase = await fs.realpath(localBase);
    if (resolvedRoot !== path.join(expectedBase, library.id)) throw failure("不允许使用链接目录");
    let current = resolvedRoot;
    for (const part of libraryPath(relative).split("/").filter(Boolean)) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw failure("不允许读取或写入符号链接");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return current;
  }
  function remoteUrl(library, relative = "", folder = false) {
    const url = validateUrl(library.endpoint);
    if (library.type === "s3") {
      url.pathname = url.pathname.replace(/\/$/, "");
      if (library.pathStyle !== false)
        url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(library.bucket)}`;
      else url.hostname = `${library.bucket}.${url.hostname}`;
      const key = [library.prefix, libraryPath(relative)].filter(Boolean).join("/");
      if (key)
        url.pathname = `${url.pathname.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
    } else {
      const base = url.pathname.replace(/\/$/, "");
      url.pathname = `${base}/${libraryPath(relative).split("/").map(encodeURIComponent).join("/")}`;
    }
    if (folder && !url.pathname.endsWith("/")) url.pathname += "/";
    return url;
  }
  async function remote(library, credentials, url, method, headers = {}, body) {
    if (library.type === "s3" && credentials.accessKeyId) {
      const signer = new AwsClient({
        ...credentials,
        service: "s3",
        region: library.region || "us-east-1",
      });
      const signed = await signer.sign(url.toString(), { method, headers, body });
      headers = Object.fromEntries(signed.headers);
      url = new URL(signed.url);
    } else if (library.type === "webdav" && credentials.username)
      headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password || ""}`).toString("base64")}`;
    const response = await transport(url.toString(), {
      method,
      headers,
      body,
      followRedirects: false,
      timeout: 30000,
    });
    if (response.status === 412 || response.status === 409)
      throw failure("同名文件或目录已存在，请修改名称后重试", 409);
    if (response.status === 404) throw failure("素材文件或目录不存在", 404);
    if (response.status < 200 || response.status >= 300)
      throw failure(`素材库请求失败（HTTP ${response.status}），请检查地址、凭证和访问权限`);
    return response;
  }
  return {
    async list(library, credentials, relative = "", cursor) {
      relative = libraryPath(relative);
      if (library.type === "local") {
        const folder = await localPath(library, relative);
        const items = await fs.readdir(folder, { withFileTypes: true });
        const entries = [];
        for (const item of items) {
          if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) continue;
          try {
            fileName(item.name);
          } catch {
            continue;
          }
          const info = await fs.stat(path.join(folder, item.name));
          entries.push({
            name: item.name,
            path: [relative, item.name].filter(Boolean).join("/"),
            type: item.isDirectory() ? "directory" : "file",
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
        }
        return { path: relative, ...pageEntries(entries, cursor) };
      }
      if (library.type === "s3") {
        const url = remoteUrl({ ...library, prefix: "" });
        const prefix = [library.prefix, relative].filter(Boolean).join("/");
        url.searchParams.set("list-type", "2");
        url.searchParams.set("delimiter", "/");
        url.searchParams.set("max-keys", "200");
        url.searchParams.set("prefix", prefix ? `${prefix}/` : "");
        if (cursor) url.searchParams.set("continuation-token", cursor);
        const result = parseXml(
          (await remote(library, credentials, url, "GET")).bytes,
        ).ListBucketResult;
        if (!result) throw failure("S3 未返回有效的目录列表，请核对 Endpoint 和 Bucket");
        const base = library.prefix ? library.prefix + "/" : "";
        const entries = [];
        const makeEntry = (key, type, item) => {
          if (!key.startsWith(base)) return;
          let entryPath;
          try {
            entryPath = libraryPath(key.slice(base.length).replace(/\/$/, ""));
          } catch {
            return;
          }
          if (
            !entryPath ||
            entryPath === relative ||
            path.posix.dirname(entryPath) !== (relative || ".")
          )
            return;
          entries.push({
            path: entryPath,
            name: path.posix.basename(entryPath),
            type,
            size: Number(item.Size || 0),
            modifiedAt: item.LastModified || null,
          });
        };
        for (const folder of array(result.CommonPrefixes))
          makeEntry(xmlText(folder.Prefix), "directory", folder);
        for (const item of array(result.Contents)) {
          const key = xmlText(item.Key);
          if (!key.endsWith("/")) makeEntry(key, "file", item);
        }
        return {
          path: relative,
          entries: pageEntries(entries).entries,
          nextCursor:
            result.IsTruncated === "true" ? xmlText(result.NextContinuationToken) || null : null,
        };
      }
      const url = remoteUrl(library, relative, true);
      const result = parseXml(
        (
          await remote(
            library,
            credentials,
            url,
            "PROPFIND",
            { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
            Buffer.from(
              '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
            ),
          )
        ).bytes,
      ).multistatus;
      if (!result) throw failure("WebDAV 未返回有效目录列表，请核对 WebDAV 根地址");
      const rootPath = new URL(library.endpoint).pathname.replace(/\/$/, "") + "/";
      const entries = [];
      for (const item of array(result.response)) {
        const href = new URL(xmlText(item.href), url).pathname;
        if (!href.startsWith(rootPath)) continue;
        let entryPath;
        try {
          entryPath = libraryPath(
            href.slice(rootPath.length).split("/").map(decodeURIComponent).join("/"),
          );
        } catch {
          continue;
        }
        if (
          !entryPath ||
          entryPath === relative ||
          path.posix.dirname(entryPath) !== (relative || ".")
        )
          continue;
        const prop = array(item.propstat).find((p) => /\s200\b/.test(p.status))?.prop;
        if (!prop) continue;
        const type =
          prop.resourcetype && Object.hasOwn(prop.resourcetype, "collection")
            ? "directory"
            : "file";
        entries.push({
          path: entryPath,
          name: path.posix.basename(entryPath),
          type,
          size: Number(prop.getcontentlength || 0),
          modifiedAt: prop.getlastmodified || null,
        });
      }
      return { path: relative, ...pageEntries(entries, cursor) };
    },
    async read(library, credentials, relative) {
      relative = libraryPath(relative);
      if (!relative) throw failure("请选择文件");
      if (library.type === "local") {
        const filename = await localPath(library, relative);
        const stat = await fs.stat(filename);
        if (!stat.isFile()) throw failure("此路径不是文件");
        if (stat.size > 32 * 1024 * 1024) throw failure("文件超过 32MB 下载/预览限制");
        return fs.readFile(filename);
      }
      return (await remote(library, credentials, remoteUrl(library, relative), "GET")).bytes;
    },
    async write(library, credentials, relative, bytes, mime = "application/octet-stream") {
      relative = libraryPath(relative);
      fileName(path.posix.basename(relative));
      if (library.type === "local") {
        try {
          await fs.writeFile(await localPath(library, relative), bytes, {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          if (error.code === "EEXIST") throw failure("同名文件已存在，请修改名称后重试", 409);
          throw error;
        }
      } else
        await remote(
          library,
          credentials,
          remoteUrl(library, relative),
          "PUT",
          { "Content-Type": mime, "If-None-Match": "*" },
          bytes,
        );
      return { path: relative, name: path.posix.basename(relative) };
    },
    async mkdir(library, credentials, relative) {
      relative = libraryPath(relative);
      if (!relative) throw failure("请输入文件夹名称");
      if (library.type === "local") {
        try {
          await fs.mkdir(await localPath(library, relative), { mode: 0o700 });
        } catch (error) {
          if (error.code === "EEXIST") throw failure("同名文件或目录已存在", 409);
          throw error;
        }
      } else if (library.type === "s3")
        await remote(
          library,
          credentials,
          remoteUrl(library, relative, true),
          "PUT",
          { "Content-Type": "application/x-directory", "If-None-Match": "*" },
          Buffer.alloc(0),
        );
      else await remote(library, credentials, remoteUrl(library, relative, true), "MKCOL");
      return { path: relative };
    },
  };
}
