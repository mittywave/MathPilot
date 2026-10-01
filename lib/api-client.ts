import type { AuthUser, Category, LibraryData, LibraryModule, LibraryScope, Question, Student, StudentSummary, WrongQuestionEntry } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

export function fetchLibrary(scope: LibraryScope = "public") { return request<LibraryData>(`/api/library?scope=${scope}`); }
export function fetchMe() { return request<{ user: AuthUser | null }>("/api/auth/me"); }
export function register(email: string, password: string, inviteCode: string) { return request<{ user: AuthUser }>("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, inviteCode }) }); }
export function login(email: string, password: string) { return request<{ user: AuthUser }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); }
export function logout() { return request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }); }
export function createCloudQuestion(question: Question, scope: LibraryScope) { return request<{ question: Question }>("/api/questions", { method: "POST", body: JSON.stringify({ question, scope }) }); }
export function updateCloudQuestion(question: Question, scope: LibraryScope) { return request<{ question: Question }>(`/api/questions/${encodeURIComponent(question.id)}`, { method: "PUT", body: JSON.stringify({ question, scope }) }); }
export function deleteCloudQuestion(id: string, scope: LibraryScope) { return request<{ ok: boolean }>(`/api/questions/${encodeURIComponent(id)}?scope=${scope}`, { method: "DELETE" }); }
export function createCloudCategory(category: Category, scope: LibraryScope) { return request<{ category: Category }>("/api/categories", { method: "POST", body: JSON.stringify({ category, scope }) }); }
export function deleteCloudCategory(id: string, scope: LibraryScope) { return request<{ ok: boolean; categoryIds: string[] }>(`/api/categories/${encodeURIComponent(id)}?scope=${scope}`, { method: "DELETE" }); }
export function createCloudModule(module: Pick<LibraryModule, "name" | "subtitle">, scope: LibraryScope) { return request<{ module: LibraryModule }>("/api/modules", { method: "POST", body: JSON.stringify({ module, scope }) }); }
export function updateCloudModule(module: LibraryModule, scope: LibraryScope) { return request<{ module: LibraryModule }>(`/api/modules/${encodeURIComponent(module.id)}`, { method: "PUT", body: JSON.stringify({ module, scope }) }); }
export function reorderCloudModules(order: string[], scope: LibraryScope) { return request<{ ok: boolean }>("/api/modules", { method: "POST", body: JSON.stringify({ order, scope }) }); }
export function deleteCloudModule(id: string, confirmation: string, scope: LibraryScope) { return request<{ ok: boolean; questionCount: number; categoryCount: number }>(`/api/modules/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ confirmation, scope }) }); }
export function copyPublicQuestions(questionIds: string[], targetModuleId: string, targetCategoryId: string) { return request<{ questions: Question[]; copied: number }>("/api/library/copy", { method: "POST", body: JSON.stringify({ questionIds, targetModuleId, targetCategoryId }) }); }
export function importCloudLibrary(data: LibraryData, targetScope: LibraryScope) { return request<{ imported: number; modules: number; categories: number }>("/api/library/import", { method: "POST", body: JSON.stringify({ ...data, targetScope }) }); }
export function authorizeDownload(scope: LibraryScope, questionIds: string[]) { return request<{ ok: boolean }>("/api/download", { method: "POST", body: JSON.stringify({ scope, questionIds }) }); }
export function fetchStudents() { return request<{ students: StudentSummary[] }>("/api/students"); }
export function createStudent(student: Pick<Student, "name" | "className" | "notes">) { return request<{ student: Student }>("/api/students", { method: "POST", body: JSON.stringify({ student }) }); }
export function updateStudent(student: Student) { return request<{ student: Student }>(`/api/students/${encodeURIComponent(student.id)}`, { method: "PUT", body: JSON.stringify({ student }) }); }
export function deleteStudent(id: string) { return request<{ ok: boolean; wrongQuestionCount: number }>(`/api/students/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function fetchWrongQuestions(studentId: string) { return request<{ entries: WrongQuestionEntry[] }>(`/api/students/${encodeURIComponent(studentId)}/wrong-questions?includeHistory=true`); }

export function updateWrongQuestion(studentId: string, entryId: string, entry: Partial<Pick<WrongQuestionEntry, "mistakeCount" | "note" | "mastered">>) { return request<{ ok: boolean }>(`/api/students/${encodeURIComponent(studentId)}/wrong-questions/${encodeURIComponent(entryId)}`, { method: "PUT", body: JSON.stringify({ entry }) }); }
export function deleteWrongQuestion(studentId: string, entryId: string) { return request<{ ok: boolean }>(`/api/students/${encodeURIComponent(studentId)}/wrong-questions/${encodeURIComponent(entryId)}`, { method: "DELETE" }); }
export type PublicationProgress = {
  phase: "snapshot" | "compare" | "assets" | "commit" | "complete";
  current: number;
  total: number;
  label: string;
  diff?: { modules: Record<string, number>; categories: Record<string, number>; questions: Record<string, number>; missingAssets: number };
};
type PublicationResult = {
  publicationId: string;
  publishedAt: number;
  diff: { modules: Record<string, number>; categories: Record<string, number>; questions: Record<string, number>; missingAssets: number };
  knowledgeGraph?: { changed: boolean; version: number } | null;
};
export async function publishPublicLibrary(onProgress?: (progress: PublicationProgress) => void) {
  const response = await fetch("/api/publications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "publish-local-stream" }) });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `发布请求失败（${response.status}）`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: PublicationResult | null = null;
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as { type: "progress"; progress: PublicationProgress } | { type: "result"; result: PublicationResult } | { type: "error"; error: string };
      if (event.type === "progress") onProgress?.(event.progress);
      else if (event.type === "result") result = event.result;
      else throw new Error(event.error);
    }
    if (chunk.done) break;
  }
  if (!result) throw new Error("发布服务未返回完成结果");
  return result;
}
