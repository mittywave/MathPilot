import type { KnowledgeGraphChangeSummary, KnowledgeGraphDocument, KnowledgeGraphEditorState, KnowledgeGraphIssue, KnowledgeGraphOverview, KnowledgeGraphVersion } from "./types";

export class KnowledgeGraphRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: KnowledgeGraphIssue[];

  constructor(message: string, status: number, code = "", issues: KnowledgeGraphIssue[] = []) {
    super(message); this.status = status; this.code = code; this.issues = issues;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string; code?: string; issues?: KnowledgeGraphIssue[] };
  if (!response.ok) throw new KnowledgeGraphRequestError(payload.error || `请求失败（${response.status}）`, response.status, payload.code, payload.issues);
  return payload;
}

export type PublishKnowledgeGraphResult = {
  version: number; frameworkVersion: string; publishedAt: number | null; summary: KnowledgeGraphChangeSummary; unchanged: boolean; revision: number;
};

export const knowledgeGraphApi = {
  overview: (studentId = "") => request<KnowledgeGraphOverview>(`/api/knowledge-graph${studentId ? `?studentId=${encodeURIComponent(studentId)}` : ""}`),
  editor: () => request<KnowledgeGraphEditorState>("/api/knowledge-graph/draft"),
  saveDraft: (revision: number, document: KnowledgeGraphDocument) =>
    request<{ revision: number; updatedAt: number; issues: KnowledgeGraphIssue[] }>("/api/knowledge-graph/draft", { method: "PUT", body: JSON.stringify({ revision, document }) }),
  discardDraft: (revision: number) => request<{ revision: number }>("/api/knowledge-graph/draft", { method: "DELETE", body: JSON.stringify({ revision }) }),
  publish: (revision: number, note: string) => request<PublishKnowledgeGraphResult>("/api/knowledge-graph/publish", { method: "POST", body: JSON.stringify({ revision, note }) }),
  versions: () => request<{ versions: KnowledgeGraphVersion[] }>("/api/knowledge-graph/versions"),
  restore: (version: number, revision: number) => request<{ revision: number; updatedAt: number }>("/api/knowledge-graph/versions", { method: "POST", body: JSON.stringify({ version, revision }) }),
};
