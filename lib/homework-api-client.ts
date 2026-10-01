import type { Assignment, AuthUser, GradingItem, HomeworkAsset, HomeworkClass, HomeworkSubmission, StudentAccount, StudentAuth, StudentCapabilityProfile, StudentSummary, WrongQuestionEntry } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`); return payload;
}

export const homeworkApi = {
  me: () => request<{ user: AuthUser | null }>("/api/auth/me"),
  students: () => request<{ students: StudentSummary[] }>("/api/students"),
  classes: () => request<{ classes: HomeworkClass[] }>("/api/classes"),
  createClass: (name: string, studentIds: string[]) => request<{ class: HomeworkClass }>("/api/classes", { method: "POST", body: JSON.stringify({ name, studentIds }) }),
  updateClass: (id: string, name: string, studentIds: string[]) => request<{ class: HomeworkClass }>(`/api/classes/${id}`, { method: "PUT", body: JSON.stringify({ name, studentIds }) }),
  deleteClass: (id: string) => request<{ ok: boolean }>(`/api/classes/${id}`, { method: "DELETE", body: JSON.stringify({}) }),
  portal: () => request<{ code: string; url: string }>("/api/student-portal"),
  studentAccount: (studentId: string) => request<{ account: StudentAccount | null }>(`/api/students/${studentId}/account`),
  setStudentAccount: (studentId: string, loginId: string, password: string) => request<{ account: StudentAccount }>(`/api/students/${studentId}/account`, { method: "POST", body: JSON.stringify({ loginId, password }) }),
  assignments: () => request<{ assignments: Assignment[] }>("/api/assignments"),
  createAssignment: (assignment: Partial<Assignment>) => request<{ assignment: Assignment }>("/api/assignments", { method: "POST", body: JSON.stringify({ assignment }) }),
  readAssignment: (id: string) => request<{ assignment: Assignment }>(`/api/assignments/${id}`),
  updateAssignment: (id: string, assignment: Partial<Assignment> & { action?: string }) => request<{ assignment: Assignment }>(`/api/assignments/${id}`, { method: "PUT", body: JSON.stringify({ assignment }) }),
  deleteAssignment: (id: string) => request<{ ok: boolean }>(`/api/assignments/${id}`, { method: "DELETE", body: JSON.stringify({}) }),
  extractAssignment: (id: string) => request<{ assignment: Assignment }>(`/api/assignments/${id}/extract`, { method: "POST", body: JSON.stringify({}) }),
  publishAssignmentResults: (id: string) => request<{ published: number; total: number }>(`/api/assignments/${id}/publish-results`, { method: "POST", body: JSON.stringify({}) }),
  reorderAssignmentAssets: (id: string, role: "question" | "answer", assetIds: string[]) => request<{ ok: boolean }>(`/api/assignments/${id}/assets`, { method: "PUT", body: JSON.stringify({ role, assetIds }) }),
  deleteAssignmentAsset: (id: string, assetId: string) => request<{ ok: boolean }>(`/api/assignments/${id}/assets`, { method: "DELETE", body: JSON.stringify({ assetId }) }),
  submissions: (assignmentId: string) => request<{ submissions: HomeworkSubmission[] }>(`/api/submissions?assignmentId=${encodeURIComponent(assignmentId)}`),
  createCompletedSubmission: (studentId: string, title: string) => request<{ submission: HomeworkSubmission }>("/api/submissions", { method: "POST", body: JSON.stringify({ inputMode: "completed_homework", studentId, title }) }),
  createSubmission: (assignmentId: string, studentId: string, newVersion = false) => request<{ submission: HomeworkSubmission }>("/api/submissions", { method: "POST", body: JSON.stringify({ assignmentId, studentId, newVersion }) }),
  submission: (id: string) => request<{ submission: HomeworkSubmission }>(`/api/submissions/${id}`),
  updateSubmission: (id: string, body: { action: string; pages?: Array<{ originalAssetId: string; processedAssetId: string; quality?: unknown; replacePageId?: string }>; items?: Array<Partial<GradingItem> & { id: string }>; reason?: string }) => request<{ submission: HomeworkSubmission }>(`/api/submissions/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  capabilityProfile: (studentId: string, assignmentId = "") => request<{ profile: StudentCapabilityProfile }>(`/api/students/${studentId}/capability-profile${assignmentId ? `?assignmentId=${encodeURIComponent(assignmentId)}` : ""}`),
};

export async function uploadHomeworkAsset(input: { blob: Blob; fileName: string; role: HomeworkAsset["role"]; pageOrder: number; assignmentId?: string; submissionId?: string }) {
  const query = new URLSearchParams({ role: input.role, pageOrder: String(input.pageOrder) });
  if (input.assignmentId) query.set("assignmentId", input.assignmentId); if (input.submissionId) query.set("submissionId", input.submissionId);
  const response = await fetch(`/api/homework-assets?${query}`, { method: "POST", headers: { "Content-Type": input.blob.type || "image/jpeg", "X-File-Name": encodeURIComponent(input.fileName) }, body: input.blob });
  const payload = await response.json().catch(() => ({})) as { asset?: HomeworkAsset; error?: string };
  if (!response.ok || !payload.asset) throw new Error(payload.error || `图片上传失败（${response.status}）`); return payload.asset;
}

export const studentHomeworkApi = {
  me: () => request<{ student: StudentAuth | null }>("/api/student-auth/me"),
  login: (teacherCode: string, loginId: string, password: string) => request<{ student: StudentAuth }>("/api/student-auth/login", { method: "POST", body: JSON.stringify({ teacherCode, loginId, password }) }),
  logout: () => request<{ ok: boolean }>("/api/student-auth/logout", { method: "POST", body: JSON.stringify({}) }),
  assignments: () => request<{ assignments: Assignment[] }>("/api/student/assignments"),
  submissions: () => request<{ submissions: HomeworkSubmission[] }>("/api/student/submissions"),
  createSubmission: (assignmentId: string) => request<{ submission: HomeworkSubmission }>("/api/student/submissions", { method: "POST", body: JSON.stringify({ assignmentId }) }),
  submission: (id: string) => request<{ submission: HomeworkSubmission }>(`/api/student/submissions/${id}`),
  updateSubmission: (id: string, body: { action: string; pages?: Array<{ originalAssetId: string; processedAssetId: string; quality?: unknown }> }) => request<{ submission: HomeworkSubmission }>(`/api/student/submissions/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  wrongQuestions: () => request<{ entries: WrongQuestionEntry[] }>("/api/student/wrong-questions"),
  capabilityProfile: (assignmentId = "") => request<{ profile: StudentCapabilityProfile }>(`/api/student/capability-profile${assignmentId ? `?assignmentId=${encodeURIComponent(assignmentId)}` : ""}`),
};
