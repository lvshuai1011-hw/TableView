import { spawn } from "node:child_process";
import { access, constants, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(process.cwd());
const claudeBin = process.env.CLAUDE_BIN || "claude";
const checks = [];

function add(name, ok, detail) { checks.push({ name, ok, detail }); }

add("运行用户", !(typeof process.getuid === "function" && process.getuid() === 0), process.env.USER || os.userInfo().username);
try {
  await access(path.join(projectRoot, "dist"), constants.R_OK);
  add("生产构建", true, path.join(projectRoot, "dist"));
} catch {
  add("生产构建", false, "请先执行 npm run build");
}

const claude = await new Promise((resolve) => {
  const child = spawn(claudeBin, ["--version"], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  const error = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => error.push(chunk));
  child.once("error", (reason) => resolve({ ok: false, detail: reason.message }));
  child.once("close", (code) => resolve(code === 0
    ? { ok: true, detail: Buffer.concat(output).toString("utf8").trim() }
    : { ok: false, detail: Buffer.concat(error).toString("utf8").trim() || `退出码 ${code}` }));
});
add("Claude Code", claude.ok, claude.detail);

const auth = claude.ok ? await new Promise((resolve) => {
  const child = spawn(claudeBin, ["auth", "status"], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  const error = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => error.push(chunk));
  child.once("error", (reason) => resolve({ ok: false, detail: reason.message }));
  child.once("close", (code) => resolve(code === 0
    ? { ok: true, detail: "已登录" }
    : { ok: false, detail: Buffer.concat(error).toString("utf8").trim() || Buffer.concat(output).toString("utf8").trim() || "请先执行 claude auth login" }));
}) : { ok: false, detail: "请先安装 Claude Code" };
add("Claude 登录", auth.ok, auth.detail);

const roots = (process.env.SCHEMA_ATLAS_REFERENCE_ROOTS || `${projectRoot}${path.delimiter}${os.homedir()}`)
  .split(path.delimiter).filter(Boolean);
for (const root of roots) {
  try {
    const resolved = await realpath(root);
    await access(resolved, constants.R_OK);
    add(`参考目录 ${root}`, true, resolved);
  } catch {
    add(`参考目录 ${root}`, false, "不存在或当前用户无读取权限");
  }
}

const width = Math.max(...checks.map((check) => check.name.length));
checks.forEach((check) => console.log(`${check.ok ? "✓" : "✗"} ${check.name.padEnd(width)}  ${check.detail}`));
if (checks.some((check) => !check.ok)) process.exitCode = 1;
