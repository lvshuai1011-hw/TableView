import type { ColumnAnnotation, EnumValue, SchemaTable } from "./data";

export type AiConfidence = "high" | "medium" | "low";

export type AiColumnDraft = ColumnAnnotation & {
  name: string;
  confidence: AiConfidence;
  reason: string;
  enumValues: EnumValue[];
};

export type AiTableDraft = {
  tableName: string;
  className: string;
  classDescription: string;
  classAliases: string[];
  confidence: AiConfidence;
  columns: AiColumnDraft[];
};

export type AiMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  at: string;
  draftUpdated?: boolean;
  todoCount?: number;
};

export type AiTodo = {
  id: string;
  sessionId: string;
  tableName: string;
  scope: "table" | "field" | "domain";
  fieldName: string;
  question: string;
  reason: string;
  suggestions: string[];
  blocking: boolean;
  status: "open" | "answered";
  answer: string;
  createdAt: string;
  answeredAt: string | null;
};

export type AiActivity = { id: string; label: string; at: string };

export type AiSessionSummary = {
  id: string;
  claudeSessionId: string;
  name: string;
  source: "schema-atlas";
  tableName: string;
  domain0: string;
  jobId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  todoCount: number;
  hasDraft: boolean;
  error: string | null;
};

export type AiSession = Omit<AiSessionSummary, "messageCount" | "todoCount" | "hasDraft"> & {
  messages: AiMessage[];
  activities: AiActivity[];
  todos: AiTodo[];
  draft: AiTableDraft | null;
  referencePaths: { requestedPath: string; resolvedPath: string; kind: "file" | "directory"; addDir: string }[];
  turnCount: number;
};

export type AiJob = {
  id: string;
  label: string;
  scope: { level: "global" | "domain"; domain0?: string };
  status: string;
  total: number;
  completed: number;
  failed: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
};

export type AiHealth = {
  available: boolean;
  authenticated: boolean;
  ready: boolean;
  version: string;
  error: string | null;
  rootUser: boolean;
  user: string;
  allowedRoots: string[];
  dataDir: string;
  permissionMode: "bypassPermissions";
};

export type AiPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tables: SchemaTable[];
  initialTableName: string | null;
  onReviewTable: (tableName: string | null) => void;
  onApplyDraft: (draft: AiTableDraft, session: AiSession) => void;
};
