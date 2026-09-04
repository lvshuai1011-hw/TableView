import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  annotationOutputSchema,
  AtlasStore,
  buildAnnotationPrompt,
  clearSessionStructureState,
  describeStreamEvent,
  normalizePromptTemplate,
  normalizeStructuredOutput,
  parseStructuredResult,
  resolveAllowedRoots,
  validateReferencePaths,
} from "./core.mjs";

const projectRoot = path.resolve(process.env.SCHEMA_ATLAS_PROJECT_ROOT || process.cwd());
const defaultPromptPath = path.join(projectRoot, "config", "default-annotation-prompt.txt");
const storeRoot = path.resolve(process.env.SCHEMA_ATLAS_AI_DATA_DIR || path.join(projectRoot, ".schema-atlas-ai"));
const claudeBin = process.env.CLAUDE_BIN || "claude";
const host = process.env.SCHEMA_ATLAS_AI_HOST || "127.0.0.1";
const port = Number(process.env.SCHEMA_ATLAS_AI_PORT || 4317);
const store = new AtlasStore(storeRoot);
const runningSessions = new Map();
const pendingDatasetReconciliations = new Map();
const runningJobs = new Set();
const cancelledJobs = new Set();
let allowedRoots = [];
let healthCache = null;
let defaultPromptTemplate = "";

function now() { return new Date().toISOString(); }

function jsonResponse(response, status, value) {
  const content = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(content);
}

function methodNotAllowed(response) {
  jsonResponse(response, 405, { error: "请求方法不受支持" });
}

async function readJsonBody(request, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("请求内容过大"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("请求不是有效 JSON"), { statusCode: 400 }); }
}

function validTable(value) {
  return value && typeof value === "object" && typeof value.tableName === "string" && Array.isArray(value.columns);
}

function requestPromptTemplate(value, fallback = defaultPromptTemplate) {
  try {
    return normalizePromptTemplate(typeof value === "string" ? value : fallback);
  } catch (error) {
    throw Object.assign(error, { statusCode: 400 });
  }
}

async function requestDatasetContext(datasetId, tableName) {
  try {
    return await store.readDatasetContext(datasetId, tableName);
  } catch (error) {
    throw Object.assign(error, { statusCode: 400 });
  }
}

function message(role, content, extra = {}) {
  return { id: randomUUID(), role, content, at: now(), ...extra };
}

function compactActivity(session, label) {
  if (!label || session.activities.at(-1)?.label === label) return;
  session.activities.push({ id: randomUUID(), label, at: now() });
  session.activities = session.activities.slice(-200);
}

function parseLines(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onLine(line);
        newline = buffer.indexOf("\n");
      }
    },
    flush() {
      const line = buffer.trim();
      buffer = "";
      if (line) onLine(line);
    },
  };
}

function claudeArguments(session, referencePaths, datasetDirectory) {
  const args = [
    "-p",
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--verbose",
    "--json-schema", JSON.stringify(annotationOutputSchema),
  ];
  if (session.turnCount > 0) args.push("--resume", session.claudeSessionId);
  else args.push("--session-id", session.claudeSessionId, "--name", session.name);
  [...new Set([...referencePaths.map((entry) => entry.addDir), datasetDirectory].filter(Boolean))].forEach((directory) => {
    args.push("--add-dir", directory);
  });
  return args;
}

