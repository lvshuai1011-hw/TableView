import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AtlasStore,
  buildAnnotationPrompt,
  normalizePromptTemplate,
  normalizeStructuredOutput,
  validateReferencePaths,
} from "../local-ai/core.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultPromptTemplate = await readFile(
  path.join(projectRoot, "config", "default-annotation-prompt.txt"),
  "utf8",
);

const table = {
  tableName: "PE_FREE_UNIT",
  domain0: "FreeUnit",
  domain1: "免费资源",
  className: "FreeUnit",
  classDescription: "",
  description: "免费资源实例",
  columns: [
    { name: "FREE_UNIT_ID", description: "免费资源标识", remark: "唯一标识", annotation: { included: true, entityColumn: "freeUnitID" } },
    { name: "FREE_UNIT_TYPE_ID", description: "类型标识", remark: "" },
  ],
  foreignKeys: [],
  referencedBy: [],
};

test("normalizes Claude output against imported columns and creates a duplicate-name todo", () => {
  const result = normalizeStructuredOutput({
    reply: "完成",
    draft: {
      className: "FreeUnitInstance",
      classDescription: "实例说明",
      classAliases: ["免费资源", "免费资源"],
      confidence: "high",
      columns: [
        { name: "FREE_UNIT_ID", entityColumn: "freeUnitID", included: true, confidence: "high" },
        { name: "FREE_UNIT_TYPE_ID", entityColumn: "freeUnitID", included: true, confidence: "low" },
        { name: "NOT_IMPORTED", entityColumn: "invented", included: true, confidence: "high" },
      ],
    },
    todos: [],
  }, table, "11111111-1111-4111-8111-111111111111");

  assert.equal(result.draft.tableName, table.tableName);
  assert.deepEqual(result.draft.classAliases, ["免费资源"]);
  assert.deepEqual(result.draft.columns.map((column) => column.name), ["FREE_UNIT_ID", "FREE_UNIT_TYPE_ID"]);
  assert.equal(result.todos.length, 1);
  assert.equal(result.todos[0].blocking, true);
  assert.match(result.todos[0].question, /属性名 freeUnitID/);
});

test("builds a direct-file prompt with human clarifications", () => {
  const prompt = buildAnnotationPrompt({
    promptTemplate: defaultPromptTemplate,
    table,
    mode: "correct",
    userMessage: "FREE_UNIT_ID 是本地标识",
    referencePaths: [{ resolvedPath: "/srv/reference/repo" }],
    clarifications: [{ question: "是否为本地标识？", answer: "是" }],
  });
  assert.match(prompt, /直接阅读/);
  assert.match(prompt, /\/srv\/reference\/repo/);
  assert.match(prompt, /人工回答：是/);
  assert.match(prompt, /不能凭空增加数据库列/);
  assert.match(prompt, /只有检索后仍没有明确依据/);
  assert.match(prompt, /checkedSources/);
});

test("renders an editable prompt template and rejects unknown placeholders", () => {
  const prompt = buildAnnotationPrompt({
    promptTemplate: "表={{table_name}}\n要求={{user_message}}\n资料={{reference_paths}}",
    table,
    mode: "generate",
    userMessage: "生成一版",
    referencePaths: [],
    clarifications: [],
  });
  assert.match(prompt, /表=PE_FREE_UNIT/);
  assert.match(prompt, /要求=生成一版/);
  assert.throws(() => normalizePromptTemplate("{{unsupported}}"), /不支持的占位符/);
});

test("keeps clarification todos only when searched sources are recorded", () => {
  const result = normalizeStructuredOutput({
    draft: { columns: [] },
    todos: [
      { scope: "field", fieldName: "FREE_UNIT_TYPE_ID", question: "它表示什么？", reason: "置信度低", checkedSources: [], suggestions: [], blocking: false },
      { scope: "field", fieldName: "FREE_UNIT_TYPE_ID", question: "两份资料定义冲突，以哪份为准？", reason: "定义冲突", checkedSources: ["/srv/reference/a.json", "/srv/reference/b.sql"], suggestions: [], blocking: true },
    ],
  }, table, "11111111-1111-4111-8111-111111111112");

  assert.equal(result.todos.length, 1);
  assert.deepEqual(result.todos[0].checkedSources, ["/srv/reference/a.json", "/srv/reference/b.sql"]);
});

