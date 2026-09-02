import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SEMANTIC_ROLES = new Set([
  "identifier",
  "name",
  "time",
  "amount",
  "quantity",
  "status",
  "code",
  "description",
  "other",
]);
const SENSITIVITIES = new Set(["none", "internal", "sensitive", "restricted"]);
const CONFIDENCE_LEVELS = new Set(["high", "medium", "low"]);

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function boolValue(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function toPascalCase(value) {
  return String(value ?? "")
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

function toCamelCase(value) {
  const pascal = toPascalCase(value);
  return pascal ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : "field";
}

function defaultClassName(tableName) {
  const parts = String(tableName ?? "").split("_").filter(Boolean);
  if (parts.length > 1 && parts[0].length <= 3) parts.shift();
  return toPascalCase(parts.join("_")) || "UnnamedEntity";
}

function defaultSemanticRole(columnName) {
  const name = String(columnName ?? "").toUpperCase();
  if (/(^|_)ID$/.test(name) || /_ID_/.test(name)) return "identifier";
  if (/(^|_)NAME$/.test(name)) return "name";
  if (/(DATE|TIME|TIMESTAMP)$/.test(name)) return "time";
  if (/(AMOUNT|BALANCE|PRICE|FEE|COST)$/.test(name)) return "amount";
  if (/(COUNT|NUM|NUMBER|QTY|QUANTITY|TIMES)$/.test(name)) return "quantity";
  if (/(STATUS|STATE|FLAG)$/.test(name)) return "status";
  if (/(TYPE|CODE)$/.test(name)) return "code";
  if (/(DESC|DESCRIPTION|REMARK|COMMENT)$/.test(name)) return "description";
  return "other";
}

function currentAnnotation(column) {
  const source = column?.annotation && typeof column.annotation === "object" ? column.annotation : {};
  return {
    included: boolValue(source.included, true),
    entityColumn: stringValue(source.entityColumn, toCamelCase(column?.name)),
    aliases: stringArray(source.aliases),
    detailedDescription: stringValue(source.detailedDescription, stringValue(column?.remark, stringValue(column?.description))),
    isLocalId: boolValue(source.isLocalId),
    isDisplayName: boolValue(source.isDisplayName),
    isSemantic: boolValue(source.isSemantic),
    isCode: boolValue(source.isCode),
    semanticRole: SEMANTIC_ROLES.has(source.semanticRole) ? source.semanticRole : defaultSemanticRole(column?.name),
    tags: stringArray(source.tags),
    unit: stringValue(source.unit),
    enumValues: normalizeEnumValues(source.enumValues),
    valueRange: stringValue(source.valueRange),
    sensitivity: SENSITIVITIES.has(source.sensitivity) ? source.sensitivity : "none",
    enumRef: stringValue(source.enumRef),
    enumDescription: stringValue(source.enumDescription),
  };
}

function normalizeEnumValues(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !stringValue(entry.value)) return [];
    return [{
      value: stringValue(entry.value),
      description: stringValue(entry.description),
      descriptionEn: stringValue(entry.descriptionEn ?? entry.description_en),
      aliases: stringArray(entry.aliases),
    }];
  });
}

export const annotationOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "draft", "todos"],
  properties: {
    reply: { type: "string" },
    draft: {
      type: "object",
      additionalProperties: false,
      required: ["tableName", "className", "classDescription", "classAliases", "confidence", "columns"],
      properties: {
        tableName: { type: "string" },
        className: { type: "string" },
        classDescription: { type: "string" },
        classAliases: { type: "array", items: { type: "string" } },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        columns: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "name", "included", "entityColumn", "aliases", "detailedDescription",
              "isLocalId", "isDisplayName", "isSemantic", "isCode", "semanticRole",
              "tags", "unit", "enumValues", "valueRange", "sensitivity", "enumRef",
              "enumDescription", "confidence", "reason",
            ],
            properties: {
              name: { type: "string" },
              included: { type: "boolean" },
              entityColumn: { type: "string" },
              aliases: { type: "array", items: { type: "string" } },
              detailedDescription: { type: "string" },
              isLocalId: { type: "boolean" },
              isDisplayName: { type: "boolean" },
              isSemantic: { type: "boolean" },
              isCode: { type: "boolean" },
              semanticRole: { type: "string", enum: [...SEMANTIC_ROLES] },
              tags: { type: "array", items: { type: "string" } },
              unit: { type: "string" },
              enumValues: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["value", "description", "descriptionEn", "aliases"],
                  properties: {
                    value: { type: "string" },
                    description: { type: "string" },
                    descriptionEn: { type: "string" },
                    aliases: { type: "array", items: { type: "string" } },
                  },
                },
              },
              valueRange: { type: "string" },
              sensitivity: { type: "string", enum: [...SENSITIVITIES] },
              enumRef: { type: "string" },
              enumDescription: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              reason: { type: "string" },
            },
          },
        },
      },
    },
    todos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["scope", "fieldName", "question", "reason", "checkedSources", "suggestions", "blocking"],
        properties: {
          scope: { type: "string", enum: ["table", "field", "domain"] },
          fieldName: { type: "string" },
          question: { type: "string" },
          reason: { type: "string" },
          checkedSources: { type: "array", minItems: 1, items: { type: "string" } },
          suggestions: { type: "array", items: { type: "string" } },
          blocking: { type: "boolean" },
        },
      },
    },
  },
};

