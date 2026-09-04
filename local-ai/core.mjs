import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
    enumValues: normalizeEnumValues(source.enumValues),
    enumRef: stringValue(source.enumRef),
    enumDescription: stringValue(source.enumDescription),
  };
}

function normalizeEnumValues(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !stringValue(entry.value)) return [];
    const description = stringValue(entry.description);
    const legacyEnglish = stringValue(entry.descriptionEn ?? entry.description_en);
    const combinedDescription = legacyEnglish && !description.includes(legacyEnglish)
      ? `${description}${description && !/[。！？.!?]$/.test(description) ? "。" : ""}${legacyEnglish}`
      : description || legacyEnglish;
    return [{
      value: stringValue(entry.value),
      description: combinedDescription,
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
        confidence: { type: "string" },
        columns: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "name", "included", "entityColumn", "aliases", "detailedDescription",
              "enumValues", "enumRef", "enumDescription", "confidence", "analysisSummary", "reason",
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
              enumValues: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["value", "description", "aliases"],
                  properties: {
                    value: { type: "string" },
                    description: { type: "string" },
                    aliases: { type: "array", items: { type: "string" } },
                  },
                },
              },
              enumRef: { type: "string" },
              enumDescription: { type: "string" },
              confidence: { type: "string" },
              analysisSummary: { type: "string" },
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
          scope: { type: "string" },
          fieldName: { type: "string" },
          question: { type: "string" },
          reason: { type: "string" },
          checkedSources: { type: "array", items: { type: "string" } },
          suggestions: { type: "array", items: { type: "string" } },
          blocking: { type: "boolean" },
        },
      },
    },
  },
};

function normalizeColumnDraft(value, column, { allowManualFlags = false } = {}) {
  const fallback = currentAnnotation(column);
  const source = value && typeof value === "object" ? value : {};
  return {
    name: column.name,
    included: boolValue(source.included, fallback.included),
    entityColumn: stringValue(source.entityColumn, fallback.entityColumn),
    aliases: stringArray(source.aliases),
    detailedDescription: stringValue(source.detailedDescription, fallback.detailedDescription),
    isLocalId: allowManualFlags ? boolValue(source.isLocalId, fallback.isLocalId) : fallback.isLocalId,
    isDisplayName: allowManualFlags ? boolValue(source.isDisplayName, fallback.isDisplayName) : fallback.isDisplayName,
    isSemantic: allowManualFlags ? boolValue(source.isSemantic, fallback.isSemantic) : fallback.isSemantic,
    isCode: allowManualFlags ? boolValue(source.isCode, fallback.isCode) : fallback.isCode,
    enumValues: normalizeEnumValues(source.enumValues),
    enumRef: stringValue(source.enumRef, fallback.enumRef),
    enumDescription: stringValue(source.enumDescription, fallback.enumDescription),
    confidence: CONFIDENCE_LEVELS.has(source.confidence) ? source.confidence : "medium",
    analysisSummary: stringValue(source.analysisSummary, stringValue(source.reason)),
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

function systemMessage(content, at) {
  return { id: randomUUID(), role: "system", content, at };
}

function dismissTodo(todo, reason, at) {
  if (todo.status !== "open") return todo;
  return {
    ...todo,
    status: "dismissed",
    dismissedReason: reason,
    dismissedAt: at,
  };
}

function restoreTodo(todo, at) {
  if (todo.status !== "dismissed") return todo;
  const restored = {
    ...todo,
    status: "open",
    answer: "",
    answeredAt: null,
    restoredAt: at,
    lastDismissedAt: todo.dismissedAt ?? null,
    lastDismissedReason: todo.dismissedReason ?? null,
  };
  delete restored.dismissedAt;
  delete restored.dismissedReason;
  return restored;
}

function uniqueNames(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(stringValue).filter(Boolean))];
}

