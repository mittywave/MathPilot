import type { AuthUser, GradingItem, HomeworkAsset, HomeworkCurriculum, HomeworkOutputs, HomeworkSheetGroup, HomeworkSubmission, Question, StudentHomework, StudentSummary } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`); return payload;
}

export const homeworkApi = {
  me: () => request<{ user: AuthUser | null }>("/api/auth/me"),
  students: () => request<{ students: StudentSummary[] }>("/api/students"),
  submissions: () => request<{ submissions: HomeworkSubmission[] }>("/api/submissions"),
  createSubmission: (studentId: string, title: string, outputs: HomeworkOutputs, curriculum: HomeworkCurriculum) => request<{ submission: HomeworkSubmission }>("/api/submissions", { method: "POST", body: JSON.stringify({ studentId, title, outputs, curriculum }) }),
  submission: (id: string) => request<{ submission: HomeworkSubmission }>(`/api/submissions/${id}`),
  updateSubmission: (id: string, body: { action: string; pages?: Array<{ assetId: string; replacePageId?: string }>; items?: Array<Partial<GradingItem> & { id: string }>; start?: string }) => request<{ submission: HomeworkSubmission }>(`/api/submissions/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  /** 布置作业: one homework per student, each waiting for the student's work to be uploaded; start is 第 1 天, YYYY-MM-DD. */
  assign: (body: { studentIds: string[]; title: string; questions: Question[]; groups?: HomeworkSheetGroup[]; start: string; recordId?: string | null }) => request<{ assigned: Array<{ id: string; studentId: string; studentName: string }> }>("/api/submissions", { method: "POST", body: JSON.stringify(body) }),
  studentHomework: (studentId: string) => request<{ homework: StudentHomework[] }>(`/api/students/${encodeURIComponent(studentId)}/homework`),
};

/** Reference answers attach to the homework (assignmentId); pages and the source PDF attach to one submission. */
export async function uploadHomeworkAsset(input: { blob: Blob; fileName: string; role: HomeworkAsset["role"]; assignmentId?: string; submissionId?: string }) {
  const query = new URLSearchParams({ role: input.role });
  if (input.assignmentId) query.set("assignmentId", input.assignmentId); if (input.submissionId) query.set("submissionId", input.submissionId);
  const response = await fetch(`/api/homework-assets?${query}`, { method: "POST", headers: { "Content-Type": input.blob.type || "image/jpeg", "X-File-Name": encodeURIComponent(input.fileName) }, body: input.blob });
  const payload = await response.json().catch(() => ({})) as { asset?: HomeworkAsset; error?: string };
  if (!response.ok || !payload.asset) throw new Error(payload.error || `图片上传失败（${response.status}）`); return payload.asset;
}