function normalizeColumnDraft(value, column) {
  const fallback = currentAnnotation(column);
  const source = value && typeof value === "object" ? value : {};
  return {
    name: column.name,
    included: boolValue(source.included, fallback.included),
    entityColumn: stringValue(source.entityColumn, fallback.entityColumn),
    aliases: stringArray(source.aliases),
    detailedDescription: stringValue(source.detailedDescription, fallback.detailedDescription),
    isLocalId: boolValue(source.isLocalId, fallback.isLocalId),
    isDisplayName: boolValue(source.isDisplayName, fallback.isDisplayName),
    isSemantic: boolValue(source.isSemantic, fallback.isSemantic),
    isCode: boolValue(source.isCode, fallback.isCode),
    semanticRole: SEMANTIC_ROLES.has(source.semanticRole) ? source.semanticRole : fallback.semanticRole,
    tags: stringArray(source.tags),
    unit: stringValue(source.unit, fallback.unit),
    enumValues: normalizeEnumValues(source.enumValues),
    valueRange: stringValue(source.valueRange, fallback.valueRange),
    sensitivity: SENSITIVITIES.has(source.sensitivity) ? source.sensitivity : fallback.sensitivity,
    enumRef: stringValue(source.enumRef, fallback.enumRef),
    enumDescription: stringValue(source.enumDescription, fallback.enumDescription),
    confidence: CONFIDENCE_LEVELS.has(source.confidence) ? source.confidence : "medium",
    reason: stringValue(source.reason),
  };
}

function normalizeTodo(value, tableName, sessionId) {
  if (!value || typeof value !== "object" || !stringValue(value.question)) return undefined;
  const checkedSources = stringArray(value.checkedSources);
  if (checkedSources.length === 0) return undefined;
  const scope = ["table", "field", "domain"].includes(value.scope) ? value.scope : "table";
  return {
    id: randomUUID(),
    sessionId,
    tableName,
    scope,
    fieldName: scope === "field" ? stringValue(value.fieldName) : "",
    question: stringValue(value.question),
    reason: stringValue(value.reason),
    checkedSources,
    suggestions: stringArray(value.suggestions),
    blocking: boolValue(value.blocking),
    status: "open",
    answer: "",
    createdAt: new Date().toISOString(),
    answeredAt: null,
  };
}

export function normalizeStructuredOutput(value, table, sessionId) {
  const source = value && typeof value === "object" ? value : {};
  const rawDraft = source.draft && typeof source.draft === "object" ? source.draft : {};
  const rawColumns = new Map(
    (Array.isArray(rawDraft.columns) ? rawDraft.columns : [])
      .filter((column) => column && typeof column === "object")
      .map((column) => [stringValue(column.name).toUpperCase(), column]),
  );
  const columns = (Array.isArray(table.columns) ? table.columns : []).map((column) =>
    normalizeColumnDraft(rawColumns.get(String(column.name).toUpperCase()), column));
  const seenNames = new Map();
  const duplicateTodos = [];
  columns.forEach((column) => {
    const key = column.entityColumn.toLowerCase();
    if (!key) return;
    const previous = seenNames.get(key);
    if (previous) duplicateTodos.push(normalizeTodo({
      scope: "field",
      fieldName: column.name,
      question: `属性名 ${column.entityColumn} 同时用于 ${previous} 和 ${column.name}，应该如何区分？`,
      reason: "同一个类内的 attr_name 必须唯一。",
      checkedSources: ["当前 AI 草稿（属性名唯一性校验）"],
      suggestions: [],
      blocking: true,
    }, table.tableName, sessionId));
    else seenNames.set(key, column.name);
  });
  const todos = [
    ...(Array.isArray(source.todos) ? source.todos.map((todo) => normalizeTodo(todo, table.tableName, sessionId)) : []),
    ...duplicateTodos,
  ].filter(Boolean);
  return {
    reply: stringValue(source.reply, "已生成一版标注草稿，请审核后应用。"),
    draft: {
      tableName: table.tableName,
      className: stringValue(rawDraft.className, stringValue(table.className, defaultClassName(table.tableName))),
      classDescription: stringValue(rawDraft.classDescription, stringValue(table.classDescription, stringValue(table.description))),
      classAliases: stringArray(rawDraft.classAliases),
      confidence: CONFIDENCE_LEVELS.has(rawDraft.confidence) ? rawDraft.confidence : "medium",
      columns,
    },
    todos,
  };
}

