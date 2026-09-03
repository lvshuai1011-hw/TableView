"use client";

import {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  useMemo,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
  FileArchive,
  FileJson,
  FilePenLine,
  Focus,
  GitBranch,
  KeyRound,
  Layers3,
  List,
  LocateFixed,
  Maximize2,
  Minus,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings2,
  Search,
  Sparkles,
  Table2,
  Trash2,
  Upload,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";

import { AiPanel } from "./ai-panel";
import type { AiSession, AiTableDraft } from "./ai-types";
import { mergeAiDraftIntoTable } from "./ai-utils";
import {
  Column,
  ColumnAnnotation,
  ColumnMapping,
  jsonExample,
  Relationship,
  SchemaTable,
  seedTables,
  TableAnnotationStatus,
  UNCLASSIFIED,
} from "./data";
import {
  ChangeRecordList,
  FieldEditorDialog,
  RenameDomainDialog,
  TableConfigDialog,
} from "./editor-dialogs";
import {
  appendChangeRecords,
  buildTableChangeHistoryExport,
  buildExportFiles,
  CHANGE_LOG_STORAGE_KEY,
  ChangeHistoryStore,
  ChangeRecord,
  ChangeRecordDraft,
  countRelationshipFieldGaps,
  createEmptyChangeHistory,
  createZip,
  defaultClassName,
  findDeletedTableRecoveryRecord,
  getTableChangeRecords,
  getTableAnnotationStatus,
  isSelfRelationship,
  inspectRelationshipMappings,
  isMissingRelationField,
  LEGACY_CHANGE_LOG_STORAGE_KEY,
  makeTableAuditSnapshot,
  mergeImportedTable,
  migrateChangeHistory,
  migrateColumn,
  migrateTables,
  normalizeDomain1,
  RelationFieldState,
  resetTableAnnotations,
  restoreTableFromChange,
  settleTableAnnotationStatus,
  validateExportConfiguration,
} from "./schema-utils";

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 720;
const MISSING_ID = "missing:endpoints";
const TABLE_STORAGE_KEY = "schema-atlas.tables.v1";

type ParsedTable = Omit<SchemaTable, "domain0" | "domain1" | "className" | "classDescription" | "classAliases" | "annotationStatus">;
type DirectionFilter = "both" | "dependencies" | "dependents";
type Scope =
  | { level: "global" }
  | { level: "domain"; domain0: string }
  | { level: "folder"; domain0: string; domain1: string }
  | { level: "focus"; tableName: string };

const ANNOTATION_STATUS_COPY: Record<TableAnnotationStatus, { label: string; short: string }> = {
  unannotated: { label: "未标注", short: "未标注" },
  in_progress: { label: "标注中", short: "标注中" },
  completed: { label: "已完整标注", short: "完整" },
};

function annotationStatusCopy(table: SchemaTable) {
  const status = getTableAnnotationStatus(table);
  return { status, ...ANNOTATION_STATUS_COPY[status] };
}

function AnnotationStatusPill({ table, compact = false }: { table: SchemaTable; compact?: boolean }) {
  const { status, label, short } = annotationStatusCopy(table);
  return <span className={`table-annotation-status ${status}`} title={`标注状态：${label}`}>{compact ? short : label}</span>;
}
type Camera = { x: number; y: number; scale: number };
type Inspector =
  | { kind: "table"; tableName: string }
  | { kind: "relations"; keys: string[]; title: string }
  | { kind: "group"; nodeId: string }
  | null;

type GraphNode = {
  id: string;
  kind: "domain" | "folder" | "table" | "ghost" | "missing";
  label: string;
  caption: string;
  meta: string;
  count: number;
  x: number;
  y: number;
  width: number;
  height: number;
  external: boolean;
  imported: boolean;
  domain0?: string;
  domain1?: string;
  tableName?: string;
  members: string[];
  layer?: number;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relations: Relationship[];
  kind: "outbound" | "inbound" | "neutral";
};

type ScopeGraph = { nodes: GraphNode[]; edges: GraphEdge[]; title: string; hint: string };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function relationKey(relation: Relationship) {
  const mapping = relation.columnMapping
    .map((item) => `${item.parentColumn}:${item.childColumn}`)
    .join(",");
  return `${relation.parentTable}>${relation.childTable}|${relation.constraintName || relation.name}|${mapping}`;
}

function uniqueRelationships(tables: Pick<SchemaTable, "foreignKeys" | "referencedBy">[]) {
  const result = new Map<string, Relationship>();
  tables.forEach((table) => {
    [...table.foreignKeys, ...table.referencedBy].forEach((relation) => {
      const key = relationKey(relation);
      if (!result.has(key)) result.set(key, relation);
    });
  });
  return [...result.values()];
}

function relationshipNeighbors(tableName: string, relationships: Relationship[]) {
  const names = new Set<string>();
  relationships.forEach((relationship) => {
    if (relationship.parentTable === tableName && relationship.childTable !== tableName) names.add(relationship.childTable);
    if (relationship.childTable === tableName && relationship.parentTable !== tableName) names.add(relationship.parentTable);
  });
  return [...names];
}

function requiredString(data: Record<string, unknown>, key: string, context: string, allowEmpty = false) {
  const value = data[key];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${context} 的 ${key} 无效`);
  }
  return value.trim();
}

function normalizeMapping(value: unknown, context: string): ColumnMapping[] {
  if (!Array.isArray(value)) throw new Error(`${context} 的 columnMapping 不是数组`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`${context} 的第 ${index + 1} 个列映射无效`);
    const data = item as Record<string, unknown>;
    return {
      parentColumn: requiredString(data, "parentColumn", context).toUpperCase(),
      childColumn: requiredString(data, "childColumn", context).toUpperCase(),
    };
  });
}

function normalizeRelation(value: unknown, tableName: string, index: number, source: string): Relationship {
  const context = `${tableName}.${source}[${index}]`;
  if (!value || typeof value !== "object") throw new Error(`${context} 不是对象`);
  const data = value as Record<string, unknown>;
  return {
    name: requiredString(data, "name", context),
    parentTable: requiredString(data, "parentTable", context).toUpperCase(),
    childTable: requiredString(data, "childTable", context).toUpperCase(),
    cardinality: requiredString(data, "cardinality", context),
    cardinalityRaw: requiredString(data, "cardinalityRaw", context),
    deleteConstraint: requiredString(data, "deleteConstraint", context).toUpperCase(),
    updateConstraint: requiredString(data, "updateConstraint", context).toUpperCase(),
    constraintName: requiredString(data, "constraintName", context, true),
    columnMapping: normalizeMapping(data.columnMapping, context),
  };
}

function normalizeColumn(value: unknown, tableName: string, index: number): Column {
  const context = `${tableName}.columns[${index}]`;
  if (!value || typeof value !== "object") throw new Error(`${context} 不是对象`);
  const data = value as Record<string, unknown>;
  if (typeof data.isPrimaryKey !== "boolean" || typeof data.nullable !== "boolean") {
    throw new Error(`${context} 的主键或可空标记无效`);
  }
  return {
    name: requiredString(data, "name", context).toUpperCase(),
    description: requiredString(data, "description", context, true),
    dataType: requiredString(data, "dataType", context),
    length: requiredString(data, "length", context, true),
    isPrimaryKey: data.isPrimaryKey,
    nullable: data.nullable,
    remark: requiredString(data, "remark", context, true),
  };
}

function normalizeTable(value: unknown): ParsedTable {
  if (!value || typeof value !== "object") throw new Error("内容不是 JSON 对象");
  const data = value as Record<string, unknown>;
  const tableName = requiredString(data, "tableName", "表").toUpperCase();
  if (!Array.isArray(data.columns) || data.columns.length === 0) {
    throw new Error(`${tableName} 的 columns 必须是非空数组`);
  }
  if (!Array.isArray(data.foreignKeys) || !Array.isArray(data.referencedBy)) {
    throw new Error(`${tableName} 缺少 foreignKeys 或 referencedBy 数组`);
  }
  const folder = normalizeDomain1(requiredString(data, "folder", tableName, true));
  return {
    tableName,
    description: requiredString(data, "description", tableName, true),
    folder,
    columns: data.columns.map((item, index) => normalizeColumn(item, tableName, index)),
    foreignKeys: data.foreignKeys.map((item, index) => normalizeRelation(item, tableName, index, "foreignKeys")),
    referencedBy: data.referencedBy.map((item, index) => normalizeRelation(item, tableName, index, "referencedBy")),
  };
}

function emptyNode(id: string, patch: Partial<GraphNode>): GraphNode {
  return {
    id,
    kind: "table",
    label: id,
    caption: "",
    meta: "",
    count: 0,
    x: 0,
    y: 0,
    width: 224,
    height: 86,
    external: false,
    imported: true,
    members: [],
    ...patch,
  };
}

function distributeColumn(nodes: GraphNode[], x: number, top = 98, bottom = 644) {
  nodes.forEach((node, index) => {
    node.x = x;
    node.y = nodes.length === 1 ? (top + bottom) / 2 : top + (index * (bottom - top)) / (nodes.length - 1);
  });
}

function distributeGrid(nodes: GraphNode[], centerX: number, centerY: number, columns = 2) {
  const cols = Math.min(columns, Math.max(1, nodes.length));
  const rows = Math.ceil(nodes.length / cols);
  const xGap = 270;
  const yGap = 150;
  nodes.forEach((node, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    node.x = centerX + (col - (cols - 1) / 2) * xGap;
    node.y = centerY + (row - (rows - 1) / 2) * yGap;
  });
}

function aggregateEdges(
  relationships: Relationship[],
  mapEndpoint: (tableName: string) => string | null,
  focusTable?: string,
) {
  const grouped = new Map<string, GraphEdge>();
  relationships.forEach((relation) => {
    const source = mapEndpoint(relation.childTable);
    const target = mapEndpoint(relation.parentTable);
    if (!source || !target || source === target || isSelfRelationship(relation)) return;
    const id = `${source}>${target}`;
    const existing = grouped.get(id);
    const kind: GraphEdge["kind"] = focusTable
      ? relation.childTable === focusTable
        ? "outbound"
        : relation.parentTable === focusTable
          ? "inbound"
          : "neutral"
      : "neutral";
    if (existing) {
      existing.relations.push(relation);
      if (existing.kind !== kind) existing.kind = "neutral";
    } else {
      grouped.set(id, { id, source, target, relations: [relation], kind });
    }
  });
  return [...grouped.values()];
}

function buildScopeGraph(
  scope: Scope,
  tables: SchemaTable[],
  relationships: Relationship[],
  depth: 1 | 2,
  direction: DirectionFilter,
): ScopeGraph {
  const tableIndex = new Map(tables.map((table) => [table.tableName, table]));
  const nodes = new Map<string, GraphNode>();
  const ensure = (node: GraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return nodes.get(node.id)!;
  };

  if (scope.level === "global") {
    const domains = new Map<string, SchemaTable[]>();
    tables.forEach((table) => domains.set(table.domain0, [...(domains.get(table.domain0) ?? []), table]));
    domains.forEach((items, domain0) => ensure(emptyNode(`domain:${domain0}`, {
      kind: "domain",
      label: domain0,
      caption: (() => {
        const count = new Set(items.map((item) => item.domain1).filter(Boolean)).size;
        return count ? `${count} 个 1级域` : "无 1级域";
      })(),
      meta: "点击进入域内关系",
      count: items.length,
      width: 248,
      height: 112,
      domain0,
      members: items.map((item) => item.tableName),
    })));

    const missing = new Set<string>();
    relationships.forEach((relation) => {
      if (!tableIndex.has(relation.parentTable)) missing.add(relation.parentTable);
      if (!tableIndex.has(relation.childTable)) missing.add(relation.childTable);
    });
    if (missing.size) ensure(emptyNode(MISSING_ID, {
      kind: "missing",
      label: "未导入关联表",
      caption: "仅存在于关系定义中",
      meta: "导入对应 JSON 后自动归位",
      count: missing.size,
      external: true,
      imported: false,
      width: 248,
      height: 112,
      members: [...missing].sort(),
    }));
    const mapEndpoint = (name: string) => {
      const table = tableIndex.get(name);
      return table ? `domain:${table.domain0}` : MISSING_ID;
    };
    const graphNodes = [...nodes.values()];
    const primary = graphNodes.filter((node) => !node.external);
    const external = graphNodes.filter((node) => node.external);
    if (external.length) {
      distributeGrid(primary, primary.length > 2 ? 400 : 370, 360, primary.length > 4 ? 2 : 1);
      distributeColumn(external, 930, 220, 510);
    } else {
      distributeGrid(primary, 600, 360, primary.length > 6 ? 3 : 2);
    }
    return {
      nodes: graphNodes,
      edges: aggregateEdges(relationships, mapEndpoint),
      title: "全局关系",
      hint: "每个节点代表一个 0级域；连线汇总跨域外键方向",
    };
  }

  if (scope.level === "domain") {
    const domainTables = tables.filter((table) => table.domain0 === scope.domain0);
    const folders = new Map<string, SchemaTable[]>();
    domainTables.filter((table) => table.domain1).forEach((table) => folders.set(table.domain1, [...(folders.get(table.domain1) ?? []), table]));
    folders.forEach((items, domain1) => ensure(emptyNode(`folder:${scope.domain0}/${domain1}`, {
      kind: "folder",
      label: domain1,
      caption: `${items.length} 张表`,
      meta: "进入表群关系",
      count: items.length,
      width: 248,
      height: 108,
      domain0: scope.domain0,
      domain1,
      members: items.map((item) => item.tableName),
    })));
    domainTables.filter((table) => !table.domain1).forEach((table) => ensure(emptyNode(`table:${table.tableName}`, {
      kind: "table",
      label: table.tableName,
      caption: table.description || "暂无表说明",
      meta: `${table.columns.length} 字段 · 直属 0级域 · ${annotationStatusCopy(table).short}`,
      tableName: table.tableName,
      domain0: table.domain0,
      members: [table.tableName],
    })));

    const relevant = relationships.filter((relation) => {
      const parent = tableIndex.get(relation.parentTable);
      const child = tableIndex.get(relation.childTable);
      return parent?.domain0 === scope.domain0 || child?.domain0 === scope.domain0;
    });
    const missing = new Set<string>();
    const mapEndpoint = (name: string) => {
      const table = tableIndex.get(name);
      if (!table) {
        missing.add(name);
        ensure(emptyNode(MISSING_ID, {
          kind: "missing",
          label: "未导入关联表",
          caption: "域外端点待补齐",
          meta: "点击查看表名",
          external: true,
          imported: false,
          width: 236,
          height: 100,
        }));
        return MISSING_ID;
      }
      if (table.domain0 === scope.domain0) return table.domain1 ? `folder:${scope.domain0}/${table.domain1}` : `table:${table.tableName}`;
      const id = `external-domain:${table.domain0}`;
      ensure(emptyNode(id, {
        kind: "domain",
        label: table.domain0,
        caption: "外部 0级域",
        meta: "点击切换到该域",
        count: tables.filter((item) => item.domain0 === table.domain0).length,
        external: true,
        domain0: table.domain0,
        members: tables.filter((item) => item.domain0 === table.domain0).map((item) => item.tableName),
      }));
      return id;
    };
    const edges = aggregateEdges(relevant, mapEndpoint);
    const missingNode = nodes.get(MISSING_ID);
    if (missingNode) {
      missingNode.members = [...missing].sort();
      missingNode.count = missing.size;
    }
    const graphNodes = [...nodes.values()];
    distributeGrid(graphNodes.filter((node) => !node.external), 390, 360, 2);
    distributeColumn(graphNodes.filter((node) => node.external), 940, 150, 570);
    return {
      nodes: graphNodes,
      edges,
      title: scope.domain0,
      hint: "有 1级域的表按域聚合；没有 1级域的表直接展开",
    };
  }

  if (scope.level === "folder") {
    const folderTables = tables.filter((table) => table.domain0 === scope.domain0 && table.domain1 === scope.domain1);
    folderTables.forEach((table) => ensure(emptyNode(`table:${table.tableName}`, {
      kind: "table",
      label: table.tableName,
      caption: table.description || "暂无表说明",
      meta: `${table.columns.length} 字段 · ${table.columns.filter((column) => column.isPrimaryKey).length} 主键 · ${annotationStatusCopy(table).short}`,
      tableName: table.tableName,
      domain0: table.domain0,
      domain1: table.domain1,
      members: [table.tableName],
    })));
    const relevant = relationships.filter((relation) => {
      const parent = tableIndex.get(relation.parentTable);
      const child = tableIndex.get(relation.childTable);
      const inFolder = (table?: SchemaTable) => table?.domain0 === scope.domain0 && table?.domain1 === scope.domain1;
      return inFolder(parent) || inFolder(child);
    });
    const missing = new Set<string>();
    const mapEndpoint = (name: string) => {
      const table = tableIndex.get(name);
      if (!table) {
        missing.add(name);
        ensure(emptyNode(MISSING_ID, {
          kind: "missing",
          label: "未导入关联表",
          caption: "外部表已聚合",
          meta: "点击查看表名",
          external: true,
          imported: false,
          width: 236,
          height: 100,
        }));
        return MISSING_ID;
      }
      if (table.domain0 === scope.domain0 && table.domain1 === scope.domain1) return `table:${name}`;
      if (table.domain0 === scope.domain0) {
        if (!table.domain1) {
          const id = `external-table:${table.tableName}`;
          ensure(emptyNode(id, {
            kind: "table",
            label: table.tableName,
            caption: "本域直属表",
            meta: `${table.columns.length} 字段 · ${annotationStatusCopy(table).short}`,
            external: true,
            tableName: table.tableName,
            domain0: table.domain0,
            members: [table.tableName],
          }));
          return id;
        }
        const id = `external-folder:${table.domain0}/${table.domain1}`;
        ensure(emptyNode(id, {
          kind: "folder",
          label: table.domain1,
          caption: "本域其他 1级域",
          meta: table.domain0,
          count: tables.filter((item) => item.domain0 === table.domain0 && item.domain1 === table.domain1).length,
          external: true,
          domain0: table.domain0,
          domain1: table.domain1,
          members: tables.filter((item) => item.domain0 === table.domain0 && item.domain1 === table.domain1).map((item) => item.tableName),
        }));
        return id;
      }
      const id = `external-domain:${table.domain0}`;
      ensure(emptyNode(id, {
        kind: "domain",
        label: table.domain0,
        caption: "外部 0级域",
        meta: "跨域关系",
        count: tables.filter((item) => item.domain0 === table.domain0).length,
        external: true,
        domain0: table.domain0,
        members: tables.filter((item) => item.domain0 === table.domain0).map((item) => item.tableName),
      }));
      return id;
    };
    const edges = aggregateEdges(relevant, mapEndpoint);
    const missingNode = nodes.get(MISSING_ID);
    if (missingNode) {
      missingNode.members = [...missing].sort();
      missingNode.count = missing.size;
    }
    const graphNodes = [...nodes.values()];
    distributeGrid(graphNodes.filter((node) => !node.external), 390, 360, 2);
    distributeColumn(graphNodes.filter((node) => node.external), 940, 140, 580);
    return {
      nodes: graphNodes,
      edges,
      title: scope.domain1,
      hint: "域内表直接展开，域外端点维持聚合以减少交叉",
    };
  }

  const focusTable = tableIndex.get(scope.tableName);
  const layers = new Map<string, number>([[scope.tableName, 0]]);
  const relationSet = new Map<string, Relationship>();
  const walk = (mode: "dependencies" | "dependents") => {
    let frontier = new Set([scope.tableName]);
    for (let step = 1; step <= depth; step += 1) {
      const next = new Set<string>();
      relationships.forEach((relation) => {
        if (isSelfRelationship(relation)) return;
        const match = mode === "dependencies" ? frontier.has(relation.childTable) : frontier.has(relation.parentTable);
        if (!match) return;
        const target = mode === "dependencies" ? relation.parentTable : relation.childTable;
        relationSet.set(relationKey(relation), relation);
        if (!layers.has(target) && target !== scope.tableName) {
          layers.set(target, mode === "dependencies" ? -step : step);
          next.add(target);
        }
      });
      frontier = next;
    }
  };
  if (direction !== "dependents") walk("dependencies");
  if (direction !== "dependencies") walk("dependents");

  layers.forEach((layer, tableName) => {
    const table = tableIndex.get(tableName);
    ensure(emptyNode(`table:${tableName}`, {
      kind: table ? "table" : "ghost",
      label: tableName,
      caption: table?.description || "未导入，仅来自关系定义",
      meta: table ? [...[table.domain0, table.domain1].filter(Boolean), annotationStatusCopy(table).short].join(" / ") : "缺少对应 JSON",
      count: table?.columns.length ?? 0,
      tableName,
      domain0: table?.domain0,
      domain1: table?.domain1,
      external: layer !== 0,
      imported: Boolean(table),
      width: layer === 0 ? 270 : 224,
      height: layer === 0 ? 114 : 86,
      members: [tableName],
      layer,
    }));
  });
  const layerGroups = new Map<number, GraphNode[]>();
  nodes.forEach((node) => layerGroups.set(node.layer ?? 0, [...(layerGroups.get(node.layer ?? 0) ?? []), node]));
  layerGroups.forEach((items, layer) => {
    const spacing = depth === 2 ? 235 : 340;
    distributeColumn(items, 600 + layer * spacing, 92, 628);
  });
  const edges = aggregateEdges([...relationSet.values()], (name) => layers.has(name) ? `table:${name}` : null, scope.tableName);
  return {
    nodes: [...nodes.values()],
    edges,
    title: scope.tableName,
    hint: focusTable ? `${focusTable.description || "当前表"} · 依赖项在左，被依赖项在右` : "该表尚未导入",
  };
}

function edgePath(edge: GraphEdge, nodeMap: Map<string, GraphNode>, hasReverse: boolean) {
  const source = nodeMap.get(edge.source)!;
  const target = nodeMap.get(edge.target)!;
  if (source.id === target.id) {
    const x = source.x;
    const y = source.y - source.height / 2;
    return `M ${x - 32} ${y} C ${x - 98} ${y - 88}, ${x + 98} ${y - 88}, ${x + 32} ${y}`;
  }
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sign = dx >= 0 ? 1 : -1;
    const startX = source.x + sign * source.width / 2;
    const endX = target.x - sign * target.width / 2;
    const offset = hasReverse ? (edge.source < edge.target ? -24 : 24) : 0;
    const midX = (startX + endX) / 2;
    return `M ${startX} ${source.y} C ${midX} ${source.y + offset}, ${midX} ${target.y + offset}, ${endX} ${target.y}`;
  }
  const sign = dy >= 0 ? 1 : -1;
  const startY = source.y + sign * source.height / 2;
  const endY = target.y - sign * target.height / 2;
  const midY = (startY + endY) / 2;
  return `M ${source.x} ${startY} C ${source.x + 54} ${midY}, ${target.x + 54} ${midY}, ${target.x} ${endY}`;
}

function edgeLabelPosition(edge: GraphEdge, nodeMap: Map<string, GraphNode>, hasReverse: boolean) {
  const source = nodeMap.get(edge.source)!;
  const target = nodeMap.get(edge.target)!;
  const offset = hasReverse ? (edge.source < edge.target ? -28 : 28) : -10;
  return { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 + offset };
}

function scopeParent(scope: Scope, tables: SchemaTable[]): Scope | null {
  if (scope.level === "global") return null;
  if (scope.level === "domain") return { level: "global" };
  if (scope.level === "folder") return { level: "domain", domain0: scope.domain0 };
  const table = tables.find((item) => item.tableName === scope.tableName);
  if (!table) return { level: "global" };
  return table.domain1
    ? { level: "folder", domain0: table.domain0, domain1: table.domain1 }
    : { level: "domain", domain0: table.domain0 };
}

function AppSidebar({
  collapsed,
  tables,
  relationships,
  scope,
  search,
  onSearch,
  onToggle,
  onScope,
  onInspectRelations,
  onRequestDelete,
  recoverableDeletedTables,
  onRestoreDeletedTable,
  onRenameDomain0,
  onRenameDomain1,
}: {
  collapsed: boolean;
  tables: SchemaTable[];
  relationships: Relationship[];
  scope: Scope;
  search: string;
  onSearch: (value: string) => void;
  onToggle: () => void;
  onScope: (scope: Scope) => void;
  onInspectRelations: (keys: string[], title: string) => void;
  onRequestDelete: (tableNames: string[]) => void;
  recoverableDeletedTables: { tableName: string; record: ChangeRecord }[];
  onRestoreDeletedTable: (record: ChangeRecord) => void;
  onRenameDomain0: (domain0: string) => void;
  onRenameDomain1: (domain0: string, domain1: string) => void;
}) {
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(() => new Set(tables.map((table) => table.domain0)));
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(tables.filter((table) => table.domain1).map((table) => `${table.domain0}/${table.domain1}`)));
  const [tab, setTab] = useState("tree");
  const [managingTables, setManagingTables] = useState(false);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => {
    const result = new Map<string, Map<string, SchemaTable[]>>();
    tables.forEach((table) => {
      const folders = result.get(table.domain0) ?? new Map<string, SchemaTable[]>();
      folders.set(table.domain1, [...(folders.get(table.domain1) ?? []), table]);
      result.set(table.domain0, folders);
    });
    return [...result.entries()];
  }, [tables]);
  const normalizedSearch = search.trim().toUpperCase();
  const filteredTables = tables.filter((table) => {
    if (!normalizedSearch) return true;
    return table.tableName.includes(normalizedSearch)
      || table.description.toUpperCase().includes(normalizedSearch)
      || table.columns.some((column) => column.name.includes(normalizedSearch));
  });
  const relationMatches = normalizedSearch
    ? relationships.filter((relation) => relation.name.toUpperCase().includes(normalizedSearch)
      || relation.constraintName.toUpperCase().includes(normalizedSearch)).slice(0, 8)
    : [];
  const availableTableNames = new Set(tables.map((table) => table.tableName));
  const selectedTableNames = [...selectedTables].filter((tableName) => availableTableNames.has(tableName));
  const filteredTableNames = filteredTables.map((table) => table.tableName);
  const filteredDeletedTables = recoverableDeletedTables.filter(({ tableName }) => !normalizedSearch || tableName.includes(normalizedSearch));
  const allFilteredSelected = filteredTableNames.length > 0 && filteredTableNames.every((tableName) => selectedTables.has(tableName));

  const toggleDomain = (domain0: string) => setExpandedDomains((current) => {
    const next = new Set(current);
    if (next.has(domain0)) next.delete(domain0); else next.add(domain0);
    return next;
  });
  const toggleFolder = (key: string) => setExpandedFolders((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleSelectedTable = (tableName: string) => setSelectedTables((current) => {
    const next = new Set(current);
    if (next.has(tableName)) next.delete(tableName); else next.add(tableName);
    return next;
  });
  const toggleAllFilteredTables = () => setSelectedTables((current) => {
    const next = new Set(current);
    if (allFilteredSelected) filteredTableNames.forEach((tableName) => next.delete(tableName));
    else filteredTableNames.forEach((tableName) => next.add(tableName));
    return next;
  });
  const finishManaging = () => {
    setManagingTables(false);
    setSelectedTables(new Set());
  };
  const requestBulkDelete = () => {
    onRequestDelete(selectedTableNames);
    finishManaging();
  };

  return <aside className={`atlas-sidebar ${collapsed ? "is-collapsed" : ""}`}>
    <div className="sidebar-brand">
      <button className="brand-symbol" onClick={() => onScope({ level: "global" })} aria-label="回到全局关系"><Network size={19} /></button>
      {!collapsed && <div><strong>Schema Atlas</strong><span>关系探索器</span></div>}
      <button className="sidebar-collapse" onClick={onToggle} aria-label={collapsed ? "展开目录" : "收起目录"}>
        {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
      </button>
    </div>
    {collapsed ? <div className="collapsed-rail">
      <button onClick={() => onScope({ level: "global" })} aria-label="全局关系"><Layers3 size={18} /></button>
      <button onClick={onToggle} aria-label="搜索与目录"><Search size={18} /></button>
      <span />
      <em>{tables.length}</em>
    </div> : <>
      <div className="catalog-search">
        <Search size={16} />
        <Input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && filteredTables[0]) onScope({ level: "focus", tableName: filteredTables[0].tableName });
          }}
          placeholder="定位表、字段或关系…"
          aria-label="定位表、字段或关系"
        />
      </div>
      <Tabs value={tab} onValueChange={setTab} className="catalog-tabs">
        <TabsList>
          <TabsTrigger value="tree"><Layers3 size={14} />域树</TabsTrigger>
          <TabsTrigger value="flat"><List size={14} />全部表</TabsTrigger>
        </TabsList>
        <TabsContent value="tree" className="catalog-tree">
          <button className={`catalog-global ${scope.level === "global" ? "active" : ""}`} onClick={() => onScope({ level: "global" })}>
            <span><Network size={15} />全局关系</span><em>{relationships.length}</em>
          </button>
          {tree.map(([domain0, folders]) => {
            const domainOpen = expandedDomains.has(domain0);
            const domainActive = scope.level !== "global" && "domain0" in scope && scope.domain0 === domain0;
            const domainCount = [...folders.values()].reduce((sum, items) => sum + items.length, 0);
            return <div className="tree-domain" key={domain0}>
              <div className={`tree-row domain ${domainActive ? "active" : ""}`}>
                <button className="tree-chevron" onClick={() => toggleDomain(domain0)} aria-label={domainOpen ? "折叠0级域" : "展开0级域"}>{domainOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                <button className="tree-label" onClick={() => onScope({ level: "domain", domain0 })}><span>{domain0}</span><em>{domainCount}</em></button>
                <button className="tree-edit" onClick={() => onRenameDomain0(domain0)} aria-label={`修改 0级域 ${domain0}`} title="修改域名"><FilePenLine size={12} /></button>
              </div>
              {domainOpen && <div className="tree-children">{[...folders.entries()].map(([domain1, items]) => {
                if (!domain1) return <div className="tree-direct-tables" key={`${domain0}:direct`}>{items.map((table) => <div key={table.tableName} className={`tree-table-row ${scope.level === "focus" && scope.tableName === table.tableName ? "active" : ""}`}>
                  <button className="tree-table-open" onClick={() => onScope({ level: "focus", tableName: table.tableName })}><Table2 size={12} /><code>{table.tableName}</code><AnnotationStatusPill table={table} compact /></button>
                  <button className="catalog-delete" onClick={() => onRequestDelete([table.tableName])} aria-label={`删除 ${table.tableName}`} title="删除表"><Trash2 size={12} /></button>
                </div>)}</div>;
                const folderKey = `${domain0}/${domain1}`;
                const folderOpen = expandedFolders.has(folderKey);
                const folderActive = scope.level === "folder" && scope.domain0 === domain0 && scope.domain1 === domain1;
                const focusTable = scope.level === "focus" ? tables.find((item) => item.tableName === scope.tableName) : null;
                const focusFolderActive = focusTable?.domain0 === domain0 && focusTable?.domain1 === domain1;
                return <div className="tree-folder" key={folderKey}>
                  <div className={`tree-row folder ${folderActive || focusFolderActive ? "active" : ""}`}>
                    <button className="tree-chevron" onClick={() => toggleFolder(folderKey)} aria-label={folderOpen ? "折叠1级域" : "展开1级域"}>{folderOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                    <button className="tree-label" onClick={() => onScope({ level: "folder", domain0, domain1 })}><span>{domain1}</span><em>{items.length}</em></button>
                    <button className="tree-edit" onClick={() => onRenameDomain1(domain0, domain1)} aria-label={`修改 1级域 ${domain1}`} title="修改域名"><FilePenLine size={11} /></button>
                  </div>
                  {folderOpen && <div className="tree-tables">{items.map((table) => <div key={table.tableName} className={`tree-table-row ${scope.level === "focus" && scope.tableName === table.tableName ? "active" : ""}`}>
                    <button className="tree-table-open" onClick={() => onScope({ level: "focus", tableName: table.tableName })}><Table2 size={12} /><code>{table.tableName}</code><AnnotationStatusPill table={table} compact /></button>
                    <button className="catalog-delete" onClick={() => onRequestDelete([table.tableName])} aria-label={`删除 ${table.tableName}`} title="删除表"><Trash2 size={12} /></button>
                  </div>)}</div>}
                </div>;
              })}</div>}
            </div>;
          })}
        </TabsContent>
        <TabsContent value="flat" className="flat-catalog">
          <div className="flat-heading"><span>全部表铺平</span><div><em>{filteredTables.length}/{tables.length}</em><button onClick={() => managingTables ? finishManaging() : setManagingTables(true)}>{managingTables ? "完成" : "管理"}</button></div></div>
          {managingTables && <div className="bulk-delete-bar"><button className="bulk-select" disabled={filteredTableNames.length === 0} onClick={toggleAllFilteredTables}>{allFilteredSelected ? "取消全选" : "全选当前"}</button><span>已选 {selectedTableNames.length} 张</span><button className="bulk-delete-action" disabled={selectedTableNames.length === 0} onClick={requestBulkDelete}><Trash2 size={12} />批量删除</button></div>}
          {filteredTables.map((table) => <div key={table.tableName} className={`flat-table-row ${scope.level === "focus" && scope.tableName === table.tableName ? "active" : ""}`}>
            {managingTables && <input type="checkbox" checked={selectedTables.has(table.tableName)} onChange={() => toggleSelectedTable(table.tableName)} aria-label={`选择 ${table.tableName}`} />}
            <button className="flat-table-open" onClick={() => managingTables ? toggleSelectedTable(table.tableName) : onScope({ level: "focus", tableName: table.tableName })}>
              <span><Table2 size={14} /></span><div><div className="flat-table-title"><code>{table.tableName}</code><AnnotationStatusPill table={table} compact /></div><small>{[table.domain0, table.domain1].filter(Boolean).join(" · ")}</small></div><em>{table.columns.length}</em>
            </button>
            {!managingTables && <button className="catalog-delete" onClick={() => onRequestDelete([table.tableName])} aria-label={`删除 ${table.tableName}`} title="删除表"><Trash2 size={13} /></button>}
          </div>)}
          {filteredTables.length === 0 && <div className="catalog-empty">没有匹配的已导入表</div>}
          {filteredDeletedTables.length > 0 && <section className="deleted-table-catalog">
            <div className="deleted-table-heading"><span>已删除表</span><em>{filteredDeletedTables.length}</em></div>
            <p>这里只列出可恢复的表，不展示其他表的变更明细。</p>
            {filteredDeletedTables.map(({ tableName, record }) => <div className="deleted-table-row" key={tableName}><code>{tableName}</code><button onClick={() => onRestoreDeletedTable(record)}><RotateCcw size={12} />恢复</button></div>)}
          </section>}
          {relationMatches.length > 0 && <div className="relation-search-results"><div>匹配关系</div>{relationMatches.map((relation) => <button key={relationKey(relation)} onClick={() => onInspectRelations([relationKey(relation)], relation.name)}><GitBranch size={13} /><span>{relation.name}</span></button>)}</div>}
        </TabsContent>
      </Tabs>
      <div className="sidebar-summary">
        <span><i />关系已去重</span>
        <small>{tables.length} 张表 · {relationships.length} 条实际关系</small>
      </div>
    </>}
  </aside>;
}

function Breadcrumbs({ scope, tables, onScope }: { scope: Scope; tables: SchemaTable[]; onScope: (scope: Scope) => void }) {
  const table = scope.level === "focus" ? tables.find((item) => item.tableName === scope.tableName) : null;
  const domain0 = scope.level === "domain" || scope.level === "folder" ? scope.domain0 : table?.domain0;
  const domain1 = scope.level === "folder" ? scope.domain1 : table?.domain1;
  return <nav className="scope-breadcrumb" aria-label="关系层级">
    <button className={scope.level === "global" ? "current" : ""} onClick={() => onScope({ level: "global" })}>全局</button>
    {domain0 && <><ChevronRight size={13} /><button className={scope.level === "domain" ? "current" : ""} onClick={() => onScope({ level: "domain", domain0 })}>{domain0}</button></>}
    {domain0 && domain1 && <><ChevronRight size={13} /><button className={scope.level === "folder" ? "current" : ""} onClick={() => onScope({ level: "folder", domain0, domain1 })}>{domain1}</button></>}
    {scope.level === "focus" && <><ChevronRight size={13} /><code>{scope.tableName}</code></>}
  </nav>;
}

function GraphCanvas({
  graph,
  scope,
  tables,
  depth,
  direction,
  camera,
  onCamera,
  onScope,
  onDepth,
  onDirection,
  onInspector,
}: {
  graph: ScopeGraph;
  scope: Scope;
  tables: SchemaTable[];
  depth: 1 | 2;
  direction: DirectionFilter;
  camera: Camera;
  onCamera: (camera: Camera) => void;
  onScope: (scope: Scope) => void;
  onDepth: (depth: 1 | 2) => void;
  onDirection: (direction: DirectionFilter) => void;
  onInspector: (inspector: Inspector) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; cameraX: number; cameraY: number } | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const nodeMap = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const connected = useMemo(() => {
    if (!hoveredNode) return new Set<string>();
    const result = new Set([hoveredNode]);
    graph.edges.forEach((edge) => {
      if (edge.source === hoveredNode) result.add(edge.target);
      if (edge.target === hoveredNode) result.add(edge.source);
    });
    return result;
  }, [graph.edges, hoveredNode]);

  const resetCamera = () => onCamera({ x: 0, y: 0, scale: 1 });
  const zoomBy = (factor: number) => {
    const nextScale = clamp(camera.scale * factor, 0.58, 2.35);
    const centerX = CANVAS_WIDTH / 2;
    const centerY = CANVAS_HEIGHT / 2;
    const worldX = (centerX - camera.x) / camera.scale;
    const worldY = (centerY - camera.y) / camera.scale;
    onCamera({ x: centerX - worldX * nextScale, y: centerY - worldY * nextScale, scale: nextScale });
  };
  const handleWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pointX = ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH;
    const pointY = ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT;
    const nextScale = clamp(camera.scale * (event.deltaY > 0 ? 0.9 : 1.1), 0.58, 2.35);
    const worldX = (pointX - camera.x) / camera.scale;
    const worldY = (pointY - camera.y) / camera.scale;
    onCamera({ x: pointX - worldX * nextScale, y: pointY - worldY * nextScale, scale: nextScale });
  };
  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest("[data-graph-node], [data-graph-edge]")) return;
    dragRef.current = { startX: event.clientX, startY: event.clientY, cameraX: camera.x, cameraY: camera.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!drag || !rect) return;
    const scaleX = CANVAS_WIDTH / rect.width;
    const scaleY = CANVAS_HEIGHT / rect.height;
    onCamera({ ...camera, x: drag.cameraX + (event.clientX - drag.startX) * scaleX, y: drag.cameraY + (event.clientY - drag.startY) * scaleY });
  };
  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const activateNode = (node: GraphNode) => {
    if (node.kind === "domain" && node.domain0) return onScope({ level: "domain", domain0: node.domain0 });
    if (node.kind === "folder" && node.domain0 && node.domain1) return onScope({ level: "folder", domain0: node.domain0, domain1: node.domain1 });
    if ((node.kind === "table" || node.kind === "ghost") && node.tableName) {
      if (!node.imported) return onInspector({ kind: "table", tableName: node.tableName });
      if (scope.level === "focus" && scope.tableName === node.tableName) return onInspector({ kind: "table", tableName: node.tableName });
      return onScope({ level: "focus", tableName: node.tableName });
    }
    onInspector({ kind: "group", nodeId: node.id });
  };
  const nodeKeyDown = (event: ReactKeyboardEvent<SVGGElement>, node: GraphNode) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateNode(node);
    }
  };
  const getMarker = (edge: GraphEdge) => edge.kind === "outbound" ? "url(#arrow-outbound)" : edge.kind === "inbound" ? "url(#arrow-inbound)" : "url(#arrow-neutral)";
  const viewport = {
    x: clamp(-camera.x / camera.scale, 0, CANVAS_WIDTH),
    y: clamp(-camera.y / camera.scale, 0, CANVAS_HEIGHT),
    width: clamp(CANVAS_WIDTH / camera.scale, 0, CANVAS_WIDTH),
    height: clamp(CANVAS_HEIGHT / camera.scale, 0, CANVAS_HEIGHT),
  };

  return <section className="graph-stage" aria-label="表关系图谱">
    <div className="canvas-heading">
      <div><strong>{graph.title}</strong><span>{graph.hint}</span></div>
      <div className="graph-totals"><span>{graph.nodes.length} 节点</span><span>{graph.edges.reduce((sum, edge) => sum + edge.relations.length, 0)} 关系</span></div>
    </div>
    <div className="canvas-toolbar" aria-label="画布工具">
      <button onClick={() => zoomBy(1.15)} aria-label="放大"><ZoomIn size={16} /></button>
      <button onClick={() => zoomBy(0.87)} aria-label="缩小"><ZoomOut size={16} /></button>
      <button onClick={resetCamera} aria-label="适配画布"><Maximize2 size={16} /></button>
      {scopeParent(scope, tables) && <><i /><button onClick={() => onScope(scopeParent(scope, tables)!)} aria-label="返回上一级"><ArrowLeft size={16} /></button></>}
    </div>
    {scope.level === "focus" ? <div className="focus-controls">
      <div className="control-group" aria-label="关系方向">
        <button className={direction === "dependencies" ? "active" : ""} onClick={() => onDirection("dependencies")}>我依赖谁</button>
        <button className={direction === "both" ? "active" : ""} onClick={() => onDirection("both")}>同时展示</button>
        <button className={direction === "dependents" ? "active" : ""} onClick={() => onDirection("dependents")}>谁依赖我</button>
      </div>
      <div className="control-group" aria-label="关系深度">
        <button className={depth === 1 ? "active" : ""} onClick={() => onDepth(1)}>1 层</button>
        <button className={depth === 2 ? "active" : ""} onClick={() => onDepth(2)}>2 层</button>
      </div>
    </div> : <div className="drill-hint"><LocateFixed size={14} />点击节点下钻 · 滚轮缩放 · 拖动画布</div>}
    <svg
      ref={svgRef}
      className="relationship-canvas"
      viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
      role="img"
      aria-label={`${graph.title}，共 ${graph.nodes.length} 个节点和 ${graph.edges.length} 组关系`}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <defs>
        <marker id="arrow-neutral" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
        <marker id="arrow-outbound" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
        <marker id="arrow-inbound" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker>
        <filter id="node-shadow" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="7" stdDeviation="8" floodOpacity=".10" /></filter>
      </defs>
      <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
        <g className="graph-edges">
          {graph.edges.map((edge) => {
            const reverse = graph.edges.some((item) => item.source === edge.target && item.target === edge.source);
            const path = edgePath(edge, nodeMap, reverse);
            const label = edgeLabelPosition(edge, nodeMap, reverse);
            const faded = Boolean(hoveredNode && edge.source !== hoveredNode && edge.target !== hoveredNode);
            const highlighted = hoveredEdge === edge.id || Boolean(hoveredNode && !faded);
            return <g
              key={edge.id}
              data-graph-edge
              className={`graph-edge ${edge.kind} ${faded ? "is-faded" : ""} ${highlighted ? "is-highlighted" : ""}`}
              onMouseEnter={() => setHoveredEdge(edge.id)}
              onMouseLeave={() => setHoveredEdge(null)}
              onClick={(event) => {
                event.stopPropagation();
                onInspector({ kind: "relations", keys: edge.relations.map(relationKey), title: `${nodeMap.get(edge.source)?.label} → ${nodeMap.get(edge.target)?.label}` });
              }}
            >
              <path className="edge-visible" d={path} markerEnd={getMarker(edge)} />
              <path className="edge-hit" d={path} />
              <g className="edge-label" transform={`translate(${label.x} ${label.y})`}>
                <rect x="-34" y="-12" width="68" height="24" rx="12" />
                <text textAnchor="middle" dominantBaseline="middle">{edge.relations.length} 条引用</text>
              </g>
              {scope.level === "focus" && camera.scale >= 1.2 && edge.relations.length === 1 && <g className="edge-mapping-label" transform={`translate(${label.x} ${label.y + 25})`}>
                <rect x="-96" y="-11" width="192" height="22" rx="5" />
                <text textAnchor="middle" dominantBaseline="middle">{`${edge.relations[0].columnMapping[0]?.childColumn ?? "?"} → ${edge.relations[0].columnMapping[0]?.parentColumn ?? "?"}`}</text>
              </g>}
            </g>;
          })}
        </g>
        <g className="graph-nodes">
          {graph.nodes.map((node) => {
            const faded = Boolean(hoveredNode && !connected.has(node.id));
            const selected = scope.level === "focus" && node.tableName === scope.tableName;
            const nodeClass = `graph-node ${node.kind} ${node.external ? "external" : ""} ${node.imported ? "" : "not-imported"} ${faded ? "is-faded" : ""} ${selected ? "is-selected" : ""}`;
            const label = node.label.length > 26 ? `${node.label.slice(0, 24)}…` : node.label;
            const caption = node.caption.length > 34 ? `${node.caption.slice(0, 32)}…` : node.caption;
            return <g
              key={node.id}
              data-graph-node
              role="button"
              tabIndex={0}
              aria-label={`${node.label}，${node.caption}`}
              className={nodeClass}
              transform={`translate(${node.x - node.width / 2} ${node.y - node.height / 2})`}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={() => setHoveredNode(null)}
              onClick={(event) => { event.stopPropagation(); activateNode(node); }}
              onKeyDown={(event) => nodeKeyDown(event, node)}
            >
              <rect className="node-surface" width={node.width} height={node.height} rx={node.kind === "domain" ? 18 : 13} filter={selected ? "url(#node-shadow)" : undefined} />
              <rect className="node-accent" width="5" height={node.height - 22} x="0" y="11" rx="2.5" />
              <g className="node-icon" transform="translate(19 18)">
                {node.kind === "domain" ? <><rect width="28" height="28" rx="8" /><path d="M8 9h12M8 14h12M8 19h7" /></> : node.kind === "folder" ? <><rect width="28" height="28" rx="8" /><path d="M7 11h6l2 2h7v8H7z" /></> : <><rect width="28" height="28" rx="8" /><path d="M8 9h12M8 14h12M8 19h12" /></>}
              </g>
              <text className="node-label" x="58" y="28">{label}</text>
              <text className="node-caption" x="19" y={node.height - 30}>{caption}</text>
              <text className="node-meta" x="19" y={node.height - 13}>{node.meta}</text>
              {(node.kind === "domain" || node.kind === "folder" || node.kind === "missing") && <g className="node-count" transform={`translate(${node.width - 42} 17)`}><rect width="27" height="21" rx="10.5" /><text x="13.5" y="11" textAnchor="middle" dominantBaseline="middle">{node.count}</text></g>}
              {node.kind === "table" && node.tableName && <g className="node-open" transform={`translate(${node.width - 29} 21)`}><path d="M0 5h10M6 1l4 4-4 4" /></g>}
              {(node.kind === "ghost" || node.kind === "missing") && <g className="node-warning" transform={`translate(${node.width - 28} 21)`}><circle cx="5" cy="5" r="5" /><path d="M5 2.5v3M5 7.5v.2" /></g>}
            </g>;
          })}
        </g>
      </g>
    </svg>
    <div className="graph-legend">
      <span><i className="legend-line outbound" />我依赖谁 · 子表 → 父表</span>
      <span><i className="legend-line inbound" />谁依赖我 · 子表 → 当前表</span>
      <span><i className="legend-node missing" />未导入端点</span>
    </div>
    <div className="mini-map" aria-hidden="true">
      <svg viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}>
        {graph.edges.map((edge) => {
          const source = nodeMap.get(edge.source)!;
          const target = nodeMap.get(edge.target)!;
          return <line key={edge.id} x1={source.x} y1={source.y} x2={target.x} y2={target.y} />;
        })}
        {graph.nodes.map((node) => <rect key={node.id} x={node.x - 24} y={node.y - 13} width="48" height="26" rx="5" className={node.imported ? "" : "missing"} />)}
        <rect className="mini-viewport" x={viewport.x} y={viewport.y} width={viewport.width} height={viewport.height} />
      </svg>
    </div>
  </section>;
}

function relationFieldStateLabel(state: RelationFieldState, side: "parent" | "child") {
  if (state === "table-missing") return side === "parent" ? "依赖表未导入" : "引用表未导入";
  if (state === "field-missing") return side === "parent" ? "依赖字段未导入" : "引用字段未导入";
  if (state === "excluded") return side === "parent" ? "依赖字段不导出" : "引用字段不导出";
  return "";
}

function RelationDetail({ relationship, tableIndex }: { relationship: Relationship; tableIndex: Map<string, SchemaTable> }) {
  const parentImported = tableIndex.has(relationship.parentTable);
  const childImported = tableIndex.has(relationship.childTable);
  const inspections = inspectRelationshipMappings(relationship, tableIndex);
  const missingCount = inspections.reduce((count, inspection) => count
    + (isMissingRelationField(inspection.parentState) ? 1 : 0)
    + (isMissingRelationField(inspection.childState) ? 1 : 0), 0);
  const excludedCount = inspections.reduce((count, inspection) => count
    + (inspection.parentState === "excluded" ? 1 : 0)
    + (inspection.childState === "excluded" ? 1 : 0), 0);
  const deleteAction = relationship.deleteConstraint.trim().toUpperCase();
  const updateAction = relationship.updateConstraint.trim().toUpperCase();
  const unusualDeleteAction = deleteAction && deleteAction !== "RESTRICT" ? deleteAction : "";
  const unusualUpdateAction = updateAction && updateAction !== "RESTRICT" ? updateAction : "";
  const constraintName = relationship.constraintName.trim();
  return <article className="relation-detail">
    <div className="relation-detail-head">
      <div><GitBranch size={16} /><code>{relationship.name}</code></div>
      <div className="relation-badges">{missingCount > 0 && <Badge variant="outline" className="mapping-gap-badge"><CircleAlert size={11} />{missingCount} 个字段缺口</Badge>}{excludedCount > 0 && <Badge variant="outline">{excludedCount} 个字段不导出</Badge>}{isSelfRelationship(relationship) && <Badge variant="outline">自引用 · 图中隐藏</Badge>}<Badge variant="outline">{relationship.cardinality}</Badge></div>
    </div>
    <div className="relation-route">
      <div className={!childImported ? "missing" : ""}><span>子表 · 引用方</span><code>{relationship.childTable}</code>{!childImported && <small>未导入</small>}</div>
      <ArrowRight size={17} />
      <div className={!parentImported ? "missing" : ""}><span>父表 · 被引用方</span><code>{relationship.parentTable}</code>{!parentImported && <small>未导入</small>}</div>
    </div>
    <div className="mapping-heading">字段映射</div>
    <div className="mapping-rows">{inspections.map((inspection, index) => {
      const { mapping, childState, parentState } = inspection;
      const hasMissing = isMissingRelationField(childState) || isMissingRelationField(parentState);
      const hasExcluded = childState === "excluded" || parentState === "excluded";
      return <div className={`mapping-row ${hasMissing ? "has-missing" : ""} ${hasExcluded ? "has-excluded" : ""}`} key={`${mapping.childColumn}-${mapping.parentColumn}-${index}`}>
        <div className={`mapping-endpoint ${childState}`}><code>{relationship.childTable}.{mapping.childColumn}</code>{childState !== "ok" && <small>{relationFieldStateLabel(childState, "child")}</small>}</div>
        <ArrowRight size={13} />
        <div className={`mapping-endpoint ${parentState}`}><code>{relationship.parentTable}.{mapping.parentColumn}</code>{parentState !== "ok" && <small>{relationFieldStateLabel(parentState, "parent")}</small>}</div>
      </div>;
    })}</div>
    {(unusualDeleteAction || unusualUpdateAction || constraintName) && <div className="constraint-row">
      {unusualDeleteAction && <span className="constraint-warning"><CircleAlert size={11} />删除行为 <code>{unusualDeleteAction}</code></span>}
      {unusualUpdateAction && <span className="constraint-warning"><CircleAlert size={11} />更新行为 <code>{unusualUpdateAction}</code></span>}
      {constraintName && <span>约束 <code>{constraintName}</code></span>}
    </div>}
  </article>;
}

function InspectorSheet({
  inspector,
  graph,
  tables,
  relationships,
  changeHistory,
  onClose,
  onFocus,
  onDelete,
  onEditField,
  onRequestDeleteField,
  onEditTable,
  onOpenAi,
  onResetAnnotations,
  onExportChanges,
  onRestoreChange,
}: {
  inspector: Inspector;
  graph: ScopeGraph;
  tables: SchemaTable[];
  relationships: Relationship[];
  changeHistory: ChangeHistoryStore;
  onClose: () => void;
  onFocus: (tableName: string) => void;
  onDelete: (tableName: string) => void;
  onEditField: (tableName: string, fieldName: string) => void;
  onRequestDeleteField: (tableName: string, fieldName: string) => void;
  onEditTable: (tableName: string) => void;
  onOpenAi: (tableName: string) => void;
  onResetAnnotations: (tableName: string) => void;
  onExportChanges: (tableName: string) => void;
  onRestoreChange: (record: ChangeRecord) => void;
}) {
  const tableIndex = useMemo(() => new Map(tables.map((table) => [table.tableName, table])), [tables]);
  const relationIndex = useMemo(() => new Map(relationships.map((relation) => [relationKey(relation), relation])), [relationships]);
  const selectedTable = inspector?.kind === "table" ? tableIndex.get(inspector.tableName) : undefined;
  const selectedRelations = inspector?.kind === "relations"
    ? inspector.keys.map((key) => relationIndex.get(key)).filter((item): item is Relationship => Boolean(item))
    : [];
  const selectedGroup = inspector?.kind === "group" ? graph.nodes.find((node) => node.id === inspector.nodeId) : undefined;
  const tableName = inspector?.kind === "table" ? inspector.tableName : "";
  const selfRelations = selectedTable ? relationships.filter((relation) => isSelfRelationship(relation) && relation.parentTable === selectedTable.tableName) : [];
  const outbound = selectedTable ? relationships.filter((relation) => !isSelfRelationship(relation) && relation.childTable === selectedTable.tableName) : [];
  const inbound = selectedTable ? relationships.filter((relation) => !isSelfRelationship(relation) && relation.parentTable === selectedTable.tableName) : [];
  const tableChanges = selectedTable ? getTableChangeRecords(changeHistory, selectedTable.tableName) : [];
  const hasImportedFieldInfo = selectedTable?.columns.some((column) => Boolean(column.description || column.remark)) ?? false;
  const title = inspector?.kind === "table" ? tableName : inspector?.kind === "relations" ? inspector.title : selectedGroup?.label ?? "关系详情";
  const inspectorDescription = selectedTable?.description || (selectedGroup?.caption ?? "");
  const selectedAnnotationStatus = selectedTable ? getTableAnnotationStatus(selectedTable) : "unannotated";

  return <Sheet open={Boolean(inspector)} onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent className={`inspector-sheet ${inspector?.kind === "table" ? "is-table-fullscreen" : ""}`}>
      <SheetHeader>
        <div className="inspector-eyebrow">{inspector?.kind === "table" ? <Table2 size={14} /> : inspector?.kind === "relations" ? <GitBranch size={14} /> : <Layers3 size={14} />}{inspector?.kind === "table" ? "表详情" : inspector?.kind === "relations" ? "关系详情" : "聚合节点"}</div>
        <SheetTitle>{title}</SheetTitle>
        {inspectorDescription && <SheetDescription>{inspectorDescription}</SheetDescription>}
      </SheetHeader>
      {inspector?.kind === "table" && !selectedTable && <div className="ghost-inspector">
        <CircleAlert size={28} /><strong>该表尚未导入</strong><p>它来自其他表的外键关系。导入对应 JSON 后，字段、域和更多上下游关系会自动补齐。</p><code>{tableName}</code>
      </div>}
      {selectedTable && <>
        <div className="inspector-summary">
          <div><span>字段</span><strong>{selectedTable.columns.length}</strong></div>
          <div><span>我依赖</span><strong>{outbound.length}</strong></div>
          <div><span>依赖我</span><strong>{inbound.length}</strong></div>
        </div>
        <div className="class-summary"><div><span>对应类</span><div className="class-summary-name"><code>{selectedTable.className}</code><AnnotationStatusPill table={selectedTable} /></div></div><button onClick={() => onEditTable(selectedTable.tableName)}><Settings2 size={14} />配置类</button></div>
        <div className="inspector-actions">
          <Button variant="outline" className="ai-from-sheet" onClick={() => onOpenAi(selectedTable.tableName)}><Sparkles size={15} />AI 审核此表</Button>
          <Button className="focus-from-sheet" onClick={() => onFocus(selectedTable.tableName)}><Focus size={15} />聚焦该表关系</Button>
          <Button variant="outline" className="reset-annotations-from-sheet" disabled={selectedAnnotationStatus === "unannotated"} onClick={() => onResetAnnotations(selectedTable.tableName)}><RotateCcw size={15} />清空标注</Button>
          <Button variant="outline" className="delete-from-sheet" onClick={() => onDelete(selectedTable.tableName)}><Trash2 size={15} />删除此表</Button>
        </div>
        <Tabs defaultValue="relations" className="inspector-tabs">
          <TabsList><TabsTrigger value="relations">上下游</TabsTrigger><TabsTrigger value="fields">字段</TabsTrigger><TabsTrigger value="changes">变更 <span>{tableChanges.length}</span></TabsTrigger></TabsList>
          <TabsContent value="relations" className="inspector-relations">
            {outbound.length > 0 && <section><h3>我依赖谁 <span>{outbound.length}</span></h3>{outbound.map((relation) => <RelationDetail key={relationKey(relation)} relationship={relation} tableIndex={tableIndex} />)}</section>}
            {inbound.length > 0 && <section><h3>谁依赖我 <span>{inbound.length}</span></h3>{inbound.map((relation) => <RelationDetail key={relationKey(relation)} relationship={relation} tableIndex={tableIndex} />)}</section>}
            {selfRelations.length > 0 && <section><h3>本表自引用 <span>{selfRelations.length}</span></h3>{selfRelations.map((relation) => <RelationDetail key={relationKey(relation)} relationship={relation} tableIndex={tableIndex} />)}</section>}
            {outbound.length + inbound.length + selfRelations.length === 0 && <div className="inspector-empty">暂无外键关系</div>}
          </TabsContent>
          <TabsContent value="fields" className="field-table-wrap">
            <Table><TableHeader><TableRow><TableHead>字段 / 属性</TableHead>{hasImportedFieldInfo && <TableHead>导入 JSON 字段信息</TableHead>}<TableHead>标注后的业务语义</TableHead><TableHead>类型</TableHead><TableHead>状态</TableHead><TableHead className="field-actions-head">操作</TableHead></TableRow></TableHeader><TableBody>{selectedTable.columns.map((column) => {
              const annotation = migrateColumn(column).annotation!;
              return <TableRow key={column.name} className={!annotation.included ? "field-excluded" : ""}><TableCell><div className="field-name">{column.isPrimaryKey ? <KeyRound size={13} /> : <Minus size={11} />}<div><code>{column.name}</code>{annotation.entityColumn && <small>{annotation.entityColumn}</small>}</div></div></TableCell>{hasImportedFieldInfo && <TableCell><div className="field-source-copy">{column.description && <div><small>description</small><strong>{column.description}</strong></div>}{column.remark && <div><small>remark</small><p>{column.remark}</p></div>}</div></TableCell>}<TableCell><div className="field-annotation-copy">{annotation.detailedDescription && <p>{annotation.detailedDescription}</p>}{annotation.aliases.length > 0 && <div>{annotation.aliases.map((alias) => <span key={alias}>{alias}</span>)}</div>}</div></TableCell><TableCell><code>{column.dataType}</code></TableCell><TableCell><div className="field-state"><span>{column.isPrimaryKey ? "PK" : column.nullable ? "可空" : "必填"}</span>{!annotation.included && <Badge variant="outline">不导出</Badge>}{annotation.isLocalId && <Badge variant="outline">LOCAL ID</Badge>}{annotation.isCode && <Badge variant="outline">CODE</Badge>}{annotation.enumRef && <Badge variant="outline">枚举 · {annotation.enumRef}</Badge>}</div></TableCell><TableCell><div className="field-row-actions"><button onClick={() => onEditField(selectedTable.tableName, column.name)} aria-label={`标注 ${column.name}`}><FilePenLine size={13} /></button><button className="danger" onClick={() => onRequestDeleteField(selectedTable.tableName, column.name)} aria-label={`删除 ${column.name}`} title="删除字段"><Trash2 size={13} /></button></div></TableCell></TableRow>;
            })}</TableBody></Table>
          </TabsContent>
          <TabsContent value="changes" className="table-change-history">
            <div className="table-change-toolbar"><div><strong>本表历史</strong><span>每条有完整前态的记录都可恢复，恢复本身也会留下新记录</span></div><Button variant="outline" size="sm" disabled={tableChanges.length === 0} onClick={() => onExportChanges(selectedTable.tableName)}><Download size={13} />导出本表</Button></div>
            <ChangeRecordList records={tableChanges} currentTable={selectedTable} onRestore={onRestoreChange} emptyText="这张表还没有变更记录" />
          </TabsContent>
        </Tabs>
      </>}
      {inspector?.kind === "relations" && <div className="relation-sheet-list">{selectedRelations.map((relationship) => <RelationDetail key={relationKey(relationship)} relationship={relationship} tableIndex={tableIndex} />)}</div>}
      {selectedGroup && <div className="group-members"><div className="group-member-heading"><span>包含对象</span><em>{selectedGroup.members.length}</em></div>{selectedGroup.members.map((member) => <button key={member} onClick={() => tableIndex.has(member) ? onFocus(member) : undefined}><Table2 size={14} /><code>{member}</code>{tableIndex.has(member) ? <ArrowRight size={13} /> : <Badge variant="outline">未导入</Badge>}</button>)}</div>}
    </SheetContent>
  </Sheet>;
}

function DeleteTablesDialog({
  tableNames,
  relationships,
  onCancel,
  onConfirm,
}: {
  tableNames: string[];
  relationships: Relationship[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const targets = new Set(tableNames);
  const affectedRelations = relationships.filter((relationship) => targets.has(relationship.parentTable) || targets.has(relationship.childTable));
  const title = tableNames.length === 1 ? `删除 ${tableNames[0]}？` : `删除选中的 ${tableNames.length} 张表？`;

  return <AlertDialog open={tableNames.length > 0} onOpenChange={(open) => { if (!open) onCancel(); }}>
    <AlertDialogContent className="delete-dialog">
      <AlertDialogHeader>
        <div className="delete-dialog-mark"><Trash2 size={20} /></div>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>删除后，相关字段信息和 {affectedRelations.length} 条关系会同时从展示盘移除。完整表快照会写入本表变更记录，可在“全部表 → 已删除表”中恢复。</AlertDialogDescription>
      </AlertDialogHeader>
      <div className="delete-table-preview">
        {tableNames.slice(0, 6).map((tableName) => <code key={tableName}>{tableName}</code>)}
        {tableNames.length > 6 && <span>另有 {tableNames.length - 6} 张表</span>}
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel onClick={onCancel}>取消</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={onConfirm}><Trash2 size={14} />确认删除</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

function ImportDialog({
  open,
  onOpenChange,
  pending,
  errors,
  domain0,
  onDomain0,
  onFiles,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: ParsedTable[];
  errors: string[];
  domain0: string;
  onDomain0: (value: string) => void;
  onFiles: (files: FileList | File[]) => void;
  onImport: () => void;
}) {
  const previewRelations = uniqueRelationships(pending);
  const rawRelations = pending.reduce((sum, table) => sum + table.foreignKeys.length + table.referencedBy.length, 0);
  const folders = [...new Set(pending.map((table) => normalizeDomain1(table.folder)).filter(Boolean))];
  const directTables = pending.filter((table) => !normalizeDomain1(table.folder)).length;
  const downloadExample = () => {
    const blob = new Blob([JSON.stringify(jsonExample, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "PE_PLAN_POLICY.example.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="import-dialog sm:max-w-2xl">
      <DialogHeader>
        <div className="dialog-mark"><FileJson size={20} /></div>
        <DialogTitle>批量导入 PDM JSON</DialogTitle>
        <DialogDescription>本批次设置 0级域；有效 folder 自动成为 1级域，空值、根目录和 DIAGRAM 1 不建立 1级域。</DialogDescription>
      </DialogHeader>
      <label
        className="json-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); onFiles([...event.dataTransfer.files]); }}
      >
        <input type="file" accept="application/json,.json" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => event.target.files && onFiles(event.target.files)} />
        <Upload size={22} />
        <strong>选择或拖入多个 JSON 文件</strong>
        <span>支持新版 foreignKeys、referencedBy 与复合列映射</span>
      </label>
      <div className="domain-input-row">
        <label htmlFor="domain0">本批次 0级域</label>
        <Input id="domain0" value={domain0} onChange={(event) => onDomain0(event.target.value)} placeholder="例如：定价域；留空则进入未归类" />
      </div>
      {pending.length > 0 && <div className="import-preview">
        <div><span>表</span><strong>{pending.length}</strong></div>
        <div><span>1级域</span><strong>{folders.length}</strong></div>
        <div><span>原始关系</span><strong>{rawRelations}</strong></div>
        <div><span>去重后</span><strong>{previewRelations.length}</strong></div>
        <div><span>未命名约束</span><strong>{previewRelations.filter((relation) => !relation.constraintName).length}</strong></div>
        <div><span>复合外键</span><strong>{previewRelations.filter((relation) => relation.columnMapping.length > 1).length}</strong></div>
        <section><span>folder → 1级域</span><div>{folders.map((folder) => <code key={folder}>{folder}</code>)}{directTables > 0 && <code>直属 0级域：{directTables} 张</code>}</div></section>
      </div>}
      {errors.length > 0 && <div className="import-errors" role="alert">{errors.map((error) => <div key={error}><CircleAlert size={14} /><span>{error}</span></div>)}</div>}
      <DialogFooter>
        <Button variant="outline" onClick={downloadExample}><Download size={15} />下载格式示例</Button>
        <Button onClick={onImport} disabled={pending.length === 0}><Upload size={15} />导入 {pending.length || ""} 张表</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export default function Home() {
  const [tables, setTables] = useState<SchemaTable[]>(() => migrateTables(seedTables));
  const [scope, setScope] = useState<Scope>({ level: "global" });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  const [depth, setDepth] = useState<1 | 2>(1);
  const [direction, setDirection] = useState<DirectionFilter>("both");
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [inspector, setInspector] = useState<Inspector>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingTables, setPendingTables] = useState<ParsedTable[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importDomain0, setImportDomain0] = useState("定价域");
  const [storageReady, setStorageReady] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<string[]>([]);
  const [fieldTarget, setFieldTarget] = useState<{ tableName: string; fieldName: string } | null>(null);
  const [fieldDeleteTarget, setFieldDeleteTarget] = useState<{ tableName: string; fieldName: string } | null>(null);
  const [annotationResetTarget, setAnnotationResetTarget] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<ChangeRecord | null>(null);
  const [tableConfigTarget, setTableConfigTarget] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiTableTarget, setAiTableTarget] = useState<string | null>(null);
  const [tableConfigError, setTableConfigError] = useState("");
  const [renameTarget, setRenameTarget] = useState<
    | { level: 0; currentName: string }
    | { level: 1; domain0: string; currentName: string }
    | null
  >(null);
  const [changeHistory, setChangeHistory] = useState<ChangeHistoryStore>(() => createEmptyChangeHistory());
  const relationships = useMemo(() => uniqueRelationships(tables), [tables]);
  const recoverableDeletedTables = useMemo(() => {
    const active = new Set(tables.map((table) => table.tableName));
    return Object.entries(changeHistory.tables).flatMap(([tableName, records]) => {
      if (active.has(tableName)) return [];
      const record = findDeletedTableRecoveryRecord(records);
      return record ? [{ tableName, record }] : [];
    }).sort((left, right) => left.tableName.localeCompare(right.tableName));
  }, [changeHistory, tables]);
  const fieldGapCount = useMemo(() => countRelationshipFieldGaps(relationships, tables), [relationships, tables]);
  const annotationCounts = useMemo(() => tables.reduce<Record<TableAnnotationStatus, number>>((counts, table) => {
    counts[getTableAnnotationStatus(table)] += 1;
    return counts;
  }, { unannotated: 0, in_progress: 0, completed: 0 }), [tables]);
  const graph = useMemo(() => buildScopeGraph(scope, tables, relationships, depth, direction), [scope, tables, relationships, depth, direction]);
  const selectedFieldTable = fieldTarget ? tables.find((table) => table.tableName === fieldTarget.tableName) : undefined;
  const selectedField = selectedFieldTable?.columns.find((column) => column.name === fieldTarget?.fieldName);
  const selectedConfigTable = tableConfigTarget ? tables.find((table) => table.tableName === tableConfigTarget) : undefined;
  const crossDomainCount = relationships.filter((relationship) => {
    const parent = tables.find((table) => table.tableName === relationship.parentTable);
    const child = tables.find((table) => table.tableName === relationship.childTable);
    return parent && child && parent.domain0 !== child.domain0;
  }).length;

  const addChanges = (records: ChangeRecordDraft[]) => setChangeHistory((current) => appendChangeRecords(current, records));

  useEffect(() => {
    let active = true;
    let restoredTables: SchemaTable[] | null = null;
    let restoredHistory: ChangeHistoryStore | null = null;
    let readFailed = false;
    try {
      const stored = window.localStorage.getItem(TABLE_STORAGE_KEY);
      const auditStored = window.localStorage.getItem(CHANGE_LOG_STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_CHANGE_LOG_STORAGE_KEY);
      if (stored !== null) {
        const restored = JSON.parse(stored) as unknown;
        if (Array.isArray(restored)) restoredTables = migrateTables(restored as SchemaTable[]);
      }
      if (auditStored !== null) {
        const restored = JSON.parse(auditStored) as unknown;
        restoredHistory = migrateChangeHistory(restored, restoredTables ?? migrateTables(seedTables));
      }
    } catch {
      readFailed = true;
    }
    queueMicrotask(() => {
      if (!active) return;
      if (restoredTables) setTables(restoredTables);
      if (restoredHistory) setChangeHistory(restoredHistory);
      if (readFailed) toast.error("本地数据读取失败", { description: "已使用内置示例启动，可重新导入 JSON。" });
      setStorageReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(TABLE_STORAGE_KEY, JSON.stringify(tables));
      window.localStorage.setItem(CHANGE_LOG_STORAGE_KEY, JSON.stringify(changeHistory));
    } catch {
      toast.error("本地保存空间不足", { description: "请减少导入量或导出后清理该站点的浏览器存储。" });
    }
  }, [storageReady, tables, changeHistory]);

  const enterScope = (next: Scope) => {
    setScope(next);
    setCamera({ x: 0, y: 0, scale: 1 });
    setInspector(null);
  };
  const inspectRelations = (keys: string[], title: string) => setInspector({ kind: "relations", keys, title });
  const handleFiles = async (files: FileList | File[]) => {
    const parsed: ParsedTable[] = [];
    const errors: string[] = [];
    await Promise.all([...files].map(async (file) => {
      try {
        parsed.push(normalizeTable(JSON.parse(await file.text())));
      } catch (error) {
        errors.push(`${file.name}: ${error instanceof Error ? error.message : "解析失败"}`);
      }
    }));
    parsed.sort((a, b) => a.tableName.localeCompare(b.tableName));
    setPendingTables(parsed);
    setImportErrors(errors);
  };
  const importTables = () => {
    const domain0 = importDomain0.trim() || UNCLASSIFIED;
    const prepared: SchemaTable[] = pendingTables.map((table) => {
      const domain1 = normalizeDomain1(table.folder);
      return {
        ...table,
        className: defaultClassName(table.tableName),
        classDescription: table.description,
        classAliases: [],
        annotationStatus: "unannotated",
        domain0,
        domain1,
        folder: domain1,
        columns: table.columns.map(migrateColumn),
      };
    });
    const existingIndex = new Map(tables.map((table) => [table.tableName, table]));
    const next = prepared.map((table) => mergeImportedTable(existingIndex.get(table.tableName), table));
    const merged = new Map(tables.map((table) => [table.tableName, table]));
    next.forEach((table) => merged.set(table.tableName, table));
    const mergedTables = migrateTables([...merged.values()]).sort((a, b) => a.tableName.localeCompare(b.tableName));
    setTables(mergedTables);
    addChanges(next.map((table) => {
      const before = existingIndex.get(table.tableName);
      return {
        action: "import_tables",
        label: `${before ? "更新" : "导入"}表 ${table.tableName}`,
        tableName: table.tableName,
        tableSnapshot: makeTableAuditSnapshot(table),
        before: before ?? null,
        after: makeTableAuditSnapshot(table),
      };
    }));
    setImportOpen(false);
    setPendingTables([]);
    setImportErrors([]);
    enterScope({ level: "global" });
    const directCount = next.filter((table) => !table.domain1).length;
    toast.success(`已导入 ${next.length} 张表`, { description: `0级域：${domain0}${directCount ? `；${directCount} 张表没有 1级域` : ""}。` });
  };
  const deleteTables = () => {
    if (deleteTargets.length === 0) return;
    const targets = new Set(deleteTargets);
    const affectedRelations = relationships.filter((relationship) => targets.has(relationship.parentTable) || targets.has(relationship.childTable));
    const deletedRelationCount = affectedRelations.length;
    const keepRelation = (relationship: Relationship) => !targets.has(relationship.parentTable) && !targets.has(relationship.childTable);
    const deletedTables = tables.filter((table) => targets.has(table.tableName));
    const remaining = tables
      .filter((table) => !targets.has(table.tableName))
      .map((table) => ({
        ...table,
        foreignKeys: table.foreignKeys.filter(keepRelation),
        referencedBy: table.referencedBy.filter(keepRelation),
      }));
    let nextScope: Scope = scope;
    if (scope.level === "focus" && targets.has(scope.tableName)) nextScope = { level: "global" };
    else if (scope.level === "domain" && !remaining.some((table) => table.domain0 === scope.domain0)) nextScope = { level: "global" };
    else if (scope.level === "folder" && !remaining.some((table) => table.domain0 === scope.domain0 && table.domain1 === scope.domain1)) {
      nextScope = remaining.some((table) => table.domain0 === scope.domain0) ? { level: "domain", domain0: scope.domain0 } : { level: "global" };
    }
    const tableIndex = new Map(tables.map((table) => [table.tableName, table]));
    const auditDrafts: ChangeRecordDraft[] = deletedTables.map((table) => ({
      action: "delete_table",
      label: `删除表 ${table.tableName}`,
      tableName: table.tableName,
      tableSnapshot: makeTableAuditSnapshot(table),
      before: table,
      after: null,
    }));
    const cleanupByTable = new Map<string, Relationship[]>();
    affectedRelations.forEach((relationship) => {
      [relationship.parentTable, relationship.childTable].forEach((tableName) => {
        if (targets.has(tableName) || !tableIndex.has(tableName)) return;
        const current = cleanupByTable.get(tableName) ?? [];
        if (!current.some((item) => relationKey(item) === relationKey(relationship))) cleanupByTable.set(tableName, [...current, relationship]);
      });
    });
    cleanupByTable.forEach((related, tableName) => {
      const table = tableIndex.get(tableName)!;
      auditDrafts.push({
        action: "update_relationship",
        label: `因删除${targets.size === 1 ? `表 ${deleteTargets[0]}` : ` ${targets.size} 张关联表`}，清理 ${related.length} 条外键关系`,
        tableName,
        tableSnapshot: makeTableAuditSnapshot(table),
        before: related,
        after: [],
      });
    });
    addChanges(auditDrafts);
    setTables(remaining);
    setScope(nextScope);
    setCamera({ x: 0, y: 0, scale: 1 });
    setInspector(null);
    setDeleteTargets([]);
    toast.success(`已删除 ${targets.size} 张表`, { description: `同时移除 ${deletedRelationCount} 条相关关系，操作已记录。` });
  };

  const saveFieldAnnotation = (annotation: ColumnAnnotation) => {
    if (!fieldTarget || !selectedField || !selectedFieldTable) return;
    const before = migrateColumn(selectedField).annotation;
    const previousStatus = getTableAnnotationStatus(selectedFieldTable);
    const nextTable = settleTableAnnotationStatus({
      ...selectedFieldTable,
      columns: selectedFieldTable.columns.map((column) => column.name === fieldTarget.fieldName ? { ...column, annotation } : column),
    });
    setTables((current) => current.map((table) => table.tableName === nextTable.tableName ? nextTable : table));
    addChanges([{
      action: "update_field",
      label: `更新字段标注 ${fieldTarget.tableName}.${fieldTarget.fieldName}`,
      tableName: fieldTarget.tableName,
      fieldName: fieldTarget.fieldName,
      tableSnapshot: makeTableAuditSnapshot(nextTable),
      before: { annotation: before, annotationStatus: previousStatus },
      after: { annotation, annotationStatus: getTableAnnotationStatus(nextTable) },
    }]);
    setFieldTarget(null);
    toast.success("字段标注已保存");
  };

  const deleteField = () => {
    if (!fieldDeleteTarget) return;
    const target = fieldDeleteTarget;
    const table = tables.find((item) => item.tableName === target.tableName);
    const column = table?.columns.find((item) => item.name === target.fieldName);
    if (!table || !column) return setFieldDeleteTarget(null);
    const relationTouchesField = (relationship: Relationship) => relationship.columnMapping.some((mapping) =>
      (relationship.parentTable === target.tableName && mapping.parentColumn === target.fieldName)
      || (relationship.childTable === target.tableName && mapping.childColumn === target.fieldName));
    const affectedRelations = relationships.filter(relationTouchesField);
    const affected = affectedRelations.length;
    const cleanRelations = (items: Relationship[]) => items.flatMap((relationship) => {
      const columnMapping = relationship.columnMapping.filter((mapping) => !(
        (relationship.parentTable === target.tableName && mapping.parentColumn === target.fieldName)
        || (relationship.childTable === target.tableName && mapping.childColumn === target.fieldName)
      ));
      return columnMapping.length ? [{ ...relationship, columnMapping }] : [];
    });
    const previousStatus = getTableAnnotationStatus(table);
    const nextTables = tables.map((item) => {
      const cleaned = {
        ...item,
        columns: item.tableName === target.tableName ? item.columns.filter((field) => field.name !== target.fieldName) : item.columns,
        foreignKeys: cleanRelations(item.foreignKeys),
        referencedBy: cleanRelations(item.referencedBy),
      };
      if (item.tableName !== target.tableName) return cleaned;
      return previousStatus === "unannotated"
        ? { ...cleaned, annotationStatus: "unannotated" as const }
        : settleTableAnnotationStatus(cleaned);
    });
    const nextTargetTable = nextTables.find((item) => item.tableName === target.tableName)!;
    setTables(nextTables);
    const tableIndex = new Map(tables.map((item) => [item.tableName, item]));
    const auditDrafts: ChangeRecordDraft[] = [{
      action: "delete_field",
      label: `删除字段 ${target.tableName}.${target.fieldName}`,
      tableName: target.tableName,
      fieldName: target.fieldName,
      tableSnapshot: makeTableAuditSnapshot(nextTargetTable),
      before: { column, index: table.columns.findIndex((item) => item.name === target.fieldName), relationships: affectedRelations, annotationStatus: previousStatus },
      after: null,
    }];
    relationshipNeighbors(target.tableName, affectedRelations).forEach((tableName) => {
      const relatedTable = tableIndex.get(tableName);
      if (!relatedTable) return;
      const related = affectedRelations.filter((relationship) => relationship.parentTable === tableName || relationship.childTable === tableName);
      auditDrafts.push({
        action: "update_relationship",
        label: `因删除 ${target.tableName}.${target.fieldName}，更新 ${related.length} 条关联外键`,
        tableName,
        tableSnapshot: makeTableAuditSnapshot(relatedTable),
        before: related,
        after: cleanRelations(related),
      });
    });
    addChanges(auditDrafts);
    setFieldDeleteTarget(null);
    setFieldTarget(null);
    toast.success(`已删除字段 ${target.fieldName}`, { description: `${affected} 条相关外键映射已同步清理，操作已记录。` });
  };

  const saveTableConfig = (value: { className: string; classDescription: string; classAliases: string[] }) => {
    if (!selectedConfigTable) return;
    const duplicate = tables.find((table) => table.tableName !== selectedConfigTable.tableName && table.className.toLowerCase() === value.className.toLowerCase());
    if (duplicate) return setTableConfigError(`类名已被 ${duplicate.tableName} 使用，请保持一表一类。`);
    const before = { className: selectedConfigTable.className, classDescription: selectedConfigTable.classDescription, classAliases: selectedConfigTable.classAliases, annotationStatus: getTableAnnotationStatus(selectedConfigTable) };
    const nextTable = settleTableAnnotationStatus({ ...selectedConfigTable, ...value });
    setTables((current) => current.map((table) => table.tableName === nextTable.tableName ? nextTable : table));
    addChanges([{ action: "update_class_name", label: `更新 ${selectedConfigTable.tableName} 的类信息`, tableName: selectedConfigTable.tableName, tableSnapshot: makeTableAuditSnapshot(nextTable), before, after: { ...value, annotationStatus: getTableAnnotationStatus(nextTable) } }]);
    setTableConfigTarget(null);
    setTableConfigError("");
    toast.success("类信息已保存");
  };

  const applyAiDraft = (draft: AiTableDraft, session: AiSession) => {
    const table = tables.find((item) => item.tableName === draft.tableName);
    if (!table) throw new Error(`表 ${draft.tableName} 已不存在，无法应用草稿`);
    const duplicate = tables.find((item) => item.tableName !== table.tableName && item.className.toLowerCase() === draft.className.trim().toLowerCase());
    if (duplicate) throw new Error(`类名 ${draft.className} 已被 ${duplicate.tableName} 使用`);
    const next = { ...mergeAiDraftIntoTable(table, draft), annotationStatus: "completed" as const };
    const validationErrors = validateExportConfiguration([next]);
    if (validationErrors.length) throw new Error(`审核草稿仍有必填项未完成：${validationErrors.slice(0, 3).join("；")}`);
    const before = {
      className: table.className,
      classDescription: table.classDescription,
      classAliases: table.classAliases,
      annotationStatus: getTableAnnotationStatus(table),
      annotations: Object.fromEntries(table.columns.map((column) => [column.name, migrateColumn(column).annotation])),
    };
    const after = {
      className: next.className,
      classDescription: next.classDescription,
      classAliases: next.classAliases,
      annotationStatus: "completed",
      annotations: Object.fromEntries(next.columns.map((column) => [column.name, migrateColumn(column).annotation])),
    };
    setTables((current) => current.map((item) => item.tableName === next.tableName ? next : item));
    addChanges([{
      action: "apply_ai_draft",
      label: `应用 AI 与人工审核后的标注草稿`,
      tableName: next.tableName,
      tableSnapshot: makeTableAuditSnapshot(next),
      source: "claude-code",
      sessionId: session.id,
      before,
      after,
    }]);
  };

  const markAnnotationsInProgress = (tableNames: string[]) => {
    const targets = new Set(tableNames);
    if (targets.size === 0) return;
    setTables((current) => current.map((table) => targets.has(table.tableName)
      ? { ...table, annotationStatus: "in_progress" }
      : table));
  };

  const resetAnnotations = () => {
    if (!annotationResetTarget) return;
    const table = tables.find((item) => item.tableName === annotationResetTarget);
    if (!table) return setAnnotationResetTarget(null);
    const occupiedClassNames = tables.filter((item) => item.tableName !== table.tableName).map((item) => item.className);
    const reset = resetTableAnnotations(table, occupiedClassNames);
    setTables((current) => current.map((item) => item.tableName === reset.tableName ? reset : item));
    addChanges([{
      action: "reset_annotations",
      label: `清空表 ${table.tableName} 的全部标注`,
      tableName: table.tableName,
      tableSnapshot: makeTableAuditSnapshot(reset),
      before: table,
      after: reset,
    }]);
    setAnnotationResetTarget(null);
    toast.success(`已清空 ${table.tableName} 的标注`, { description: "原始字段、域、外键和 Claude Code Session 均已保留，可从本表变更记录恢复。" });
  };

  const renameDomain = (newName: string) => {
    if (!renameTarget) return;
    if (renameTarget.level === 0) {
      const before = renameTarget.currentName;
      if (!newName || newName === before) return setRenameTarget(null);
      const affectedTables = tables.filter((table) => table.domain0 === before);
      setTables((current) => current.map((table) => table.domain0 === before ? { ...table, domain0: newName } : table));
      setScope((current) => {
        if ((current.level === "domain" || current.level === "folder") && current.domain0 === before) return { ...current, domain0: newName };
        return current;
      });
      addChanges(affectedTables.map((table) => ({ action: "rename_domain0", label: `0级域 ${before} → ${newName}`, tableName: table.tableName, tableSnapshot: makeTableAuditSnapshot({ ...table, domain0: newName }), before: { domain0: before }, after: { domain0: newName } })));
    } else {
      const { domain0, currentName } = renameTarget;
      const normalized = normalizeDomain1(newName);
      if (normalized === currentName) return setRenameTarget(null);
      const affectedTables = tables.filter((table) => table.domain0 === domain0 && table.domain1 === currentName);
      setTables((current) => current.map((table) => table.domain0 === domain0 && table.domain1 === currentName ? { ...table, domain1: normalized, folder: normalized } : table));
      setScope((current) => current.level === "folder" && current.domain0 === domain0 && current.domain1 === currentName
        ? normalized ? { level: "folder", domain0, domain1: normalized } : { level: "domain", domain0 }
        : current);
      addChanges(affectedTables.map((table) => ({ action: "rename_domain1", label: `1级域 ${currentName} → ${normalized || "无"}`, tableName: table.tableName, tableSnapshot: makeTableAuditSnapshot({ ...table, domain1: normalized, folder: normalized }), before: { domain0, domain1: currentName }, after: { domain0, domain1: normalized } })));
    }
    setRenameTarget(null);
    setCamera({ x: 0, y: 0, scale: 1 });
    toast.success("域名已更新", { description: "相关表、目录和导出路径已同步。" });
  };

  const downloadBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const exportAnnotations = () => {
    const errors = validateExportConfiguration(tables);
    if (errors.length) return toast.error("导出前需要修正配置", { description: errors.slice(0, 3).join("；") });
    const files = buildExportFiles(tables);
    const zip = createZip(files);
    const buffer = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
    downloadBlob(new Blob([buffer], { type: "application/zip" }), `schema-atlas-annotations-${new Date().toISOString().slice(0, 10)}.zip`);
    toast.success(`已导出 ${files.length} 个 JSON 文件`, { description: "包含 ontologies、rdb-mapping 及枚举目录。" });
  };
  const exportTableAudit = (tableName: string) => {
    const group = buildTableChangeHistoryExport(changeHistory, tableName);
    if (!group) return toast.error("这张表还没有变更记录");
    downloadBlob(new Blob([JSON.stringify(group, null, 2)], { type: "application/json" }), `${tableName}-change-log-${new Date().toISOString().slice(0, 10)}.json`);
  };

  const restoreChange = () => {
    if (!restoreTarget) return;
    const record = restoreTarget;
    const current = tables.find((table) => table.tableName === record.tableName);
    const restored = restoreTableFromChange(current, record);
    if (restored === undefined) {
      setRestoreTarget(null);
      return toast.error("这条旧记录没有完整前态，无法安全恢复");
    }
    if (restored) {
      const duplicate = tables.find((table) => table.tableName !== restored.tableName && table.className.toLowerCase() === restored.className.toLowerCase());
      if (duplicate) return toast.error("恢复会造成类名冲突", { description: `${restored.className} 已由 ${duplicate.tableName} 使用。` });
    }
    const nextTables = restored === null
      ? tables.filter((table) => table.tableName !== record.tableName)
      : current
        ? tables.map((table) => table.tableName === record.tableName ? restored : table)
        : [...tables, restored];
    setTables(migrateTables(nextTables).sort((left, right) => left.tableName.localeCompare(right.tableName)));
    addChanges([{
      action: "restore_change",
      label: `恢复“${record.label}”之前的状态`,
      tableName: record.tableName,
      fieldName: record.fieldName,
      tableSnapshot: restored ? makeTableAuditSnapshot(restored) : current ? makeTableAuditSnapshot(current) : record.tableSnapshot,
      before: current ?? null,
      after: restored ? makeTableAuditSnapshot(restored) : null,
    }]);
    if (restored === null) {
      if (scope.level === "focus" && scope.tableName === record.tableName) setScope({ level: "global" });
      setInspector(null);
    } else if (!current) {
      setScope({ level: "focus", tableName: restored.tableName });
      setInspector({ kind: "table", tableName: restored.tableName });
    }
    setCamera({ x: 0, y: 0, scale: 1 });
    setRestoreTarget(null);
    toast.success(restored ? `已恢复 ${record.tableName}` : `已恢复到 ${record.tableName} 尚未导入的状态`, { description: "本次恢复已记录，仍可再次恢复到操作前。" });
  };

  const deleteFieldColumn = fieldDeleteTarget
    ? tables.find((table) => table.tableName === fieldDeleteTarget.tableName)?.columns.find((column) => column.name === fieldDeleteTarget.fieldName)
    : undefined;
  const deleteFieldRelations = fieldDeleteTarget ? relationships.filter((relationship) => relationship.columnMapping.some((mapping) =>
    (relationship.parentTable === fieldDeleteTarget.tableName && mapping.parentColumn === fieldDeleteTarget.fieldName)
    || (relationship.childTable === fieldDeleteTarget.tableName && mapping.childColumn === fieldDeleteTarget.fieldName))).length : 0;
  const annotationResetTable = annotationResetTarget ? tables.find((table) => table.tableName === annotationResetTarget) : undefined;

  if (aiOpen) return <>
    <AiPanel open onOpenChange={setAiOpen} tables={tables} datasetReady={storageReady} initialTableName={aiTableTarget} onReviewTable={setAiTableTarget} onAnnotationStarted={markAnnotationsInProgress} onApplyDraft={applyAiDraft} />
    <Toaster position="bottom-right" />
  </>;

  return <main className={`atlas-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    <AppSidebar
      collapsed={sidebarCollapsed}
      tables={tables}
      relationships={relationships}
      scope={scope}
      search={search}
      onSearch={setSearch}
      onToggle={() => setSidebarCollapsed((value) => !value)}
      onScope={enterScope}
      onInspectRelations={inspectRelations}
      onRequestDelete={setDeleteTargets}
      recoverableDeletedTables={recoverableDeletedTables}
      onRestoreDeletedTable={setRestoreTarget}
      onRenameDomain0={(domain0) => setRenameTarget({ level: 0, currentName: domain0 })}
      onRenameDomain1={(domain0, domain1) => setRenameTarget({ level: 1, domain0, currentName: domain1 })}
    />
    <div className="atlas-workspace">
      <header className="workspace-bar">
        <div>
          <Breadcrumbs scope={scope} tables={tables} onScope={enterScope} />
          <div className="workspace-title"><Database size={17} /><span>表关系拓扑</span><em>从全局依赖到字段标注</em></div>
        </div>
        <div className="workspace-actions">
          <div className="model-status"><i />{tables.length} 表<span />{relationships.length} 关系<span />{crossDomainCount} 跨域{fieldGapCount > 0 && <><span /><strong className="quality-alert"><CircleAlert size={12} />{fieldGapCount} 字段缺口</strong></>}</div>
          <div className="annotation-overview" aria-label="表标注状态汇总">
            <strong className="completed">{annotationCounts.completed} 完整</strong>
            <strong className="in_progress">{annotationCounts.in_progress} 标注中</strong>
            <strong className="unannotated">{annotationCounts.unannotated} 未标注</strong>
          </div>
          <Button variant="outline" className="ai-toolbar-button" onClick={() => { setAiTableTarget(null); setAiOpen(true); }}><Sparkles size={16} />AI 标注</Button>
          <Button variant="outline" onClick={exportAnnotations}><FileArchive size={16} />导出标注</Button>
          <Button onClick={() => setImportOpen(true)}><Plus size={16} />导入 JSON</Button>
        </div>
      </header>
      <GraphCanvas
        graph={graph}
        scope={scope}
        tables={tables}
        depth={depth}
        direction={direction}
        camera={camera}
        onCamera={setCamera}
        onScope={enterScope}
        onDepth={setDepth}
        onDirection={setDirection}
        onInspector={setInspector}
      />
    </div>
    <InspectorSheet
      inspector={inspector}
      graph={graph}
      tables={tables}
      relationships={relationships}
      changeHistory={changeHistory}
      onClose={() => setInspector(null)}
      onFocus={(tableName) => enterScope({ level: "focus", tableName })}
      onDelete={(tableName) => setDeleteTargets([tableName])}
      onEditField={(tableName, fieldName) => setFieldTarget({ tableName, fieldName })}
      onRequestDeleteField={(tableName, fieldName) => setFieldDeleteTarget({ tableName, fieldName })}
      onEditTable={(tableName) => { setTableConfigError(""); setTableConfigTarget(tableName); }}
      onOpenAi={(tableName) => { setInspector(null); setAiTableTarget(tableName); setAiOpen(true); }}
      onResetAnnotations={setAnnotationResetTarget}
      onExportChanges={exportTableAudit}
      onRestoreChange={setRestoreTarget}
    />
    <DeleteTablesDialog tableNames={deleteTargets} relationships={relationships} onCancel={() => setDeleteTargets([])} onConfirm={deleteTables} />
    <AlertDialog open={Boolean(fieldDeleteTarget && deleteFieldColumn)} onOpenChange={(open) => { if (!open) setFieldDeleteTarget(null); }}>
      <AlertDialogContent className="delete-dialog"><AlertDialogHeader><div className="delete-dialog-mark"><Trash2 size={20} /></div><AlertDialogTitle>删除字段 {fieldDeleteTarget?.fieldName}？</AlertDialogTitle><AlertDialogDescription>该字段会从 {fieldDeleteTarget?.tableName} 移除，并清理 {deleteFieldRelations} 条关系中的对应列映射。删除前内容会写入变更记录。</AlertDialogDescription></AlertDialogHeader><div className="delete-table-preview"><code>{fieldDeleteTarget?.tableName}.{fieldDeleteTarget?.fieldName}</code><span>{deleteFieldColumn?.description || "暂无字段说明"}</span></div><AlertDialogFooter><AlertDialogCancel onClick={() => setFieldDeleteTarget(null)}>取消</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={deleteField}><Trash2 size={14} />确认删除字段</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={Boolean(annotationResetTarget && annotationResetTable)} onOpenChange={(open) => { if (!open) setAnnotationResetTarget(null); }}>
      <AlertDialogContent className="reset-annotations-dialog">
        <AlertDialogHeader>
          <div className="reset-dialog-mark"><RotateCcw size={20} /></div>
          <AlertDialogTitle>清空表 {annotationResetTable?.tableName} 的全部标注？</AlertDialogTitle>
          <AlertDialogDescription>类名、类说明、类别名和全部字段标注将恢复到刚导入时的默认状态。原始表结构、导入字段说明、域、外键关系及 Claude Code Session 不会删除。</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="reset-annotations-preview">
          <div><span>当前状态</span>{annotationResetTable && <AnnotationStatusPill table={annotationResetTable} />}</div>
          <div><span>对应类</span><code>{annotationResetTable?.className}</code></div>
          <div><span>涉及字段</span><strong>{annotationResetTable?.columns.length ?? 0}</strong></div>
        </div>
        <p className="reset-annotations-note">本次清空会写入该表的变更记录，之后可以在表详情的“变更”页签中恢复。</p>
        <AlertDialogFooter><AlertDialogCancel onClick={() => setAnnotationResetTarget(null)}>取消</AlertDialogCancel><AlertDialogAction className="reset-annotations-confirm" onClick={resetAnnotations}><RotateCcw size={14} />确认清空标注</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={Boolean(restoreTarget)} onOpenChange={(open) => { if (!open) setRestoreTarget(null); }}>
      <AlertDialogContent className="restore-dialog"><AlertDialogHeader><div className="restore-dialog-mark"><RotateCcw size={20} /></div><AlertDialogTitle>恢复到这次变更之前？</AlertDialogTitle><AlertDialogDescription>将恢复“{restoreTarget?.label}”发生前与 {restoreTarget?.tableName} 相关的内容。较新的同表编辑可能被覆盖；本次恢复也会生成一条新的可恢复记录。</AlertDialogDescription></AlertDialogHeader><div className="restore-change-preview"><code>{restoreTarget?.tableName}{restoreTarget?.fieldName ? `.${restoreTarget.fieldName}` : ""}</code><span>{restoreTarget ? new Date(restoreTarget.timestamp).toLocaleString("zh-CN", { hour12: false }) : ""}</span></div><AlertDialogFooter><AlertDialogCancel onClick={() => setRestoreTarget(null)}>取消</AlertDialogCancel><AlertDialogAction onClick={restoreChange}><RotateCcw size={14} />确认恢复</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
    <ImportDialog open={importOpen} onOpenChange={setImportOpen} pending={pendingTables} errors={importErrors} domain0={importDomain0} onDomain0={setImportDomain0} onFiles={handleFiles} onImport={importTables} />
    <FieldEditorDialog open={Boolean(fieldTarget && selectedFieldTable && selectedField)} table={selectedFieldTable} column={selectedField} onOpenChange={(open) => { if (!open) setFieldTarget(null); }} onSave={saveFieldAnnotation} onDelete={() => { if (fieldTarget) setFieldDeleteTarget(fieldTarget); setFieldTarget(null); }} />
    <TableConfigDialog open={Boolean(tableConfigTarget && selectedConfigTable)} table={selectedConfigTable} error={tableConfigError} onOpenChange={(open) => { if (!open) { setTableConfigTarget(null); setTableConfigError(""); } }} onSave={saveTableConfig} />
    <RenameDomainDialog open={Boolean(renameTarget)} level={renameTarget?.level ?? 0} currentName={renameTarget?.currentName ?? ""} onOpenChange={(open) => { if (!open) setRenameTarget(null); }} onSave={renameDomain} />
    <Toaster position="bottom-right" />
  </main>;
}
