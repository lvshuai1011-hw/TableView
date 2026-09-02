"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock3,
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
  WandSparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { summarizeAiDraft } from "./ai-utils";
import type {
  AiHealth,
  AiJob,
  AiPanelProps,
  AiSession,
  AiSessionSummary,
  AiTodo,
} from "./ai-types";

const REFERENCES_KEY = "schema-atlas.ai.reference-paths.v1";

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
  } as Record<string, string>)[status] ?? status;
}

function statusClass(status: string) {
  if (["completed", "applied"].includes(status)) return "is-success";
  if (["failed", "completed_with_errors"].includes(status)) return "is-error";
  if (["running", "queued", "cancelling"].includes(status)) return "is-running";
  if (status === "needs_clarification") return "is-warning";
  return "";
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

function TodoCard({ todo, busy, onAnswer }: { todo: AiTodo; busy: boolean; onAnswer: (todo: AiTodo, answer: string) => void }) {
  const [answer, setAnswer] = useState("");
  return <article className={`ai-todo-card ${todo.blocking ? "blocking" : ""}`}>
    <div className="ai-todo-head"><Badge variant="outline">{todo.scope === "field" ? todo.fieldName : todo.scope === "domain" ? "域级概念" : "表级概念"}</Badge>{todo.blocking && <span><CircleAlert size={12} />阻塞生成</span>}</div>
    <strong>{todo.question}</strong>
    {todo.reason && <p>{todo.reason}</p>}
    {todo.suggestions.length > 0 && <div className="ai-todo-suggestions">{todo.suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => setAnswer(suggestion)}>{suggestion}</button>)}</div>}
    {todo.status === "answered" ? <div className="ai-todo-answer"><CheckCircle2 size={13} /><span>{todo.answer}</span></div> : <div className="ai-todo-compose"><Input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="填写业务确认结果" /><Button size="sm" disabled={!answer.trim() || busy} onClick={() => onAnswer(todo, answer.trim())}>{busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />}提交</Button></div>}
  </article>;
}

function SessionListItem({ session, active, onClick }: { session: AiSessionSummary; active: boolean; onClick: () => void }) {
  return <button type="button" className={`ai-session-row ${active ? "active" : ""}`} onClick={onClick}>
    <span className={`ai-session-dot ${statusClass(session.status)}`} />
    <div><strong>{session.tableName}</strong><small>{session.domain0} · {session.messageCount} 条消息</small></div>
    <div><Badge variant="outline" className={statusClass(session.status)}>{statusLabel(session.status)}</Badge><time>{shortTime(session.updatedAt)}</time></div>
  </button>;
}

