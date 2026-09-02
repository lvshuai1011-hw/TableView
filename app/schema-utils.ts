import {
  Column,
  ColumnAnnotation,
  EnumValue,
  ExportDataType,
  Relationship,
  ROOT_FOLDER,
  SchemaTable,
  SemanticRole,
  Sensitivity,
  UNCLASSIFIED,
} from "./data";

export const CHANGE_LOG_STORAGE_KEY = "schema-atlas.change-log.v2";
export const LEGACY_CHANGE_LOG_STORAGE_KEY = "schema-atlas.change-log.v1";

const PLACEHOLDER_FOLDERS = new Set(["", ROOT_FOLDER.toUpperCase(), "DIAGRAM 1", "DIAGRAM_1", "DIAGRAM-1"]);

export function normalizeDomain1(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return PLACEHOLDER_FOLDERS.has(normalized.toUpperCase()) ? "" : normalized;
}

export function toPascalCase(value: string) {
  return value
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join("");
}

export function defaultClassName(tableName: string) {
  const parts = tableName.split("_").filter(Boolean);
  if (parts.length > 1 && parts[0].length <= 3) parts.shift();
  return toPascalCase(parts.join("_")) || "UnnamedEntity";
}

export function toCamelCase(value: string) {
  const pascal = toPascalCase(value);
  return pascal ? pascal.charAt(0).toLowerCase() + pascal.slice(1) : "field";
}

export function inferSemanticRole(columnName: string): SemanticRole {
  const name = columnName.toUpperCase();
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

export function createDefaultAnnotation(column: Pick<Column, "name">): ColumnAnnotation {
  return {
    included: true,
    entityColumn: toCamelCase(column.name),
    aliases: [],
    detailedDescription: "",
    isLocalId: false,
    isDisplayName: false,
    isSemantic: false,
    isCode: false,
    semanticRole: inferSemanticRole(column.name),
    tags: [],
    unit: "",
    enumValues: [],
    valueRange: "",
    sensitivity: "none",
    enumRef: "",
    enumDescription: "",
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function enumArray(value: unknown): EnumValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.value !== "string" || !entry.value.trim()) return [];
    return [{
      value: entry.value.trim(),
      description: typeof entry.description === "string" ? entry.description.trim() : "",
      descriptionEn: typeof entry.descriptionEn === "string" ? entry.descriptionEn.trim() : "",
      aliases: stringArray(entry.aliases),
    }];
  });
}

export function migrateColumn(column: Column): Column {
  const defaults = createDefaultAnnotation(column);
  const source = column.annotation as Partial<ColumnAnnotation> | undefined;
  const semanticRoles: SemanticRole[] = ["identifier", "name", "time", "amount", "quantity", "status", "code", "description", "other"];
  const sensitivities: Sensitivity[] = ["none", "internal", "sensitive", "restricted"];
  return {
    ...column,
    annotation: {
      included: typeof source?.included === "boolean" ? source.included : defaults.included,
      entityColumn: typeof source?.entityColumn === "string" && source.entityColumn.trim() ? source.entityColumn.trim() : defaults.entityColumn,
      aliases: stringArray(source?.aliases),
      detailedDescription: typeof source?.detailedDescription === "string" ? source.detailedDescription : "",
      isLocalId: source?.isLocalId === true,
      isDisplayName: source?.isDisplayName === true,
      isSemantic: source?.isSemantic === true,
      isCode: source?.isCode === true,
      semanticRole: semanticRoles.includes(source?.semanticRole as SemanticRole) ? source!.semanticRole as SemanticRole : defaults.semanticRole,
      tags: stringArray(source?.tags),
      unit: typeof source?.unit === "string" ? source.unit.trim() : "",
      enumValues: enumArray(source?.enumValues),
      valueRange: typeof source?.valueRange === "string" ? source.valueRange.trim() : "",
      sensitivity: sensitivities.includes(source?.sensitivity as Sensitivity) ? source!.sensitivity as Sensitivity : "none",
      enumRef: typeof source?.enumRef === "string" ? source.enumRef.trim() : "",
      enumDescription: typeof source?.enumDescription === "string" ? source.enumDescription.trim() : "",
    },
  };
}

