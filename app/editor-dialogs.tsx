"use client";

import { useState } from "react";
import { CircleAlert, FilePenLine, Plus, RotateCcw, Tags, Trash2 } from "lucide-react";

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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { Column, ColumnAnnotation, EnumValue, SchemaTable } from "./data";
import { ChangeRecord, isChangeRestorable, migrateColumn, normalizeExportType } from "./schema-utils";

function parseList(value: string) {
  return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))];
}

function defaultEnumName(attributeName: string) {
  const normalized = attributeName.trim();
  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "";
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
  const [enumAliasTexts, setEnumAliasTexts] = useState(() => draft.enumValues.map((item) => item.aliases.join("，")));
  const [enumEnabled, setEnumEnabled] = useState(() => Boolean(draft.enumRef || draft.enumDescription || draft.enumValues.length));
  const update = <K extends keyof ColumnAnnotation>(key: K, value: ColumnAnnotation[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const updateEnum = (index: number, patch: Partial<EnumValue>) => update("enumValues", draft.enumValues.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const addEnum = () => {
    update("enumValues", [...draft.enumValues, { value: "", description: "", aliases: [] }]);
    setEnumAliasTexts((current) => [...current, ""]);
  };
  const removeEnum = (index: number) => {
    update("enumValues", draft.enumValues.filter((_, itemIndex) => itemIndex !== index));
    setEnumAliasTexts((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };
  const onEntityColumnChange = (value: string) => {
    const previousDefault = defaultEnumName(draft.entityColumn);
    setDraft((current) => ({
      ...current,
      entityColumn: value,
      enumRef: enumEnabled && (!current.enumRef || current.enumRef === previousDefault) ? defaultEnumName(value) : current.enumRef,
    }));
  };
  const onEnumEnabledChange = (checked: boolean) => {
    setEnumEnabled(checked);
    if (checked) {
      setDraft((current) => ({
        ...current,
        enumRef: current.enumRef || defaultEnumName(current.entityColumn),
        enumValues: current.enumValues.length ? current.enumValues : [{ value: "", description: "", aliases: [] }],
      }));
      if (draft.enumValues.length === 0) setEnumAliasTexts([""]);
      return;
    }
    setDraft((current) => ({ ...current, enumRef: "", enumDescription: "", enumValues: [] }));
    setEnumAliasTexts([]);
  };
  const parsedAliases = parseList(aliasesText);
  const parsedEnumValues = draft.enumValues.map((item, index) => ({
    value: item.value.trim(),
    description: item.description.trim(),
    aliases: parseList(enumAliasTexts[index] ?? ""),
  }));
  const missingRequired = draft.included ? [
    !draft.entityColumn.trim() ? "属性名" : "",
    parsedAliases.length === 0 ? "字段别名" : "",
    !draft.detailedDescription.trim() ? "中英文业务语义说明" : "",
    enumEnabled && !draft.enumRef.trim() ? "枚举名称" : "",
    enumEnabled && !draft.enumDescription.trim() ? "枚举说明" : "",
    enumEnabled && parsedEnumValues.length === 0 ? "枚举值" : "",
    ...parsedEnumValues.flatMap((item, index) => enumEnabled ? [
      !item.value ? `枚举值 ${index + 1} 的 value` : "",
      item.aliases.length === 0 ? `枚举值 ${index + 1} 的别名` : "",
      !item.description ? `枚举值 ${index + 1} 的说明` : "",
    ] : []),
  ].filter(Boolean) : [];
  const canSave = missingRequired.length === 0;

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

      {(column.description || column.remark) && <section className="editor-section imported-field-context">
        <h3>导入 JSON 中的字段资料</h3>
        {column.description && <div><span>description</span><p>{column.description}</p></div>}
        {column.remark && <div><span>remark</span><p>{column.remark}</p></div>}
      </section>}

      <section className="editor-section">
        <h3>属性基础信息</h3>
        <div className="editor-grid two">
          <label><span>属性名 attr_name <b>*</b></span><Input value={draft.entityColumn} onChange={(event) => onEntityColumnChange(event.target.value)} /></label>
          <label><span>字段别名 aliases（逗号或换行分隔）<b>*</b></span><Input value={aliasesText} onChange={(event) => setAliasesText(event.target.value)} /></label>
        </div>
        <label><span>中英文业务语义描述 description <b>*</b></span><Textarea value={draft.detailedDescription} onChange={(event) => update("detailedDescription", event.target.value)} /></label>
        <div className="editor-boolean-grid">
          <label><Switch checked={draft.isLocalId} onCheckedChange={(checked) => update("isLocalId", checked)} /><span><strong>is_local_id</strong><small>false 时不导出</small></span></label>
          <label><Switch checked={draft.isDisplayName} onCheckedChange={(checked) => update("isDisplayName", checked)} /><span><strong>is_display_name</strong><small>作为对象显示名称</small></span></label>
          <label><Switch checked={draft.isSemantic} onCheckedChange={(checked) => update("isSemantic", checked)} /><span><strong>is_semantic</strong><small>参与语义理解</small></span></label>
          <label><Switch checked={draft.isCode} onCheckedChange={(checked) => update("isCode", checked)} /><span><strong>is_code</strong><small>标识编码类属性</small></span></label>
        </div>
      </section>

      <section className="editor-section enum-editor">
        <div className="editor-section-heading"><div><h3>枚举引用</h3><p>开启后自动以 attr_name 首字母大写生成默认名称，也可手工修改；定义单独导出到当前 0级域的 enums 文件夹。</p></div><div className="enum-switch"><Badge variant="outline">{enumEnabled ? `${draft.enumValues.length} 个值` : "未开启"}</Badge><Switch checked={enumEnabled} onCheckedChange={onEnumEnabledChange} aria-label="启用枚举引用" /></div></div>
        {enumEnabled && <div className="enum-structure">
          <div className="editor-grid two">
            <label><span>枚举名称 enum_ref / enum_name <b>*</b></span><Input value={draft.enumRef} onChange={(event) => update("enumRef", event.target.value)} /></label>
            <label><span>枚举说明 description <b>*</b></span><Textarea value={draft.enumDescription} onChange={(event) => update("enumDescription", event.target.value)} rows={3} /></label>
          </div>
          <div className="enum-values-heading"><div><strong>枚举值 values</strong><span>每一项的值、别名和中英文业务说明都必须填写</span></div><Button type="button" variant="outline" size="sm" onClick={addEnum}><Plus size={14} />添加枚举值</Button></div>
          <div className="enum-values">
          {draft.enumValues.map((item, index) => <article key={`${index}-${item.value}`}>
            <div className="enum-value-heading"><strong>枚举项 {index + 1}</strong><button type="button" onClick={() => removeEnum(index)} aria-label={`删除枚举值 ${item.value || index + 1}`}><Trash2 size={14} />删除</button></div>
            <div className="editor-grid two">
              <label><span>value <b>*</b></span><Input value={item.value} onChange={(event) => updateEnum(index, { value: event.target.value })} aria-label={`枚举值 ${index + 1}`} /></label>
              <label><span>aliases（逗号或换行分隔）<b>*</b></span><Input value={enumAliasTexts[index] ?? ""} onChange={(event) => setEnumAliasTexts((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.value : value))} aria-label={`枚举值 ${index + 1} 的别名`} /></label>
            </div>
            <label><span>description（中英文业务说明）<b>*</b></span><Textarea value={item.description} onChange={(event) => updateEnum(index, { description: event.target.value })} aria-label={`枚举值 ${index + 1} 的说明`} rows={3} /></label>
          </article>)}
          </div>
        </div>}
      </section>
      {missingRequired.length > 0 && <div className="required-fields-alert" role="alert"><CircleAlert size={15} /><div><strong>还不能保存</strong><span>请填写：{missingRequired.join("、")}</span></div></div>}
    </div>
    <DialogFooter className="editor-footer">
      <Button variant="outline" className="editor-delete" onClick={onDelete}><Trash2 size={14} />删除字段</Button>
      <div><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button disabled={!canSave} onClick={() => onSave({ ...draft, entityColumn: draft.entityColumn.trim(), aliases: parsedAliases, detailedDescription: draft.detailedDescription.trim(), enumRef: enumEnabled ? draft.enumRef.trim() : "", enumDescription: enumEnabled ? draft.enumDescription.trim() : "", enumValues: enumEnabled ? parsedEnumValues : [] })}>保存标注</Button></div>
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
  const parsedAliases = parseList(aliases);
  const missing = [!className.trim() ? "类名" : "", !description.trim() ? "中英文业务语义说明" : "", parsedAliases.length === 0 ? "类别名" : ""].filter(Boolean);
  return <DialogContent className="table-config-dialog sm:max-w-xl">
    <DialogHeader><div className="dialog-mark"><Tags size={20} /></div><DialogTitle>配置类 · {table.tableName}</DialogTitle><DialogDescription>一张表对应一个唯一类，类信息用于本体与 RDB Mapping 文件命名。</DialogDescription></DialogHeader>
    <div className="table-config-fields">
      <label><span>类名 class_name <b>*</b></span><Input value={className} onChange={(event) => setClassName(event.target.value)} /></label>
      <label><span>类别名 aliases（逗号或换行分隔）<b>*</b></span><Input value={aliases} onChange={(event) => setAliases(event.target.value)} /></label>
      <label><span>类的中英文业务语义描述 <b>*</b></span><Textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={9} /></label>
      {missing.length > 0 && <p className="editor-required"><CircleAlert size={14} />请填写：{missing.join("、")}</p>}
      {error && <p className="editor-error">{error}</p>}
    </div>
    <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button><Button disabled={missing.length > 0} onClick={() => onSave({ className: className.trim(), classDescription: description.trim(), classAliases: parsedAliases })}>保存类信息</Button></DialogFooter>
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
    apply_ai_draft: "应用 AI 草稿",
    update_class_name: "更新类信息",
    update_relationship: "更新外键关系",
    rename_domain0: "修改 0级域",
    rename_domain1: "修改 1级域",
    restore_change: "恢复变更",
  } as const)[action];
}

export function ChangeRecordList({ records, currentTable, onRestore, emptyText = "暂时没有变更记录" }: { records: ChangeRecord[]; currentTable?: SchemaTable; onRestore?: (record: ChangeRecord) => void; emptyText?: string }) {
  return <div className="change-record-list">{records.map((record) => <article key={record.id}>
    <div><Badge variant="outline">{actionLabel(record.action)}</Badge>{record.source === "claude-code" && <Badge variant="outline">Claude Code</Badge>}<time>{new Date(record.timestamp).toLocaleString("zh-CN", { hour12: false })}</time>{onRestore && isChangeRestorable(record, currentTable) && <button className="change-restore" onClick={() => onRestore(record)} title="恢复到这次变更发生之前"><RotateCcw size={12} />恢复</button>}</div>
    <strong>{record.label}</strong>
    {(record.tableName || record.fieldName) && <code>{[record.tableName, record.fieldName].filter(Boolean).join(".")}</code>}
    {record.sessionId && <small>Session · {record.sessionId.slice(0, 8)}</small>}
  </article>)}{records.length === 0 && <div className="audit-empty">{emptyText}</div>}</div>;
}
