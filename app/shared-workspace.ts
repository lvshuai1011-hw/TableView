import type { SchemaTable } from "./data";
import type { ChangeHistoryStore } from "./schema-utils";

export type SharedWorkspaceData = {
  initialized: boolean;
  revision: number;
  updatedAt: string | null;
  tables: SchemaTable[];
  changeHistory: ChangeHistoryStore;
};

export type SharedAiPreferences = {
  initialized: boolean;
  revision: number;
  updatedAt: string | null;
  referenceText: string;
  promptTemplate: string;
  batchInstruction: string;
};

export type SharedAiPreferencesValue = Pick<
  SharedAiPreferences,
  "referenceText" | "promptTemplate" | "batchInstruction"
>;

export class SharedWorkspaceConflict extends Error {
  conflicts: string[];
  workspace: unknown;

  constructor(message: string, conflicts: string[] = [], workspace: unknown = null) {
    super(message);
    this.name = "SharedWorkspaceConflict";
    this.conflicts = conflicts;
    this.workspace = workspace;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : `请求失败（${response.status}）`;
    if (response.status === 409) {
      throw new SharedWorkspaceConflict(
        message,
        Array.isArray(payload.conflicts) ? payload.conflicts.filter((item): item is string => typeof item === "string") : [],
        payload.workspace,
      );
    }
    throw new Error(message);
  }
  return payload as T;
}

export async function readSharedWorkspaceData(revision?: number) {
  const suffix = Number.isInteger(revision) ? `?revision=${revision}` : "";
  return requestJson<{ unchanged: boolean; revision?: number; data?: SharedWorkspaceData }>(`/api/ai/workspace/data${suffix}`);
}

export async function saveSharedWorkspaceData(input: {
  baseRevision: number;
  tables: SchemaTable[];
  changeHistory: ChangeHistoryStore;
  changedTableNames: string[];
}) {
  return requestJson<{ data: SharedWorkspaceData }>("/api/ai/workspace/data", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function readSharedAiPreferences(revision?: number) {
  const suffix = Number.isInteger(revision) ? `?revision=${revision}` : "";
  return requestJson<{ unchanged: boolean; revision?: number; preferences?: SharedAiPreferences }>(`/api/ai/workspace/preferences${suffix}`);
}

export async function saveSharedAiPreferences(input: {
  baseRevision: number;
  preferences: SharedAiPreferencesValue;
}) {
  return requestJson<{ preferences: SharedAiPreferences }>("/api/ai/workspace/preferences", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
