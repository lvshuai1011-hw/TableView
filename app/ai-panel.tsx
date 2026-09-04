"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FilePenLine,
  FileText,
  FileCheck2,
  FolderSearch,
  ListTodo,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import DEFAULT_ANNOTATION_PROMPT from "../config/default-annotation-prompt.txt?raw";
import DEFAULT_BATCH_INSTRUCTION_TEXT from "../config/default-batch-instruction.txt?raw";
import DEFAULT_TABLE_INSTRUCTION_TEXT from "../config/default-table-instruction.txt?raw";
import { mergeAiDraftIntoTable, summarizeAiDraft } from "./ai-utils";
import type { ColumnAnnotation, SchemaTable } from "./data";
import { splitBilingualDescription } from "./description-utils";
import { FieldEditorDialog, TableConfigDialog } from "./editor-dialogs";
import { validateExportConfiguration } from "./schema-utils";
import type {
  AiDataset,
  AiHealth,
  AiJob,
  AiPanelProps,
  AiSession,
  AiSessionSummary,
  AiTodo,
} from "./ai-types";

const REFERENCES_KEY = "schema-atlas.ai.reference-paths.v1";
const PROMPT_KEY = "schema-atlas.ai.prompt-template.v4";
const PREVIOUS_PROMPT_KEY = "schema-atlas.ai.prompt-template.v3";
const BATCH_INSTRUCTION_KEY = "schema-atlas.ai.batch-instruction.v2";
const PREVIOUS_BATCH_INSTRUCTION_KEY = "schema-atlas.ai.batch-instruction.v1";
const DEFAULT_BATCH_INSTRUCTION = DEFAULT_BATCH_INSTRUCTION_TEXT.trim();
const DEFAULT_TABLE_INSTRUCTION = DEFAULT_TABLE_INSTRUCTION_TEXT.trim();
const PROMPT_VARIABLES = ["table_name", "mode", "dataset_context", "reference_paths", "clarifications", "user_message"];

function withFieldAnalysisRequirement(value: string) {
  const prompt = value.trim();
  if (!prompt || /\banalysisSummary\b/.test(prompt)) return prompt;
  return `${prompt}\n\n补充的逐字段审核输出要求：每个字段必须填写简洁、可审核的 analysisSummary，解释业务理解、entityColumn 与 aliases 命名、枚举证据、外键语义及不确定性；reason 只列可回查的具体证据来源。isLocalId、isCode、isDisplayName 和 isSemantic 是人工标志，不要判断或修改。`;
}

function withBatchFieldAnalysisRequirement(value: string) {
  const instruction = value.trim();
  if (!instruction || instruction.includes("AI 标注分析")) return instruction;
  return `${instruction}\n每个字段还必须生成可供人工审核的 AI 标注分析，并说明命名、别名、枚举证据、关系语义与不确定性。isLocalId、isCode、isDisplayName 和 isSemantic 由人工设置，不要判断或修改。`;
}

function statusLabel(status: string) {
  return ({
    idle: "待开始",
    queued: "排队中",
    running: "生成中",
    draft_ready: "待审核",
    needs_clarification: "待澄清",
    applied: "已应用",
    failed: "失败",
    cancelling: "正在停止",
    cancelled: "已停止",
    completed: "已完成",
    completed_with_errors: "部分失败",
    stale: "结构已变化",
  } as Record<string, string>)[status] ?? status;
}

function statusClass(status: string) {
  if (["completed", "applied"].includes(status)) return "is-success";
  if (["failed", "completed_with_errors"].includes(status)) return "is-error";
  if (["running", "queued", "cancelling"].includes(status)) return "is-running";
  if (["needs_clarification", "stale"].includes(status)) return "is-warning";
  return "";
}

function sessionIsBusy(status?: string) {
  return Boolean(status && ["queued", "running", "cancelling"].includes(status));
}

function shortTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
  return value as T;
}

async function streamChat(
  body: unknown,
  onEvent: (event: { type: string; session?: AiSession; label?: string; error?: string }) => void,
) {
  const response = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    throw new Error(value.error || `请求失败（${response.status}）`);
  }
  if (!response.body) throw new Error("浏览器无法读取 Claude Code 输出流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(JSON.parse(line));
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer));
}

function EmptyState({ icon: Icon, title, detail }: { icon: typeof Bot; title: string; detail: string }) {
  return <div className="ai-empty"><Icon size={26} /><strong>{title}</strong><p>{detail}</p></div>;
}

function SessionTranscript({ session }: { session: AiSession }) {
  return <div className="ai-transcript">
    {session.messages.map((item) => <article key={item.id} className={`ai-message ${item.role}`}>
      <div>{item.role === "assistant" ? <Bot size={14} /> : item.role === "user" ? <MessageSquareText size={14} /> : <TerminalSquare size={14} />}<span>{item.role === "assistant" ? "Claude Code" : item.role === "user" ? "你" : "系统"}</span><time>{shortTime(item.at)}</time></div>
      <p>{item.content}</p>
      {item.draftUpdated && <small><FileCheck2 size={12} />已更新草稿{item.todoCount ? ` · 新增 ${item.todoCount} 个待澄清项` : ""}</small>}
    </article>)}
    {session.status === "running" && <article className="ai-message assistant is-streaming"><div><Loader2 size={14} className="spin" /><span>Claude Code</span></div><p>{session.activities.at(-1)?.label || "正在阅读资料并生成标注…"}</p></article>}
    {session.messages.length === 0 && session.status !== "running" && <EmptyState icon={MessageSquareText} title="还没有对话" detail="发送要求后，Claude Code 会读取当前表和已配置的参考资料。" />}
  </div>;
}

function SessionTrace({ session }: { session: AiSession }) {
  const trace = session.trace ?? [];
  return <section className="ai-trace">
    <div className="ai-trace-heading"><div><TerminalSquare size={15} /><strong>完整执行轨迹</strong></div><Badge variant="outline">{trace.length} 项</Badge></div>
    {trace.length > 0 ? <div className="ai-trace-list">{trace.map((item) => <details key={item.id} className={`ai-trace-item ${item.kind}`}>
      <summary><span>{item.label}</span><time>{shortTime(item.at)}</time></summary>
      {item.detail && <pre>{item.detail}</pre>}
    </details>)}</div> : <p className="ai-trace-empty">这个 Session 还没有 Claude Code 流事件。</p>}
  </section>;
}