async function runClaudeTurn({ session, table, userMessage, mode, datasetContext, referencePaths, promptTemplate, onEvent = () => {} }) {
  if (runningSessions.has(session.id)) throw Object.assign(new Error("该会话正在运行，请等待本轮完成"), { statusCode: 409 });
  if (session.jobId && cancelledJobs.has(session.jobId)) throw new Error("批量任务已停止");
  if (!datasetContext) throw Object.assign(new Error("缺少当前表的数据集上下文"), { statusCode: 400 });
  const workspace = store.workspacePath(session.id);
  await writeFile(path.join(workspace, "input-table.json"), `${JSON.stringify(table, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, "dataset-context.json"), `${JSON.stringify(datasetContext, null, 2)}\n`, "utf8");
  if (session.draft) await writeFile(path.join(workspace, "current-draft.json"), `${JSON.stringify(session.draft, null, 2)}\n`, "utf8");
  const clarifications = session.todos.filter((todo) => todo.status === "answered" && todo.answer);
  await writeFile(path.join(workspace, "reference-paths.json"), `${JSON.stringify(referencePaths, null, 2)}\n`, "utf8");
  await writeFile(path.join(workspace, "clarifications.json"), `${JSON.stringify(clarifications, null, 2)}\n`, "utf8");
  const prompt = buildAnnotationPrompt({ promptTemplate, table, mode, userMessage, datasetContext, referencePaths, clarifications });

  session.status = "running";
  session.error = null;
  session.referencePaths = referencePaths;
  session.datasetId = datasetContext.datasetId;
  session.relatedTableCount = datasetContext.relatedTables.length;
  session.promptTemplate = promptTemplate;
  session.messages.push(message("user", userMessage));
  compactActivity(session, `准备当前表与 ${datasetContext.relatedTables.length} 张关联表`);
  await store.saveSession(session);
  onEvent({ type: "started", session: await store.readSession(session.id) });

  const events = [];
  const stderr = [];
  let rawWrite = Promise.resolve();
  const child = spawn(claudeBin, claudeArguments(session, referencePaths, datasetContext.datasetDir), {
    cwd: workspace,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  runningSessions.set(session.id, child);
  if (session.jobId && cancelledJobs.has(session.jobId)) child.kill("SIGTERM");
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  const parser = parseLines((line) => {
    let event;
    try { event = JSON.parse(line); }
    catch { event = { type: "unparsed", text: line }; }
    events.push(event);
    rawWrite = rawWrite.then(() => store.appendRawEvent(session.id, event));
    const label = describeStreamEvent(event);
    if (label) {
      compactActivity(session, label);
      onEvent({ type: "activity", label, at: now() });
    }
  });
  child.stdout.on("data", (chunk) => parser.push(chunk));
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
    if (Buffer.concat(stderr).length > 64 * 1024) stderr.shift();
  });

  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    parser.flush();
    await rawWrite;
    if (exitCode !== 0) {
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      throw new Error(detail || `Claude Code 退出码为 ${exitCode}`);
    }
    const structured = parseStructuredResult(events);
    if (!structured) throw new Error("Claude Code 未返回符合约定的结构化标注");
    const result = normalizeStructuredOutput(structured, table, session.id);
    const answeredTodos = session.todos.filter((todo) => todo.status === "answered");
    session.draft = result.draft;
    session.todos = [...answeredTodos, ...result.todos];
    session.messages.push(message("assistant", result.reply, { draftUpdated: true, todoCount: result.todos.length }));
    session.turnCount += 1;
    clearSessionStructureState(session);
    session.status = result.todos.some((todo) => todo.blocking) ? "needs_clarification" : "draft_ready";
    compactActivity(session, "草稿已保存，等待人工审核");
    await writeFile(path.join(workspace, "current-draft.json"), `${JSON.stringify(result.draft, null, 2)}\n`, "utf8");
    await store.saveSession(session);
    onEvent({ type: "completed", session: await store.readSession(session.id) });
    return session;
  } catch (error) {
    session.status = "failed";
    session.error = error instanceof Error ? error.message : "Claude Code 执行失败";
    session.messages.push(message("system", session.error));
    compactActivity(session, "本轮执行失败");
    await store.saveSession(session);
    onEvent({ type: "failed", error: session.error, session: await store.readSession(session.id) });
    throw error;
  } finally {
    runningSessions.delete(session.id);
    const pendingTables = pendingDatasetReconciliations.get(session.id);
    if (pendingTables) {
      pendingDatasetReconciliations.delete(session.id);
      await store.reconcileSessions(pendingTables, { onlySessionIds: [session.id] });
    }
  }
}

async function checkClaude() {
  if (healthCache && Date.now() - healthCache.checkedAt < 10_000) return healthCache.value;
  const rootUser = typeof process.getuid === "function" && process.getuid() === 0;
  const probe = (args) => new Promise((resolve) => {
    const child = spawn(claudeBin, args, { shell: false, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, output: "", error: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0
        ? { ok: true, output: Buffer.concat(output).toString("utf8").trim(), error: null }
        : { ok: false, output: "", error: Buffer.concat(errors).toString("utf8").trim() || `退出码 ${code}` });
    });
  });
  const version = await probe(["--version"]);
  const auth = version.ok ? await probe(["auth", "status"]) : { ok: false, error: "Claude Code 不可用" };
  const value = {
    available: version.ok,
    authenticated: auth.ok,
    version: version.output || "",
    error: version.error || auth.error || null,
  };
  healthCache = {
    checkedAt: Date.now(),
    value: {
      ...value,
      ready: value.available && value.authenticated && !rootUser,
      rootUser,
      user: process.env.USER || process.env.LOGNAME || os.userInfo().username,
      allowedRoots,
      dataDir: storeRoot,
      permissionMode: "bypassPermissions",
    },
  };
  return healthCache.value;
}

async function allTodos() {
  const summaries = await store.listSessions();
  const sessions = await Promise.all(summaries.map((summary) => store.readSession(summary.id)));
  return sessions.flatMap((session) => (session?.todos ?? []).filter((todo) => todo.status !== "dismissed"))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function recoverInterruptedWork() {
  const sessionSummaries = await store.listSessions();
  for (const summary of sessionSummaries.filter((item) => ["running", "queued"].includes(item.status))) {
    const session = await store.readSession(summary.id);
    if (!session) continue;
    session.status = "failed";
    session.error = "服务重启中断了上一轮执行，请在表级对话中重新发送。";
    session.messages.push(message("system", session.error));
    await store.saveSession(session);
  }
  const jobSummaries = await store.listJobs();
  for (const summary of jobSummaries.filter((item) => ["running", "queued", "cancelling"].includes(item.status))) {
    const job = await store.readJob(summary.id);
    if (!job) continue;
    job.status = "failed";
    job.error = "服务重启中断了批量任务，可以重新启动未完成范围。";
    await store.saveJob(job);
  }
}

async function stopSessionProcess(sessionId) {
  const child = runningSessions.get(sessionId);
  if (!child) return;
  await new Promise((resolve) => {
    let settled = false;
    let forceTimer;
    let finishTimer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(finishTimer);
      resolve();
    };
    child.once("close", finish);
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 3_000);
    forceTimer.unref?.();
    finishTimer = setTimeout(finish, 5_000);
    finishTimer.unref?.();
  });
}

async function cancelJob(job) {
  if (!job || !["queued", "running", "cancelling"].includes(job.status)) return job;
  cancelledJobs.add(job.id);
  job.cancelled = true;
  job.status = "cancelling";
  await store.saveJob(job);
  await Promise.all((job.sessionIds ?? []).map(stopSessionProcess));
  return job;
}

async function handleDeleteSessions(request, response) {
  const body = await readJsonBody(request);
  const sessionIds = Array.isArray(body.sessionIds) ? [...new Set(body.sessionIds.map(String))] : [];
  if (sessionIds.length === 0) throw Object.assign(new Error("请选择要清理的 Session"), { statusCode: 400 });
  const sessions = (await Promise.all(sessionIds.map((id) => store.readSession(id)))).filter(Boolean);
  if (sessions.length !== sessionIds.length) throw Object.assign(new Error("部分 Session 已不存在，请刷新后重试"), { statusCode: 404 });
  const jobIds = [...new Set(sessions.map((session) => session.jobId).filter(Boolean))];
  const jobs = (await Promise.all(jobIds.map((id) => store.readJob(id)))).filter(Boolean);
  await Promise.all(jobs.map(cancelJob));
  await Promise.all(sessionIds.map(stopSessionProcess));
  const deleted = await store.deleteSessions(sessionIds);
  return jsonResponse(response, 200, { deleted });
}

async function handleCancelJobs(request, response) {
  const body = await readJsonBody(request);
  const summaries = await store.listJobs();
  const requested = body.all === true
    ? summaries.filter((job) => ["queued", "running", "cancelling"].includes(job.status)).map((job) => job.id)
    : Array.isArray(body.jobIds) ? [...new Set(body.jobIds.map(String))] : [];
  if (requested.length === 0) throw Object.assign(new Error("没有可停止的批量任务"), { statusCode: 400 });
  const jobs = (await Promise.all(requested.map((id) => store.readJob(id)))).filter(Boolean);
  await Promise.all(jobs.map(cancelJob));
  return jsonResponse(response, 202, { jobs });
}

async function runBatch(job, tables, references) {
  if (runningJobs.has(job.id)) return;
  runningJobs.add(job.id);
  job.status = "running";
  await store.saveJob(job);
  try {
    const startingState = await store.readJob(job.id);
    if (startingState?.cancelled || cancelledJobs.has(job.id)) {
      job.cancelled = true;
      job.status = "cancelled";
      await store.saveJob(job);
      return;
    }
    for (const table of tables) {
      const latest = await store.readJob(job.id);
      if (latest?.cancelled) {
        job.cancelled = true;
        job.status = "cancelled";
        break;
      }
      let session;
      try {
        const datasetContext = await requestDatasetContext(job.datasetId, table.tableName);
        session = await store.createSession({ table, jobId: job.id, datasetId: job.datasetId, referencePaths: references, promptTemplate: job.promptTemplate });
        job.sessionIds.push(session.id);
        await store.saveJob(job);
        if (cancelledJobs.has(job.id)) throw new Error("批量任务已停止");
        await runClaudeTurn({
          session,
          table,
          mode: "generate",
          userMessage: job.batchInstruction,
          datasetContext,
          referencePaths: references,
          promptTemplate: job.promptTemplate,
        });
        job.completed += 1;
      } catch {
        const latestAfterTurn = await store.readJob(job.id);
        if (latestAfterTurn?.cancelled) {
          job.cancelled = true;
          job.status = "cancelled";
        } else job.failed += 1;
      }
      await store.saveJob(job);
      if (job.cancelled) break;
    }
    if (!job.cancelled) job.status = job.failed > 0 ? "completed_with_errors" : "completed";
    await store.saveJob(job);
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "批量生成失败";
    await store.saveJob(job);
  } finally {
    runningJobs.delete(job.id);
    cancelledJobs.delete(job.id);
  }
}

async function handleChat(request, response) {
  const body = await readJsonBody(request);
  if (!validTable(body.table)) throw Object.assign(new Error("缺少有效的当前表数据"), { statusCode: 400 });
  const validation = await validateReferencePaths(body.referencePaths, allowedRoots);
  if (validation.errors.length) throw Object.assign(new Error(validation.errors.join("；")), { statusCode: 400 });
  let session = body.sessionId ? await store.readSession(body.sessionId) : null;
  if (body.sessionId && !session) throw Object.assign(new Error("会话不存在"), { statusCode: 404 });
  if (session && session.tableName !== body.table.tableName) throw Object.assign(new Error("会话与当前表不匹配"), { statusCode: 409 });
  const promptTemplate = requestPromptTemplate(body.promptTemplate, session?.promptTemplate || defaultPromptTemplate);
  const datasetContext = await requestDatasetContext(body.datasetId, body.table.tableName);
  if (!session) session = await store.createSession({ table: body.table, datasetId: datasetContext.datasetId, referencePaths: validation.resolved, promptTemplate });
  const userMessage = typeof body.message === "string" ? body.message.trim() : "";
  if (!userMessage) throw Object.assign(new Error("请填写本轮生成或修订要求"), { statusCode: 400 });

  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    connection: "keep-alive",
  });
  const send = (event) => {
    if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
  };
  try {
    await runClaudeTurn({
      session,
      table: body.table,
      mode: session.turnCount > 0 ? "correct" : "generate",
      userMessage,
      datasetContext,
      referencePaths: validation.resolved,
      promptTemplate,
      onEvent: send,
    });
  } catch {
    // runClaudeTurn already emitted and persisted the failure.
  }
  response.end();
}

async function handleDraftUpdate(request, response, sessionId) {
  const session = await store.readSession(sessionId);
  if (!session) return jsonResponse(response, 404, { error: "会话不存在" });
  if (runningSessions.has(session.id) || ["queued", "running", "cancelling"].includes(session.status)) {
    return jsonResponse(response, 409, { error: "该会话正在执行，请等待本轮完成后再人工修改" });
  }
  const body = await readJsonBody(request);
  if (!validTable(body.table) || body.table.tableName !== session.tableName) {
    return jsonResponse(response, 409, { error: "审核草稿与当前表不匹配" });
  }
  if (!body.draft || typeof body.draft !== "object") {
    return jsonResponse(response, 400, { error: "缺少有效的审核草稿" });
  }
  const normalized = normalizeStructuredOutput(
    { draft: body.draft, reply: "", todos: [] },
    body.table,
    session.id,
    { allowManualFlags: true },
  );
  session.draft = normalized.draft;
  clearSessionStructureState(session);
  session.status = session.todos.some((todo) => todo.status === "open" && todo.blocking) ? "needs_clarification" : "draft_ready";
  session.error = null;
  const changeLabel = typeof body.label === "string" && body.label.trim()
    ? body.label.trim().slice(0, 240)
    : "更新了审核草稿";
  session.messages.push(message("system", `人工${changeLabel}。`));
  await writeFile(path.join(store.workspacePath(session.id), "current-draft.json"), `${JSON.stringify(session.draft, null, 2)}\n`, "utf8");
  await store.saveSession(session);
  session.trace = await store.readSessionTrace(session.id);
  return jsonResponse(response, 200, { session });
}

async function handleGenerate(request, response) {
  const body = await readJsonBody(request);
  const tables = Array.isArray(body.tables) ? body.tables.filter(validTable) : [];
  if (tables.length === 0) throw Object.assign(new Error("当前范围内没有可生成的表"), { statusCode: 400 });
  const validation = await validateReferencePaths(body.referencePaths, allowedRoots);
  if (validation.errors.length) throw Object.assign(new Error(validation.errors.join("；")), { statusCode: 400 });
  const scope = body.scope && typeof body.scope === "object" ? body.scope : { level: "global" };
  const promptTemplate = requestPromptTemplate(body.promptTemplate);
  const batchInstruction = typeof body.batchInstruction === "string" ? body.batchInstruction.trim() : "";
  if (!batchInstruction) throw Object.assign(new Error("请填写批量生成要求"), { statusCode: 400 });
  const datasetId = String(body.datasetId ?? "");
  let datasetManifest;
  try { datasetManifest = await store.readDatasetManifest(datasetId); }
  catch (error) { throw Object.assign(error, { statusCode: 400 }); }
  const datasetTableNames = new Set(datasetManifest.tables.map((table) => table.tableName));
  const missingTable = tables.find((table) => !datasetTableNames.has(table.tableName));
  if (missingTable) throw Object.assign(new Error(`数据集快照中没有待处理表：${missingTable.tableName}`), { statusCode: 400 });
  const label = scope.level === "domain" && scope.domain0 ? `${scope.domain0} · AI 全量标注` : `全部域 · AI 全量标注`;
  const job = await store.createJob({ label, scope, tables, datasetId, referencePaths: validation.resolved, promptTemplate, batchInstruction });
  setImmediate(() => runBatch(job, tables, validation.resolved));
  jsonResponse(response, 202, { job });
}

async function handleTodoAnswer(request, response, todoId) {
  const body = await readJsonBody(request);
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (!answer) throw Object.assign(new Error("请填写澄清答案"), { statusCode: 400 });
  const todos = await allTodos();
  const target = todos.find((todo) => todo.id === todoId);
  if (!target) throw Object.assign(new Error("待澄清项不存在"), { statusCode: 404 });
  const session = await store.readSession(target.sessionId);
  if (!session) throw Object.assign(new Error("待澄清项所属会话不存在"), { statusCode: 404 });
  if (body.table !== undefined && !validTable(body.table)) {
    throw Object.assign(new Error("当前表数据无效"), { statusCode: 400 });
  }
  if (validTable(body.table) && body.table.tableName !== session.tableName) {
    throw Object.assign(new Error("当前表与待澄清项不匹配"), { statusCode: 409 });
  }
  const table = validTable(body.table)
    ? body.table
    : JSON.parse(await readFile(path.join(store.workspacePath(session.id), "input-table.json"), "utf8"));
  const promptTemplate = requestPromptTemplate(body.promptTemplate, session.promptTemplate || defaultPromptTemplate);
  const datasetContext = await requestDatasetContext(body.datasetId || session.datasetId, table.tableName);
  const todo = session.todos.find((item) => item.id === todoId);
  if (!todo) throw Object.assign(new Error("待澄清项已不存在"), { statusCode: 404 });
  if (todo.status !== "open") throw Object.assign(new Error("待澄清项已失效或已经处理"), { statusCode: 409 });
  todo.status = "answered";
  todo.answer = answer;
  todo.answeredAt = now();
  session.status = "queued";
  await store.saveSession(session);
  setImmediate(async () => {
    try {
      await runClaudeTurn({
        session,
        table,
        mode: "correct",
        userMessage: answer,
        datasetContext,
        referencePaths: session.referencePaths ?? [],
        promptTemplate,
      });
    } catch { /* failure is visible in the session */ }
  });
  jsonResponse(response, 202, { sessionId: session.id, todo });
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (!url.pathname.startsWith("/api/ai/")) return jsonResponse(response, 404, { error: "接口不存在" });
  if (request.method === "OPTIONS") {
    response.writeHead(204, { allow: "GET, POST, PATCH, DELETE, OPTIONS", "cache-control": "no-store" });
    return response.end();
  }
  if (url.pathname === "/api/ai/health") {
    if (request.method !== "GET") return methodNotAllowed(response);
    return jsonResponse(response, 200, await checkClaude());
  }
  if (url.pathname === "/api/ai/prompt-default") {
    if (request.method !== "GET") return methodNotAllowed(response);
    return jsonResponse(response, 200, { promptTemplate: defaultPromptTemplate });
  }
  if (url.pathname === "/api/ai/datasets/sync") {
    if (request.method !== "POST") return methodNotAllowed(response);
    const body = await readJsonBody(request);
    if (!Array.isArray(body.tables) || !body.tables.every(validTable)) {
      return jsonResponse(response, 400, { error: "缺少有效的导入表数据集" });
    }
    const runningSessionIds = [...runningSessions.keys()];
    runningSessionIds.forEach((sessionId) => pendingDatasetReconciliations.set(sessionId, body.tables));
    const dataset = await store.syncDataset(body.tables, { skipSessionIds: runningSessionIds });
    return jsonResponse(response, 200, { dataset });
  }
  if (url.pathname === "/api/ai/sessions") {
    if (request.method === "GET") return jsonResponse(response, 200, { sessions: await store.listSessions() });
    if (request.method === "DELETE") return handleDeleteSessions(request, response);
    return methodNotAllowed(response);
  }
  if (url.pathname === "/api/ai/jobs") {
    if (request.method !== "GET") return methodNotAllowed(response);
    return jsonResponse(response, 200, { jobs: await store.listJobs() });
  }
  if (url.pathname === "/api/ai/todos") {
    if (request.method !== "GET") return methodNotAllowed(response);
    return jsonResponse(response, 200, { todos: await allTodos() });
  }
  if (url.pathname === "/api/ai/chat") {
    if (request.method !== "POST") return methodNotAllowed(response);
    return handleChat(request, response);
  }
  if (url.pathname === "/api/ai/jobs/generate") {
    if (request.method !== "POST") return methodNotAllowed(response);
    return handleGenerate(request, response);
  }
  if (url.pathname === "/api/ai/jobs/cancel") {
    if (request.method !== "POST") return methodNotAllowed(response);
    return handleCancelJobs(request, response);
  }
  const sessionMatch = url.pathname.match(/^\/api\/ai\/sessions\/([0-9a-f-]+)$/i);
  if (sessionMatch) {
    if (request.method !== "GET") return methodNotAllowed(response);
    const session = await store.readSession(sessionMatch[1]);
    if (!session) return jsonResponse(response, 404, { error: "会话不存在" });
    session.trace = await store.readSessionTrace(session.id);
    return jsonResponse(response, 200, { session });
  }
  const appliedMatch = url.pathname.match(/^\/api\/ai\/sessions\/([0-9a-f-]+)\/applied$/i);
  if (appliedMatch) {
    if (request.method !== "POST") return methodNotAllowed(response);
    const session = await store.readSession(appliedMatch[1]);
    if (!session) return jsonResponse(response, 404, { error: "会话不存在" });
    if (!session.draft) return jsonResponse(response, 409, { error: "该会话没有可应用的草稿" });
    if (session.status === "stale" || session.staleReason) {
      return jsonResponse(response, 409, { error: "当前 Session 基于旧表结构，请先继续对话重新核对或人工保存当前结构" });
    }
    session.status = "applied";
    session.appliedAt = now();
    session.messages.push(message("system", "人工已将本版草稿应用到表标注。"));
    await store.saveSession(session);
    return jsonResponse(response, 200, { session });
  }
  const draftMatch = url.pathname.match(/^\/api\/ai\/sessions\/([0-9a-f-]+)\/draft$/i);
  if (draftMatch) {
    if (request.method !== "PATCH") return methodNotAllowed(response);
    return handleDraftUpdate(request, response, draftMatch[1]);
  }
  const jobMatch = url.pathname.match(/^\/api\/ai\/jobs\/([0-9a-f-]+)$/i);
  if (jobMatch) {
    if (request.method !== "GET") return methodNotAllowed(response);
    const job = await store.readJob(jobMatch[1]);
    return job ? jsonResponse(response, 200, { job }) : jsonResponse(response, 404, { error: "任务不存在" });
  }
  const cancelMatch = url.pathname.match(/^\/api\/ai\/jobs\/([0-9a-f-]+)\/cancel$/i);
  if (cancelMatch) {
    if (request.method !== "POST") return methodNotAllowed(response);
    const job = await store.readJob(cancelMatch[1]);
    if (!job) return jsonResponse(response, 404, { error: "任务不存在" });
    await cancelJob(job);
    return jsonResponse(response, 202, { job });
  }
  const todoMatch = url.pathname.match(/^\/api\/ai\/todos\/([0-9a-f-]+)\/answer$/i);
  if (todoMatch) {
    if (request.method !== "POST") return methodNotAllowed(response);
    return handleTodoAnswer(request, response, todoMatch[1]);
  }
  return jsonResponse(response, 404, { error: "接口不存在" });
}

export async function startServer() {
  if (typeof process.getuid === "function" && process.getuid() === 0 && process.env.SCHEMA_ATLAS_ALLOW_ROOT !== "1") {
    throw new Error("Schema Atlas AI 服务拒绝以 root 运行。请切换到 claude 用户后启动。 ");
  }
  defaultPromptTemplate = normalizePromptTemplate(await readFile(defaultPromptPath, "utf8"));
  await store.init();
  await recoverInterruptedWork();
  allowedRoots = await resolveAllowedRoots(projectRoot);
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        if (!response.writableEnded) response.end(`${JSON.stringify({ type: "failed", error: error.message })}\n`);
        return;
      }
      jsonResponse(response, error?.statusCode || 500, { error: error instanceof Error ? error.message : "服务内部错误" });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const boundPort = address && typeof address === "object" ? address.port : port;
  console.log(`Schema Atlas AI listening on http://${host}:${boundPort}`);
  return server;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
