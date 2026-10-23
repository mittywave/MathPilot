import type { AuthUser, Category, Handout, HandoutCourseNode, HandoutGroup, HandoutSummary, LibraryData, LibraryModule, Question, SmartPaperPlan, Student, StudentAbilityAnalysis, StudentProfileSummary, StudentReport, StudentReportText, StudentSummary, TeamInvite, TeamMember, TypesetRecord, TypesetSettings, WrongQuestionCatalogItem, WrongQuestionEntry } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

export function fetchLibrary() { return request<LibraryData>("/api/library"); }
export function fetchMe() { return request<{ user: AuthUser | null }>("/api/auth/me"); }
export function register(email: string, password: string, inviteCode: string) { return request<{ user: AuthUser }>("/api/auth/register", { method: "POST", body: JSON.stringify({ email, password, inviteCode }) }); }
export function login(email: string, password: string) { return request<{ user: AuthUser }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); }
export function logout() { return request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }); }
/** The login page, which comes back to `next` (a path on this site) once signed in. */
export function loginPath(next = "/library") { return `/login?next=${encodeURIComponent(next)}`; }
export function createCloudQuestion(question: Question) { return request<{ question: Question }>("/api/questions", { method: "POST", body: JSON.stringify({ question }) }); }
export function saveTypesetQuestions(questions: Question[]) { return request<{ questions: Question[] }>("/api/questions", { method: "POST", body: JSON.stringify({ questions }) }); }
export function updateCloudQuestion(question: Question) { return request<{ question: Question }>(`/api/questions/${encodeURIComponent(question.id)}`, { method: "PUT", body: JSON.stringify({ question }) }); }
export function deleteCloudQuestion(id: string) { return request<{ ok: boolean }>(`/api/questions/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function fetchDeletedQuestions() { return request<{ questions: Array<Question & { deletedAt: number }> }>("/api/questions"); }
export function restoreCloudQuestion(id: string) { return request<{ ok: boolean }>(`/api/questions/${encodeURIComponent(id)}`, { method: "PATCH" }); }
export function createCloudCategory(category: Category) { return request<{ category: Category }>("/api/categories", { method: "POST", body: JSON.stringify({ category }) }); }
export function moveCloudCategory(move: { id: string; parentId: string; beforeId: string | null }) { return request<{ ok: boolean }>("/api/categories", { method: "POST", body: JSON.stringify({ move }) }); }
export function deleteCloudCategory(id: string) { return request<{ ok: boolean; categoryIds: string[] }>(`/api/categories/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function createCloudModule(module: Pick<LibraryModule, "name" | "subtitle">) { return request<{ module: LibraryModule }>("/api/modules", { method: "POST", body: JSON.stringify({ module }) }); }
export function updateCloudModule(module: LibraryModule) { return request<{ module: LibraryModule }>(`/api/modules/${encodeURIComponent(module.id)}`, { method: "PUT", body: JSON.stringify({ module }) }); }
export function reorderCloudModules(order: string[]) { return request<{ ok: boolean }>("/api/modules", { method: "POST", body: JSON.stringify({ order }) }); }
export function deleteCloudModule(id: string, confirmation: string) { return request<{ ok: boolean; questionCount: number; categoryCount: number }>(`/api/modules/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ confirmation }) }); }
export function importCloudLibrary(data: LibraryData) { return request<{ imported: number; modules: number; categories: number }>("/api/library/import", { method: "POST", body: JSON.stringify(data) }); }
export function authorizeDownload(questionIds: string[]) { return request<{ ok: boolean }>("/api/download", { method: "POST", body: JSON.stringify({ questionIds }) }); }
export function fetchHandouts() { return request<{ handouts: HandoutSummary[]; courseNodes: HandoutCourseNode[] }>("/api/handouts"); }
export function saveHandoutCourse(change: { id?: string; parentId?: string | null; name?: string; direction?: number }) { return request<{ id: string; courseNodes: HandoutCourseNode[] }>("/api/handout-courses", { method: "POST", body: JSON.stringify(change) }); }
export function deleteHandoutCourse(id: string) { return request<{ courseNodes: HandoutCourseNode[] }>("/api/handout-courses", { method: "DELETE", body: JSON.stringify({ id }) }); }
export function fetchHandout(id: string) { return request<{ handout: Handout }>(`/api/handouts/${encodeURIComponent(id)}`); }
export function createHandout(handout: Pick<Handout, "title" | "items"> & Partial<HandoutGroup & Pick<Handout, "temporaryQuestions">>) { return request<{ handout: Handout }>("/api/handouts", { method: "POST", body: JSON.stringify({ handout }) }); }
export function arrangeHandouts(group: HandoutGroup, ids: string[]) { return request<HandoutGroup & { ids: string[] }>("/api/handouts", { method: "PATCH", body: JSON.stringify({ ...group, ids }) }); }
export function updateHandout(handout: Pick<Handout, "id" | "title" | "items"> & Partial<Pick<Handout, "temporaryQuestions">>) { return request<{ handout: Handout }>(`/api/handouts/${encodeURIComponent(handout.id)}`, { method: "PUT", body: JSON.stringify({ handout }) }); }
export function deleteHandout(id: string) { return request<{ ok: boolean }>(`/api/handouts/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function fetchTypesetRecords() { return request<{ records: TypesetRecord[] }>("/api/typeset-records"); }
export async function createTypesetRecord(file: File, record: Pick<TypesetRecord, "title" | "questionCount"> & { settings: TypesetSettings }) {
  const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
  return request<{ record: TypesetRecord }>("/api/typeset-records", { method: "POST", body: JSON.stringify({ ...record, fileName: file.name, file: data }) });
}
// 智能组卷: the agent reads the request (and the student's archive) and picks the questions by day; with current and
// instruction it revises that plan. exclude lists questions the student has already met, which swaps leave out too.
export function generateSmartPaper(body: { request: string; studentId?: string; current?: SmartPaperPlan; instruction?: string }) { return request<{ plan: SmartPaperPlan; exclude: string[] }>("/api/smart-paper", { method: "POST", body: JSON.stringify(body) }); }
// 智能组卷 keeps its plan (the questions by day) in the same history; it carries no Word.
export function createSmartPaperRecord(record: { title: string; plan: SmartPaperPlan; settings: Partial<TypesetSettings> }) { return request<{ record: TypesetRecord }>("/api/typeset-records", { method: "POST", body: JSON.stringify(record) }); }
export function updateTypesetRecord(id: string, change: { title?: string; settings?: TypesetSettings; plan?: SmartPaperPlan }) { return request<{ record: TypesetRecord }>(`/api/typeset-records/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(change) }); }
export function deleteTypesetRecord(id: string) { return request<{ ok: boolean }>(`/api/typeset-records/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export async function fetchTypesetSource(record: Pick<TypesetRecord, "id" | "fileName">) {
  const response = await fetch(`/api/typeset-records/${encodeURIComponent(record.id)}/source`);
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || `Word 读取失败（${response.status}）`);
  return new File([await response.blob()], record.fileName, { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
export function uploadHandoutImage(image: string) { return request<{ url: string }>("/api/handout-images", { method: "POST", body: JSON.stringify({ image }) }); }
export function fetchStudents() { return request<{ students: StudentSummary[]; classes: string[] }>("/api/students"); }
export function saveStudentClass(name: string, studentIds: string[], previousName?: string) { return request<{ name: string }>("/api/student-classes", { method: previousName === undefined ? "POST" : "PUT", body: JSON.stringify({ name, studentIds, previousName }) }); }
export function deleteStudentClass(name: string) { return request<{ ok: boolean }>("/api/student-classes", { method: "DELETE", body: JSON.stringify({ name }) }); }
export function createStudent(student: Pick<Student, "name" | "className" | "notes">) { return request<{ student: Student }>("/api/students", { method: "POST", body: JSON.stringify({ student }) }); }
export function updateStudent(student: Student) { return request<{ student: Student }>(`/api/students/${encodeURIComponent(student.id)}`, { method: "PUT", body: JSON.stringify({ student }) }); }
export function deleteStudent(id: string) { return request<{ ok: boolean; wrongQuestionCount: number }>(`/api/students/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export function deleteWrongQuestion(studentId: string, entryId: string) { return request<{ ok: boolean }>(`/api/students/${encodeURIComponent(studentId)}/wrong-questions/${encodeURIComponent(entryId)}`, { method: "DELETE" }); }
export function restoreWrongQuestion(studentId: string, entryId: string) { return request<{ ok: boolean }>(`/api/students/${encodeURIComponent(studentId)}/wrong-questions/${encodeURIComponent(entryId)}`, { method: "PATCH" }); }
export function fetchWrongQuestionCatalog() { return request<{ items: WrongQuestionCatalogItem[] }>("/api/wrong-questions"); }
export function fetchWrongQuestions(studentId: string) { return request<{ entries: WrongQuestionEntry[] }>(`/api/students/${encodeURIComponent(studentId)}/wrong-questions?includeHistory=true`); }
// 定档: knowledge statistics load first; open-ended ability analysis reads the same confirmed work.
export function fetchStudentProfile(studentId: string, since: number | null, signal?: AbortSignal) { return request<{ profile: StudentProfileSummary }>(`/api/students/${encodeURIComponent(studentId)}/profile${since ? `?since=${since}` : ""}`, { signal }); }
export function analyzeStudentProfile(studentId: string, since: number | null, signal?: AbortSignal, refresh = false) { return request<Pick<StudentProfileSummary, "abilityEvidence" | "abilityEvidenceTotal"> & { analysis: StudentAbilityAnalysis | null; notice: string }>(`/api/students/${encodeURIComponent(studentId)}/profile?${new URLSearchParams({ ...(since ? { since: String(since) } : {}), ...(refresh ? { refresh: "1" } : {}) })}`, { method: "POST", signal }); }
export function fetchStudentReports(studentId: string) { return request<{ reports: StudentReport[] }>(`/api/students/${encodeURIComponent(studentId)}/reports`); }
export function createStudentReport(studentId: string, period: { periodStart: number; periodEnd: number; timeZone: string }) { return request<{ report: StudentReport; notice: string }>(`/api/students/${encodeURIComponent(studentId)}/reports`, { method: "POST", body: JSON.stringify(period) }); }
export function updateStudentReport(studentId: string, id: string, text: StudentReportText) { return request<{ report: StudentReport }>(`/api/students/${encodeURIComponent(studentId)}/reports/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ text }) }); }
export function deleteStudentReport(studentId: string, id: string) { return request<{ ok: boolean }>(`/api/students/${encodeURIComponent(studentId)}/reports/${encodeURIComponent(id)}`, { method: "DELETE" }); }

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
export function fetchTeam() { return request<{ members: TeamMember[]; invite: TeamInvite; me: string }>("/api/admin/members"); }
export function updateTeamMember(id: string, changes: { role?: TeamMember["role"]; disabled?: boolean }) { return request<{ member: TeamMember }>(`/api/admin/members/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) }); }
export function resetTeamPassword(id: string) { return request<{ password: string }>(`/api/admin/members/${encodeURIComponent(id)}/password`, { method: "POST" }); }
export function changeTeamInvite(action: "rotate" | "close") { return request<{ invite: TeamInvite }>("/api/admin/invite", { method: "POST", body: JSON.stringify({ action }) }); }