export function migrateTables(input: SchemaTable[]) {
  const used = new Set<string>();
  return input.map((table) => {
    const base = typeof table.className === "string" && table.className.trim()
      ? table.className.trim()
      : defaultClassName(table.tableName);
    let className = base;
    let suffix = 2;
    while (used.has(className.toLowerCase())) className = `${base}${suffix++}`;
    used.add(className.toLowerCase());
    const domain1 = normalizeDomain1(table.domain1 || table.folder);
    return {
      ...table,
      className,
      classDescription: typeof table.classDescription === "string" && table.classDescription.trim() ? table.classDescription : table.description,
      classAliases: stringArray(table.classAliases),
      domain0: table.domain0?.trim() || UNCLASSIFIED,
      domain1,
      folder: domain1,
      columns: Array.isArray(table.columns) ? table.columns.map(migrateColumn) : [],
      foreignKeys: Array.isArray(table.foreignKeys) ? table.foreignKeys : [],
      referencedBy: Array.isArray(table.referencedBy) ? table.referencedBy : [],
    };
  });
}

export function mergeImportedTable(existing: SchemaTable | undefined, imported: SchemaTable) {
  if (!existing) return imported;
  const annotations = new Map(existing.columns.map((column) => [column.name, column.annotation]));
  return {
    ...imported,
    className: existing.className,
    classDescription: existing.classDescription,
    classAliases: existing.classAliases,
    columns: imported.columns.map((column) => migrateColumn({ ...column, annotation: annotations.get(column.name) })),
  };
}

export function normalizeExportType(dataType: string): ExportDataType {
  const type = dataType.trim().toUpperCase();
  if (/^(NUMBER|NUMERIC|DECIMAL|DEC|INTEGER|INT|SMALLINT|BIGINT|FLOAT|DOUBLE|REAL|BINARY_FLOAT|BINARY_DOUBLE)/.test(type)) return "number";
  if (/^(VARCHAR|VARCHAR2|NVARCHAR|NVARCHAR2|CHAR|NCHAR|TEXT|CLOB|NCLOB|LONG|STRING|UUID)/.test(type)) return "string";
  if (/^(DATE|DATETIME|TIMESTAMP|TIME)/.test(type)) return "datetime";
  if (/^(BOOLEAN|BOOL|BIT)/.test(type)) return "boolean";
  return "unknown";
}

export function isSelfRelationship(relationship: Relationship) {
  return relationship.parentTable === relationship.childTable;
}

export type RelationFieldState = "ok" | "table-missing" | "field-missing" | "excluded";

export type RelationshipMappingInspection = {
  mapping: Relationship["columnMapping"][number];
  parentState: RelationFieldState;
  childState: RelationFieldState;
};

function relationFieldState(table: SchemaTable | undefined, columnName: string): RelationFieldState {
  if (!table) return "table-missing";
  const column = table.columns.find((item) => item.name === columnName);
  if (!column) return "field-missing";
  return migrateColumn(column).annotation!.included ? "ok" : "excluded";
}

export function inspectRelationshipMappings(
  relationship: Relationship,
  tableIndex: Map<string, SchemaTable>,
): RelationshipMappingInspection[] {
  const parent = tableIndex.get(relationship.parentTable);
  const child = tableIndex.get(relationship.childTable);
  return relationship.columnMapping.map((mapping) => ({
    mapping,
    parentState: relationFieldState(parent, mapping.parentColumn),
    childState: relationFieldState(child, mapping.childColumn),
  }));
}

export function isMissingRelationField(state: RelationFieldState) {
  return state === "table-missing" || state === "field-missing";
}

