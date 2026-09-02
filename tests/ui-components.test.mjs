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
