import type { ColumnAnnotation, SchemaTable } from "./data";
import { migrateColumn } from "./schema-utils";
import type { AiTableDraft } from "./ai-types";

export function mergeAiDraftIntoTable(table: SchemaTable, draft: AiTableDraft): SchemaTable {
  if (table.tableName !== draft.tableName) throw new Error("AI 草稿与当前表不匹配");
  const annotations = new Map(draft.columns.map((column) => [column.name.toUpperCase(), column]));
  return {
    ...table,
    className: draft.className.trim() || table.className,
    classDescription: draft.classDescription.trim() || table.classDescription || table.description,
    classAliases: [...new Set(draft.classAliases.map((item) => item.trim()).filter(Boolean))],
    columns: table.columns.map((column) => {
      const proposed = annotations.get(column.name.toUpperCase());
      if (!proposed) return column;
      const annotation: ColumnAnnotation = {
        included: proposed.included,
        entityColumn: proposed.entityColumn.trim(),
        aliases: [...new Set(proposed.aliases.map((item) => item.trim()).filter(Boolean))],
        detailedDescription: proposed.detailedDescription.trim(),
        isLocalId: proposed.isLocalId,
        isDisplayName: proposed.isDisplayName,
        isSemantic: proposed.isSemantic,
        isCode: proposed.isCode,
        semanticRole: proposed.semanticRole,
        tags: [...new Set(proposed.tags.map((item) => item.trim()).filter(Boolean))],
        unit: proposed.unit.trim(),
        enumValues: proposed.enumValues.map((item) => ({
          value: item.value.trim(),
          description: item.description.trim(),
          descriptionEn: item.descriptionEn.trim(),
          aliases: [...new Set(item.aliases.map((alias) => alias.trim()).filter(Boolean))],
        })).filter((item) => item.value),
        valueRange: proposed.valueRange.trim(),
        sensitivity: proposed.sensitivity,
        enumRef: proposed.enumRef.trim(),
        enumDescription: proposed.enumDescription.trim(),
      };
      return migrateColumn({ ...column, annotation });
    }),
  };
}

export function summarizeAiDraft(table: SchemaTable, draft: AiTableDraft) {
  const next = mergeAiDraftIntoTable(table, draft);
  const changedFields = table.columns.reduce((count, column, index) => {
    const before = migrateColumn(column).annotation;
    const after = migrateColumn(next.columns[index]).annotation;
    return count + (JSON.stringify(before) === JSON.stringify(after) ? 0 : 1);
  }, 0);
  return {
    classChanged: table.className !== next.className
      || table.classDescription !== next.classDescription
      || JSON.stringify(table.classAliases) !== JSON.stringify(next.classAliases),
    changedFields,
    includedFields: next.columns.filter((column) => migrateColumn(column).annotation!.included).length,
    lowConfidenceFields: draft.columns.filter((column) => column.confidence === "low").length,
  };
}