export function countRelationshipFieldGaps(relationships: Relationship[], tables: SchemaTable[]) {
  const tableIndex = new Map(tables.map((table) => [table.tableName, table]));
  return relationships.reduce((total, relationship) => total + inspectRelationshipMappings(relationship, tableIndex)
    .reduce((count, inspection) => count
      + (isMissingRelationField(inspection.parentState) ? 1 : 0)
      + (isMissingRelationField(inspection.childState) ? 1 : 0), 0), 0);
}

function safeSegment(value: string) {
  const clean = value.trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\.{2,}/g, ".");
  return clean || UNCLASSIFIED;
}

function optionalObject<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (item === "" || item === false || item === undefined || item === null) return false;
    if (Array.isArray(item) && item.length === 0) return false;
    return true;
  }));
}

export type ExportFile = { path: string; content: string };

export function validateExportConfiguration(tables: SchemaTable[]) {
  const errors: string[] = [];
  const classNames = new Map<string, string>();
  const enums = new Map<string, { description: string; values: Map<string, EnumValue> }>();
  tables.forEach((table) => {
    const classKey = table.className.trim().toLowerCase();
    if (!classKey) errors.push(`${table.tableName} 尚未设置类名`);
    else if (classNames.has(classKey)) errors.push(`类名 ${table.className} 同时用于 ${classNames.get(classKey)} 和 ${table.tableName}`);
    else classNames.set(classKey, table.tableName);

    const attributes = new Set<string>();
    table.columns.filter((column) => migrateColumn(column).annotation!.included).forEach((column) => {
      const annotation = migrateColumn(column).annotation!;
      const attributeKey = annotation.entityColumn.trim().toLowerCase();
      if (!attributeKey) errors.push(`${table.tableName}.${column.name} 尚未设置属性名`);
      else if (attributes.has(attributeKey)) errors.push(`${table.className} 中属性名 ${annotation.entityColumn} 重复`);
      else attributes.add(attributeKey);
      if (!annotation.enumRef) return;
      const enumKey = `${table.domain0.toLowerCase()}/${annotation.enumRef.toLowerCase()}`;
      const current = enums.get(enumKey) ?? { description: annotation.enumDescription, values: new Map<string, EnumValue>() };
      if (current.description && annotation.enumDescription && current.description !== annotation.enumDescription) {
        errors.push(`${table.domain0}/${annotation.enumRef} 存在不同的枚举说明`);
      }
      annotation.enumValues.forEach((value) => {
        const existing = current.values.get(value.value);
        if (existing && JSON.stringify(existing) !== JSON.stringify(value)) errors.push(`${table.domain0}/${annotation.enumRef} 的值 ${value.value} 定义冲突`);
        else current.values.set(value.value, value);
      });
      enums.set(enumKey, current);
    });
  });
  return [...new Set(errors)];
}