test("keeps a durable index containing only Schema Atlas-created sessions", async () => {
  const temp = await mkdtemp(path.join(projectRoot, ".schema-atlas-ai-test-"));
  try {
    const store = new AtlasStore(temp);
    await store.init();
    const session = await store.createSession({ table });
    const summaries = await store.listSessions();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].source, "schema-atlas");
    assert.equal(summaries[0].claudeSessionId, session.id);
    assert.equal((await store.readSession(session.id)).tableName, "PE_FREE_UNIT");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("rejects reference paths outside configured roots", async () => {
  const temp = await mkdtemp(path.join(projectRoot, ".schema-atlas-ref-test-"));
  try {
    const accepted = await validateReferencePaths([temp], [temp]);
    assert.equal(accepted.errors.length, 0);
    assert.equal(accepted.resolved[0].kind, "directory");
    const rejected = await validateReferencePaths([os.homedir()], [temp]);
    assert.equal(rejected.resolved.length, 0);
    assert.match(rejected.errors[0], /不在允许读取的根目录内/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("streams a structured Claude CLI turn through the local HTTP bridge", async () => {
  const temp = await mkdtemp(path.join(projectRoot, ".schema-atlas-server-test-"));
  const fakeClaude = path.join(temp, "fake-claude.mjs");
  await writeFile(fakeClaude, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("fake-claude 1.0.0"); process.exit(0); }
const sessionFlag = args.indexOf("--session-id");
const resumeFlag = args.indexOf("--resume");
const sessionId = sessionFlag >= 0 ? args[sessionFlag + 1] : args[resumeFlag + 1];
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }));
console.log(JSON.stringify({ type: "result", is_error: false, structured_output: {
  reply: "第一版已经生成",
  draft: { className: "FreeUnitInstance", classDescription: "免费资源实例", classAliases: [], confidence: "high", columns: [
    { name: "FREE_UNIT_ID", included: true, entityColumn: "freeUnitInstanceID", aliases: ["主键"], detailedDescription: "唯一标识", isLocalId: true, isDisplayName: false, isSemantic: false, isCode: false, semanticRole: "identifier", tags: [], unit: "", enumValues: [], valueRange: "", sensitivity: "none", enumRef: "", enumDescription: "", confidence: "high", reason: "主键" },
    { name: "FREE_UNIT_TYPE_ID", included: true, entityColumn: "freeUnitTypeID", aliases: [], detailedDescription: "类型标识", isLocalId: false, isDisplayName: false, isSemantic: false, isCode: false, semanticRole: "identifier", tags: [], unit: "", enumValues: [], valueRange: "", sensitivity: "none", enumRef: "", enumDescription: "", confidence: "medium", reason: "字段名" }
  ] },
  todos: []
} }));
`, "utf8");
  await chmod(fakeClaude, 0o755);

  const previous = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    SCHEMA_ATLAS_AI_DATA_DIR: process.env.SCHEMA_ATLAS_AI_DATA_DIR,
    SCHEMA_ATLAS_AI_PORT: process.env.SCHEMA_ATLAS_AI_PORT,
    SCHEMA_ATLAS_ALLOW_ROOT: process.env.SCHEMA_ATLAS_ALLOW_ROOT,
    SCHEMA_ATLAS_PROJECT_ROOT: process.env.SCHEMA_ATLAS_PROJECT_ROOT,
    SCHEMA_ATLAS_REFERENCE_ROOTS: process.env.SCHEMA_ATLAS_REFERENCE_ROOTS,
  };
  Object.assign(process.env, {
    CLAUDE_BIN: fakeClaude,
    SCHEMA_ATLAS_AI_DATA_DIR: path.join(temp, "data"),
    SCHEMA_ATLAS_AI_PORT: "0",
    SCHEMA_ATLAS_ALLOW_ROOT: "1",
    SCHEMA_ATLAS_PROJECT_ROOT: projectRoot,
    SCHEMA_ATLAS_REFERENCE_ROOTS: projectRoot,
  });
  let server;
  try {
    const moduleUrl = new URL(`../local-ai/server.mjs?test=${Date.now()}`, import.meta.url);
    const { startServer } = await import(moduleUrl.href);
    server = await startServer();
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/api/ai/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        table,
        message: "生成第一版",
        referencePaths: [],
        promptTemplate: defaultPromptTemplate,
      }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const completed = events.find((event) => event.type === "completed");
    assert.equal(completed.session.source, "schema-atlas");
    assert.equal(completed.session.draft.className, "FreeUnitInstance");
    assert.equal(completed.session.draft.columns[0].isLocalId, true);
    const sessions = await (await fetch(`${origin}/api/ai/sessions`)).json();
    assert.equal(sessions.sessions.length, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    await rm(temp, { recursive: true, force: true });
  }
});