function markSessionStale(session, reason, at) {
  if (session.status !== "stale") session.stalePreviousStatus = session.status;
  session.status = "stale";
  session.staleReason = reason;
  session.staleAt = at;
}

/**
 * Reconcile one historical AI Session with the latest imported table structure.
 * The transcript is never deleted. Only open work that points at a deleted
 * object is dismissed, while restored/new structure makes the old draft stale.
 */
export function reconcileSessionWithTables(value, rawTables, at = new Date().toISOString()) {
  const session = value && typeof value === "object" ? value : {};
  const tables = Array.isArray(rawTables) ? rawTables : [];
  const table = tables.find((item) => stringValue(item?.tableName) === stringValue(session.tableName));
  const next = {
    ...session,
    messages: Array.isArray(session.messages) ? [...session.messages] : [],
    todos: Array.isArray(session.todos) ? session.todos.map((todo) => ({ ...todo })) : [],
    draft: session.draft && typeof session.draft === "object"
      ? { ...session.draft, columns: Array.isArray(session.draft.columns) ? [...session.draft.columns] : [] }
      : session.draft ?? null,
  };
  let changed = false;
  let draftChanged = false;

  if (!table) {
    const dismissedCount = next.todos.filter((todo) => todo.status === "open").length;
    if (dismissedCount > 0) {
      next.todos = next.todos.map((todo) => dismissTodo(todo, "table_deleted", at));
      changed = true;
    }
    const transitioned = next.status !== "stale" || next.staleReason !== "table_deleted";
    if (transitioned) {
      markSessionStale(next, "table_deleted", at);
      next.messages.push(systemMessage(
        `表 ${session.tableName} 已从当前数据集中删除；此 Session 已移出待审核和待澄清队列，完整对话与旧草稿仍保留。`,
        at,
      ));
      changed = true;
    }
    return { session: next, changed, draftChanged, tableDeleted: transitioned, removedFields: [] };
  }

  const currentColumns = Array.isArray(table.columns) ? table.columns : [];
  const currentNames = new Map(currentColumns.map((column) => [stringValue(column?.name).toUpperCase(), stringValue(column?.name)]));
  const wasTableDeleted = session.staleReason === "table_deleted";
  const restorableTodos = next.todos.filter((todo) => {
    if (todo.status !== "dismissed") return false;
    if (todo.dismissedReason === "table_deleted") {
      return todo.scope !== "field" || currentNames.has(stringValue(todo.fieldName).toUpperCase());
    }
    return todo.dismissedReason === "field_deleted"
      && todo.scope === "field"
      && currentNames.has(stringValue(todo.fieldName).toUpperCase());
  });
  const restorableTodoIds = new Set(restorableTodos.map((todo) => todo.id));
  const restoredTodoFields = uniqueNames(restorableTodos
    .filter((todo) => todo.scope === "field")
    .map((todo) => todo.fieldName));
  if (restorableTodos.length > 0) {
    next.todos = next.todos.map((todo) => restorableTodoIds.has(todo.id) ? restoreTodo(todo, at) : todo);
    changed = true;
  }
  const orphanedTableDeletedTodos = next.todos.filter((todo) => todo.status === "dismissed"
    && todo.dismissedReason === "table_deleted"
    && todo.scope === "field"
    && !currentNames.has(stringValue(todo.fieldName).toUpperCase()));
  if (orphanedTableDeletedTodos.length > 0) {
    const orphanedIds = new Set(orphanedTableDeletedTodos.map((todo) => todo.id));
    next.todos = next.todos.map((todo) => orphanedIds.has(todo.id)
      ? { ...todo, dismissedReason: "field_deleted" }
      : todo);
    changed = true;
  }
  let restorationMessageCovered = false;
  if (wasTableDeleted) {
    markSessionStale(next, "table_restored_requires_review", at);
    next.messages.push(systemMessage(
      `表 ${session.tableName} 已恢复到当前数据集；${restorableTodos.length > 0 ? `${restorableTodos.length} 个仍适用的待澄清项已重新放回队列，` : ""}此 Session 基于删除前结构，请继续重新核对或人工保存当前结构后再应用。`,
      at,
    ));
    restorationMessageCovered = true;
    changed = true;
  }

  const draftColumns = Array.isArray(next.draft?.columns) ? next.draft.columns : [];
  const draftNames = new Map(draftColumns.map((column) => [stringValue(column?.name).toUpperCase(), stringValue(column?.name)]));
  const removedFields = draftColumns
    .filter((column) => !currentNames.has(stringValue(column?.name).toUpperCase()))
    .map((column) => stringValue(column?.name))
    .filter(Boolean);
  const missingTodoFields = next.todos
    .filter((todo) => todo.status === "open" && todo.scope === "field" && todo.fieldName
      && !currentNames.has(stringValue(todo.fieldName).toUpperCase()))
    .map((todo) => stringValue(todo.fieldName));
  const previouslyRemovedNames = uniqueNames([
    ...(session.removedFieldNames ?? []),
    ...session.todos
      .filter((todo) => todo.status === "dismissed" && todo.dismissedReason === "field_deleted")
      .map((todo) => todo.fieldName),
  ]);
  const newlyRemoved = uniqueNames([...removedFields, ...missingTodoFields])
    .filter((name) => !previouslyRemovedNames.includes(name));

  if (removedFields.length > 0) {
    next.draft = {
      ...next.draft,
      columns: draftColumns.filter((column) => currentNames.has(stringValue(column?.name).toUpperCase())),
    };
    draftChanged = true;
    changed = true;
  }
  if (missingTodoFields.length > 0) {
    next.todos = next.todos.map((todo) => (
      todo.scope === "field" && todo.fieldName && !currentNames.has(stringValue(todo.fieldName).toUpperCase())
        ? dismissTodo(todo, "field_deleted", at)
        : todo
    ));
    changed = true;
  }
  if (newlyRemoved.length > 0) {
    next.removedFieldNames = uniqueNames([...(session.removedFieldNames ?? []), ...newlyRemoved]);
    next.structureChangedAt = at;
    next.messages.push(systemMessage(
      `字段 ${newlyRemoved.join("、")} 已从当前表结构删除；对应草稿项与待澄清项已失效，同表其他标注保持不变。`,
      at,
    ));
    changed = true;
  }

  const addedColumns = next.draft
    ? currentColumns.filter((column) => !draftNames.has(stringValue(column?.name).toUpperCase()))
    : [];
  const addedFields = addedColumns.map((column) => stringValue(column?.name)).filter(Boolean);
  if (addedFields.length > 0) {
    const previouslyRemoved = new Set(previouslyRemovedNames.map((name) => name.toUpperCase()));
    const restoredFields = addedFields.filter((name) => previouslyRemoved.has(name.toUpperCase()));
    const nextReason = restoredFields.length > 0
      ? "fields_restored_requires_review"
      : "fields_added_requires_review";
    if (!wasTableDeleted) markSessionStale(next, nextReason, at);
    next.restoredFieldNames = uniqueNames([...(session.restoredFieldNames ?? []), ...addedFields]);
    next.removedFieldNames = previouslyRemovedNames
      .filter((name) => !restoredFields.some((restored) => restored.toUpperCase() === name.toUpperCase()));
    next.draft = {
      ...next.draft,
      columns: [...next.draft.columns, ...addedColumns.map((column) => normalizeColumnDraft({}, column, { allowManualFlags: true }))],
    };
    draftChanged = true;
    if (!wasTableDeleted) {
      next.messages.push(systemMessage(
        `${restoredFields.length > 0 ? "已恢复" : "已新增"}字段 ${addedFields.join("、")}；已按当前表结构补入草稿${restorableTodos.length > 0 ? `，并将 ${restorableTodos.length} 个相关待澄清项重新放回队列` : ""}，继续原 Session 重新核对或人工保存后才可应用。`,
        at,
      ));
      restorationMessageCovered = true;
    }
    changed = true;
  }

  if (restorableTodos.length > 0 && !restorationMessageCovered) {
    if (!next.staleReason) {
      markSessionStale(
        next,
        restorableTodos.some((todo) => todo.dismissedReason === "table_deleted")
          ? "table_restored_requires_review"
          : "fields_restored_requires_review",
        at,
      );
    }
    next.restoredFieldNames = uniqueNames([...(next.restoredFieldNames ?? []), ...restoredTodoFields]);
    next.messages.push(systemMessage(
      `已将 ${restorableTodos.length} 个因表或字段删除而暂停的待澄清项重新放回队列，请结合当前结构继续处理。`,
      at,
    ));
    changed = true;
  }

  if (["needs_clarification", "draft_ready"].includes(next.status)) {
    const nextStatus = next.todos.some((todo) => todo.status === "open" && todo.blocking)
      ? "needs_clarification"
      : next.draft ? "draft_ready" : "idle";
    if (nextStatus !== next.status) {
      next.status = nextStatus;
      changed = true;
    }
  }

  return { session: next, changed, draftChanged, tableDeleted: false, removedFields: newlyRemoved };
}

