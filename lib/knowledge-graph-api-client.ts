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

// Every call names the graph it works on (see KNOWLEDGE_GRAPHS).
const query = (values: Record<string, string>) => `?${new URLSearchParams(Object.entries(values).filter(([, value]) => value))}`;

export const knowledgeGraphApi = {
  overview: (graph: string, studentId = "") => request<KnowledgeGraphOverview>(`/api/knowledge-graph${query({ graph, studentId })}`),
  editor: (graph: string) => request<KnowledgeGraphEditorState>(`/api/knowledge-graph/draft${query({ graph })}`),
  saveDraft: (graph: string, revision: number, document: KnowledgeGraphDocument) =>
    request<{ revision: number; updatedAt: number; issues: KnowledgeGraphIssue[] }>("/api/knowledge-graph/draft", { method: "PUT", body: JSON.stringify({ graph, revision, document }) }),
  discardDraft: (graph: string, revision: number) => request<{ revision: number }>("/api/knowledge-graph/draft", { method: "DELETE", body: JSON.stringify({ graph, revision }) }),
  publish: (graph: string, revision: number, note: string) => request<PublishKnowledgeGraphResult>("/api/knowledge-graph/publish", { method: "POST", body: JSON.stringify({ graph, revision, note }) }),
  versions: (graph: string) => request<{ versions: KnowledgeGraphVersion[] }>(`/api/knowledge-graph/versions${query({ graph })}`),
  restore: (graph: string, version: number, revision: number) => request<{ revision: number; updatedAt: number }>("/api/knowledge-graph/versions", { method: "POST", body: JSON.stringify({ graph, version, revision }) }),
};
