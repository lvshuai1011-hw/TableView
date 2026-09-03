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

const relationship = {
  name: "Reference_6",
  parentTable: "PE_FREE_UNIT_TYPE",
  childTable: "PE_FREE_UNIT",
  cardinality: "1:N",
  cardinalityRaw: "0..*",
  deleteConstraint: "RESTRICT",
  updateConstraint: "RESTRICT",
  constraintName: "",
  columnMapping: [{ parentColumn: "FREE_UNIT_TYPE_ID", childColumn: "FREE_UNIT_TYPE_ID" }],
};

const relatedTable = {
  ...table,
  tableName: "PE_FREE_UNIT_TYPE",
  className: "FreeUnitType",
  description: "免费资源类型",
  columns: [{ name: "FREE_UNIT_TYPE_ID", description: "免费资源类型标识", remark: "唯一标识一种免费资源" }],
  referencedBy: [relationship],
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
    datasetContext: {
      datasetId: "a".repeat(64),
      manifestPath: "/srv/schema-atlas/datasets/manifest.json",
      relationIndexPath: "/srv/schema-atlas/datasets/relation-index.json",
      currentTable: { path: "/srv/schema-atlas/datasets/tables/PE_FREE_UNIT.json" },
      relatedTables: [{ tableName: "PE_FREE_UNIT_TYPE", path: "/srv/schema-atlas/datasets/tables/PE_FREE_UNIT_TYPE.json" }],
    },
    referencePaths: [{ resolvedPath: "/srv/reference/repo" }],
    clarifications: [{ question: "是否为本地标识？", answer: "是" }],
  });
  assert.match(prompt, /本地参考资料/);
  assert.match(prompt, /\/srv\/reference\/repo/);
  assert.match(prompt, /人工回答：是/);
  assert.match(prompt, /不能创造数据库列/);
  assert.match(prompt, /仍无明确依据/);
  assert.match(prompt, /checkedSources/);
  assert.match(prompt, /PE_FREE_UNIT_TYPE\.json/);
  assert.match(prompt, /classAliases 必须提供 4–12 个/);
  assert.match(prompt, /enum_ref/);
  assert.match(prompt, /English Description/);
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