function SessionStructureNotice({ session }: { session: AiSession | AiSessionSummary }) {
  const removedFields = session.removedFieldNames ?? [];
  const restoredFields = session.restoredFieldNames ?? [];
  let detail = "";
  if (session.staleReason === "table_deleted") {
    detail = "这张表已从当前数据集中删除。Session、完整对话和旧草稿仍保留，但不会再出现在待审核或待澄清队列。";
  } else if (session.staleReason === "table_restored_requires_review") {
    detail = "这张表已经恢复，但当前 Session 基于删除前的结构。请继续原 Session 重新核对，或人工编辑并保存当前结构后再应用。";
  } else if (session.staleReason === "fields_restored_requires_review") {
    detail = `字段 ${restoredFields.join("、") || "已删除字段"} 已恢复并按当前表结构补入草稿；重新核对或人工保存后才可应用。`;
  } else if (session.staleReason === "fields_added_requires_review") {
    detail = `当前表新增了字段 ${restoredFields.join("、") || "（名称未记录）"}，并已补入草稿；重新核对或人工保存后才可应用。`;
  } else if (removedFields.length > 0) {
    detail = `字段 ${removedFields.join("、")} 已删除，对应草稿项和待澄清项已自动失效；同表其他标注保持不变。`;
  }
  if (!detail) return null;
  return <div className="ai-session-table-missing ai-structure-notice"><CircleAlert size={14} /><span>{detail}</span></div>;
}

function TodoCard({ todo, busy, onAnswer }: { todo: AiTodo; busy: boolean; onAnswer: (todo: AiTodo, answer: string) => void }) {
  const [answer, setAnswer] = useState("");
  return <article className={`ai-todo-card ${todo.blocking ? "blocking" : ""}`}>
    <div className="ai-todo-head"><Badge variant="outline">{todo.scope === "field" ? todo.fieldName : todo.scope === "domain" ? "域级概念" : "表级概念"}</Badge>{todo.blocking && <span><CircleAlert size={12} />阻塞生成</span>}</div>
    <strong>{todo.question}</strong>
    {todo.reason && <p>{todo.reason}</p>}
    {Boolean(todo.checkedSources?.length) && <div className="ai-todo-sources"><FolderSearch size={12} /><span>已检索</span>{todo.checkedSources?.map((source) => <code key={source}>{source}</code>)}</div>}
    {todo.suggestions.length > 0 && <div className="ai-todo-suggestions">{todo.suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => setAnswer(suggestion)}>{suggestion}</button>)}</div>}
    {todo.status === "answered" ? <div className="ai-todo-answer"><CheckCircle2 size={13} /><span>{todo.answer}</span></div> : <div className="ai-todo-compose"><Input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="填写业务确认结果" /><Button size="sm" disabled={!answer.trim() || busy} onClick={() => onAnswer(todo, answer.trim())}>{busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />}提交</Button></div>}
  </article>;
}

function SessionListItem({ session, active, selected, onClick, onSelectedChange }: { session: AiSessionSummary; active: boolean; selected: boolean; onClick: () => void; onSelectedChange: (checked: boolean) => void }) {
  return <div className={`ai-session-row ${active ? "active" : ""}`}>
    <Checkbox checked={selected} onCheckedChange={(value) => onSelectedChange(value === true)} aria-label={`选择 Session ${session.tableName}`} />
    <button type="button" onClick={onClick}>
      <span className={`ai-session-dot ${statusClass(session.status)}`} />
      <div><strong>{session.tableName}</strong><small>{session.domain0} · {session.messageCount} 条消息</small></div>
      <div><Badge variant="outline" className={statusClass(session.status)}>{statusLabel(session.status)}</Badge><time>{shortTime(session.updatedAt)}</time></div>
    </button>
  </div>;
}