export function AiPanel({ open, onOpenChange, tables, initialTableName, onReviewTable, onApplyDraft }: AiPanelProps) {
  const [tab, setTab] = useState("work");
  const [health, setHealth] = useState<AiHealth | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [sessions, setSessions] = useState<AiSessionSummary[]>([]);
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [todos, setTodos] = useState<AiTodo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<AiSession | null>(null);
  const [loadingSession, setLoadingSession] = useState(false);
  const [chatMessage, setChatMessage] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [activity, setActivity] = useState("");
  const [batchDomain, setBatchDomain] = useState("__all__");
  const [batchBusy, setBatchBusy] = useState(false);
  const [answeringTodo, setAnsweringTodo] = useState<string | null>(null);
  const [referenceText, setReferenceText] = useState("");
  const activeTable = initialTableName ? tables.find((table) => table.tableName === initialTableName) : undefined;
  const domains = useMemo(() => [...new Set(tables.map((table) => table.domain0))].sort((a, b) => a.localeCompare(b, "zh-CN")), [tables]);
  const referencePaths = useMemo(() => referenceText.split("\n").map((item) => item.trim()).filter(Boolean), [referenceText]);
  const currentJob = jobs.find((job) => ["queued", "running", "cancelling"].includes(job.status)) ?? jobs[0];
  const tableSessions = activeTable ? sessions.filter((session) => session.tableName === activeTable.tableName) : [];

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
      try { setReferenceText(window.localStorage.getItem(REFERENCES_KEY) ?? ""); } catch { /* preferences are optional */ }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(REFERENCES_KEY, referenceText); } catch { /* preferences are optional */ }
  }, [referenceText]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setTab("work");
      setSelectedSessionId(null);
      setSelectedSession(null);
      void refresh();
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
    queueMicrotask(() => { if (active) setSelectedSessionId(candidate.id); });
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
    if (tab === "work" && !activeTable) setTab("sessions");
  };

  const sendMessage = async () => {
    if (!activeTable || chatBusy) return;
    const text = chatMessage.trim() || (selectedSession ? "请重新检查当前草稿，补充仍然缺少的标注。" : "请生成当前表的第一版完整标注。");
    setChatMessage("");
    setChatBusy(true);
    setActivity("正在启动 Claude Code…");
    try {
      await streamChat({
        table: activeTable,
        message: text,
        referencePaths,
        sessionId: selectedSession?.tableName === activeTable.tableName ? selectedSession.id : undefined,
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
      toast.error("Claude Code 执行失败", { description: error instanceof Error ? error.message : "未知错误" });
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
      const value = await api<{ job: AiJob }>("/api/ai/jobs/generate", {
        method: "POST",
        body: JSON.stringify({
          tables: selectedTables,
          referencePaths,
          scope: batchDomain === "__all__" ? { level: "global" } : { level: "domain", domain0: batchDomain },
        }),
      });
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

  const answerTodo = async (todo: AiTodo, answer: string) => {
    setAnsweringTodo(todo.id);
    try {
      const currentTable = tables.find((table) => table.tableName === todo.tableName);
      await api(`/api/ai/todos/${todo.id}/answer`, {
        method: "POST",
        body: JSON.stringify({ answer, table: currentTable }),
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
      toast.success(`已应用 ${activeTable.tableName} 的 AI 草稿`, { description: "本次修改已写入该表自己的变更记录。" });
    } catch (error) {
      toast.warning("标注已应用，但 Session 状态同步失败", { description: error instanceof Error ? error.message : "可稍后重试" });
    }
  };

  const draftSummary = activeTable && selectedSession?.draft && selectedSession.draft.tableName === activeTable.tableName
    ? summarizeAiDraft(activeTable, selectedSession.draft)
    : null;
  const currentTodos = selectedSession?.todos.filter((todo) => todo.status === "open") ?? [];
  const openTodos = todos.filter((todo) => todo.status === "open");

  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent className="ai-workbench-sheet">
      <SheetHeader className="ai-sheet-header">
        <div className="ai-title-mark"><Sparkles size={18} /></div>
        <div><SheetTitle>Claude Code 标注台</SheetTitle><SheetDescription>{activeTable ? `${activeTable.tableName} · 表级审核会话` : "批量生成、人工澄清与 Session 管理"}</SheetDescription></div>
        <div className={`ai-connection ${health?.ready ? "online" : "offline"}`}><i />{health?.ready ? `${health.user} · 已连接` : "未连接"}</div>
      </SheetHeader>

      {connectionError && <div className="ai-connection-error"><CircleAlert size={16} /><div><strong>本地 AI 服务不可用</strong><p>{connectionError}。请使用 <code>npm run start:local</code> 启动完整服务。</p></div><Button variant="outline" size="sm" onClick={() => refresh()}><RefreshCw size={13} />重试</Button></div>}

      <Tabs value={tab} onValueChange={setTab} className="ai-tabs">
        <TabsList>
          <TabsTrigger value="work"><WandSparkles size={14} />{activeTable ? "审核对话" : "批量生成"}</TabsTrigger>
          <TabsTrigger value="sessions"><MessageSquareText size={14} />Sessions <span>{sessions.length}</span></TabsTrigger>
          <TabsTrigger value="todos"><ListTodo size={14} />待澄清 <span>{openTodos.length}</span></TabsTrigger>
          <TabsTrigger value="settings"><FolderSearch size={14} />资料</TabsTrigger>
        </TabsList>

        <TabsContent value="work" className="ai-tab-content">
          {activeTable ? <div className="ai-table-workspace">
            <div className="ai-table-context"><div><span>当前表</span><code>{activeTable.tableName}</code><small>{activeTable.className} · {activeTable.columns.length} 个字段</small></div><div className="ai-table-context-actions">{tableSessions.length > 1 && <Select value={selectedSession?.tableName === activeTable.tableName ? selectedSession.id : tableSessions[0]?.id} onValueChange={selectSession}><SelectTrigger size="sm"><SelectValue placeholder="选择会话" /></SelectTrigger><SelectContent>{tableSessions.map((session) => <SelectItem key={session.id} value={session.id}>{shortTime(session.updatedAt)} · {statusLabel(session.status)}</SelectItem>)}</SelectContent></Select>}<button type="button" onClick={() => onReviewTable(null)}>返回批量</button></div></div>
            {selectedSession?.tableName === activeTable.tableName ? <>
              <SessionTranscript session={{ ...selectedSession, status: chatBusy ? "running" : selectedSession.status, activities: activity ? [...selectedSession.activities, { id: "live", label: activity, at: new Date().toISOString() }] : selectedSession.activities }} />
              {selectedSession.draft && draftSummary && <section className="ai-draft-card">
                <div className="ai-draft-heading"><div><FileCheck2 size={16} /><span>AI 标注草稿</span></div><Badge variant="outline" className={`confidence-${selectedSession.draft.confidence}`}>{selectedSession.draft.confidence === "high" ? "高置信" : selectedSession.draft.confidence === "low" ? "低置信" : "中等置信"}</Badge></div>
                <div className="ai-draft-stats"><div><strong>{draftSummary.changedFields}</strong><span>字段有变化</span></div><div><strong>{draftSummary.includedFields}</strong><span>字段将导出</span></div><div><strong>{draftSummary.lowConfidenceFields}</strong><span>低置信字段</span></div></div>
                <div className="ai-draft-class"><span>类名</span><code>{activeTable.className}</code><strong>→</strong><code>{selectedSession.draft.className}</code></div>
                <details className="ai-draft-fields">
                  <summary>查看 {selectedSession.draft.columns.length} 个字段的标注草稿</summary>
                  <div>{selectedSession.draft.columns.map((column) => <article key={column.name}>
                    <div><code>{column.name}</code><strong>→</strong><code>{column.entityColumn}</code><Badge variant="outline" className={`confidence-${column.confidence}`}>{column.confidence === "high" ? "高" : column.confidence === "low" ? "低" : "中"}</Badge></div>
                    <p>{column.detailedDescription || "暂无详细描述"}</p>
                    <div className="ai-draft-flags">{!column.included && <span>不导出</span>}{column.isLocalId && <span>LOCAL ID</span>}{column.isCode && <span>CODE</span>}{column.isDisplayName && <span>DISPLAY NAME</span>}{column.enumRef && <span>ENUM · {column.enumRef}</span>}{column.aliases.map((alias) => <span key={alias}>{alias}</span>)}</div>
                    {column.reason && <small>{column.reason}</small>}
                  </article>)}</div>
                </details>
                <Button onClick={applyDraft} disabled={chatBusy || selectedSession.status === "applied"}>{selectedSession.status === "applied" ? <CheckCircle2 size={15} /> : <FileCheck2 size={15} />}{selectedSession.status === "applied" ? "草稿已应用" : "审核后应用到当前表"}</Button>
              </section>}
              {currentTodos.length > 0 && <section className="ai-table-todos"><h3>需要人工确认 <span>{currentTodos.length}</span></h3>{currentTodos.map((todo) => <TodoCard key={todo.id} todo={todo} busy={answeringTodo === todo.id} onAnswer={answerTodo} />)}</section>}
            </> : <EmptyState icon={Bot} title="为当前表建立 AI 会话" detail="Claude Code 会读取表结构、上下游关系和你配置的本地参考资料，先生成一版供人工审核。" />}
            <div className="ai-chat-composer"><Textarea value={chatMessage} onChange={(event) => setChatMessage(event.target.value)} placeholder={selectedSession ? "指出不准确的字段、补充业务规则，或要求重新检查…" : "可补充本表的生成要求；留空则直接生成第一版"} rows={3} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void sendMessage(); }} /><div><span>Ctrl/⌘ + Enter 发送</span><Button onClick={sendMessage} disabled={chatBusy || !health?.ready}>{chatBusy ? <Loader2 size={15} className="spin" /> : <Send size={15} />}{selectedSession ? "发送并修订" : "生成当前表"}</Button></div></div>
          </div> : <div className="ai-batch-workspace">
            <section className="ai-batch-card"><div className="ai-section-heading"><div><WandSparkles size={18} /><span>生成所有 JSON 的标注草稿</span></div><Badge variant="outline">逐表 Session</Badge></div><p>每张表建立独立会话，批量任务只负责统一调度。草稿不会覆盖当前标注。</p><label><span>生成范围</span><Select value={batchDomain} onValueChange={setBatchDomain}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__all__">全部 0级域 · {tables.length} 张表</SelectItem>{domains.map((domain) => <SelectItem key={domain} value={domain}>{domain} · {tables.filter((table) => table.domain0 === domain).length} 张表</SelectItem>)}</SelectContent></Select></label><Button onClick={startBatch} disabled={!health?.ready || batchBusy || tables.length === 0}>{batchBusy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}启动全量生成</Button></section>
            {currentJob && <section className="ai-job-card"><div><div><span className={`ai-session-dot ${statusClass(currentJob.status)}`} /><strong>{currentJob.label}</strong></div><Badge variant="outline" className={statusClass(currentJob.status)}>{statusLabel(currentJob.status)}</Badge></div><Progress value={currentJob.total ? ((currentJob.completed + currentJob.failed) / currentJob.total) * 100 : 0} /><div className="ai-job-stats"><span>{currentJob.completed} 已完成</span><span>{currentJob.failed} 失败</span><span>{currentJob.total - currentJob.completed - currentJob.failed} 待处理</span>{["queued", "running"].includes(currentJob.status) && <button onClick={() => stopJob(currentJob)}><Square size={11} />停止</button>}</div></section>}
            <div className="ai-batch-note"><Clock3 size={15} /><p>生成在服务器后台继续运行。关闭浏览器或 SSH 不会中断由 systemd 托管的任务。</p></div>
          </div>}
        </TabsContent>

        <TabsContent value="sessions" className="ai-tab-content ai-sessions-content">
          <div className="ai-session-list"><div className="ai-list-heading"><div><strong>Schema Atlas Sessions</strong><span>只展示本系统登记的会话</span></div><Button variant="outline" size="sm" onClick={() => refresh()}><RefreshCw size={13} />刷新</Button></div>{sessions.map((session) => <SessionListItem key={session.id} session={session} active={selectedSessionId === session.id} onClick={() => selectSession(session.id)} />)}{sessions.length === 0 && <EmptyState icon={MessageSquareText} title="暂无 Session" detail="生成一张表或启动批量任务后，会话会出现在这里。" />}</div>
          <div className="ai-session-detail">{loadingSession ? <div className="ai-loading"><Loader2 size={18} className="spin" />读取完整对话…</div> : selectedSession ? <><div className="ai-session-detail-head"><div><code>{selectedSession.tableName}</code><span>{selectedSession.name}</span></div><div><Badge variant="outline" className={statusClass(selectedSession.status)}>{statusLabel(selectedSession.status)}</Badge><Button variant="outline" size="sm" onClick={() => { onReviewTable(selectedSession.tableName); setTab("work"); }}>审核此表</Button></div></div><SessionTranscript session={selectedSession} />{selectedSession.activities.length > 0 && <details className="ai-activities"><summary>执行过程 · {selectedSession.activities.length}</summary>{selectedSession.activities.map((item) => <div key={item.id}><time>{shortTime(item.at)}</time><span>{item.label}</span></div>)}</details>}</> : <EmptyState icon={TerminalSquare} title="选择一个 Session" detail="这里会展示完整的人工与 Claude Code 对话过程。" />}</div>
        </TabsContent>

        <TabsContent value="todos" className="ai-tab-content ai-todo-list">
          <div className="ai-list-heading"><div><strong>人工澄清队列</strong><span>答案会回到原表 Session，并触发草稿修订</span></div><Badge variant="outline">{openTodos.length} 待处理</Badge></div>
          {openTodos.map((todo) => <div key={todo.id} className="ai-todo-with-table"><div><button type="button" onClick={() => { setSelectedSessionId(todo.sessionId); setTab("sessions"); }}><code>{todo.tableName}</code><span>查看会话</span></button><button type="button" onClick={() => { onReviewTable(todo.tableName); setTab("work"); }}>进入表审核</button></div><TodoCard todo={todo} busy={answeringTodo === todo.id} onAnswer={answerTodo} /></div>)}
          {openTodos.length === 0 && <EmptyState icon={CheckCircle2} title="没有待澄清项" detail="Claude Code 不确定的业务概念会集中到这里，由人工逐项确认。" />}
        </TabsContent>

        <TabsContent value="settings" className="ai-tab-content ai-reference-settings">
          <section><div className="ai-section-heading"><div><FolderSearch size={18} /><span>本地参考资料</span></div><Badge variant="outline">直接读取</Badge></div><p>每行填写一个服务器本地文件或目录。Claude Code直接阅读这些路径，不建立检索库。</p><Textarea value={referenceText} onChange={(event) => setReferenceText(event.target.value)} rows={8} placeholder={"/home/claude/repos/billing\n/home/claude/annotations/ontologies"} /><small>路径会在任务启动时验证，且必须位于服务端允许的根目录内。</small></section>
          <section className="ai-runtime-card"><div><span>运行账户</span><code>{health?.user || "未连接"}</code></div><div><span>Claude Code</span><code>{health?.version || health?.error || "未检测"}</code></div><div><span>登录状态</span><code>{health?.authenticated ? "已登录" : "未登录"}</code></div><div><span>权限模式</span><code>--dangerously-skip-permissions</code></div><div><span>允许根目录</span><div>{health?.allowedRoots?.map((root) => <code key={root}>{root}</code>) ?? <code>等待连接</code>}</div></div></section>
        </TabsContent>
      </Tabs>
    </SheetContent>
  </Sheet>;
}