export function buildExportFiles(tables: SchemaTable[]): ExportFile[] {
  const enumFiles = new Map<string, { path: string; enum_name: string; description: string; values: EnumValue[] }>();
  const classFiles = tables.flatMap((table) => {
    const domain = safeSegment(table.domain0);
    const className = safeSegment(table.className);
    const included = table.columns.filter((column) => migrateColumn(column).annotation!.included);
    const mapping = {
      class_name: table.className,
      table: { name: table.tableName },
      db_columns: included.map((column) => {
        const annotation = migrateColumn(column).annotation!;
        return optionalObject({
          entity_column: annotation.entityColumn,
          db_column: column.name,
          type: normalizeExportType(column.dataType),
        });
      }),
    };
    const ontology = {
      class_name: table.className,
      description: table.classDescription || table.description,
      ...(table.classAliases.length ? { aliases: table.classAliases } : {}),
      attributes: included.map((column) => {
        const annotation = migrateColumn(column).annotation!;
        if (annotation.enumRef) {
          const enumName = safeSegment(annotation.enumRef);
          const key = `${domain}/${enumName}`;
          const current = enumFiles.get(key);
          const values = new Map((current?.values ?? []).map((item) => [item.value, item]));
          annotation.enumValues.forEach((item) => values.set(item.value, item));
          enumFiles.set(key, {
            path: `ontologies/${domain}/enums/${enumName}.json`,
            enum_name: annotation.enumRef,
            description: current?.description || annotation.enumDescription,
            values: [...values.values()],
          });
        }
        return optionalObject({
          attr_name: annotation.entityColumn,
          enum_ref: annotation.enumRef,
          data_type: normalizeExportType(column.dataType),
          is_local_id: annotation.isLocalId || undefined,
          is_display_name: annotation.isDisplayName || undefined,
          is_semantic: annotation.isSemantic || undefined,
          is_code: annotation.isCode || undefined,
          aliases: annotation.aliases,
          description: annotation.detailedDescription || column.remark || column.description,
        });
      }),
      metrics: [],
    };
    return [
      { path: `ontologies/${domain}/entity-classes/${className}.json`, content: `${JSON.stringify(ontology, null, 2)}\n` },
      { path: `rdb-mapping/${domain}/entity-classes/${className}-rdb-mapping.json`, content: `${JSON.stringify(mapping, null, 2)}\n` },
    ];
  });
  const enums = [...enumFiles.values()].map((item) => ({
    path: item.path,
    content: `${JSON.stringify({
      enum_name: item.enum_name,
      description: item.description,
      values: item.values.map((value) => ({
        value: value.value,
        description: value.description,
        description_en: value.descriptionEn,
        aliases: value.aliases,
      })),
    }, null, 2)}\n`,
  }));
  return [...classFiles, ...enums];
}

function crcTable() {
  return Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
}

const CRC_TABLE = crcTable();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  bytes.forEach((byte) => { crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); });
  return (crc ^ 0xffffffff) >>> 0;
}

function setU16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function setU32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

function concatBytes(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  parts.forEach((part) => { result.set(part, offset); offset += part.length; });
  return result;
}

export function createZip(files: ExportFile[]) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  files.forEach((file) => {
    const name = encoder.encode(file.path);
    const body = encoder.encode(file.content);
    const checksum = crc32(body);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    setU32(localView, 0, 0x04034b50);
    setU16(localView, 4, 20);
    setU16(localView, 6, 0x0800);
    setU16(localView, 8, 0);
    setU32(localView, 14, checksum);
    setU32(localView, 18, body.length);
    setU32(localView, 22, body.length);
    setU16(localView, 26, name.length);
    local.set(name, 30);
    localParts.push(local, body);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    setU32(centralView, 0, 0x02014b50);
    setU16(centralView, 4, 20);
    setU16(centralView, 6, 20);
    setU16(centralView, 8, 0x0800);
    setU16(centralView, 10, 0);
    setU32(centralView, 16, checksum);
    setU32(centralView, 20, body.length);
    setU32(centralView, 24, body.length);
    setU16(centralView, 28, name.length);
    setU32(centralView, 42, localOffset);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length + body.length;
  });
  const central = concatBytes(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  setU32(endView, 0, 0x06054b50);
  setU16(endView, 8, files.length);
  setU16(endView, 10, files.length);
  setU32(endView, 12, central.length);
  setU32(endView, 16, localOffset);
  return concatBytes([...localParts, central, end]);
}

export type ChangeAction =
  | "import_tables"
  | "delete_table"
  | "delete_field"
  | "update_field"
  | "apply_ai_draft"
  | "update_class_name"
  | "update_relationship"
  | "rename_domain0"
  | "rename_domain1";

export type TableAuditSnapshot = {
  tableName: string;
  className: string;
  description: string;
  domain0: string;
  domain1: string;
};

export type ChangeRecord = {
  id: string;
  timestamp: string;
  action: ChangeAction;
  label: string;
  tableName: string;
  fieldName?: string;
  source?: "user" | "claude-code";
  sessionId?: string;
  tableSnapshot?: TableAuditSnapshot;
  before?: unknown;
  after?: unknown;
};

export type ChangeRecordDraft = Omit<ChangeRecord, "id" | "timestamp">;

