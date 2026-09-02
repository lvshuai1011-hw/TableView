import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicHost = process.env.SCHEMA_ATLAS_HOST || "127.0.0.1";
const publicPort = Number(process.env.SCHEMA_ATLAS_PORT || 3000);
const uiHost = "127.0.0.1";
const uiPort = Number(process.env.SCHEMA_ATLAS_UI_INTERNAL_PORT || 3001);
const aiHost = "127.0.0.1";
const aiPort = Number(process.env.SCHEMA_ATLAS_AI_PORT || 4317);
const vinextBin = path.join(projectRoot, "node_modules", ".bin", "vinext");
const authUser = process.env.SCHEMA_ATLAS_AUTH_USER || "";
const authPassword = process.env.SCHEMA_ATLAS_AUTH_PASSWORD || "";

if (typeof process.getuid === "function" && process.getuid() === 0 && process.env.SCHEMA_ATLAS_ALLOW_ROOT !== "1") {
  console.error("Schema Atlas 本地服务不能以 root 运行，请使用 claude 用户启动。");
  process.exit(1);
}
if (!existsSync(vinextBin)) {
  console.error("缺少前端运行依赖，请先执行 npm ci 和 npm run build。");
  process.exit(1);
}
if (!["127.0.0.1", "::1", "localhost"].includes(publicHost) && (!authUser || !authPassword)) {
  console.error("非本机监听必须设置 SCHEMA_ATLAS_AUTH_USER 和 SCHEMA_ATLAS_AUTH_PASSWORD。");
  process.exit(1);
}

const children = [];
let stopping = false;

function startChild(command, args, env) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: false,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`${path.basename(command)} 意外退出：${signal || code}`);
    shutdown(code || 1);
  });
  return child;
}

startChild(vinextBin, ["start", "--hostname", uiHost, "--port", String(uiPort)], {
  NODE_ENV: "production",
});
startChild(process.execPath, [path.join(projectRoot, "local-ai", "server.mjs")], {
  SCHEMA_ATLAS_PROJECT_ROOT: projectRoot,
  SCHEMA_ATLAS_AI_HOST: aiHost,
  SCHEMA_ATLAS_AI_PORT: String(aiPort),
});

function equalSecret(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticated(request) {
  if (!authUser && !authPassword) return true;
  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    return equalSecret(decoded.slice(0, separator), authUser)
      && equalSecret(decoded.slice(separator + 1), authPassword);
  } catch {
    return false;
  }
}

function proxyRequest(request, response) {
  if (!authenticated(request)) {
    response.writeHead(401, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": 'Basic realm="Schema Atlas", charset="UTF-8"',
    });
    response.end("需要登录 Schema Atlas");
    return;
  }
  const isAi = request.url?.startsWith("/api/ai/");
  const targetPort = isAi ? aiPort : uiPort;
  const proxy = http.request({
    hostname: "127.0.0.1",
    port: targetPort,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, host: `127.0.0.1:${targetPort}` },
  }, (upstream) => {
    response.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(response);
  });
  proxy.on("error", (error) => {
    if (response.headersSent) return response.end();
    response.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: isAi ? "AI 服务正在启动" : "网页服务正在启动", detail: error.message }));
  });
  request.pipe(proxy);
}

const gateway = http.createServer(proxyRequest);
gateway.keepAliveTimeout = 75_000;
gateway.headersTimeout = 80_000;
gateway.requestTimeout = 0;
gateway.listen(publicPort, publicHost, () => {
  console.log(`Schema Atlas 已启动：http://${publicHost}:${publicPort}`);
});

function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  gateway.close();
  children.forEach((child) => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  const timer = setTimeout(() => {
    children.forEach((child) => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    process.exit(exitCode);
  }, 5_000);
  timer.unref();
  Promise.all(children.map((child) => new Promise((resolve) => child.once("exit", resolve))))
    .finally(() => process.exit(exitCode));
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