test("persists a complete dataset and resolves directly related table files", async () => {
  const temp = await mkdtemp(path.join(projectRoot, ".schema-atlas-dataset-test-"));
  try {
    const store = new AtlasStore(temp);
    await store.init();
    const childTable = { ...table, foreignKeys: [relationship] };
    const manifest = await store.syncDataset([childTable, relatedTable]);
    const context = await store.readDatasetContext(manifest.id, table.tableName);
    const parentContext = await store.readDatasetContext(manifest.id, relatedTable.tableName);

    assert.equal(manifest.tableCount, 2);
    assert.equal(manifest.relationshipCount, 1);
    assert.deepEqual(context.relatedTables.map((entry) => entry.tableName), ["PE_FREE_UNIT_TYPE"]);
    assert.equal(context.relationships.foreignKeys.length, 1);
    assert.equal(parentContext.relationships.referencedBy.length, 1);
    assert.equal(JSON.parse(await readFile(context.currentTable.path, "utf8")).tableName, "PE_FREE_UNIT");
    assert.equal(JSON.parse(await readFile(context.relatedTables[0].path, "utf8")).columns[0].description, "免费资源类型标识");

    const afterDelete = await store.syncDataset([childTable]);
    const afterDeleteContext = await store.readDatasetContext(afterDelete.id, table.tableName);
    assert.notEqual(afterDelete.id, manifest.id);
    assert.equal(afterDelete.tableCount, 1);
    assert.equal(afterDeleteContext.relatedTables.length, 0);
    assert.equal(JSON.parse(await readFile(store.currentDatasetPath, "utf8")).datasetId, afterDelete.id);
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
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "先读取当前表与关系索引。" }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "dataset-context.json" } }] } }));
console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "已读取当前表与关联表清单" }] } }));
console.log(JSON.stringify({ type: "result", is_error: false, structured_output: {
  reply: "第一版已经生成",
  draft: { className: "FreeUnitInstance", classDescription: "中文描述：免费资源实例代表归属于特定业务属主、可在有效周期内用于抵扣对应通信消费的权益余额，是免费资源授予、消耗、滚存与失效管理中的核心业务对象，并通过资源类型界定可抵扣的服务范围与度量口径。\\n\\nEnglish Description: A free unit instance represents a benefit balance granted to a specific business owner and available for offsetting eligible telecommunications usage during its validity period. It is the central business object for grant, consumption, rollover, and expiry management, while its resource type defines the applicable service scope and measurement convention.", classAliases: ["Free resource instance", "Bonus resource", "免费资源实例", "赠送资源"], confidence: "high", columns: [
    { name: "FREE_UNIT_ID", included: true, entityColumn: "freeUnitInstanceID", aliases: ["Free unit instance identifier", "免费资源实例标识"], detailedDescription: "中文描述：免费资源实例标识用于在免费资源业务范围内唯一识别一份已经授予某个属主的资源权益，并作为该权益在余额变化、使用抵扣、滚存衔接和生命周期追踪中的稳定关联依据。\\n\\nEnglish Description: The free unit instance identifier uniquely identifies a granted resource entitlement within the free-unit business scope and serves as the stable reference for balance changes, usage offsets, rollover continuity, and lifecycle tracking.", isLocalId: true, isDisplayName: false, isSemantic: false, isCode: false, enumValues: [], enumRef: "", enumDescription: "", confidence: "high", reason: "input-table.json 主键及 remark" },
    { name: "FREE_UNIT_TYPE_ID", included: true, entityColumn: "freeUnitTypeID", aliases: ["Free unit type identifier", "免费资源类型标识"], detailedDescription: "中文描述：免费资源类型标识指明当前免费资源实例所属的资源类别，用于确定该权益能够抵扣的业务使用类型、对应度量口径以及适用的资源管理规则，并把实例关联到统一的类型定义。\\n\\nEnglish Description: The free unit type identifier specifies the resource category of the current free-unit instance, determining the eligible usage category, measurement convention, and applicable resource-management rules while linking the instance to a shared type definition.", isLocalId: false, isDisplayName: false, isSemantic: false, isCode: false, enumValues: [], enumRef: "", enumDescription: "", confidence: "medium", reason: "字段 remark 与父表关系" }
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
    const syncResponse = await fetch(`${origin}/api/ai/datasets/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tables: [table] }),
    });
    assert.equal(syncResponse.status, 200);
    const { dataset } = await syncResponse.json();
    const response = await fetch(`${origin}/api/ai/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        table,
        datasetId: dataset.id,
        message: "生成第一版",
        referencePaths: [],
        promptTemplate: defaultPromptTemplate,
      }),
    });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    const completed = events.find((event) => event.type === "completed");
    assert.equal(completed.session.source, "schema-atlas");
    assert.equal(completed.session.datasetId, dataset.id);
    assert.equal(completed.session.draft.className, "FreeUnitInstance");
    assert.equal(completed.session.draft.columns[0].isLocalId, true);
    const sessions = await (await fetch(`${origin}/api/ai/sessions`)).json();
    assert.equal(sessions.sessions.length, 1);
    const contextPath = path.join(temp, "data", "sessions", `${completed.session.id}.workspace`, "dataset-context.json");
    const datasetContext = JSON.parse(await readFile(
      contextPath,
      "utf8",
    ));
    assert.equal(datasetContext.currentTable.tableName, "PE_FREE_UNIT");
    const sessionDetail = await (await fetch(`${origin}/api/ai/sessions/${completed.session.id}`)).json();
    assert.deepEqual(sessionDetail.session.trace.map((item) => item.kind), ["system", "assistant", "tool_use", "tool_result", "result"]);
    assert.match(sessionDetail.session.trace.find((item) => item.kind === "tool_use").detail, /dataset-context\.json/);
    const deleteResponse = await fetch(`${origin}/api/ai/sessions`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionIds: [completed.session.id] }),
    });
    assert.equal(deleteResponse.status, 200);
    assert.equal((await (await fetch(`${origin}/api/ai/sessions`)).json()).sessions.length, 0);
    await assert.rejects(readFile(contextPath, "utf8"));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    await rm(temp, { recursive: true, force: true });
  }
});