export type ChangeHistoryStore = {
  version: 2;
  tables: Record<string, ChangeRecord[]>;
};

export function createEmptyChangeHistory(): ChangeHistoryStore {
  return { version: 2, tables: {} };
}

export function makeTableAuditSnapshot(table: SchemaTable): TableAuditSnapshot {
  return {
    tableName: table.tableName,
    className: table.className,
    description: table.description,
    domain0: table.domain0,
    domain1: table.domain1,
  };
}

export function makeChangeRecord(record: ChangeRecordDraft): ChangeRecord {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { id, timestamp: new Date().toISOString(), ...record };
}

export function appendChangeRecords(history: ChangeHistoryStore, drafts: ChangeRecordDraft[]): ChangeHistoryStore {
  const tables = Object.fromEntries(Object.entries(history.tables).map(([tableName, records]) => [tableName, [...records]]));
  drafts.forEach((draft) => {
    const record = makeChangeRecord(draft);
    tables[record.tableName] = [record, ...(tables[record.tableName] ?? [])].slice(0, 1000);
  });
  return { version: 2, tables };
}

const CHANGE_ACTIONS = new Set<ChangeAction>([
  "import_tables",
  "delete_table",
  "delete_field",
  "update_field",
  "apply_ai_draft",
  "update_class_name",
  "update_relationship",
  "rename_domain0",
  "rename_domain1",
]);

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function snapshotFromUnknown(value: unknown, tableName: string): TableAuditSnapshot | undefined {
  const source = objectValue(value);
  if (!source) return undefined;
  return {
    tableName,
    className: typeof source.className === "string" ? source.className : "",
    description: typeof source.description === "string" ? source.description : "",
    domain0: typeof source.domain0 === "string" ? source.domain0 : "",
    domain1: typeof source.domain1 === "string" ? source.domain1 : "",
  };
}

function migrateChangeRecord(
  value: unknown,
  tableIndex: Map<string, SchemaTable>,
  salt: string,
  tableNameOverride?: string,
): ChangeRecord | undefined {
  const source = objectValue(value);
  if (!source || typeof source.action !== "string" || !CHANGE_ACTIONS.has(source.action as ChangeAction)) return undefined;
  const tableName = tableNameOverride || (typeof source.tableName === "string" && source.tableName.trim() ? source.tableName.trim() : undefined);
  if (!tableName) return undefined;
  const timestamp = typeof source.timestamp === "string" && source.timestamp ? source.timestamp : new Date().toISOString();
  const table = tableIndex.get(tableName);
  const tableSnapshot = snapshotFromUnknown(source.tableSnapshot, tableName)
    ?? (table ? makeTableAuditSnapshot(table) : snapshotFromUnknown(source.before, tableName))
    ?? { tableName, className: "", description: "", domain0: "", domain1: "" };
  return {
    id: typeof source.id === "string" && source.id ? `${source.id}${tableNameOverride && typeof source.tableName !== "string" ? `:${tableNameOverride}` : ""}` : `legacy-${timestamp}-${salt}`,
    timestamp,
    action: source.action as ChangeAction,
    label: typeof source.label === "string" && source.label ? source.label : "历史变更",
    tableName,
    tableSnapshot,
    ...(source.source === "claude-code" ? { source: "claude-code" as const } : {}),
    ...(typeof source.sessionId === "string" && source.sessionId ? { sessionId: source.sessionId } : {}),
    ...(typeof source.fieldName === "string" && source.fieldName ? { fieldName: source.fieldName } : {}),
    ...(Object.prototype.hasOwnProperty.call(source, "before") ? { before: source.before } : {}),
    ...(Object.prototype.hasOwnProperty.call(source, "after") ? { after: source.after } : {}),
  };
}

function addMigratedRecord(history: ChangeHistoryStore, record: ChangeRecord) {
  history.tables[record.tableName] = [...(history.tables[record.tableName] ?? []), record];
}

