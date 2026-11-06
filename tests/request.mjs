import http from "node:http";
import { Duplex } from "node:stream";

// Exercise Express and the real Node ServerResponse without opening a TCP socket.
export async function dispatch(
  app,
  route,
  { method = "GET", body, cookie, origin, host = "127.0.0.1", headers = {} } = {},
) {
  const chunks = [];
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  socket.remoteAddress = "127.0.0.1";
  const request = new http.IncomingMessage(socket);
  request.method = method;
  request.url = route;
  request.httpVersion = "1.1";
  request.httpVersionMajor = 1;
  request.httpVersionMinor = 1;
  const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
  request.headers = {
    host,
    connection: "close",
    ...headers,
    ...(encoded
      ? { "content-type": "application/json", "content-length": String(encoded.length) }
      : {}),
    ...(cookie ? { cookie } : {}),
    ...(origin ? { origin } : {}),
  };
  const response = new http.ServerResponse(request);
  response.assignSocket(socket);
  const finished = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(
            `Dispatch timeout: ${method} ${route}, ended=${response.writableEnded}, finished=${response.writableFinished}, chunks=${chunks.length}`,
          ),
        ),
      2000,
    );
    response.once("finish", () => {
      clearTimeout(timeout);
      resolve();
    });
    response.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  app(request, response);
  if (encoded) request.push(encoded);
  request.complete = true;
  request.push(null);
  await finished;
  const wire = Buffer.concat(chunks);
  const separator = wire.indexOf("\r\n\r\n");
  const bytes = wire.subarray(separator + 4);
  const text = bytes.toString();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  const result = { status: response.statusCode, headers: response.getHeaders(), bytes, data };
  socket.destroy();
  return result;
}