export function AiPanel({ open, onOpenChange, tables, datasetReady, initialTableName, onReviewTable, onAnnotationStarted, onApplyDraft }: AiPanelProps) {
  const [tab, setTab] = useState("work");
  const [health, setHealth] = useState<AiHealth | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [todos, setTodos] = useState<AiTodo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<AiSession | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [chatMessage, setChatMessage] = useState(DEFAULT_TABLE_INSTRUCTION);
  const [sessionMessage, setSessionMessage] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [batchDomain, setBatchDomain] = useState("__all__");
  const [batchBusy, setBatchBusy] = useState(false);
  const [answeringTodo, setAnsweringTodo] = useState<string | null>(null);
  const [referenceText, setReferenceText] = useState("");
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_ANNOTATION_PROMPT.trim());
  const [batchInstruction, setBatchInstruction] = useState(DEFAULT_BATCH_INSTRUCTION);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [dataset, setDataset] = useState<AiDataset | null>(null);
  const [datasetSyncing, setDatasetSyncing] = useState(false);
  const [datasetError, setDatasetError] = useState("");
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [sessionDeleteOpen, setSessionDeleteOpen] = useState(false);
  const [sessionsDeleting, setSessionsDeleting] = useState(false);
  const [draftClassEditorOpen, setDraftClassEditorOpen] = useState(false);
  const [draftFieldEditorName, setDraftFieldEditorName] = useState<string | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const pendingConversationSessionId = useRef<string | null>(null);
  const workComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const activeTable = initialTableName ? tables.find((table) => table.tableName === initialTableName) : undefined;
  const domains = useMemo(() => [...new Set(tables.map((table) => table.domain0))].sort((a, b) => a.localeCompare(b, "zh-CN")), [tables]);
  const referencePaths = useMemo(() => referenceText.split("\n").map((item) => item.trim()).filter(Boolean), [referenceText]);
  const activeJobs = jobs.filter((job) => ["queued", "running", "cancelling"].includes(job.status));
  const visibleJobs = jobs.slice(0, 10);
  const tableSessions = activeTable ? sessions.filter((session) => session.tableName === activeTable.tableName) : [];
  const activeConversationSession = activeTable && selectedSession?.tableName === activeTable.tableName ? selectedSession : null;
  const selectedSessionTable = selectedSession ? tables.find((table) => table.tableName === selectedSession.tableName) : undefined;
  const activeConversationBusy = sessionIsBusy(activeConversationSession?.status);
  const selectedConversationBusy = sessionIsBusy(selectedSession?.status);
  const reviewDraftTable = activeTable && activeConversationSession?.draft
    ? mergeAiDraftIntoTable(activeTable, activeConversationSession.draft)
    : undefined;
  const reviewDraftColumn = reviewDraftTable?.columns.find((column) => column.name === draftFieldEditorName);

  const loadSession = useCallback(async (sessionId: string, silent = false) => {
    if (!silent) setLoadingSession(true);
    try {
      const value = await api<{ session: AiSession }>(`/api/ai/sessions/${sessionId}`);
      setSelectedSession(value.session);
    } catch (error) {
      if (!silent) toast.error("会话读取失败", { description: error instanceof Error ? error.message : "未知错误" });
    } finally {
      if (!silent) setLoadingSession(false);
    }
  }, []);

  const syncDataset = useCallback(async () => {
    if (!datasetReady) throw new Error("浏览器中的导入数据尚未恢复完成");
    setDatasetSyncing(true);
    try {
      const value = await api<{ dataset: AiDataset }>("/api/ai/datasets/sync", {
        method: "POST",
        body: JSON.stringify({ tables }),
      });
      setDataset(value.dataset);
      setDatasetError("");
      return value.dataset;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "数据集同步失败";
      setDatasetError(detail);
      throw error;
    } finally {
      setDatasetSyncing(false);
    }
  }, [datasetReady, tables]);

  const refresh = useCallback(async (silent = false) => {
    try {
      const [healthValue, sessionValue, jobValue, todoValue] = await Promise.all([
        api<AiHealth>("/api/ai/health"),
        api<{ sessions: AiSessionSummary[] }>("/api/ai/sessions"),
        api<{ jobs: AiJob[] }>("/api/ai/jobs"),
        api<{ todos: AiTodo[] }>("/api/ai/todos"),
      ]);
      setHealth(healthValue);
      setSessions(sessionValue.sessions);
      setJobs(jobValue.jobs);
      setTodos(todoValue.todos);
      setConnectionError("");
    } catch (error) {
      setHealth(null);
      setConnectionError(error instanceof Error ? error.message : "无法连接本地 AI 服务");
      if (!silent) setSessions([]);
    }
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        setReferenceText(window.localStorage.getItem(REFERENCES_KEY) ?? "");
        const storedPrompt = window.localStorage.getItem(PROMPT_KEY);
        const previousPrompt = window.localStorage.getItem(PREVIOUS_PROMPT_KEY);
        setPromptTemplate(storedPrompt || (previousPrompt ? withFieldAnalysisRequirement(previousPrompt) : DEFAULT_ANNOTATION_PROMPT.trim()));
        const storedBatchInstruction = window.localStorage.getItem(BATCH_INSTRUCTION_KEY);
        const previousBatchInstruction = window.localStorage.getItem(PREVIOUS_BATCH_INSTRUCTION_KEY);
        setBatchInstruction(storedBatchInstruction || (previousBatchInstruction ? withBatchFieldAnalysisRequirement(previousBatchInstruction) : DEFAULT_BATCH_INSTRUCTION));
      } catch { /* preferences are optional */ }
      setPreferencesReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    try {
      window.localStorage.setItem(REFERENCES_KEY, referenceText);
      window.localStorage.setItem(PROMPT_KEY, promptTemplate);
      window.localStorage.setItem(BATCH_INSTRUCTION_KEY, batchInstruction);
    } catch { /* preferences are optional */ }
  }, [batchInstruction, preferencesReady, promptTemplate, referenceText]);

  useEffect(() => {
    if (!datasetReady) return;
    let cancelled = false;
    let timer = 0;
    const run = () => {
      void syncDataset().catch(() => {
        if (!cancelled) timer = window.setTimeout(run, 15_000);
      });
    };
    timer = window.setTimeout(run, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [datasetReady, syncDataset]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const conversationSessionId = pendingConversationSessionId.current;
      pendingConversationSessionId.current = null;
      setTab("work");
      if (conversationSessionId) {
        setSelectedSessionId(conversationSessionId);
        setChatMessage("");
      } else {
        setSelectedSessionId(null);
        setSelectedSession(null);
        setChatMessage(initialTableName ? DEFAULT_TABLE_INSTRUCTION : "");
      }
      void refresh();
      if (datasetReady) void syncDataset().catch(() => {});
    });
    return () => { active = false; };
  }, [open, initialTableName]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => {
      void refresh(true);
      if (selectedSessionId) void loadSession(selectedSessionId, true);
    }, 3_500);
    return () => window.clearInterval(timer);
  }, [loadSession, open, refresh, selectedSessionId]);

  useEffect(() => {
    if (!open || selectedSessionId) return;
    const candidate = initialTableName
      ? sessions.find((session) => session.tableName === initialTableName)
      : sessions[0];
    if (!candidate) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setSelectedSessionId(candidate.id);
      if (initialTableName) setChatMessage("");
    });
    return () => { active = false; };
  }, [open, initialTableName, sessions, selectedSessionId]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (selectedSessionId) void loadSession(selectedSessionId);
      else setSelectedSession(null);
    });
    return () => { active = false; };
  }, [loadSession, selectedSessionId]);

  const selectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setSessionMessage("");
    if (activeTable) setChatMessage("");
    if (tab === "work" && !activeTable) setTab("sessions");
  };

  const openSessionConversation = (sessionId: string, tableName: string) => {
    if (!tables.some((table) => table.tableName === tableName)) {
      toast.error("无法继续这个 Session", { description: `对应表 ${tableName} 已不在当前导入数据中，请先恢复或重新导入。` });
      return;
    }
    pendingConversationSessionId.current = initialTableName === tableName ? null : sessionId;
    setSelectedSessionId(sessionId);
    setSelectedSession((current) => current?.id === sessionId ? current : null);
    setChatMessage("");
    onReviewTable(tableName);
    setTab("work");
  };

  const prepareClaudeRevision = (fieldName?: string) => {
    if (!activeTable) return;
    const request = fieldName
      ? `请只重新审核字段 ${activeTable.tableName}.${fieldName}。请结合导入字段资料、外键关系和已配置参考资料，修订它的 attr_name、详细中英文业务语义、aliases 及有明确证据的枚举配置，并同步更新供人工审核的 analysisSummary 和证据 reason；isLocalId、isCode、isDisplayName 和 isSemantic 由人工设置，不要判断或修改，也不要改动无关字段。`
      : `请只重新审核表 ${activeTable.tableName} 的类级标注。请结合已配置参考资料，修订 class_name、详细中英文业务语义和 aliases；不要改动无关字段。`;
    setChatMessage(request);
    queueMicrotask(() => workComposerRef.current?.focus());
  };

  const runSessionTurn = async (targetTable: SchemaTable | undefined, targetSession: AiSession | null, rawMessage: string, clearMessage: () => void) => {
    if (!targetTable || chatBusy || sessionIsBusy(targetSession?.status)) return;
    const text = rawMessage.trim();
    if (!text) return;
    setChatBusy(true);
    setActivity(targetSession ? "正在恢复 Claude Code Session…" : "正在启动 Claude Code…");
    try {
      const currentDataset = await syncDataset();
      onAnnotationStarted([targetTable.tableName]);
      clearMessage();
      await streamChat({
        table: targetTable,
        datasetId: currentDataset.id,
        message: text,
        referencePaths,
        promptTemplate,
        sessionId: targetSession?.tableName === targetTable.tableName ? targetSession.id : undefined,
      }, (event) => {
        if (event.label) setActivity(event.label);
        if (event.session) {
          setSelectedSessionId(event.session.id);
          setSelectedSession(event.session);
        }
        if (event.error) setActivity(event.error);
      });
      await refresh(true);
    } catch (error) {
      toast.error("AI 任务失败", { description: error instanceof Error ? error.message : "未知错误" });
    } finally {
      setChatBusy(false);
      setActivity("");
    }
  };

  const startBatch = async () => {
    const selectedTables = batchDomain === "__all__" ? tables : tables.filter((table) => table.domain0 === batchDomain);
    if (selectedTables.length === 0 || batchBusy) return;
    setBatchBusy(true);
    try {
      const currentDataset = await syncDataset();
      const value = await api<{ job: AiJob }>("/api/ai/jobs/generate", {
        method: "POST",
        body: JSON.stringify({
          tables: selectedTables,
          datasetId: currentDataset.id,
          referencePaths,
          promptTemplate,
          batchInstruction,
          scope: batchDomain === "__all__" ? { level: "global" } : { level: "domain", domain0: batchDomain },
        }),
      });
      onAnnotationStarted(selectedTables.map((table) => table.tableName));
      setJobs((current) => [value.job, ...current.filter((job) => job.id !== value.job.id)]);
      toast.success("全量标注任务已启动", { description: `将依次处理 ${selectedTables.length} 张表。` });
    } catch (error) {
      toast.error("无法启动批量任务", { description: error instanceof Error ? error.message : "未知错误" });
    } finally {
      setBatchBusy(false);
    }
  };

  const stopJob = async (job: AiJob) => {
    try {
      await api(`/api/ai/jobs/${job.id}/cancel`, { method: "POST", body: "{}" });
      await refresh(true);
    } catch (error) {
      toast.error("停止任务失败", { description: error instanceof Error ? error.message : "未知错误" });
    }
  };

  const stopAllJobs = async () => {
    if (activeJobs.length === 0) return;
    try {
      await api("/api/ai/jobs/cancel", { method: "POST", body: JSON.stringify({ all: true }) });
      await refresh(true);
      toast.success(`正在停止 ${activeJobs.length} 个批量任务`);
    } catch (error) {
      toast.error("批量停止失败", { description: error instanceof Error ? error.message : "未知错误" });
    }
  };

  const setSessionSelected = (sessionId: string, checked: boolean) => setSelectedSessionIds((current) => {
    const next = new Set(current);
    if (checked) next.add(sessionId); else next.delete(sessionId);
    return next;
  });

  const selectAllSessions = (checked: boolean) => {
    setSelectedSessionIds(checked ? new Set(sessions.map((session) => session.id)) : new Set());
  };

  const deleteSelectedSessions = async () => {
    const sessionIds = [...selectedSessionIds].filter((id) => sessions.some((session) => session.id === id));
    if (sessionIds.length === 0) return;
    setSessionsDeleting(true);
    try {
      await api<{ deleted: string[] }>("/api/ai/sessions", {
        method: "DELETE",
        body: JSON.stringify({ sessionIds }),
      });
      if (selectedSessionId && sessionIds.includes(selectedSessionId)) {
        setSelectedSessionId(null);
        setSelectedSession(null);
      }
      setSelectedSessionIds(new Set());
      setSessionDeleteOpen(false);
      await refresh(true);
      toast.success(`已清理 ${sessionIds.length} 个 Session`);
    } catch (error) {
      toast.error("Session 清理失败", { description: error instanceof Error ? error.message : "未知错误" });
    } finally {
      setSessionsDeleting(false);
    }
  };

  const answerTodo = async (todo: AiTodo, answer: string) => {
    setAnsweringTodo(todo.id);
    try {
      const currentDataset = await syncDataset();
      const currentTable = tables.find((table) => table.tableName === todo.tableName);
      if (currentTable) onAnnotationStarted([currentTable.tableName]);
      await api(`/api/ai/todos/${todo.id}/answer`, {
        method: "POST",
        body: JSON.stringify({ answer, table: currentTable, datasetId: currentDataset.id, promptTemplate }),
      });
      toast.success("澄清已提交", { description: "Claude Code 正在恢复原会话并修订草稿。" });
      setSelectedSessionId(todo.sessionId);
      await refresh(true);
    } catch (error) {
      toast.error("提交失败", { description: error instanceof Error ? error.message : "未知错误" });
    } finally {
      setAnsweringTodo(null);
    }
  };

  const applyDraft = async () => {
    if (!activeTable || !selectedSession?.draft) return;
    if (selectedSession.status === "stale" || selectedSession.staleReason) {
      toast.error("旧结构草稿不能直接应用", { description: "请继续原 Session 重新核对，或人工编辑并保存当前结构。" });
      return;
    }
    try {
      onApplyDraft(selectedSession.draft, selectedSession);
    } catch (error) {
      toast.error("草稿无法应用", { description: error instanceof Error ? error.message : "未知错误" });
      return;
    }
    try {
      await api(`/api/ai/sessions/${selectedSession.id}/applied`, { method: "POST", body: "{}" });
      await refresh(true);
      await loadSession(selectedSession.id, true);
      toast.success(`已应用 ${activeTable.tableName} 的审核草稿`, { description: "本次修改已写入该表自己的变更记录。" });
    } catch (error) {
      toast.warning("标注已应用，但 Session 状态同步失败", { description: error instanceof Error ? error.message : "可稍后重试" });
    }
  };

  const persistManualDraft = async (draft: AiSession["draft"], label: string) => {
    if (!activeTable || !activeConversationSession || !draft || draftSaving) return false;
    setDraftSaving(true);
    try {
      const value = await api<{ session: AiSession }>(`/api/ai/sessions/${activeConversationSession.id}/draft`, {
        method: "PATCH",
        body: JSON.stringify({ table: activeTable, draft, label }),
      });
      setSelectedSession(value.session);
      await refresh(true);
      toast.success(label, { description: "已保存到当前 Session 的审核草稿，尚未应用到正式表标注。" });
      return true;
    } catch (error) {
      toast.error("人工修改保存失败", { description: error instanceof Error ? error.message : "未知错误" });
      return false;
    } finally {
      setDraftSaving(false);
    }
  };

  const saveDraftClass = async (value: { className: string; classDescription: string; classAliases: string[] }) => {
    if (!activeConversationSession?.draft) return;
    const saved = await persistManualDraft({ ...activeConversationSession.draft, ...value }, "修改了类级标注");
    if (saved) setDraftClassEditorOpen(false);
  };

  const saveDraftField = async (annotation: ColumnAnnotation) => {
    if (!activeConversationSession?.draft || !draftFieldEditorName) return;
    const draft = activeConversationSession.draft;
    const saved = await persistManualDraft({
      ...draft,
      columns: draft.columns.map((column) => column.name === draftFieldEditorName ? { ...column, ...annotation } : column),
    }, `修改了字段 ${draftFieldEditorName} 的审核标注`);
    if (saved) setDraftFieldEditorName(null);
  };

  const draftSummary = activeTable && selectedSession?.draft && selectedSession.draft.tableName === activeTable.tableName
    ? summarizeAiDraft(activeTable, selectedSession.draft)
    : null;
  const draftValidationErrors = activeTable && selectedSession?.draft && selectedSession.draft.tableName === activeTable.tableName
    ? validateExportConfiguration([mergeAiDraftIntoTable(activeTable, selectedSession.draft)])
    : [];
  const unknownPromptVariables = [...promptTemplate.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)]
    .map((match) => match[1])
    .filter((key, index, items) => !PROMPT_VARIABLES.includes(key) && items.indexOf(key) === index);
  const hasDatasetContextVariable = /\{\{\s*dataset_context\s*\}\}/.test(promptTemplate);
  const promptValid = Boolean(promptTemplate.trim()) && unknownPromptVariables.length === 0;
  const tableIndex = new Map(tables.map((table) => [table.tableName, table]));
  const todoMatchesCurrentStructure = (todo: AiTodo) => {
    const table = tableIndex.get(todo.tableName);
    if (!table) return false;
    return todo.scope !== "field" || table.columns.some((column) => column.name === todo.fieldName);
  };
  const currentTodos = selectedSession?.todos.filter((todo) => todo.status === "open" && todoMatchesCurrentStructure(todo)) ?? [];
  const classTodos = currentTodos.filter((todo) => todo.scope !== "field");
  const openTodos = todos.filter((todo) => todo.status === "open" && todoMatchesCurrentStructure(todo));
  const reviewSessions = sessions.filter((session) => session.status === "draft_ready" && tableIndex.has(session.tableName));
  const selectedSessionCount = [...selectedSessionIds].filter((id) => sessions.some((session) => session.id === id)).length;
  const allSessionsSelected = sessions.length > 0 && selectedSessionCount === sessions.length;

  if (!open) return null;

  return <>
    <main className="ai-workbench-page">
      <header className="ai-sheet-header">
        <Button variant="ghost" className="ai-page-back" onClick={() => onOpenChange(false)}><ArrowLeft size={16} />返回关系图</Button>
        <div className="ai-title-mark"><Sparkles size={18} /></div>
        <div><h1>Claude Code 标注台</h1><p>{activeTable ? `${activeTable.tableName} · 表级审核会话` : "批量生成、人工澄清与 Session 管理"}</p></div>
        <div className={`ai-connection ${health?.ready ? "online" : "offline"}`}><i />{health?.ready ? `${health.user} · 已连接` : "未连接"}</div>
      </header>

      {connectionError && <div className="ai-connection-error"><CircleAlert size={16} /><div><strong>本地 AI 服务不可用</strong><p>{connectionError}。请使用 <code>npm run start:local</code> 启动完整服务。</p></div><Button variant="outline" size="sm" onClick={() => refresh()}><RefreshCw size={13} />重试</Button></div>}

      <Tabs value={tab} onValueChange={setTab} className="ai-tabs">
        <TabsList>
          <TabsTrigger value="work"><WandSparkles size={14} />{activeTable ? "审核对话" : "批量生成"}</TabsTrigger>
          <TabsTrigger value="review"><FileCheck2 size={14} />待审核 <span>{reviewSessions.length}</span></TabsTrigger>
          <TabsTrigger value="todos"><ListTodo size={14} />待澄清 <span>{openTodos.length}</span></TabsTrigger>
          <TabsTrigger value="sessions"><MessageSquareText size={14} />Sessions <span>{sessions.length}</span></TabsTrigger>
        </TabsList>

        <TabsContent value="work" className="ai-tab-content">
          {activeTable ? <div className="ai-table-workspace">
            <div className="ai-table-context-stack">
              <div className="ai-table-context"><div><span>当前表</span><code>{activeTable.tableName}</code><small>{activeTable.className} · {activeTable.columns.length} 个字段</small></div><div className="ai-table-context-actions">{tableSessions.length > 1 && <Select value={selectedSession?.tableName === activeTable.tableName ? selectedSession.id : tableSessions[0]?.id} onValueChange={selectSession}><SelectTrigger size="sm"><SelectValue placeholder="选择会话" /></SelectTrigger><SelectContent>{tableSessions.map((session) => <SelectItem key={session.id} value={session.id}>{shortTime(session.updatedAt)} · {statusLabel(session.status)}</SelectItem>)}</SelectContent></Select>}<button type="button" onClick={() => onReviewTable(null)}>返回批量</button></div></div>
              {activeConversationSession && <SessionStructureNotice session={activeConversationSession} />}
            </div>
            <div className="ai-review-workbench">
              <section className="ai-review-pane ai-review-conversation-pane">
                <header><div><MessageSquareText size={15} /><strong>原 Session 对话</strong></div>{activeConversationSession && <Badge variant="outline" className={statusClass(activeConversationSession.status)}>{statusLabel(activeConversationSession.status)}</Badge>}</header>
                <div className="ai-review-pane-scroll">
                  {activeConversationSession
                    ? <><SessionTranscript session={{ ...activeConversationSession, status: chatBusy ? "running" : activeConversationSession.status, activities: activity ? [...activeConversationSession.activities, { id: "live", label: activity, at: new Date().toISOString() }] : activeConversationSession.activities }} /><details className="ai-review-trace"><summary><TerminalSquare size={13} />执行轨迹 <span>{activeConversationSession.trace?.length ?? 0}</span></summary><SessionTrace session={activeConversationSession} /></details></>
                    : <EmptyState icon={Bot} title="为当前表建立 AI 会话" detail="Claude Code 会读取表结构、上下游关系和你配置的本地参考资料，先生成一版供人工审核。" />}
                </div>
                <div className="ai-chat-composer"><Textarea ref={workComposerRef} value={chatMessage} onChange={(event) => setChatMessage(event.target.value)} placeholder={activeConversationSession ? "指出不准确的字段、补充业务规则，或要求重新检查…" : "填写本表的生成要求"} rows={3} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void runSessionTurn(activeTable, activeConversationSession, chatMessage, () => setChatMessage("")); }} /><div><span>{activeConversationSession ? "继续现有 Session，不会新建会话" : <>首次生成要求会写入 <code>{"{{user_message}}"}</code></>}</span><Button onClick={() => void runSessionTurn(activeTable, activeConversationSession, chatMessage, () => setChatMessage(""))} disabled={chatBusy || activeConversationBusy || !health?.ready || !chatMessage.trim() || !promptValid}>{chatBusy || activeConversationBusy ? <Loader2 size={15} className="spin" /> : <Send size={15} />}{activeConversationBusy ? "Session 执行中" : activeConversationSession ? "继续原 Session" : "生成当前表"}</Button></div></div>
              </section>

              <section className="ai-review-pane ai-review-draft-pane">
                <header><div><FileCheck2 size={15} /><strong>结构化审核草稿</strong></div>{draftSaving && <span><Loader2 size={12} className="spin" />正在保存人工修改</span>}</header>
                <div className="ai-review-pane-scroll">
                  {activeConversationSession?.draft && draftSummary ? <section className="ai-draft-card">
                    <div className="ai-draft-heading"><div><FileCheck2 size={16} /><span>类与字段标注</span></div><Badge variant="outline" className={`confidence-${activeConversationSession.draft.confidence}`}>{activeConversationSession.draft.confidence === "high" ? "高置信" : activeConversationSession.draft.confidence === "low" ? "低置信" : "中等置信"}</Badge></div>
                    <div className="ai-draft-stats"><div><strong>{draftSummary.changedFields}</strong><span>字段有变化</span></div><div><strong>{draftSummary.includedFields}</strong><span>字段将导出</span></div><div><strong>{draftSummary.lowConfidenceFields}</strong><span>低置信字段</span></div></div>
                    <article className="ai-draft-class-review">
                      <div className="ai-draft-review-heading"><div><span>类</span><code>{activeConversationSession.draft.className}</code></div><div><Button variant="outline" size="sm" onClick={() => prepareClaudeRevision()}><MessageSquareText size={13} />让 Claude 修订</Button><Button variant="outline" size="sm" onClick={() => setDraftClassEditorOpen(true)} disabled={draftSaving}><FilePenLine size={13} />人工编辑</Button></div></div>
                      <p>{activeConversationSession.draft.classDescription}</p>
                      <div className="ai-draft-flags">{activeConversationSession.draft.classAliases.map((alias) => <span key={alias}>{alias}</span>)}</div>
                      {classTodos.map((todo) => <TodoCard key={todo.id} todo={todo} busy={answeringTodo === todo.id} onAnswer={answerTodo} />)}
                    </article>
                    {draftValidationErrors.length > 0 && <div className="ai-draft-validation" role="alert"><CircleAlert size={15} /><div><strong>草稿还有必填项未完成</strong><span>{draftValidationErrors.slice(0, 4).join("；")}{draftValidationErrors.length > 4 ? `；另有 ${draftValidationErrors.length - 4} 项` : ""}</span></div></div>}
                    <div className="ai-draft-fields"><div>{activeConversationSession.draft.columns.map((column) => {
                      const fieldTodos = currentTodos.filter((todo) => todo.scope === "field" && todo.fieldName === column.name);
                      const description = splitBilingualDescription(column.detailedDescription);
                      return <article key={column.name}>
                        <div className="ai-draft-review-heading"><div className="ai-field-mapping"><span>物理字段</span><code>{column.name}</code><span>对应本体属性</span><code>{column.entityColumn}</code><Badge variant="outline" className={`confidence-${column.confidence}`}>{column.confidence === "high" ? "高" : column.confidence === "low" ? "低" : "中"}</Badge></div><div><button type="button" onClick={() => prepareClaudeRevision(column.name)}><MessageSquareText size={12} />AI 修订</button><button type="button" onClick={() => setDraftFieldEditorName(column.name)} disabled={draftSaving}><FilePenLine size={12} />人工编辑</button></div></div>
                        <section className="ai-field-descriptions">
                          <div><span>中文业务描述</span><p>{description.chinese}</p></div>
                          <div><span>English Description</span><p>{description.english}</p></div>
                        </section>
                        <div className="ai-draft-flags">{!column.included && <span>不导出</span>}{column.isLocalId && <span>LOCAL ID</span>}{column.isCode && <span>CODE</span>}{column.isDisplayName && <span>DISPLAY NAME</span>}{column.isSemantic && <span>SEMANTIC</span>}{column.enumRef && <span>ENUM · {column.enumRef}</span>}{column.aliases.map((alias) => <span key={alias}>{alias}</span>)}</div>
                        <section className="ai-field-analysis">
                          <div><Sparkles size={13} /><strong>AI 标注分析</strong></div>
                          <p>{column.analysisSummary || column.reason || "旧版草稿未记录逐字段分析，可点击“AI 修订”补充。"}</p>
                        </section>
                        {column.reason && <small className="ai-field-evidence"><FileText size={11} />证据依据：{column.reason}</small>}
                        {fieldTodos.map((todo) => <TodoCard key={todo.id} todo={todo} busy={answeringTodo === todo.id} onAnswer={answerTodo} />)}
                      </article>;
                    })}</div></div>
                    <div className="ai-draft-apply"><span>{activeConversationSession.status === "stale" || activeConversationSession.staleReason ? "表结构已变化，请先重新核对或人工保存当前结构。" : "人工编辑只保存到本 Session；应用后才写入表级变更记录。"}</span><Button onClick={applyDraft} disabled={chatBusy || draftSaving || activeConversationSession.status === "applied" || activeConversationSession.status === "stale" || Boolean(activeConversationSession.staleReason) || draftValidationErrors.length > 0}>{activeConversationSession.status === "applied" ? <CheckCircle2 size={15} /> : <FileCheck2 size={15} />}{activeConversationSession.status === "applied" ? "草稿已应用" : activeConversationSession.status === "stale" || activeConversationSession.staleReason ? "需重新核对" : "应用到当前表"}</Button></div>
                  </section> : <EmptyState icon={FileCheck2} title="等待生成审核草稿" detail="左侧完成第一轮生成后，类、字段、枚举和待澄清项会在这里按对象展示。" />}
                </div>
              </section>
            </div>
          </div> : <div className="ai-batch-workspace">
            <div className="ai-batch-layout">
              <div className="ai-batch-primary">
                <section className="ai-batch-card"><div className="ai-section-heading"><div><WandSparkles size={18} /><span>生成所有 JSON 的标注草稿</span></div><Badge variant="outline">逐表 Session</Badge></div><p>每张表建立独立会话，批量任务只负责统一调度。草稿不会覆盖当前标注。</p><label><span>生成范围</span><Select value={batchDomain} onValueChange={setBatchDomain}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all__">全部 0级域 · {tables.length} 张表</SelectItem>{domains.map((domain) => <SelectItem key={domain} value={domain}>{domain} · {tables.filter((table) => table.domain0 === domain).length} 张表</SelectItem>)}</SelectContent></Select></label><label><span>本次批量生成要求</span><Textarea value={batchInstruction} onChange={(event) => setBatchInstruction(event.target.value)} rows={4} /></label><Button onClick={startBatch} disabled={!health?.ready || batchBusy || tables.length === 0 || !batchInstruction.trim() || !promptValid}>{batchBusy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}启动全量生成</Button></section>
                {activeJobs.length > 0 && <div className="ai-bulk-stop"><span>{activeJobs.length} 个批量任务正在执行或排队</span><Button variant="destructive" size="sm" onClick={stopAllJobs}><Square size={12} />全部停止</Button></div>}
                <div className="ai-job-list">{visibleJobs.map((job) => <section className="ai-job-card" key={job.id}><div><div><span className={`ai-session-dot ${statusClass(job.status)}`} /><strong>{job.label}</strong></div><Badge variant="outline" className={statusClass(job.status)}>{statusLabel(job.status)}</Badge></div><Progress value={job.total ? ((job.completed + job.failed) / job.total) * 100 : 0} /><div className="ai-job-stats"><span>{job.completed} 已完成</span><span>{job.failed} 失败</span><span>{Math.max(0, job.total - job.completed - job.failed)} 待处理</span>{["queued", "running", "cancelling"].includes(job.status) && <button onClick={() => stopJob(job)} disabled={job.status === "cancelling"}><Square size={11} />{job.status === "cancelling" ? "停止中" : "停止"}</button>}</div></section>)}</div>
                <div className="ai-batch-note"><Clock3 size={15} /><p>生成在服务器后台继续运行。关闭浏览器或 SSH 不会中断由 systemd 托管的任务。</p></div>
              </div>
              <aside className="ai-generation-config">
                <section className="ai-generation-settings">
                  <div className="ai-section-heading"><div><FileText size={18} /><span>完整提示词模板</span></div><Badge variant="outline">自动保存</Badge></div>
                  <p>单表首次生成、批量生成和后续修订共用此模板。默认模板优先检索原始 JSON 与 RB、WEB、DB，Teleco_Context 仅限量用于校准格式。</p>
                  <div className="ai-prompt-variables">{PROMPT_VARIABLES.map((variable) => <code key={variable}>{`{{${variable}}}`}</code>)}</div>
                  <Textarea value={promptTemplate} onChange={(event) => setPromptTemplate(event.target.value)} spellCheck={false} aria-label="Claude Code 提示词模板" />
                  {unknownPromptVariables.length > 0 && <div className="ai-prompt-error"><CircleAlert size={14} />不支持的占位符：{unknownPromptVariables.join("、")}</div>}
                  {!hasDatasetContextVariable && <div className="ai-prompt-warning"><CircleAlert size={14} />当前模板没有使用 <code>{"{{dataset_context}}"}</code>，Claude Code 将无法从提示词中获得关联表落盘路径。</div>}
                  <div className="ai-prompt-footer"><span>{promptTemplate.length.toLocaleString("zh-CN")} 字符 · 下一轮任务生效</span><Button variant="outline" size="sm" onClick={() => setPromptTemplate(DEFAULT_ANNOTATION_PROMPT.trim())}><RefreshCw size={13} />恢复默认</Button></div>
                </section>
                <section className="ai-generation-settings">
                  <div className="ai-section-heading"><div><FolderSearch size={18} /><span>本地参考资料</span></div><Badge variant="outline">直接读取</Badge></div>
                  <p>每行填写一个服务器本地文件或目录。Claude Code 直接阅读这些路径，不建立检索库。</p>
                  <Textarea value={referenceText} onChange={(event) => setReferenceText(event.target.value)} rows={6} placeholder={"/home/claude/repos/billing\n/home/claude/annotations/ontologies"} />
                  <small>路径会在任务启动时验证，且必须位于服务端允许的根目录内。</small>
                </section>
                <section className="ai-runtime-card"><div><span>导入数据集</span><code>{datasetSyncing ? "正在落盘…" : dataset ? `${dataset.tableCount} 张表 · ${dataset.relationshipCount} 条关系 · 已落盘` : datasetError || "等待本地服务"}</code></div><div><span>运行账户</span><code>{health?.user || "未连接"}</code></div><div><span>Claude Code</span><code>{health?.version || health?.error || "未检测"}</code></div><div><span>登录状态</span><code>{health?.authenticated ? "已登录" : "未登录"}</code></div><div><span>权限模式</span><code>--dangerously-skip-permissions</code></div><div><span>允许根目录</span><div>{health?.allowedRoots?.map((root) => <code key={root}>{root}</code>) ?? <code>等待连接</code>}</div></div></section>
              </aside>
            </div>
          </div>}
        </TabsContent>

        <TabsContent value="review" className="ai-tab-content ai-review-list">
          <div className="ai-list-heading"><div><strong>待人工审核草稿</strong><span>只有生成完成且不再阻塞澄清的 Session 会进入这里</span></div><Badge variant="outline">{reviewSessions.length} 待审核</Badge></div>
          {reviewSessions.map((session) => <article className="ai-review-card" key={session.id}>
            <div><span className={`ai-session-dot ${statusClass(session.status)}`} /><div><code>{session.tableName}</code><small>{session.domain0} · 更新于 {shortTime(session.updatedAt)}</small></div><Badge variant="outline">{session.todoCount ? `${session.todoCount} 个非阻塞澄清` : "可审核"}</Badge></div>
            <div><span>{session.messageCount} 条对话</span><span>{session.relatedTableCount ?? 0} 张直接关联表</span><Button size="sm" onClick={() => openSessionConversation(session.id, session.tableName)}>打开并继续</Button></div>
          </article>)}
          {reviewSessions.length === 0 && <EmptyState icon={CheckCircle2} title="没有待审核草稿" detail="生成完成且无需继续澄清的表会出现在这里。" />}
        </TabsContent>

        <TabsContent value="sessions" className="ai-tab-content ai-sessions-content">
          <div className="ai-session-list">
            <div className="ai-list-heading"><div><strong>Schema Atlas Sessions</strong><span>只展示本系统登记的会话</span></div><Button variant="outline" size="sm" onClick={() => refresh()}><RefreshCw size={13} />刷新</Button></div>
            {sessions.length > 0 && <div className="ai-session-bulk"><label><Checkbox checked={allSessionsSelected} onCheckedChange={(value) => selectAllSessions(value === true)} /><span>全选</span></label><span>已选 {selectedSessionCount}</span><Button variant="destructive" size="sm" disabled={selectedSessionCount === 0} onClick={() => setSessionDeleteOpen(true)}><Trash2 size={12} />清理</Button></div>}
            {sessions.map((session) => <SessionListItem key={session.id} session={session} active={selectedSessionId === session.id} selected={selectedSessionIds.has(session.id)} onClick={() => selectSession(session.id)} onSelectedChange={(checked) => setSessionSelected(session.id, checked)} />)}
            {sessions.length === 0 && <EmptyState icon={MessageSquareText} title="暂无 Session" detail="生成一张表或启动批量任务后，会话会出现在这里。" />}
          </div>
          <div className="ai-session-detail">{loadingSession ? <div className="ai-loading"><Loader2 size={18} className="spin" />读取完整对话…</div> : selectedSession ? <><div className="ai-session-detail-head"><div><code>{selectedSession.tableName}</code><span>{selectedSession.name}</span>{selectedSession.datasetId && <small>数据集 {selectedSession.datasetId.slice(0, 10)} · {selectedSession.relatedTableCount ?? 0} 张直接关联表</small>}</div><div><Badge variant="outline" className={statusClass(selectedSession.status)}>{statusLabel(selectedSession.status)}</Badge><Button variant="outline" size="sm" disabled={!selectedSessionTable} onClick={() => openSessionConversation(selectedSession.id, selectedSession.tableName)}>{selectedSessionTable ? "打开表审核" : "对应表已删除"}</Button></div></div><SessionStructureNotice session={selectedSession} /><SessionTranscript session={selectedSession} />{selectedSessionTable ? <div className="ai-session-reply"><Textarea value={sessionMessage} onChange={(event) => setSessionMessage(event.target.value)} placeholder="继续补充要求、指出错误或要求 Claude Code 重新核对资料…" rows={3} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void runSessionTurn(selectedSessionTable, selectedSession, sessionMessage, () => setSessionMessage("")); }} /><div><span>{selectedConversationBusy ? "当前 Session 正在执行，完成后可继续" : "消息会通过 Claude Code --resume 接到原上下文"}</span><Button size="sm" onClick={() => void runSessionTurn(selectedSessionTable, selectedSession, sessionMessage, () => setSessionMessage(""))} disabled={chatBusy || selectedConversationBusy || !health?.ready || !sessionMessage.trim() || !promptValid}>{chatBusy || selectedConversationBusy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}{selectedConversationBusy ? "执行中" : "继续对话"}</Button></div></div> : <div className="ai-session-table-missing"><CircleAlert size={14} /><span>此 Session 现在只读。恢复或重新导入对应表后，可以带着最新表结构继续对话。</span></div>}<SessionTrace session={selectedSession} />{selectedSession.promptTemplate && <details className="ai-session-prompt"><summary>查看本 Session 最近使用的提示词模板</summary><pre>{selectedSession.promptTemplate}</pre></details>}</> : <EmptyState icon={TerminalSquare} title="选择一个 Session" detail="这里会展示完整对话、工具调用及读取资料的过程。" />}</div>
        </TabsContent>

        <TabsContent value="todos" className="ai-tab-content ai-todo-list">
          <div className="ai-list-heading"><div><strong>人工澄清队列</strong><span>答案会回到原表 Session，并触发草稿修订</span></div><Badge variant="outline">{openTodos.length} 待处理</Badge></div>
          {openTodos.map((todo) => <div key={todo.id} className="ai-todo-with-table"><div><button type="button" onClick={() => { setSelectedSessionId(todo.sessionId); setTab("sessions"); }}><code>{todo.tableName}</code><span>查看会话</span></button><button type="button" onClick={() => openSessionConversation(todo.sessionId, todo.tableName)}>进入并继续</button></div><TodoCard todo={todo} busy={answeringTodo === todo.id} onAnswer={answerTodo} /></div>)}
          {openTodos.length === 0 && <EmptyState icon={CheckCircle2} title="没有待澄清项" detail="检索资料后仍无明确依据或存在冲突的业务概念，才会进入这里。" />}
        </TabsContent>

      </Tabs>
    </main>
    <TableConfigDialog open={draftClassEditorOpen} table={reviewDraftTable} onOpenChange={setDraftClassEditorOpen} onSave={(value) => { void saveDraftClass(value); }} />
    <FieldEditorDialog open={Boolean(draftFieldEditorName)} table={reviewDraftTable} column={reviewDraftColumn} onOpenChange={(nextOpen) => { if (!nextOpen) setDraftFieldEditorName(null); }} onSave={(annotation) => { void saveDraftField(annotation); }} />
    <AlertDialog open={sessionDeleteOpen} onOpenChange={setSessionDeleteOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>清理选中的 {selectedSessionCount} 个 Session？</AlertDialogTitle>
          <AlertDialogDescription>完整对话、Claude Code 操作轨迹、工作目录和草稿都会从本地服务删除。正在执行的关联批量任务会先停止。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={sessionsDeleting}>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={sessionsDeleting} onClick={deleteSelectedSessions}>{sessionsDeleting ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}确认清理</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
