"use client";

import { useState } from "react";
import { Clock3, Download, FilePenLine, Plus, Tags, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { Column, ColumnAnnotation, EnumValue, SchemaTable, SemanticRole, Sensitivity } from "./data";
import { ChangeRecord, migrateColumn, normalizeExportType } from "./schema-utils";

const SEMANTIC_ROLES: { value: SemanticRole; label: string }[] = [
  { value: "identifier", label: "标识" },
  { value: "name", label: "名称" },
  { value: "time", label: "时间" },
  { value: "amount", label: "金额/额度" },
  { value: "quantity", label: "数量" },
  { value: "status", label: "状态" },
  { value: "code", label: "编码/类型" },
  { value: "description", label: "描述" },
  { value: "other", label: "其他" },
];

const SENSITIVITIES: { value: Sensitivity; label: string }[] = [
  { value: "none", label: "未标注" },
  { value: "internal", label: "内部" },
  { value: "sensitive", label: "敏感" },
  { value: "restricted", label: "受限" },
];

function parseList(value: string) {
  return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))];
}

function FieldEditorForm({
  table,
  column,
  onOpenChange,
  onSave,
  onDelete,
}: {
  table: SchemaTable;
  column: Column;
  onOpenChange: (open: boolean) => void;
  onSave: (annotation: ColumnAnnotation) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<ColumnAnnotation>(() => migrateColumn(column).annotation!);
  const [aliasesText, setAliasesText] = useState(() => draft.aliases.join("，"));
  const [tagsText, setTagsText] = useState(() => draft.tags.join("，"));
  const [enumAliasTexts, setEnumAliasTexts] = useState(() => draft.enumValues.map((item) => item.aliases.join("，")));
  const update = <K extends keyof ColumnAnnotation>(key: K, value: ColumnAnnotation[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const updateEnum = (index: number, patch: Partial<EnumValue>) => update("enumValues", draft.enumValues.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const addEnum = () => {
    update("enumValues", [...draft.enumValues, { value: "", description: "", descriptionEn: "", aliases: [] }]);
    setEnumAliasTexts((current) => [...current, ""]);
  };
  const removeEnum = (index: number) => {
    update("enumValues", draft.enumValues.filter((_, itemIndex) => itemIndex !== index));
    setEnumAliasTexts((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };
  const canSave = draft.entityColumn.trim().length > 0 && (!draft.enumRef || draft.enumValues.every((item) => item.value.trim()));

  return <DialogContent className="field-editor-dialog sm:max-w-3xl">
    <DialogHeader>
      <div className="dialog-mark"><FilePenLine size={20} /></div>
      <DialogTitle>字段标注 · {column.name}</DialogTitle>
      <DialogDescription>{table.className} · 数据库类型 {column.dataType} → 导出类型 {normalizeExportType(column.dataType)}</DialogDescription>
    </DialogHeader>
    <div className="editor-scroll">
      <section className="editor-switch-row">
        <div><strong>导出该字段</strong><span>关闭后，本体与 RDB Mapping 都不会包含它</span></div>
        <Switch checked={draft.included} onCheckedChange={(checked) => update("included", checked)} />
      </section>

      <section className="editor-section">
        <h3>属性基础信息</h3>
        <div className="editor-grid two">
          <label><span>属性名 attr_name</span><Input value={draft.entityColumn} onChange={(event) => update("entityColumn", event.target.value)} placeholder="freeUnitInstanceID" /></label>
          <label><span>字段别名（逗号或换行分隔）</span><Input value={aliasesText} onChange={(event) => setAliasesText(event.target.value)} placeholder="标识，主键" /></label>
        </div>
        <label><span>详细中文描述</span><Textarea value={draft.detailedDescription} onChange={(event) => update("detailedDescription", event.target.value)} placeholder={column.remark || column.description || "说明字段的业务含义、使用规则和联动要求"} /></label>
        <div className="editor-boolean-grid">
          <label><Switch checked={draft.isLocalId} onCheckedChange={(checked) => update("isLocalId", checked)} /><span><strong>is_local_id</strong><small>false 时不导出</small></span></label>
          <label><Switch checked={draft.isDisplayName} onCheckedChange={(checked) => update("isDisplayName", checked)} /><span><strong>is_display_name</strong><small>作为对象显示名称</small></span></label>
          <label><Switch checked={draft.isSemantic} onCheckedChange={(checked) => update("isSemantic", checked)} /><span><strong>is_semantic</strong><small>参与语义理解</small></span></label>
          <label><Switch checked={draft.isCode} onCheckedChange={(checked) => update("isCode", checked)} /><span><strong>is_code</strong><small>标识编码类属性</small></span></label>
        </div>
      </section>

      <section className="editor-section">
        <h3>辅助治理信息</h3>
        <div className="editor-grid four">
          <label><span>语义角色</span><select value={draft.semanticRole} onChange={(event) => update("semanticRole", event.target.value as SemanticRole)}>{SEMANTIC_ROLES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label><span>敏感级别</span><select value={draft.sensitivity} onChange={(event) => update("sensitivity", event.target.value as Sensitivity)}>{SENSITIVITIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
          <label><span>单位</span><Input value={draft.unit} onChange={(event) => update("unit", event.target.value)} placeholder="MB / 分钟" /></label>
          <label><span>取值范围</span><Input value={draft.valueRange} onChange={(event) => update("valueRange", event.target.value)} placeholder="例如 ≥ 0" /></label>
        </div>
        <label><span>治理标签（逗号或换行分隔）</span><Input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="计费，资源，关键字段" /></label>
      </section>

      <section className="editor-section enum-editor">
        <div className="editor-section-heading"><div><h3>枚举引用</h3><p>设置后，字段只输出 enum_ref，枚举定义单独写入当前 0级域的 enums 文件夹。</p></div><Badge variant="outline">{draft.enumValues.length} 个值</Badge></div>
        <div className="editor-grid two">
          <label><span>enum_ref</span><Input value={draft.enumRef} onChange={(event) => update("enumRef", event.target.value)} placeholder="QuotaCycleType" /></label>
          <label><span>枚举说明</span><Input value={draft.enumDescription} onChange={(event) => update("enumDescription", event.target.value)} placeholder="免费资源代付限额周期类型" /></label>
        </div>
        {draft.enumRef && <div className="enum-values">
          {draft.enumValues.map((item, index) => <article key={`${index}-${item.value}`}>
            <Input value={item.value} onChange={(event) => updateEnum(index, { value: event.target.value })} placeholder="值，如 D" />
            <Input value={item.description} onChange={(event) => updateEnum(index, { description: event.target.value })} placeholder="中文说明" />
            <Input value={item.descriptionEn} onChange={(event) => updateEnum(index, { descriptionEn: event.target.value })} placeholder="English description" />
            <Input value={enumAliasTexts[index] ?? ""} onChange={(event) => setEnumAliasTexts((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.value : value))} placeholder="别名" />
            <button onClick={() => removeEnum(index)} aria-label={`删除枚举值 ${item.value || index + 1}`}><Trash2 size={14} /></button>
          </article>)}
          <Button type="button" variant="outline" onClick={addEnum}><Plus size={14} />添加枚举值</Button>
        </div>}
      </section>
    </div>
    <DialogFooter className="editor-footer">
      <Button variant="outline" className="editor-delete" onClick={onDelete}><Trash2 size={14} />删除字段</Button>
      <div><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button disabled={!canSave} onClick={() => onSave({ ...draft, entityColumn: draft.entityColumn.trim(), aliases: parseList(aliasesText), tags: parseList(tagsText), enumRef: draft.enumRef.trim(), enumValues: draft.enumValues.map((item, index) => ({ ...item, value: item.value.trim(), aliases: parseList(enumAliasTexts[index] ?? "") })) })}>保存标注</Button></div>
    </DialogFooter>
  </DialogContent>;
}

export function FieldEditorDialog({
  open,
  table,
  column,
  onOpenChange,
  onSave,
  onDelete,
}: {
  open: boolean;
  table?: SchemaTable;
  column?: Column;
  onOpenChange: (open: boolean) => void;
  onSave: (annotation: ColumnAnnotation) => void;
  onDelete: () => void;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    {table && column && <FieldEditorForm key={`${table.tableName}:${column.name}:${open}`} table={table} column={column} onOpenChange={onOpenChange} onSave={onSave} onDelete={onDelete} />}
  </Dialog>;
}

function TableConfigForm({ table, onOpenChange, onSave, error }: { table: SchemaTable; onOpenChange: (open: boolean) => void; onSave: (value: { className: string; classDescription: string; classAliases: string[] }) => void; error?: string }) {
  const [className, setClassName] = useState(table.className);
  const [description, setDescription] = useState(table.classDescription || table.description);
  const [aliases, setAliases] = useState(table.classAliases.join("，"));
  return <DialogContent className="table-config-dialog sm:max-w-xl">
    <DialogHeader><div className="dialog-mark"><Tags size={20} /></div><DialogTitle>配置类 · {table.tableName}</DialogTitle><DialogDescription>一张表对应一个唯一类，类信息用于本体与 RDB Mapping 文件命名。</DialogDescription></DialogHeader>
    <div className="table-config-fields">
      <label><span>类名 class_name</span><Input value={className} onChange={(event) => setClassName(event.target.value)} placeholder="FreeUnitInstance" /></label>
      <label><span>类别名（逗号或换行分隔）</span><Input value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="赠送实例，免费流量，套餐内时长" /></label>
      <label><span>类的详细中文描述</span><Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={7} /></label>
      {error && <p className="editor-error">{error}</p>}
    </div>
    <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button disabled={!className.trim()} onClick={() => onSave({ className: className.trim(), classDescription: description.trim(), classAliases: parseList(aliases) })}>保存类信息</Button></DialogFooter>
  </DialogContent>;
}

export function TableConfigDialog({ open, table, onOpenChange, onSave, error }: { open: boolean; table?: SchemaTable; onOpenChange: (open: boolean) => void; onSave: (value: { className: string; classDescription: string; classAliases: string[] }) => void; error?: string }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>{table && <TableConfigForm key={`${table.tableName}:${open}`} table={table} onOpenChange={onOpenChange} onSave={onSave} error={error} />}</Dialog>;
}

function RenameDomainForm({ level, currentName, onOpenChange, onSave }: { level: 0 | 1; currentName: string; onOpenChange: (open: boolean) => void; onSave: (name: string) => void }) {
  const [name, setName] = useState(currentName);
  return <DialogContent className="rename-domain-dialog sm:max-w-md">
    <DialogHeader><div className="dialog-mark"><FilePenLine size={20} /></div><DialogTitle>修改 {level}级域名称</DialogTitle><DialogDescription>{level === 0 ? "该域下所有表和导出目录将同步更新。" : "留空表示这些表不再设置 1级域，将直接挂在 0级域下。"}</DialogDescription></DialogHeader>
    <div className="rename-domain-field"><label htmlFor="renamed-domain">新名称</label><Input id="renamed-domain" autoFocus value={name} onChange={(event) => setName(event.target.value)} /></div>
    <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button disabled={level === 0 && !name.trim()} onClick={() => onSave(name.trim())}>保存并同步</Button></DialogFooter>
  </DialogContent>;
}

export function RenameDomainDialog({ open, level, currentName, onOpenChange, onSave }: { open: boolean; level: 0 | 1; currentName: string; onOpenChange: (open: boolean) => void; onSave: (name: string) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><RenameDomainForm key={`${level}:${currentName}:${open}`} level={level} currentName={currentName} onOpenChange={onOpenChange} onSave={onSave} /></Dialog>;
}

function actionLabel(action: ChangeRecord["action"]) {
  return ({
    import_tables: "导入表",
    delete_table: "删除表",
    delete_field: "删除字段",
    update_field: "更新字段标注",
    update_class_name: "更新类信息",
    rename_domain0: "修改 0级域",
    rename_domain1: "修改 1级域",
  } as const)[action];
}

export function AuditLogSheet({ open, records, onOpenChange, onDownload }: { open: boolean; records: ChangeRecord[]; onOpenChange: (open: boolean) => void; onDownload: () => void }) {
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent className="audit-sheet">
    <SheetHeader><div className="inspector-eyebrow"><Clock3 size={14} />本地审计</div><SheetTitle>变更记录</SheetTitle><SheetDescription>记录表、字段、域和类配置的变更；数据保存在当前浏览器。</SheetDescription></SheetHeader>
    <div className="audit-toolbar"><span>{records.length} 条记录</span><Button variant="outline" size="sm" onClick={onDownload} disabled={records.length === 0}><Download size={14} />导出记录</Button></div>
    <div className="audit-list">{records.map((record) => <article key={record.id}>
      <div><Badge variant="outline">{actionLabel(record.action)}</Badge><time>{new Date(record.timestamp).toLocaleString("zh-CN", { hour12: false })}</time></div>
      <strong>{record.label}</strong>
      {(record.tableName || record.fieldName) && <code>{[record.tableName, record.fieldName].filter(Boolean).join(".")}</code>}
    </article>)}{records.length === 0 && <div className="audit-empty">暂时没有变更记录</div>}</div>
  </SheetContent></Sheet>;
}
