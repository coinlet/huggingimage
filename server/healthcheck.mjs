import http from "node:http";
const request = http.get(`http://127.0.0.1:${process.env.PORT || 3001}/api/session`, (response) => {
  const ok =
    response.statusCode === 200 && response.headers["content-type"]?.includes("application/json");
  response.resume();
  process.exitCode = ok ? 0 : 1;
});
request.setTimeout(3000, () => request.destroy(new Error("Health check timed out")));
request.on("error", () => {
  process.exitCode = 1;
});
