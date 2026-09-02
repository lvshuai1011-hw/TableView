import type { ColumnAnnotation, SchemaTable } from "./data";

export type AiClarification = {
  id: string;
  concept: string;
  question: string;
  context?: string;
  tableNames?: string[];
  fieldRefs?: string[];
  priority?: "high" | "medium" | "low";
};

export type AiColumnPatch = {
  columnName: string;
  reason: string;
  annotation: Partial<ColumnAnnotation>;
};

export type AiTablePatch = {
  tableName: string;
  reason: string;
  className?: string;
  classDescription?: string;
  classAliases?: string[];
  columnPatches: AiColumnPatch[];
};

export type AiAnnotationProposal = {
  summary: string;
  notes?: string[];
  clarifications: AiClarification[];
  tablePatches: AiTablePatch[];
};

export type AiRunRequest = {
  projectRoot?: string;
  referenceDirs: string[];
  tables: SchemaTable[];
  sessionId?: string;
  mode: "generate-all" | "clarify" | "chat";
  message?: string;
  clarificationAnswers?: { id: string; answer: string }[];
};

export type AiRunResponse = {
  ok: boolean;
  sessionId?: string;
  proposal?: AiAnnotationProposal;
  error?: string;
  stderr?: string;
};

export type ClaudeSessionSummary = {
  id: string;
  title: string;
  projectPath: string;
  updatedAt: string;
  size: number;
};

export type ClaudeSessionMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  timestamp?: string;
  toolName?: string;
};

export type ClaudeSessionDetail = ClaudeSessionSummary & {
  messages: ClaudeSessionMessage[];
};
