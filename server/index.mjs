import { createApp } from "./app.mjs";
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3001);
const adminToken = process.env.ADMIN_TOKEN || "";
if (!["127.0.0.1", "localhost", "::1"].includes(HOST) && !adminToken)
  throw new Error("对外监听必须设置 ADMIN_TOKEN");
const workspace = createApp();
const server = workspace.app.listen(PORT, HOST, () =>
  console.log(
    `Imagine API → http://${HOST}:${PORT}${adminToken ? " (protected)" : " (local workspace)"}`,
  ),
);
function shutdown() {
  workspace.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