export const PROMPT_TEMPLATE_KEYS = [
  "table_name",
  "mode",
  "reference_paths",
  "clarifications",
  "user_message",
];

export function normalizePromptTemplate(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("提示词模板不能为空");
  if (value.length > 100_000) throw new Error("提示词模板不能超过 100000 个字符");
  const unknown = [...value.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)]
    .map((match) => match[1])
    .filter((key) => !PROMPT_TEMPLATE_KEYS.includes(key));
  if (unknown.length) throw new Error(`提示词包含不支持的占位符：${[...new Set(unknown)].join("、")}`);
  return value.trim();
}

export function buildAnnotationPrompt({ promptTemplate, table, mode, userMessage, referencePaths, clarifications }) {
  const template = normalizePromptTemplate(promptTemplate);
  const references = referencePaths.length
    ? referencePaths.map((entry) => `- ${entry.resolvedPath}`).join("\n")
    : "- 未配置额外参考资料";
  const clarificationText = clarifications.length
    ? clarifications.map((item) => `- ${item.question}\n  人工回答：${item.answer}`).join("\n")
    : "- 暂无人工澄清。";
  const replacements = {
    table_name: table.tableName,
    mode: mode === "generate" ? "首次生成" : "人工审核后的纠正",
    reference_paths: references,
    clarifications: clarificationText,
    user_message: typeof userMessage === "string" ? userMessage : "",
  };
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (placeholder, key) =>
    Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : placeholder);
}

export function parseStructuredResult(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.structured_output && typeof event.structured_output === "object") return event.structured_output;
    if (event?.result && typeof event.result === "object") return event.result;
    if (typeof event?.result === "string") {
      const raw = event.result.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      try { return JSON.parse(raw); } catch { /* continue */ }
    }
  }
  return undefined;
}

