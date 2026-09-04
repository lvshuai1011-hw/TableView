import type { ColumnAnnotation, EnumValue, SchemaTable } from "./data";

export type AiConfidence = "high" | "medium" | "low";

export type AiDataset = {
  id: string;
  createdAt: string;
  tableCount: number;
  relationshipCount: number;
};

export type AiColumnDraft = ColumnAnnotation & {
  name: string;
  confidence: AiConfidence;
  analysisSummary: string;
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
  checkedSources?: string[];
  suggestions: string[];
  blocking: boolean;
  status: "open" | "answered" | "dismissed";
  answer: string;
  createdAt: string;
  answeredAt: string | null;
  dismissedAt?: string | null;
  dismissedReason?: "field_deleted" | "table_deleted";
};

export type AiActivity = { id: string; label: string; at: string };

export type AiTraceEvent = {
  id: string;
  kind: "system" | "assistant" | "tool_use" | "tool_result" | "result" | "error" | "raw";
  label: string;
  detail: string;
  at: string;
};

export type AiSessionSummary = {
  id: string;
  claudeSessionId: string;
  name: string;
  source: "schema-atlas";
  tableName: string;
  domain0: string;
  jobId: string | null;
  datasetId?: string | null;
  relatedTableCount?: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  todoCount: number;
  hasDraft: boolean;
  staleReason?: "table_deleted" | "table_restored_requires_review" | "fields_restored_requires_review" | "fields_added_requires_review" | null;
  staleAt?: string | null;
  removedFieldNames?: string[];
  restoredFieldNames?: string[];
  structureChangedAt?: string | null;
  error: string | null;
};

export type AiSession = Omit<AiSessionSummary, "messageCount" | "todoCount" | "hasDraft"> & {
  messages: AiMessage[];
  activities: AiActivity[];
  todos: AiTodo[];
  draft: AiTableDraft | null;
  referencePaths: { requestedPath: string; resolvedPath: string; kind: "file" | "directory"; addDir: string }[];
  promptTemplate?: string;
  turnCount: number;
  trace?: AiTraceEvent[];
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
  datasetId?: string | null;
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
  datasetReady: boolean;
  initialTableName: string | null;
  onReviewTable: (tableName: string | null) => void;
  onAnnotationStarted: (tableNames: string[]) => void;
  onApplyDraft: (draft: AiTableDraft, session: AiSession) => void;
};
