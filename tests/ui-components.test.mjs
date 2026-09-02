import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true },
});

after(async () => {
  await vite.close();
});

async function readCssTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const contents = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return readCssTree(entryPath);
      }
      return entry.name.endsWith(".css") ? readFile(entryPath, "utf8") : "";
    }),
  );
  return contents.join("\n");
}

test("emits the catalog's animation and scrolling utilities", async () => {
  const css = await readCssTree(path.join(root, "dist"));

  assert.match(css, /--tw-enter-opacity/);
  assert.match(css, /scrollbar-width:\s*thin/);
  assert.match(css, /scroll-fade-reveal-b/);
  assert.match(css, /mask-image:/);
  assert.match(css, /tw-shimmer/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("forwards progress semantics to the primitive", async () => {
  const { Progress } = await vite.ssrLoadModule("/components/ui/progress.tsx");
  const html = renderToStaticMarkup(React.createElement(Progress, { value: 37 }));

  assert.match(html, /aria-valuenow="37"/);
  assert.match(html, /aria-valuetext="37%"/);
  assert.match(html, /data-state="loading"/);
});

test("emits chart themes for the starter's media dark mode", async () => {
  const { ChartStyle } = await vite.ssrLoadModule("/components/ui/chart.tsx");
  const html = renderToStaticMarkup(
    React.createElement(ChartStyle, {
      id: "contract",
      config: {
        latency: { theme: { light: "#ffffff", dark: "#000000" } },
      },
    }),
  );

  assert.match(html, /\[data-chart=contract\]/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.doesNotMatch(html, /\.dark/);
});

test("renders sidebar skeletons deterministically", async () => {
  const { SidebarMenuSkeleton } = await vite.ssrLoadModule(
    "/components/ui/sidebar.tsx",
  );
  const first = renderToStaticMarkup(React.createElement(SidebarMenuSkeleton));
  const second = renderToStaticMarkup(React.createElement(SidebarMenuSkeleton));

  assert.equal(first, second);
  assert.match(first, /--skeleton-width:70%/);
});

test("normalizes missing level-one domains and exports the requested ontology layout", async () => {
  const {
    buildExportFiles,
    createZip,
    migrateTables,
    normalizeDomain1,
  } = await vite.ssrLoadModule("/app/schema-utils.ts");

  assert.equal(normalizeDomain1("DIAGRAM 1"), "");
  assert.equal(normalizeDomain1("根目录"), "");
  assert.equal(normalizeDomain1("免费资源"), "免费资源");

  const [table] = migrateTables([{
    tableName: "PE_FREE_UNIT",
    className: "FreeUnitInstance",
    classDescription: "免费资源实例",
    classAliases: ["赠送实例"],
    description: "原表说明",
    folder: "DIAGRAM 1",
    domain0: "FreeUnit",
    domain1: "DIAGRAM 1",
    columns: [{
      name: "FREE_UNIT_ID",
      description: "免费资源标识",
      dataType: "NUMBER(20)",
      length: "20",
      isPrimaryKey: true,
      nullable: false,
      remark: "唯一标识",
      annotation: {
        included: true,
        entityColumn: "freeUnitInstanceID",
        aliases: ["标识", "主键"],
        detailedDescription: "唯一标识免费资源实例",
        isLocalId: true,
        isDisplayName: false,
        isSemantic: false,
        isCode: true,
        semanticRole: "identifier",
        tags: [],
        unit: "",
        enumValues: [],
        valueRange: "",
        sensitivity: "none",
        enumRef: "",
        enumDescription: "",
      },
    }],
    foreignKeys: [],
    referencedBy: [],
  }]);

  assert.equal(table.domain1, "");
  const files = buildExportFiles([table]);
  assert.deepEqual(files.map((file) => file.path), [
    "ontologies/FreeUnit/entity-classes/FreeUnitInstance.json",
    "rdb-mapping/FreeUnit/entity-classes/FreeUnitInstance-rdb-mapping.json",
  ]);
  const ontology = JSON.parse(files[0].content);
  assert.equal(ontology.attributes[0].data_type, "number");
  assert.equal(ontology.attributes[0].is_local_id, true);
  assert.equal(ontology.attributes[0].is_code, true);
  assert.equal(ontology.attributes[0].attr_name, "freeUnitInstanceID");
  const zip = createZip(files);
  assert.deepEqual([...zip.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
});

test("writes enum references and definitions as separate files", async () => {
  const { buildExportFiles, migrateTables } = await vite.ssrLoadModule("/app/schema-utils.ts");
  const [table] = migrateTables([{
    tableName: "PE_QUOTA",
    className: "FreeUnitPaymentQuota",
    classDescription: "代付额度",
    classAliases: [],
    description: "",
    folder: "额度",
    domain0: "FreeUnit",
    domain1: "额度",
    columns: [{
      name: "CYCLE_TYPE",
      description: "周期类型",
      dataType: "VARCHAR2(1)",
      length: "1",
      isPrimaryKey: false,
      nullable: false,
      remark: "",
      annotation: {
        included: true,
        entityColumn: "quotaCycleType",
        aliases: [],
        detailedDescription: "代付额度的控制周期",
        isLocalId: false,
        isDisplayName: false,
        isSemantic: false,
        isCode: false,
        semanticRole: "code",
        tags: [],
        unit: "",
        enumValues: [{ value: "D", description: "日限额", descriptionEn: "Daily limit", aliases: [] }],
        valueRange: "",
        sensitivity: "none",
        enumRef: "QuotaCycleType",
        enumDescription: "免费资源代付限额周期类型",
      },
    }],
    foreignKeys: [],
    referencedBy: [],
  }]);
  const files = buildExportFiles([table]);
  assert.equal(files[2].path, "ontologies/FreeUnit/enums/QuotaCycleType.json");
  const ontology = JSON.parse(files[0].content);
  const enumFile = JSON.parse(files[2].content);
  assert.equal(ontology.attributes[0].enum_ref, "QuotaCycleType");
  assert.equal(ontology.attributes[0].is_local_id, undefined);
  assert.equal(ontology.attributes[0].is_code, undefined);
  assert.equal(enumFile.values[0].description_en, "Daily limit");
});

test("reports missing relationship fields separately from excluded export fields", async () => {
  const {
    countRelationshipFieldGaps,
    inspectRelationshipMappings,
    isMissingRelationField,
    migrateTables,
  } = await vite.ssrLoadModule("/app/schema-utils.ts");
  const tables = migrateTables([
    {
      tableName: "PARENT_TABLE",
      description: "",
      folder: "",
      domain0: "Demo",
      domain1: "",
      columns: [{ name: "ID", description: "", dataType: "NUMBER(20)", length: "20", isPrimaryKey: true, nullable: false, remark: "" }],
      foreignKeys: [],
      referencedBy: [],
    },
    {
      tableName: "CHILD_TABLE",
      description: "",
      folder: "",
      domain0: "Demo",
      domain1: "",
      columns: [{ name: "PARENT_ID", description: "", dataType: "NUMBER(20)", length: "20", isPrimaryKey: false, nullable: true, remark: "" }],
      foreignKeys: [],
      referencedBy: [],
    },
  ]);
  const missingField = {
    name: "FK_MISSING_FIELD",
    parentTable: "PARENT_TABLE",
    childTable: "CHILD_TABLE",
    cardinality: "1:N",
    cardinalityRaw: "0..*",
    deleteConstraint: "RESTRICT",
    updateConstraint: "RESTRICT",
    constraintName: "",
    columnMapping: [{ parentColumn: "NOT_IMPORTED_ID", childColumn: "PARENT_ID" }],
  };
  const missingTable = {
    ...missingField,
    name: "FK_MISSING_TABLE",
    parentTable: "NOT_IMPORTED_TABLE",
    columnMapping: [{ parentColumn: "ID", childColumn: "PARENT_ID" }],
  };
  const tableIndex = new Map(tables.map((table) => [table.tableName, table]));

  assert.deepEqual(inspectRelationshipMappings(missingField, tableIndex).map(({ parentState, childState }) => [parentState, childState]), [["field-missing", "ok"]]);
  assert.deepEqual(inspectRelationshipMappings(missingTable, tableIndex).map(({ parentState, childState }) => [parentState, childState]), [["table-missing", "ok"]]);
  assert.equal(countRelationshipFieldGaps([missingField, missingTable], tables), 2);

  tables[0].columns[0].annotation.included = false;
  const excluded = { ...missingField, name: "FK_EXCLUDED", columnMapping: [{ parentColumn: "ID", childColumn: "PARENT_ID" }] };
  const excludedState = inspectRelationshipMappings(excluded, tableIndex)[0].parentState;
  assert.equal(excludedState, "excluded");
  assert.equal(isMissingRelationField(excludedState), false);
  assert.equal(countRelationshipFieldGaps([excluded], tables), 0);
});

test("stores table history independently and migrates the legacy flat log", async () => {
  const {
    appendChangeRecords,
    buildChangeHistoryExport,
    makeTableAuditSnapshot,
    migrateChangeHistory,
    migrateTables,
  } = await vite.ssrLoadModule("/app/schema-utils.ts");
  const tables = migrateTables(["TABLE_A", "TABLE_B"].map((tableName) => ({
    tableName,
    description: `${tableName} description`,
    folder: "",
    domain0: "Demo",
    domain1: "",
    columns: [{ name: "ID", description: "", dataType: "NUMBER(20)", length: "20", isPrimaryKey: true, nullable: false, remark: "" }],
    foreignKeys: [],
    referencedBy: [],
  })));
  const legacy = [{
    id: "legacy-import",
    timestamp: "2026-01-01T00:00:00.000Z",
    action: "import_tables",
    label: "导入两张表",
    after: ["TABLE_A", "TABLE_B"],
  }, {
    id: "legacy-domain",
    timestamp: "2026-01-02T00:00:00.000Z",
    action: "rename_domain0",
    label: "0级域 Old → Demo",
  }];

  const migrated = migrateChangeHistory(legacy, tables);
  assert.equal(migrated.tables.TABLE_A.length, 1);
  assert.equal(migrated.tables.TABLE_B.length, 1);
  assert.equal(migrated.system.length, 1);
  assert.equal(migrated.tables.TABLE_A[0].tableSnapshot.className, tables[0].className);

  const restored = migrateChangeHistory(JSON.parse(JSON.stringify(migrated)), tables);
  assert.equal(restored.tables.TABLE_A[0].id, migrated.tables.TABLE_A[0].id);

  const history = appendChangeRecords(restored, [{
    action: "delete_field",
    label: "删除字段 TABLE_A.ID",
    tableName: "TABLE_A",
    fieldName: "ID",
    tableSnapshot: makeTableAuditSnapshot(tables[0]),
  }, {
    action: "rename_domain1",
    label: "1级域 A → B",
  }]);
  assert.equal(history.tables.TABLE_A.length, 2);
  assert.equal(history.tables.TABLE_B.length, 1);
  assert.equal(history.system.length, 2);

  const exported = buildChangeHistoryExport(history);
  assert.equal(exported.schemaVersion, 2);
  assert.deepEqual(exported.tables.map((group) => group.table.tableName).sort(), ["TABLE_A", "TABLE_B"]);
  assert.equal(exported.systemChanges.length, 2);
});
