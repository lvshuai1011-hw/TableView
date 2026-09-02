"use client";

import { useEffect, useState } from "react";

import { ClaudeAssistantPanel } from "./claude-assistant-panel";
import type { AiAnnotationProposal } from "./ai-types";
import type { ColumnAnnotation, SchemaTable } from "./data";
import { migrateColumn, migrateTables } from "./schema-utils";

const TABLE_STORAGE_KEY = "schema-atlas.tables.v1";

function readTables(): SchemaTable[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(TABLE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? migrateTables(parsed as SchemaTable[]) : [];
  } catch {
    return [];
  }
}

function mergeAnnotation(current: ColumnAnnotation, patch: Partial<ColumnAnnotation>): ColumnAnnotation {
  return {
    ...current,
    ...patch,
    aliases: Array.isArray(patch.aliases) ? patch.aliases : current.aliases,
    tags: Array.isArray(patch.tags) ? patch.tags : current.tags,
    enumValues: Array.isArray(patch.enumValues) ? patch.enumValues : current.enumValues,
  };
}

function applyProposal(tables: SchemaTable[], proposal: AiAnnotationProposal) {
  const patches = new Map(proposal.tablePatches.map((patch) => [patch.tableName, patch]));
  return migrateTables(tables.map((table) => {
    const patch = patches.get(table.tableName);
    if (!patch) return table;
    const columnPatches = new Map(patch.columnPatches.map((column) => [column.columnName, column]));
    return {
      ...table,
      className: patch.className?.trim() || table.className,
      classDescription: patch.classDescription !== undefined ? patch.classDescription.trim() : table.classDescription,
      classAliases: Array.isArray(patch.classAliases) ? patch.classAliases : table.classAliases,
      columns: table.columns.map((column) => {
        const columnPatch = columnPatches.get(column.name);
        if (!columnPatch) return column;
        const migrated = migrateColumn(column);
        return {
          ...migrated,
          annotation: mergeAnnotation(migrated.annotation!, columnPatch.annotation),
        };
      }),
    };
  }));
}

export function ClaudeAssistantHost() {
  const [tables, setTables] = useState<SchemaTable[]>([]);

  useEffect(() => {
    const sync = () => setTables(readTables());
    sync();
    const timer = window.setInterval(sync, 1200);
    window.addEventListener("focus", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const apply = (proposal: AiAnnotationProposal) => {
    const current = readTables();
    if (!current.length) return;
    const next = applyProposal(current, proposal);
    window.localStorage.setItem(TABLE_STORAGE_KEY, JSON.stringify(next));
    window.localStorage.setItem("schema-atlas.ai.last-applied.v1", JSON.stringify({
      appliedAt: new Date().toISOString(),
      proposal,
    }));
    window.location.reload();
  };

  return <ClaudeAssistantPanel tables={tables} onApplyProposal={apply} />;
}