export function clearSessionStructureState(session) {
  delete session.staleReason;
  delete session.staleAt;
  delete session.stalePreviousStatus;
  delete session.removedFieldNames;
  delete session.restoredFieldNames;
  delete session.structureChangedAt;
  return session;
}

export function normalizeStructuredOutput(value, table, sessionId, options = {}) {
  const source = value && typeof value === "object" ? value : {};
  const rawDraft = source.draft && typeof source.draft === "object" ? source.draft : {};
  const rawColumns = new Map(
    (Array.isArray(rawDraft.columns) ? rawDraft.columns : [])
      .filter((column) => column && typeof column === "object")
      .map((column) => [stringValue(column.name).toUpperCase(), column]),
  );
  const columns = (Array.isArray(table.columns) ? table.columns : []).map((column) =>
    normalizeColumnDraft(rawColumns.get(String(column.name).toUpperCase()), column, options));
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

function traceDetail(value, limit = 12_000) {
  let text;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value, null, 2); }
    catch { text = String(value ?? ""); }
  }
  const normalized = String(text ?? "").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}\n…内容过长，已截断显示` : normalized;
}

function resultMetadata(event) {
  const copy = { ...event };
  delete copy.structured_output;
  if (copy.result && typeof copy.result === "object") delete copy.result;
  return copy;
}

export function buildSessionTrace(records) {
  const tools = new Map();
  return records.flatMap((record, recordIndex) => {
    const event = record?.event && typeof record.event === "object" ? record.event : {};
    const at = stringValue(record?.at, new Date(0).toISOString());
    const entries = [];
    const push = (kind, label, detail = "") => entries.push({
      id: `${recordIndex}-${entries.length}`,
      kind,
      label,
      detail: traceDetail(detail),
      at,
    });

    if (event.type === "system" && event.subtype === "init") {
      push("system", "Claude Code 会话初始化", resultMetadata(event));
      return entries;
    }

    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    content.forEach((block) => {
      if (!block || typeof block !== "object") return;
      if (block.type === "text" && stringValue(block.text)) {
        push("assistant", "Claude Code 中间说明", block.text);
      } else if (block.type === "tool_use") {
        const name = stringValue(block.name, "工具");
        if (block.id) tools.set(block.id, name);
        push("tool_use", `调用 ${name}`, block.input ?? {});
      } else if (block.type === "tool_result") {
        const name = tools.get(block.tool_use_id) || "工具";
        push(block.is_error ? "error" : "tool_result", `${name} ${block.is_error ? "执行失败" : "返回结果"}`, block.content ?? "");
      }
    });

    if (event.type === "result") {
      push(event.is_error ? "error" : "result", event.is_error ? "本轮执行失败" : "本轮执行完成", resultMetadata(event));
    } else if (event.type === "unparsed") {
      push("raw", "未解析的 Claude Code 输出", event.text ?? event);
    } else if (entries.length === 0 && !["assistant", "user"].includes(event.type)) {
      push("raw", `Claude Code 事件 · ${stringValue(event.type, "unknown")}`, event);
    }
    return entries;
  });
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

function validSharedTable(value) {
  return value && typeof value === "object" && stringValue(value.tableName) && Array.isArray(value.columns);
}

function normalizeSharedTables(value) {
  if (!Array.isArray(value) || !value.every(validSharedTable)) throw new Error("共享工作区包含无效表结构");
  const names = new Set();
  return [...value].map((table) => {
    const name = stringValue(table.tableName);
    if (names.has(name)) throw new Error(`共享工作区存在重复表名：${name}`);
    names.add(name);
    return table;
  }).sort((left, right) => String(left.tableName).localeCompare(String(right.tableName)));
}

function normalizeChangeHistory(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawTables = source.tables && typeof source.tables === "object" && !Array.isArray(source.tables)
    ? source.tables
    : {};
  const tables = {};
  Object.entries(rawTables).forEach(([tableName, records]) => {
    if (!Array.isArray(records)) return;
    const seen = new Set();
    tables[tableName] = records.filter((record) => {
      if (!record || typeof record !== "object" || !stringValue(record.id) || seen.has(record.id)) return false;
      seen.add(record.id);
      return true;
    }).slice(0, 1000);
  });
  return { version: 2, tables };
}

function mergeChangeHistory(currentValue, incomingValue) {
  const current = normalizeChangeHistory(currentValue);
  const incoming = normalizeChangeHistory(incomingValue);
  const names = new Set([...Object.keys(current.tables), ...Object.keys(incoming.tables)]);
  const tables = {};
  names.forEach((tableName) => {
    const records = [...(current.tables[tableName] ?? []), ...(incoming.tables[tableName] ?? [])];
    const byId = new Map();
    records.forEach((record) => {
      if (!byId.has(record.id)) byId.set(record.id, record);
    });
    const merged = [...byId.values()]
      .sort((left, right) => String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? "")))
      .slice(0, 1000);
    if (merged.length) tables[tableName] = merged;
  });
  return { version: 2, tables };
}

function normalizeSharedPreferences(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    referenceText: typeof source.referenceText === "string" ? source.referenceText : "",
    promptTemplate: typeof source.promptTemplate === "string" ? source.promptTemplate : "",
    batchInstruction: typeof source.batchInstruction === "string" ? source.batchInstruction : "",
  };
}

function emptySharedWorkspace() {
  return {
    schemaVersion: 1,
    data: {
      initialized: false,
      revision: 0,
      updatedAt: null,
      tables: [],
      changeHistory: { version: 2, tables: {} },
      tableRevisions: {},
    },
    preferences: {
      initialized: false,
      revision: 0,
      updatedAt: null,
      ...normalizeSharedPreferences({}),
    },
  };
}

function normalizeSharedWorkspace(value) {
  const fallback = emptySharedWorkspace();
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const data = value.data && typeof value.data === "object" && !Array.isArray(value.data) ? value.data : {};
  const preferences = value.preferences && typeof value.preferences === "object" && !Array.isArray(value.preferences)
    ? value.preferences
    : {};
  const initializedData = data.initialized === true;
  const initializedPreferences = preferences.initialized === true;
  return {
    schemaVersion: 1,
    data: {
      initialized: initializedData,
      revision: initializedData && Number.isInteger(data.revision) && data.revision > 0 ? data.revision : 0,
      updatedAt: initializedData && typeof data.updatedAt === "string" ? data.updatedAt : null,
      tables: initializedData ? normalizeSharedTables(data.tables) : [],
      changeHistory: initializedData ? normalizeChangeHistory(data.changeHistory) : fallback.data.changeHistory,
      tableRevisions: initializedData && data.tableRevisions && typeof data.tableRevisions === "object" && !Array.isArray(data.tableRevisions)
        ? Object.fromEntries(Object.entries(data.tableRevisions).flatMap(([name, revision]) => Number.isInteger(revision) && revision > 0 ? [[name, revision]] : []))
        : {},
    },
    preferences: {
      initialized: initializedPreferences,
      revision: initializedPreferences && Number.isInteger(preferences.revision) && preferences.revision > 0 ? preferences.revision : 0,
      updatedAt: initializedPreferences && typeof preferences.updatedAt === "string" ? preferences.updatedAt : null,
      ...normalizeSharedPreferences(preferences),
    },
  };
}

function publicSharedData(data) {
  const visible = { ...data };
  delete visible.tableRevisions;
  return visible;
}

export class SharedWorkspaceConflictError extends Error {
  constructor(message, workspace, conflicts = []) {
    super(message);
    this.name = "SharedWorkspaceConflictError";
    this.statusCode = 409;
    this.workspace = workspace;
    this.conflicts = conflicts;
  }
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
    this.sharedWorkspacePath = path.join(rootDir, "shared-workspace.json");
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

  async readSharedWorkspace() {
    return normalizeSharedWorkspace(await this.readJson(this.sharedWorkspacePath, null));
  }

  async readSharedData() {
    return publicSharedData((await this.readSharedWorkspace()).data);
  }

  async readSharedPreferences() {
    return (await this.readSharedWorkspace()).preferences;
  }

  async updateSharedData({ baseRevision = 0, tables: rawTables, changeHistory, changedTableNames = [] }) {
    const incomingTables = normalizeSharedTables(rawTables);
    const requestedNames = [...new Set((Array.isArray(changedTableNames) ? changedTableNames : [])
      .map((name) => stringValue(name)).filter(Boolean))];
    return this.serialize(async () => {
      const workspace = await this.readSharedWorkspace();
      const current = workspace.data;
      const initialized = current.initialized;
      const nextRevision = initialized ? current.revision + 1 : 1;
      const names = initialized ? requestedNames : incomingTables.map((table) => table.tableName);
      if (initialized && (!Number.isInteger(baseRevision) || baseRevision < 1 || baseRevision > current.revision)) {
        throw new SharedWorkspaceConflictError("共享工作区版本无效，请重新载入", publicSharedData(current));
      }
      const conflicts = initialized
        ? names.filter((name) => Number(current.tableRevisions[name] ?? 0) > baseRevision)
        : [];
      if (conflicts.length) {
        throw new SharedWorkspaceConflictError(
          `以下表已被其他用户修改：${conflicts.join("、")}`,
          publicSharedData(current),
          conflicts,
        );
      }
      const incomingByName = new Map(incomingTables.map((table) => [table.tableName, table]));
      const mergedByName = new Map((initialized ? current.tables : []).map((table) => [table.tableName, table]));
      names.forEach((name) => {
        if (incomingByName.has(name)) mergedByName.set(name, incomingByName.get(name));
        else mergedByName.delete(name);
      });
      const now = new Date().toISOString();
      const nextData = {
        initialized: true,
        revision: nextRevision,
        updatedAt: now,
        tables: [...mergedByName.values()].sort((left, right) => String(left.tableName).localeCompare(String(right.tableName))),
        changeHistory: initialized
          ? mergeChangeHistory(current.changeHistory, changeHistory)
          : normalizeChangeHistory(changeHistory),
        tableRevisions: { ...(initialized ? current.tableRevisions : {}) },
      };
      names.forEach((name) => { nextData.tableRevisions[name] = nextRevision; });
      workspace.data = nextData;
      await this.atomicWrite(this.sharedWorkspacePath, workspace);
      return publicSharedData(nextData);
    });
  }

  async updateSharedPreferences({ baseRevision = 0, preferences: rawPreferences }) {
    const nextPreferences = normalizeSharedPreferences(rawPreferences);
    return this.serialize(async () => {
      const workspace = await this.readSharedWorkspace();
      const current = workspace.preferences;
      if (current.initialized && baseRevision !== current.revision) {
        throw new SharedWorkspaceConflictError("共享生成配置已被其他用户修改，请重新载入", current);
      }
      const next = {
        initialized: true,
        revision: current.initialized ? current.revision + 1 : 1,
        updatedAt: new Date().toISOString(),
        ...nextPreferences,
      };
      workspace.preferences = next;
      await this.atomicWrite(this.sharedWorkspacePath, workspace);
      return next;
    });
  }

  async syncDataset(rawTables, { skipSessionIds = [] } = {}) {
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
    const manifest = await this.serialize(async () => {
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
    const reconciliation = await this.reconcileSessions(tables, { skipSessionIds });
    return { ...manifest, reconciliation };
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
        staleReason: session.staleReason ?? null,
        staleAt: session.staleAt ?? null,
        removedFieldNames: uniqueNames(session.removedFieldNames),
        restoredFieldNames: uniqueNames(session.restoredFieldNames),
        structureChangedAt: session.structureChangedAt ?? null,
        error: session.error ?? null,
      };
      const next = [summary, ...index.filter((item) => item.id !== session.id)]
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      await this.atomicWrite(this.sessionIndexPath, next);
      return session;
    });
  }

  async reconcileSessions(tables, { skipSessionIds = [], onlySessionIds = [] } = {}) {
    const skipped = new Set(skipSessionIds);
    const limited = new Set(onlySessionIds);
    const summaries = await this.listSessions();
    const result = { updatedSessions: 0, deletedTables: 0, removedFields: 0, skippedSessions: 0 };
    for (const summary of summaries) {
      if (limited.size > 0 && !limited.has(summary.id)) continue;
      if (skipped.has(summary.id) || ["queued", "running", "cancelling"].includes(summary.status)) {
        result.skippedSessions += 1;
        continue;
      }
      const session = await this.readSession(summary.id);
      if (!session) continue;
      const reconciled = reconcileSessionWithTables(session, tables);
      if (!reconciled.changed) continue;
      await this.saveSession(reconciled.session);
      if (reconciled.draftChanged && reconciled.session.draft) {
        await this.atomicWrite(
          path.join(this.workspacePath(reconciled.session.id), "current-draft.json"),
          reconciled.session.draft,
        );
      }
      result.updatedSessions += 1;
      if (reconciled.tableDeleted) result.deletedTables += 1;
      result.removedFields += reconciled.removedFields.length;
    }
    return result;
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

  async readSessionTrace(id) {
    let content = "";
    try { content = await readFile(this.transcriptPath(id), "utf8"); }
    catch { return []; }
    const records = content.split("\n").flatMap((line) => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; }
      catch { return [{ at: new Date(0).toISOString(), event: { type: "unparsed", text: line } }]; }
    });
    return buildSessionTrace(records);
  }

  async deleteSessions(values) {
    const ids = [...new Set((Array.isArray(values) ? values : []).map(safeId))];
    return this.serialize(async () => {
      await Promise.all(ids.flatMap((id) => [
        rm(this.sessionPath(id), { force: true }),
        rm(this.transcriptPath(id), { force: true }),
        rm(this.workspacePath(id), { recursive: true, force: true }),
      ]));
      const index = await this.readJson(this.sessionIndexPath, []);
      await this.atomicWrite(this.sessionIndexPath, index.filter((item) => !ids.includes(item.id)));
      return ids;
    });
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
