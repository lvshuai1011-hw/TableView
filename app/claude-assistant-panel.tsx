"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  History,
  ListTodo,
  Loader2,
  MessageSquareText,
  PanelRightClose,
  Play,
  RefreshCw,
  Send,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { SchemaTable } from "./data";
import type {
  AiAnnotationProposal,
  AiRunResponse,
  ClaudeSessionDetail,
  ClaudeSessionSummary,
} from "./ai-types";

const SETTINGS_KEY = "schema-atlas.claude-code.settings.v1";
const DEFAULT_BASE_URL = "/claude-sidecar";

type AssistantSettings = {
  baseUrl: string;
  projectRoot: string;
  referenceDirs: string[];
};

type PanelTab = "review" | "todo" | "sessions" | "settings";

type Health = {
  ok: boolean;
  version?: string;
  projectRoot?: string;
  sessionRoot?: string;
  permissionMode?: string;
  error?: string;
};

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim() || DEFAULT_BASE_URL;
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function readSettings(): AssistantSettings {
  if (typeof window === "undefined") return { baseUrl: DEFAULT_BASE_URL, projectRoot: "", referenceDirs: [] };
  try {
    const value = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "null") as Partial<AssistantSettings> | null;
    return {
      baseUrl: normalizeBaseUrl(value?.baseUrl || DEFAULT_BASE_URL),
      projectRoot: value?.projectRoot?.trim() || "",
      referenceDirs: Array.isArray(value?.referenceDirs) ? value.referenceDirs.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [],
    };
  } catch {
    return { baseUrl: DEFAULT_BASE_URL, projectRoot: "", referenceDirs: [] };
  }
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function shortProject(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || value;
}