export function describeStreamEvent(event) {
  if (!event || typeof event !== "object") return undefined;
  if (event.type === "system" && event.subtype === "init") return "Claude Code 会话已启动";
  if (event.type === "result") return event.is_error ? "Claude Code 返回错误" : "本轮生成完成";
  const content = event.message?.content;
  if (!Array.isArray(content)) return undefined;
  const tool = content.find((block) => block?.type === "tool_use");
  if (tool) return `正在使用 ${stringValue(tool.name, "工具")} 检查资料`;
  return undefined;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveAllowedRoots(rootDir, configured = process.env.SCHEMA_ATLAS_REFERENCE_ROOTS) {
  const requested = configured
    ? configured.split(path.delimiter).map((item) => item.trim()).filter(Boolean)
    : [rootDir, os.homedir()];
  const roots = [];
  for (const item of requested) {
    try {
      const resolved = await realpath(item.replace(/^~(?=$|[\\/])/, os.homedir()));
      const info = await stat(resolved);
      if (info.isDirectory() && !roots.includes(resolved)) roots.push(resolved);
    } catch { /* invalid roots are reported by health instead of crashing */ }
  }
  return roots;
}

export async function validateReferencePaths(values, allowedRoots) {
  const requested = stringArray(values);
  const resolved = [];
  const errors = [];
  for (const original of requested) {
    try {
      const expanded = original.replace(/^~(?=$|[\\/])/, os.homedir());
      const resolvedPath = await realpath(expanded);
      if (!allowedRoots.some((root) => isWithinRoot(resolvedPath, root))) {
        errors.push(`${original} 不在允许读取的根目录内`);
        continue;
      }
      const info = await stat(resolvedPath);
      if (!info.isDirectory() && !info.isFile()) {
        errors.push(`${original} 不是文件或目录`);
        continue;
      }
      resolved.push({
        requestedPath: original,
        resolvedPath,
        kind: info.isDirectory() ? "directory" : "file",
        addDir: info.isDirectory() ? resolvedPath : path.dirname(resolvedPath),
      });
    } catch {
      errors.push(`${original} 不存在或 claude 用户无权读取`);
    }
  }
  return { resolved, errors };
}

function safeId(value) {
  const id = String(value ?? "");
  if (!/^[0-9a-f-]{20,}$/i.test(id)) throw new Error("无效的记录 ID");
  return id;
}

export class AtlasStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.sessionsDir = path.join(rootDir, "sessions");
    this.jobsDir = path.join(rootDir, "jobs");
    this.sessionIndexPath = path.join(this.sessionsDir, "index.json");
    this.jobIndexPath = path.join(this.jobsDir, "index.json");
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await Promise.all([mkdir(this.sessionsDir, { recursive: true }), mkdir(this.jobsDir, { recursive: true })]);
    await Promise.all([this.ensureJson(this.sessionIndexPath, []), this.ensureJson(this.jobIndexPath, [])]);
  }

  async ensureJson(filePath, fallback) {
    try { await readFile(filePath, "utf8"); } catch { await this.atomicWrite(filePath, fallback); }
  }

  async readJson(filePath, fallback) {
    try { return JSON.parse(await readFile(filePath, "utf8")); } catch { return fallback; }
  }

  async atomicWrite(filePath, value) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, filePath);
  }

  serialize(task) {
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.catch(() => {});
    return result;
  }

  sessionPath(id) { return path.join(this.sessionsDir, `${safeId(id)}.json`); }
  transcriptPath(id) { return path.join(this.sessionsDir, `${safeId(id)}.stream.jsonl`); }
  workspacePath(id) { return path.join(this.sessionsDir, `${safeId(id)}.workspace`); }
  jobPath(id) { return path.join(this.jobsDir, `${safeId(id)}.json`); }

  async listSessions() {
    return this.readJson(this.sessionIndexPath, []);
  }

  async readSession(id) {
    return this.readJson(this.sessionPath(id), null);
  }

  async saveSession(session) {
    return this.serialize(async () => {
      session.updatedAt = new Date().toISOString();
      await this.atomicWrite(this.sessionPath(session.id), session);
      const index = await this.readJson(this.sessionIndexPath, []);
      const summary = {
        id: session.id,
        claudeSessionId: session.claudeSessionId,
        name: session.name,
        source: "schema-atlas",
        tableName: session.tableName,
        domain0: session.domain0,
        jobId: session.jobId ?? null,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        todoCount: session.todos.filter((todo) => todo.status === "open").length,
        hasDraft: Boolean(session.draft),
        error: session.error ?? null,
      };
      const next = [summary, ...index.filter((item) => item.id !== session.id)]
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      await this.atomicWrite(this.sessionIndexPath, next);
      return session;
    });
  }

  async createSession({ table, jobId = null, referencePaths = [], promptTemplate = "" }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const session = {
      id,
      claudeSessionId: id,
      name: `schema-atlas:${stringValue(table.domain0, "未归类")}:${table.tableName}`,
      source: "schema-atlas",
      tableName: table.tableName,
      domain0: stringValue(table.domain0, "未归类"),
      jobId,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      messages: [],
      activities: [],
      todos: [],
      draft: null,
      referencePaths,
      promptTemplate,
      turnCount: 0,
      error: null,
    };
    await mkdir(this.workspacePath(id), { recursive: true });
    await this.atomicWrite(path.join(this.workspacePath(id), "input-table.json"), table);
    await this.saveSession(session);
    return session;
  }

  async appendRawEvent(id, event) {
    const filePath = this.transcriptPath(id);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({ at: new Date().toISOString(), event })}\n`, { encoding: "utf8", flag: "a" });
  }

  async listJobs() { return this.readJson(this.jobIndexPath, []); }
  async readJob(id) { return this.readJson(this.jobPath(id), null); }

  async saveJob(job) {
    return this.serialize(async () => {
      job.updatedAt = new Date().toISOString();
      await this.atomicWrite(this.jobPath(job.id), job);
      const index = await this.readJson(this.jobIndexPath, []);
      const summary = {
        id: job.id,
        label: job.label,
        scope: job.scope,
        status: job.status,
        total: job.total,
        completed: job.completed,
        failed: job.failed,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        error: job.error ?? null,
      };
      const next = [summary, ...index.filter((item) => item.id !== job.id)]
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      await this.atomicWrite(this.jobIndexPath, next);
      return job;
    });
  }

  async createJob({ label, scope, tables, referencePaths, promptTemplate, batchInstruction }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const job = {
      id,
      label,
      scope,
      status: "queued",
      total: tables.length,
      completed: 0,
      failed: 0,
      createdAt: now,
      updatedAt: now,
      tableNames: tables.map((table) => table.tableName),
      sessionIds: [],
      referencePaths,
      promptTemplate,
      batchInstruction,
      cancelled: false,
      error: null,
    };
    await this.saveJob(job);
    return job;
  }
}
