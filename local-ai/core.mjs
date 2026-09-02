import { createHash, randomUUID } from "node:crypto";
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
  "dataset_context",
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

export function buildAnnotationPrompt({ promptTemplate, table, mode, userMessage, datasetContext, referencePaths, clarifications }) {
  const template = normalizePromptTemplate(promptTemplate);
  const relatedTables = datasetContext?.relatedTables?.length
    ? datasetContext.relatedTables.map((entry) => `  - ${entry.tableName}: ${entry.path}`).join("\n")
    : "  - 没有已导入的直接关联表";
  const datasetText = datasetContext
    ? [
      `- 数据集 ID：${datasetContext.datasetId}`,
      "- Session 上下文索引：dataset-context.json",
      `- 数据集清单：${datasetContext.manifestPath}`,
      `- 全局关系索引：${datasetContext.relationIndexPath}`,
      `- 当前表落盘文件：${datasetContext.currentTable.path}`,
      "- 已导入的直接关联表：",
      relatedTables,
      "- 同 0级域的其他表路径已列在 dataset-context.json 的 domainTables 中。",
    ].join("\n")
    : "- 当前任务未绑定后台数据集快照";
  const references = referencePaths.length
    ? referencePaths.map((entry) => `- ${entry.resolvedPath}`).join("\n")
    : "- 未配置额外参考资料";
  const clarificationText = clarifications.length
    ? clarifications.map((item) => `- ${item.question}\n  人工回答：${item.answer}`).join("\n")
    : "- 暂无人工澄清。";
  const replacements = {
    table_name: table.tableName,
    mode: mode === "generate" ? "首次生成" : "人工审核后的纠正",
    dataset_context: datasetText,
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

function safeDatasetId(value) {
  const id = String(value ?? "");
  if (!/^[0-9a-f]{64}$/i.test(id)) throw new Error("无效的数据集 ID");
  return id.toLowerCase();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function tableFileName(tableName) {
  const name = stringValue(tableName);
  if (/^[A-Za-z0-9_$#.-]{1,160}$/.test(name) && name !== "." && name !== "..") return `${name}.json`;
  const readable = name.replace(/[^A-Za-z0-9_$#.-]+/g, "_").replace(/^\.+|\.+$/g, "").slice(0, 120) || "table";
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `${readable}-${suffix}.json`;
}

function relationshipKey(relationship) {
  const mappings = Array.isArray(relationship?.columnMapping)
    ? relationship.columnMapping.map((mapping) => `${stringValue(mapping?.parentColumn)}>${stringValue(mapping?.childColumn)}`).join(",")
    : "";
  return [
    stringValue(relationship?.parentTable),
    stringValue(relationship?.childTable),
    stringValue(relationship?.constraintName, stringValue(relationship?.name)),
    mappings,
  ].join("|");
}

function datasetArtifacts(tables, id, createdAt) {
  const tableNames = new Set(tables.map((table) => table.tableName));
  const relations = [];
  const relationKeys = new Set();
  tables.forEach((table) => {
    [...(Array.isArray(table.foreignKeys) ? table.foreignKeys : []), ...(Array.isArray(table.referencedBy) ? table.referencedBy : [])]
      .forEach((relationship) => {
        if (!relationship || typeof relationship !== "object") return;
        const key = relationshipKey(relationship);
        if (!key || relationKeys.has(key)) return;
        relationKeys.add(key);
        relations.push(relationship);
      });
  });
  const byTable = Object.fromEntries(tables.map((table) => [table.tableName, {
    foreignKeys: [],
    referencedBy: [],
    selfReferences: [],
    relatedTables: [],
  }]));
  relations.forEach((relationship) => {
    const parent = stringValue(relationship.parentTable);
    const child = stringValue(relationship.childTable);
    if (parent === child && byTable[parent]) byTable[parent].selfReferences.push(relationship);
    if (byTable[child]) byTable[child].foreignKeys.push(relationship);
    if (byTable[parent]) byTable[parent].referencedBy.push(relationship);
    if (parent !== child && tableNames.has(parent) && tableNames.has(child)) {
      if (!byTable[parent].relatedTables.includes(child)) byTable[parent].relatedTables.push(child);
      if (!byTable[child].relatedTables.includes(parent)) byTable[child].relatedTables.push(parent);
    }
  });
  Object.values(byTable).forEach((entry) => entry.relatedTables.sort((a, b) => a.localeCompare(b)));
  const domains = new Map();
  tables.forEach((table) => {
    const key = stringValue(table.domain0, "未归类");
    const value = domains.get(key) ?? { name: key, tableCount: 0, levelOneDomains: new Set() };
    value.tableCount += 1;
    if (stringValue(table.domain1)) value.levelOneDomains.add(stringValue(table.domain1));
    domains.set(key, value);
  });
  const manifest = {
    schemaVersion: 1,
    id,
    createdAt,
    tableCount: tables.length,
    relationshipCount: relations.length,
    domains: [...domains.values()].map((domain) => ({
      name: domain.name,
      tableCount: domain.tableCount,
      levelOneDomains: [...domain.levelOneDomains].sort((a, b) => a.localeCompare(b, "zh-CN")),
    })).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    tables: tables.map((table) => ({
      tableName: table.tableName,
      description: stringValue(table.description),
      domain0: stringValue(table.domain0, "未归类"),
      domain1: stringValue(table.domain1),
      columnCount: Array.isArray(table.columns) ? table.columns.length : 0,
      file: path.posix.join("tables", tableFileName(table.tableName)),
    })),
  };
  return { manifest, relationIndex: { schemaVersion: 1, datasetId: id, relations, byTable } };
}

export class AtlasStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.sessionsDir = path.join(rootDir, "sessions");
    this.jobsDir = path.join(rootDir, "jobs");
    this.datasetsDir = path.join(rootDir, "datasets");
    this.sessionIndexPath = path.join(this.sessionsDir, "index.json");
    this.jobIndexPath = path.join(this.jobsDir, "index.json");
    this.currentDatasetPath = path.join(this.datasetsDir, "current.json");
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await Promise.all([
      mkdir(this.sessionsDir, { recursive: true }),
      mkdir(this.jobsDir, { recursive: true }),
      mkdir(this.datasetsDir, { recursive: true }),
    ]);
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
  datasetPath(id) { return path.join(this.datasetsDir, safeDatasetId(id)); }

  async syncDataset(rawTables) {
    if (!Array.isArray(rawTables)) throw new Error("数据集必须是表数组");
    const tables = [...rawTables].sort((a, b) => String(a.tableName).localeCompare(String(b.tableName)));
    const names = new Set();
    tables.forEach((table) => {
      const name = stringValue(table?.tableName);
      if (!name || !Array.isArray(table?.columns)) throw new Error("数据集中存在无效表结构");
      if (names.has(name)) throw new Error(`数据集中存在重复表名：${name}`);
      names.add(name);
    });
    const id = createHash("sha256").update(canonicalJson(tables)).digest("hex");
    return this.serialize(async () => {
      const datasetDir = this.datasetPath(id);
      const manifestPath = path.join(datasetDir, "manifest.json");
      let manifest = await this.readJson(manifestPath, null);
      if (!manifest) {
        const createdAt = new Date().toISOString();
        const artifacts = datasetArtifacts(tables, id, createdAt);
        await mkdir(path.join(datasetDir, "tables"), { recursive: true });
        await Promise.all(tables.map((table) => this.atomicWrite(
          path.join(datasetDir, "tables", tableFileName(table.tableName)),
          table,
        )));
        await this.atomicWrite(path.join(datasetDir, "relation-index.json"), artifacts.relationIndex);
        await this.atomicWrite(manifestPath, artifacts.manifest);
        manifest = artifacts.manifest;
      }
      await this.atomicWrite(this.currentDatasetPath, {
        datasetId: id,
        syncedAt: new Date().toISOString(),
        tableCount: manifest.tableCount,
        relationshipCount: manifest.relationshipCount,
      });
      return manifest;
    });
  }

  async readDatasetContext(datasetId, tableName) {
    const datasetDir = this.datasetPath(datasetId);
    const manifest = await this.readDatasetManifest(datasetId);
    const relationIndex = await this.readJson(path.join(datasetDir, "relation-index.json"), null);
    if (!relationIndex) throw new Error("数据集关系索引不存在，请重新同步导入表");
    const current = manifest.tables.find((table) => table.tableName === tableName);
    if (!current) throw new Error(`数据集快照中没有当前表：${tableName}`);
    const tableContext = relationIndex.byTable?.[tableName] ?? {
      foreignKeys: [], referencedBy: [], selfReferences: [], relatedTables: [],
    };
    const entryByName = new Map(manifest.tables.map((table) => [table.tableName, table]));
    const withAbsolutePath = (entry) => ({
      ...entry,
      path: path.join(datasetDir, ...entry.file.split("/")),
    });
    const relatedTables = tableContext.relatedTables
      .map((name) => entryByName.get(name))
      .filter(Boolean)
      .map(withAbsolutePath);
    const domainTables = manifest.tables
      .filter((entry) => entry.domain0 === current.domain0 && entry.tableName !== tableName)
      .map(withAbsolutePath);
    return {
      schemaVersion: 1,
      datasetId: manifest.id,
      datasetDir,
      manifestPath: path.join(datasetDir, "manifest.json"),
      relationIndexPath: path.join(datasetDir, "relation-index.json"),
      currentTable: withAbsolutePath(current),
      relatedTables,
      domainTables,
      relationships: tableContext,
    };
  }

  async readDatasetManifest(datasetId) {
    const datasetDir = this.datasetPath(datasetId);
    const manifest = await this.readJson(path.join(datasetDir, "manifest.json"), null);
    if (!manifest) throw new Error("数据集快照不存在，请重新同步导入表");
    return manifest;
  }

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
        datasetId: session.datasetId ?? null,
        relatedTableCount: session.relatedTableCount ?? 0,
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

  async createSession({ table, jobId = null, datasetId = null, referencePaths = [], promptTemplate = "" }) {
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
      datasetId,
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
        datasetId: job.datasetId ?? null,
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

  async createJob({ label, scope, tables, datasetId, referencePaths, promptTemplate, batchInstruction }) {
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
      datasetId,
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