function affectedTablesForUnscopedRecord(value: unknown, tables: SchemaTable[]) {
  const source = objectValue(value);
  const before = objectValue(source?.before);
  const after = objectValue(source?.after);
  const explicit = stringArray(after?.affectedTables);
  if (explicit.length > 0) return explicit;
  if (source?.action === "rename_domain0") {
    const beforeName = typeof source.before === "string" ? source.before : typeof before?.domain0 === "string" ? before.domain0 : "";
    const afterName = typeof source.after === "string" ? source.after : typeof after?.domain0 === "string" ? after.domain0 : "";
    return tables.filter((table) => table.domain0 === beforeName || table.domain0 === afterName).map((table) => table.tableName);
  }
  if (source?.action === "rename_domain1") {
    const domain0 = typeof after?.domain0 === "string" ? after.domain0 : typeof before?.domain0 === "string" ? before.domain0 : "";
    const beforeName = typeof before?.domain1 === "string" ? before.domain1 : "";
    const afterName = typeof after?.domain1 === "string" ? after.domain1 : "";
    return tables.filter((table) => table.domain0 === domain0 && (table.domain1 === beforeName || table.domain1 === afterName)).map((table) => table.tableName);
  }
  return [];
}

export function migrateChangeHistory(value: unknown, tables: SchemaTable[] = []): ChangeHistoryStore {
  const history = createEmptyChangeHistory();
  const tableIndex = new Map(tables.map((table) => [table.tableName, table]));
  const source = objectValue(value);

  if (source?.version === 2) {
    const storedTables = objectValue(source.tables);
    Object.entries(storedTables ?? {}).forEach(([tableName, records], tableIndexPosition) => {
      if (!Array.isArray(records)) return;
      records.forEach((record, recordIndex) => {
        const migrated = migrateChangeRecord(record, tableIndex, `${tableIndexPosition}-${recordIndex}`, tableName);
        if (migrated) addMigratedRecord(history, migrated);
      });
    });
    if (Array.isArray(source.system)) source.system.forEach((record, recordIndex) => {
      affectedTablesForUnscopedRecord(record, tables).forEach((tableName, tableIndexPosition) => {
        const migrated = migrateChangeRecord(record, tableIndex, `system-${recordIndex}-${tableIndexPosition}`, tableName);
        if (migrated) addMigratedRecord(history, migrated);
      });
    });
    return history;
  }

  if (!Array.isArray(value)) return history;
  value.forEach((record, recordIndex) => {
    const raw = objectValue(record);
    const importedTables = raw?.action === "import_tables" && typeof raw.tableName !== "string"
      ? stringArray(raw.after)
      : [];
    if (importedTables.length > 0) {
      importedTables.forEach((tableName, tableIndexPosition) => {
        const migrated = migrateChangeRecord({ ...raw, label: `导入或更新表 ${tableName}` }, tableIndex, `${recordIndex}-${tableIndexPosition}`, tableName);
        if (migrated) addMigratedRecord(history, migrated);
      });
      return;
    }
    const migrated = migrateChangeRecord(record, tableIndex, `${recordIndex}`);
    if (migrated) addMigratedRecord(history, migrated);
    else affectedTablesForUnscopedRecord(record, tables).forEach((tableName, tableIndexPosition) => {
      const scoped = migrateChangeRecord(record, tableIndex, `${recordIndex}-${tableIndexPosition}`, tableName);
      if (scoped) addMigratedRecord(history, scoped);
    });
  });
  return history;
}

export function getTableChangeRecords(history: ChangeHistoryStore, tableName: string) {
  return history.tables[tableName] ?? [];
}

export function buildTableChangeHistoryExport(history: ChangeHistoryStore, tableName: string) {
  const changes = history.tables[tableName] ?? [];
  if (changes.length === 0) return undefined;
  return {
    schemaVersion: 2,
    table: changes.find((record) => record.tableSnapshot)?.tableSnapshot ?? { tableName, className: "", description: "", domain0: "", domain1: "" },
    deleted: changes[0]?.action === "delete_table",
    changes,
  };
}
