import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";

const HOST = process.env.CLAUDE_SIDECAR_HOST || "127.0.0.1";
const PORT = Number(process.env.CLAUDE_SIDECAR_PORT || 4318);
const DEFAULT_PROJECT_ROOT = resolve(process.env.SCHEMA_ATLAS_PROJECT_ROOT || process.cwd());
const CLAUDE_HOME = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
const SESSION_ROOT = join(CLAUDE_HOME, "projects");
const MAX_BODY_BYTES = 80 * 1024 * 1024;
const MAX_STDIO_BYTES = 120 * 1024 * 1024;

const annotationProperties = {
  included: { type: "boolean" },
  entityColumn: { type: "string" },
  aliases: { type: "array", items: { type: "string" } },
  detailedDescription: { type: "string" },
  isLocalId: { type: "boolean" },
  isDisplayName: { type: "boolean" },
  isSemantic: { type: "boolean" },
  isCode: { type: "boolean" },
  semanticRole: {
    type: "string",
    enum: ["identifier", "name", "time", "amount", "quantity", "status", "code", "description", "other"],
  },
  tags: { type: "array", items: { type: "string" } },
  unit: { type: "string" },
  enumValues: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        value: { type: "string" },
        description: { type: "string" },
        descriptionEn: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
      },
      required: ["value", "description", "descriptionEn", "aliases"],
    },
  },
  valueRange: { type: "string" },
  sensitivity: { type: "string", enum: ["none", "internal", "sensitive", "restricted"] },
  enumRef: { type: "string" },
  enumDescription: { type: "string" },
};

const proposalSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
    clarifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          concept: { type: "string" },
          question: { type: "string" },
          context: { type: "string" },
          tableNames: { type: "array", items: { type: "string" } },
          fieldRefs: { type: "array", items: { type: "string" } },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["id", "concept", "question"],
      },
    },
    tablePatches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          tableName: { type: "string" },
          reason: { type: "string" },
          className: { type: "string" },
          classDescription: { type: "string" },
          classAliases: { type: "array", items: { type: "string" } },
          columnPatches: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                columnName: { type: "string" },
                reason: { type: "string" },
                annotation: {
                  type: "object",
                  additionalProperties: false,
                  properties: annotationProperties,
                },
              },
              required: ["columnName", "reason", "annotation"],
            },
          },
        },
        required: ["tableName", "reason", "columnPatches"],
      },
    },
  },
  required: ["summary", "clarifications", "tablePatches"],
};

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function ensureDirectory(value, label) {
  const path = resolve(String(value || ""));
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${label} 不是可访问目录: ${path}`);
  return path;
}

function runProcess(command, args, { cwd = DEFAULT_PROJECT_ROOT, timeoutMs = 0 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer = null;

    const abortForSize = () => {
      child.kill("SIGTERM");
      rejectPromise(new Error("Claude Code 输出超过 sidecar 限制"));
    };

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDIO_BYTES) return abortForSize();
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDIO_BYTES) return abortForSize();
      stderr.push(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`Claude Code 超过 ${Math.round(timeoutMs / 1000)} 秒未完成`));
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

async function claudeHealth() {
  const version = await runProcess("claude", ["--version"], { timeoutMs: 10_000 });
  if (version.code !== 0) throw new Error(version.stderr || "claude --version 执行失败");
  const auth = await runProcess("claude", ["auth", "status"], { timeoutMs: 10_000 }).catch(() => null);
  let authStatus = null;
  if (auth?.stdout) {
    try { authStatus = JSON.parse(auth.stdout); } catch { authStatus = auth.stdout.trim(); }
  }
  return {
    version: version.stdout.trim() || version.stderr.trim(),
    auth: authStatus,
    projectRoot: DEFAULT_PROJECT_ROOT,
    sessionRoot: SESSION_ROOT,
    permissionMode: "--dangerously-skip-permissions",
  };
}

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      if (block.type === "text" && typeof block.text === "string") return [block.text];
      if (block.type === "tool_use") {
        const input = block.input === undefined ? "" : `\n${JSON.stringify(block.input, null, 2)}`;
        return [`[Tool: ${block.name || "unknown"}]${input}`];
      }
      if (block.type === "tool_result") {
        const nested = extractTextContent(block.content);
        return [nested ? `[Tool result]\n${nested}` : "[Tool result]"];
      }
      return [];
    })
    .filter(Boolean)
    .join("\n\n");
}

function recordToMessages(record, index) {
  if (!record || typeof record !== "object") return [];
  const message = record.message && typeof record.message === "object" ? record.message : null;
  const role = message?.role === "assistant" ? "assistant" : message?.role === "user" ? "user" : null;
  if (!role) return [];
  const content = Array.isArray(message.content) ? message.content : message.content;
  const blocks = Array.isArray(content) ? content : [content];
  const result = [];
  let ordinal = 0;
  for (const block of blocks) {
    if (typeof block === "string") {
      if (block.trim()) result.push({ id: `${index}:${ordinal++}`, role, text: block, timestamp: record.timestamp });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    if (block.type === "thinking") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      result.push({ id: `${index}:${ordinal++}`, role, text: block.text, timestamp: record.timestamp });
      continue;
    }
    if (block.type === "tool_use") {
      result.push({
        id: `${index}:${ordinal++}`,
        role: "tool",
        toolName: String(block.name || "tool"),
        text: block.input === undefined ? "" : JSON.stringify(block.input, null, 2),
        timestamp: record.timestamp,
      });
      continue;
    }
    if (block.type === "tool_result") {
      const text = extractTextContent(block.content);
      result.push({ id: `${index}:${ordinal++}`, role: "tool", toolName: "result", text, timestamp: record.timestamp });
    }
  }
  return result;
}

async function sessionFiles() {
  const projects = await readdir(SESSION_ROOT, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(SESSION_ROOT, project.name);
    const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(projectDir, entry.name));
    }
  }
  return files;
}

async function readSessionPreview(file) {
  let title = "Claude Code session";
  let projectPath = "";
  const input = createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let lineCount = 0;
  try {
    for await (const line of rl) {
      lineCount += 1;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!projectPath && typeof record.cwd === "string") projectPath = record.cwd;
      if (typeof record.customTitle === "string" && record.customTitle.trim()) title = record.customTitle.trim();
      if (title === "Claude Code session") {
        const message = record.message && typeof record.message === "object" ? record.message : null;
        if (message?.role === "user") {
          const text = extractTextContent(message.content).replace(/\s+/g, " ").trim();
          if (text) title = text.slice(0, 96);
        }
      }
      if (lineCount >= 250 && title !== "Claude Code session" && projectPath) break;
    }
  } finally {
    rl.close();
    input.destroy();
  }
  const info = await stat(file);
  return {
    id: basename(file, ".jsonl"),
    title,
    projectPath: projectPath || dirname(file),
    updatedAt: info.mtime.toISOString(),
    size: info.size,
  };
}

async function listSessions() {
  const files = await sessionFiles();
  const result = [];
  for (const file of files) {
    try { result.push(await readSessionPreview(file)); } catch { /* ignore malformed transcript */ }
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function findSessionFile(sessionId) {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  const files = await sessionFiles();
  return files.find((file) => basename(file, ".jsonl") === sessionId) || null;
}

async function readSessionDetail(sessionId) {
  const file = await findSessionFile(sessionId);
  if (!file) return null;
  const summary = await readSessionPreview(file);
  const raw = await readFile(file, "utf8");
  const messages = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      messages.push(...recordToMessages(JSON.parse(line), index));
    } catch {
      // Ignore malformed JSONL records while keeping the rest of the transcript readable.
    }
  });
  return { ...summary, messages };
}

function buildPrompt({ mode, inputPath, message, clarificationAnswers, referenceDirs }) {
  const modeInstruction = mode === "generate-all"
    ? "为输入中的所有表和所有字段生成完整第一版标注。不要只做样例。遇到无法可靠判断的业务概念时，创建 clarification TODO，同时对能确定的部分继续完成。"
    : mode === "clarify"
      ? "这是人工澄清后的继续生成。吸收澄清答案，重新检查受影响的表和字段，并返回需要更新的 proposal。不要机械地只改一个字段；要检查相同概念的相关字段。"
      : "这是人工审核过程中的交互纠正。根据用户消息和既有 session 上下文调查参考资料，返回结构化修改 proposal；没有必要修改的字段不要制造变更。";

  return [
    "你是 Schema Atlas 的本地 Claude Code 标注 Agent。",
    "你运行在用户机器上的 Claude Code CLI 中，可以主动使用 Read/Grep/Glob/Bash 等工具调查本地资料。",
    "禁止修改 Schema Atlas 源代码、输入文件和参考资料；本次任务只返回标注 proposal。",
    `输入快照文件：${inputPath}`,
    referenceDirs.length ? `已通过 --add-dir 授予访问的参考目录：\n${referenceDirs.map((item) => `- ${item}`).join("\n")}` : "本次未配置额外参考目录。",
    "调查优先级：已人工审核的标注 JSON / 明确业务规范 > 实际代码中的业务语义和使用方式 > PDM 原始说明与外键关系 > 单纯字段名猜测。",
    "不要为了填满字段而编造业务事实。无法可靠确认的概念必须进入 clarifications，供人工逐项澄清。",
    "所有建议都只是待人工审核的 proposal，不要直接写回正式标注。",
    modeInstruction,
    message ? `用户本轮补充：${message}` : "",
    clarificationAnswers?.length ? `人工澄清答案：\n${clarificationAnswers.map((item) => `- ${item.id}: ${item.answer}`).join("\n")}` : "",
    "返回值必须严格符合 --json-schema 指定的结构。",
  ].filter(Boolean).join("\n\n");
}

async function runClaudeAnnotation(body) {
  const projectRoot = await ensureDirectory(body.projectRoot || DEFAULT_PROJECT_ROOT, "projectRoot");
  const referenceDirs = [];
  for (const value of Array.isArray(body.referenceDirs) ? body.referenceDirs : []) {
    referenceDirs.push(await ensureDirectory(value, "参考资料目录"));
  }
  if (!Array.isArray(body.tables) || body.tables.length === 0) throw new Error("没有可供 AI 标注的表数据");
  if (!["generate-all", "clarify", "chat"].includes(body.mode)) throw new Error("mode 无效");

  const jobId = randomUUID();
  const jobDir = join(projectRoot, ".schema-atlas-ai", "jobs", jobId);
  await mkdir(jobDir, { recursive: true });
  const inputPath = join(jobDir, "input.json");
  await writeFile(inputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: body.mode,
    tables: body.tables,
    clarificationAnswers: body.clarificationAnswers || [],
    userMessage: body.message || "",
  }, null, 2));

  const prompt = buildPrompt({
    mode: body.mode,
    inputPath,
    message: typeof body.message === "string" ? body.message : "",
    clarificationAnswers: Array.isArray(body.clarificationAnswers) ? body.clarificationAnswers : [],
    referenceDirs,
  });

  const args = [
    "--dangerously-skip-permissions",
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(proposalSchema),
  ];
  if (body.sessionId) args.push("--resume", String(body.sessionId));
  else args.push("--name", `schema-atlas-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  for (const dir of referenceDirs) args.push("--add-dir", dir);
  args.push(prompt);

  const result = await runProcess("claude", args, { cwd: projectRoot });
  if (result.code !== 0) {
    return {
      ok: false,
      error: `Claude Code 退出码 ${result.code}${result.signal ? ` (${result.signal})` : ""}`,
      stderr: result.stderr.trim(),
    };
  }

  let envelope;
  try { envelope = JSON.parse(result.stdout); }
  catch {
    return { ok: false, error: "Claude Code 没有返回可解析的 JSON", stderr: result.stderr.trim() || result.stdout.slice(0, 2000) };
  }
  const proposal = envelope?.structured_output || envelope?.structuredOutput || null;
  if (!proposal) {
    return {
      ok: false,
      sessionId: envelope?.session_id || envelope?.sessionId,
      error: envelope?.subtype ? `Claude Code 未返回 structured_output: ${envelope.subtype}` : "Claude Code 未返回 structured_output",
      stderr: result.stderr.trim(),
    };
  }
  return {
    ok: true,
    sessionId: envelope?.session_id || envelope?.sessionId,
    proposal,
    stderr: result.stderr.trim() || undefined,
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, ...(await claudeHealth()) });
    if (req.method === "GET" && url.pathname === "/sessions") return sendJson(res, 200, { ok: true, sessions: await listSessions() });
    if (req.method === "GET" && url.pathname.startsWith("/sessions/")) {
      const sessionId = decodeURIComponent(url.pathname.slice("/sessions/".length));
      const session = await readSessionDetail(sessionId);
      return session ? sendJson(res, 200, { ok: true, session }) : sendJson(res, 404, { ok: false, error: "session 不存在" });
    }
    if (req.method === "POST" && url.pathname === "/run") {
      const body = await readJsonBody(req);
      const result = await runClaudeAnnotation(body);
      return sendJson(res, result.ok ? 200 : 500, result);
    }
    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[schema-atlas] Claude Code sidecar listening on http://${HOST}:${PORT}`);
  console.log(`[schema-atlas] project root: ${DEFAULT_PROJECT_ROOT}`);
  console.log(`[schema-atlas] sessions: ${SESSION_ROOT}`);
  console.log("[schema-atlas] Claude Code permission mode: --dangerously-skip-permissions");
});