export function ClaudeAssistantPanel({
  tables,
  onApplyProposal,
}: {
  tables: SchemaTable[];
  onApplyProposal: (proposal: AiAnnotationProposal) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>("review");
  const [settings, setSettings] = useState<AssistantSettings>(() => readSettings());
  const [referenceText, setReferenceText] = useState(() => readSettings().referenceDirs.join("\n"));
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState<AiAnnotationProposal | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string>("");
  const [chatMessage, setChatMessage] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<ClaudeSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [selectedSession, setSelectedSession] = useState<ClaudeSessionDetail | null>(null);
  const [sessionQuery, setSessionQuery] = useState("");

  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  const todos = proposal?.clarifications ?? [];
  const patchCount = useMemo(() => proposal?.tablePatches.reduce((sum, table) => sum + table.columnPatches.length, 0) ?? 0, [proposal]);
  const filteredSessions = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((session) => `${session.title} ${session.projectPath} ${session.id}`.toLowerCase().includes(query));
  }, [sessions, sessionQuery]);

  const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers || {}) },
    });
    const body = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!response.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${response.status}`);
    return body as T;
  };

  const checkHealth = async () => {
    try {
      const next = await api<Health>("/health");
      setHealth(next);
      setError("");
    } catch (caught) {
      setHealth({ ok: false, error: caught instanceof Error ? caught.message : String(caught) });
    }
  };

  const loadSessions = async () => {
    setSessionsLoading(true);
    try {
      const result = await api<{ ok: boolean; sessions: ClaudeSessionSummary[] }>("/sessions");
      setSessions(result.sessions || []);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSessionsLoading(false);
    }
  };

  const openSession = async (session: ClaudeSessionSummary) => {
    setSessionsLoading(true);
    try {
      const result = await api<{ ok: boolean; session: ClaudeSessionDetail }>(`/sessions/${encodeURIComponent(session.id)}`);
      setSelectedSession(result.session);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSessionsLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void checkHealth();
  }, [open, baseUrl]);

  useEffect(() => {
    if (!open || tab !== "sessions" || sessions.length) return;
    void loadSessions();
  }, [open, tab]);

  const run = async (body: Record<string, unknown>) => {
    if (!tables.length) return setError("请先导入表结构再运行 Claude Code。");
    setBusy(true);
    setError("");
    try {
      const result = await api<AiRunResponse>("/run", {
        method: "POST",
        body: JSON.stringify({
          projectRoot: settings.projectRoot || undefined,
          referenceDirs: settings.referenceDirs,
          tables,
          ...body,
        }),
      });
      if (!result.proposal) throw new Error("Claude Code 没有返回 proposal");
      setProposal(result.proposal);
      if (result.sessionId) setCurrentSessionId(result.sessionId);
      setAnswers({});
      setTab(result.proposal.clarifications.length ? "todo" : "review");
      void loadSessions();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const generateAll = () => run({ mode: "generate-all" });

  const submitClarifications = () => {
    const clarificationAnswers = todos
      .map((item) => ({ id: item.id, answer: answers[item.id]?.trim() || "" }))
      .filter((item) => item.answer);
    if (!currentSessionId) return setError("当前没有可继续的 Claude Code session，请先生成一版标注。");
    if (!clarificationAnswers.length) return setError("请至少回答一个待澄清问题。");
    return run({ mode: "clarify", sessionId: currentSessionId, clarificationAnswers });
  };

  const sendChat = () => {
    const message = chatMessage.trim();
    if (!message) return;
    if (!currentSessionId) return setError("请选择一个历史 session，或先执行“AI 生成全部标注”。");
    setChatMessage("");
    return run({ mode: "chat", sessionId: currentSessionId, message });
  };

  const saveSettings = () => {
    const next: AssistantSettings = {
      baseUrl: normalizeBaseUrl(settings.baseUrl),
      projectRoot: settings.projectRoot.trim(),
      referenceDirs: [...new Set(referenceText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))],
    };
    setSettings(next);
    setReferenceText(next.referenceDirs.join("\n"));
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    void checkHealth();
  };

  const chooseSession = (session: ClaudeSessionDetail) => {
    setCurrentSessionId(session.id);
    setTab("review");
    setSelectedSession(null);
    setError("");
  };

  return <>
    {!open && <button className="claude-assistant-launcher" onClick={() => setOpen(true)} title="打开 Claude Code 标注助手">
      <Sparkles size={18} />
      <span>AI 标注</span>
      {todos.length > 0 && <em>{todos.length}</em>}
    </button>}

    {open && <aside className="claude-assistant-panel" aria-label="Claude Code 标注助手">
      <header className="claude-panel-header">
        <div><span className="claude-mark"><Bot size={18} /></span><div><strong>Claude Code 标注助手</strong><small>{currentSessionId ? `Session ${currentSessionId.slice(0, 8)}` : "本地 CLI"}</small></div></div>
        <button onClick={() => setOpen(false)} aria-label="关闭 AI 面板"><PanelRightClose size={18} /></button>
      </header>

      <nav className="claude-panel-tabs">
        <button className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}><MessageSquareText size={14} />审核</button>
        <button className={tab === "todo" ? "active" : ""} onClick={() => setTab("todo")}><ListTodo size={14} />澄清{todos.length > 0 && <em>{todos.length}</em>}</button>
        <button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}><History size={14} />Sessions</button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Settings2 size={14} />设置</button>
      </nav>

      {error && <div className="claude-panel-error"><CircleAlert size={15} /><span>{error}</span><button onClick={() => setError("")}><X size={13} /></button></div>}

      <div className="claude-panel-body">
        {tab === "review" && <div className="claude-review-pane">
          <section className="claude-status-card">
            <div><span className={`status-dot ${health?.ok ? "online" : ""}`} /><strong>{health?.ok ? "Claude Code 已连接" : "等待本地 sidecar"}</strong></div>
            <small>{health?.version || health?.error || "默认通过 /claude-sidecar 连接本机 CLI"}</small>
            {health?.permissionMode && <code>{health.permissionMode}</code>}
          </section>

          {!proposal && <section className="claude-empty-state">
            <Sparkles size={27} />
            <strong>生成全部表与全部字段的第一版标注</strong>
            <p>Claude Code 会主动读取你配置的本地代码仓库、已审核 JSON 和规范资料。无法确认的业务概念会进入人工澄清 Todo。</p>
            <Button onClick={generateAll} disabled={busy || tables.length === 0}>{busy ? <Loader2 className="spin" size={15} /> : <Play size={15} />}AI 生成全部标注</Button>
          </section>}

          {proposal && <>
            <section className="claude-proposal-summary">
              <div><Sparkles size={16} /><strong>当前 Proposal</strong></div>
              <p>{proposal.summary}</p>
              <div className="proposal-stats"><Badge variant="outline">{proposal.tablePatches.length} 张表</Badge><Badge variant="outline">{patchCount} 个字段建议</Badge><Badge variant="outline">{todos.length} 个待澄清</Badge></div>
              {proposal.notes?.length ? <ul>{proposal.notes.map((note, index) => <li key={`${index}:${note}`}>{note}</li>)}</ul> : null}
              <div className="proposal-actions"><Button variant="outline" onClick={generateAll} disabled={busy}><RefreshCw size={14} />重新生成全部</Button><Button onClick={() => onApplyProposal(proposal)} disabled={busy || proposal.tablePatches.length === 0}><Check size={14} />应用当前 Proposal</Button></div>
            </section>

            <section className="claude-patch-list">
              {proposal.tablePatches.map((table) => <details key={table.tableName}>
                <summary><div><code>{table.tableName}</code><small>{table.reason}</small></div><Badge variant="outline">{table.columnPatches.length}</Badge></summary>
                {(table.className || table.classDescription || table.classAliases) && <div className="class-patch">
                  {table.className && <div><span>class_name</span><code>{table.className}</code></div>}
                  {table.classDescription && <p>{table.classDescription}</p>}
                  {table.classAliases?.length ? <small>别名：{table.classAliases.join("，")}</small> : null}
                </div>}
                <div className="column-patches">{table.columnPatches.map((column) => <article key={column.columnName}>
                  <div><code>{column.columnName}</code><small>{column.reason}</small></div>
                  <pre>{JSON.stringify(column.annotation, null, 2)}</pre>
                </article>)}</div>
              </details>)}
              {proposal.tablePatches.length === 0 && <div className="claude-list-empty">本轮没有产生字段修改。</div>}
            </section>
          </>}

          <section className="claude-chat-box">
            <div><MessageSquareText size={14} /><strong>继续纠正</strong></div>
            <Textarea value={chatMessage} onChange={(event) => setChatMessage(event.target.value)} placeholder="例如：CUST_ID 在这里是计费客户标识，不是 CRM 客户 ID。请检查全部相关表并修正。" rows={4} />
            <Button onClick={sendChat} disabled={busy || !chatMessage.trim() || !currentSessionId}>{busy ? <Loader2 className="spin" size={14} /> : <Send size={14} />}发送到当前 Session</Button>
          </section>
        </div>}

        {tab === "todo" && <div className="claude-todo-pane">
          <header><div><ListTodo size={17} /><strong>人工澄清 Todo</strong></div><small>AI 不确定的概念先在这里逐项澄清，再继续同一个 Claude Code session。</small></header>
          {todos.map((item, index) => <article key={item.id} className="clarification-card">
            <div className="clarification-heading"><span>{index + 1}</span><div><strong>{item.concept}</strong><small>{item.priority ? `${item.priority} priority` : "待澄清"}</small></div></div>
            <p>{item.question}</p>
            {item.context && <blockquote>{item.context}</blockquote>}
            {(item.tableNames?.length || item.fieldRefs?.length) && <div className="clarification-scope">{item.tableNames?.map((name) => <code key={name}>{name}</code>)}{item.fieldRefs?.map((name) => <code key={name}>{name}</code>)}</div>}
            <Textarea value={answers[item.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="填写人工确认的业务含义、命名规则或处理原则…" rows={3} />
          </article>)}
          {todos.length === 0 && <div className="claude-list-empty"><Check size={20} />当前没有需要人工澄清的概念。</div>}
          {todos.length > 0 && <div className="clarification-submit"><Button onClick={submitClarifications} disabled={busy || !Object.values(answers).some((value) => value.trim())}>{busy ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}提交澄清并继续生成</Button></div>}
        </div>}

        {tab === "sessions" && <div className="claude-sessions-pane">
          {!selectedSession ? <>
            <header className="session-browser-header"><div><History size={17} /><strong>本机 Claude Code Sessions</strong></div><button onClick={loadSessions} disabled={sessionsLoading} title="刷新">{sessionsLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}</button></header>
            <Input value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="搜索标题、项目路径或 session id" />
            <div className="session-list">{filteredSessions.map((session) => <button key={`${session.projectPath}:${session.id}`} onClick={() => openSession(session)}>
              <div><strong>{session.title}</strong><small>{shortProject(session.projectPath)} · {formatDate(session.updatedAt)}</small></div><ChevronRight size={15} />
            </button>)}</div>
            {!sessionsLoading && filteredSessions.length === 0 && <div className="claude-list-empty">没有找到本地 Claude Code session。</div>}
          </> : <>
            <header className="session-detail-header"><button onClick={() => setSelectedSession(null)}>← Sessions</button><Button size="sm" onClick={() => chooseSession(selectedSession)}>设为当前并继续</Button></header>
            <section className="session-meta"><strong>{selectedSession.title}</strong><code>{selectedSession.id}</code><small>{selectedSession.projectPath}</small></section>
            <div className="session-transcript">{selectedSession.messages.map((message) => <article key={message.id} className={`session-message ${message.role}`}>
              <div><span>{message.role === "assistant" ? "Claude" : message.role === "user" ? "User" : message.toolName || "Tool"}</span>{message.timestamp && <time>{formatDate(message.timestamp)}</time>}</div>
              <pre>{message.text || "(empty)"}</pre>
            </article>)}</div>
          </>}
        </div>}

        {tab === "settings" && <div className="claude-settings-pane">
          <header><Settings2 size={17} /><div><strong>本地 Claude Code 配置</strong><small>这里只保存路径和 sidecar 地址，不保存模型密钥。</small></div></header>
          <label><span>Sidecar URL</span><Input value={settings.baseUrl} onChange={(event) => setSettings((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="/claude-sidecar" /></label>
          <label><span>Schema Atlas 项目目录</span><Input value={settings.projectRoot} onChange={(event) => setSettings((current) => ({ ...current, projectRoot: event.target.value }))} placeholder="留空使用 sidecar 启动目录，例如 /home/AI_BUILD/TableView" /></label>
          <label><span>参考资料目录（每行一个）</span><Textarea value={referenceText} onChange={(event) => setReferenceText(event.target.value)} rows={9} placeholder={"/data/repos/billing\n/data/approved-json\n/data/specs"} /></label>
          <div className="settings-note"><CircleAlert size={14} /><span>这些目录会通过 Claude Code 原生 <code>--add-dir</code> 传入。sidecar 默认使用 <code>--dangerously-skip-permissions</code>，建议参考目录在操作系统层面保持只读。</span></div>
          <Button onClick={saveSettings}><Check size={14} />保存并检测连接</Button>
          {health && <section className="health-details"><div><span>状态</span><strong>{health.ok ? "正常" : "不可用"}</strong></div>{health.version && <div><span>版本</span><code>{health.version}</code></div>}{health.projectRoot && <div><span>默认项目目录</span><code>{health.projectRoot}</code></div>}{health.sessionRoot && <div><span>Session 目录</span><code>{health.sessionRoot}</code></div>}</section>}
        </div>}
      </div>
    </aside>}
  </>;
}
