import { env } from "cloudflare:workers";
import type { AuthUser, HomeworkAsset, HomeworkAssetRole, StudentAuth } from "../types";

type AppEnv = {
  DB: D1Database;
  HOMEWORK_ASSETS?: R2Bucket;
  HOMEWORK_GRADING_QUEUE?: { send(message: { kind: "cleanup_homework_assets"; jobId: string }): Promise<void> };
  HOMEWORK_GRADING_ENABLED?: string;
  LOCAL_ADMIN_MODE?: string;
};

function appEnv(): AppEnv {
  const bindings = env as unknown as AppEnv;
  if (!bindings.DB) throw new Error("D1 数据库尚未绑定");
  return bindings;
}

export function homeworkEnabled() {
  const bindings = appEnv();
  return bindings.LOCAL_ADMIN_MODE === "true" || bindings.HOMEWORK_GRADING_ENABLED === "true";
}

export function requireHomeworkEnabled() {
  if (!homeworkEnabled()) throw new Response(JSON.stringify({ error: "作业批改功能尚未开放" }), { status: 404, headers: { "Content-Type": "application/json" } });
}

function requireBucket() {
  const bucket = appEnv().HOMEWORK_ASSETS;
  if (!bucket) throw new Response(JSON.stringify({ error: "作业原件存储尚未配置" }), { status: 503, headers: { "Content-Type": "application/json" } });
  return bucket;
}

async function sha256(bytes: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeName(value: string) {
  return value.trim().replace(/[\p{Cc}/\\]/gu, "_").slice(0, 180) || "homework-page.jpg";
}

export async function assertTeacherUploadContext(user: AuthUser, input: { assignmentId?: string; submissionId?: string }) {
  if (input.assignmentId) {
    const row = await appEnv().DB.prepare(`SELECT id FROM homework_assignments a WHERE id = ? AND owner_user_id = ? AND
      (status='draft' OR (input_mode='completed_homework' AND EXISTS(SELECT 1 FROM homework_submissions s WHERE s.assignment_id=a.id AND
        (s.status='draft' OR (s.status='published' AND (EXISTS(SELECT 1 FROM grading_items g WHERE g.submission_id=s.id AND g.requires_review=1)
          OR EXISTS(SELECT 1 FROM submission_page_extractions e WHERE e.submission_id=s.id AND e.status='complete' AND json_extract(e.result_json,'$.kind')='unreadable')))))))`)
      .bind(input.assignmentId, user.id).first();
    if (!row) throw new Response(JSON.stringify({ error: "作业不存在或题目模板已经锁定" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return;
  }
  if (input.submissionId) {
    const row = await appEnv().DB.prepare(`SELECT homework_submissions.id FROM homework_submissions
      JOIN homework_assignments ON homework_assignments.id=homework_submissions.assignment_id
      WHERE homework_submissions.id=? AND homework_assignments.owner_user_id=? AND
      (homework_submissions.status='draft' OR (homework_submissions.status='published' AND
        (EXISTS(SELECT 1 FROM grading_items WHERE grading_items.submission_id=homework_submissions.id AND grading_items.requires_review=1)
        OR EXISTS(SELECT 1 FROM submission_page_extractions e WHERE e.submission_id=homework_submissions.id AND e.status='complete' AND json_extract(e.result_json,'$.kind')='unreadable'))))`)
      .bind(input.submissionId, user.id).first();
    if (!row) throw new Response(JSON.stringify({ error: "提交记录不存在或当前不可修改" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return;
  }
  throw new Response(JSON.stringify({ error: "缺少作业或提交上下文" }), { status: 400, headers: { "Content-Type": "application/json" } });
}

export async function assertStudentUploadContext(student: StudentAuth, submissionId: string) {
  const row = await appEnv().DB.prepare(`SELECT id FROM homework_submissions
    WHERE id = ? AND student_id = ? AND status = 'draft'`).bind(submissionId, student.studentId).first();
  if (!row) throw new Response(JSON.stringify({ error: "提交记录不存在或当前不可修改" }), { status: 404, headers: { "Content-Type": "application/json" } });
}

export async function storeHomeworkAsset(input: {
  ownerUserId: string;
  bytes: ArrayBuffer;
  contentType: string;
  originalName: string;
  role: HomeworkAssetRole;
  pageOrder: number;
  assignmentId?: string;
  submissionId?: string;
  studentId?: string;
}) {
  requireHomeworkEnabled();
  if (!(input.contentType.startsWith("image/") || (input.role === "submission_document" && input.contentType === "application/pdf"))) throw new Response(JSON.stringify({ error: "作业页面必须是图片" }), { status: 415, headers: { "Content-Type": "application/json" } });
  if (!input.bytes.byteLength || input.bytes.byteLength > 15 * 1024 * 1024) throw new Response(JSON.stringify({ error: "单页图片需小于 15MB" }), { status: 413, headers: { "Content-Type": "application/json" } });
  const id = crypto.randomUUID(); const now = Date.now(); const hash = await sha256(input.bytes);
  const extension = input.contentType === "application/pdf" ? "pdf" : input.contentType.includes("png") ? "png" : input.contentType.includes("webp") ? "webp" : "jpg";
  const key = `${input.ownerUserId}/${new Date(now).toISOString().slice(0, 10)}/${id}.${extension}`;
  await requireBucket().put(key, input.bytes, { httpMetadata: { contentType: input.contentType }, customMetadata: { hash, role: input.role } });
  try {
    await appEnv().DB.prepare(`INSERT INTO homework_assets
      (id, owner_user_id, r2_key, content_type, byte_size, content_hash, original_name, created_at,
       role, upload_assignment_id, upload_submission_id, upload_student_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, input.ownerUserId, key, input.contentType, input.bytes.byteLength, hash, safeName(input.originalName), now,
        input.role === "submission_document" ? "submission_original" : input.role, input.assignmentId ?? null, input.submissionId ?? null, input.studentId ?? null).run();
  } catch (error) {
    await requireBucket().delete(key);
    throw error;
  }
  return {
    id, role: input.role, url: `/api/homework-assets/${id}`, contentType: input.contentType,
    byteSize: input.bytes.byteLength, originalName: safeName(input.originalName), pageOrder: input.pageOrder, createdAt: now,
  } satisfies HomeworkAsset;
}

export async function attachAssignmentAsset(assignmentId: string, asset: HomeworkAsset, user: AuthUser) {
  await assertTeacherUploadContext(user, { assignmentId });
  const old = await appEnv().DB.prepare(`SELECT homework_assets.id, homework_assets.r2_key FROM assignment_assets
    JOIN homework_assets ON homework_assets.id = assignment_assets.asset_id
    WHERE assignment_assets.assignment_id = ? AND assignment_assets.role = ? AND assignment_assets.page_order = ?`)
    .bind(assignmentId, asset.role, asset.pageOrder).first<{ id: string; r2_key: string }>();
  await appEnv().DB.batch([
    appEnv().DB.prepare("DELETE FROM assignment_assets WHERE assignment_id = ? AND role = ? AND page_order = ?")
      .bind(assignmentId, asset.role, asset.pageOrder),
    appEnv().DB.prepare("INSERT INTO assignment_assets (assignment_id, asset_id, role, page_order) VALUES (?, ?, ?, ?)")
      .bind(assignmentId, asset.id, asset.role, asset.pageOrder),
    appEnv().DB.prepare("UPDATE homework_assignments SET template_confirmed = 0, updated_at = ? WHERE id = ? AND owner_user_id = ?")
      .bind(Date.now(), assignmentId, user.id),
  ]);
  if (old) {
    await requireBucket().delete(old.r2_key);
    await appEnv().DB.prepare("DELETE FROM homework_assets WHERE id = ?").bind(old.id).run();
  }
}

export async function reorderAssignmentAssets(assignmentId: string, role: "question" | "answer", assetIds: string[], user: AuthUser) {
  await assertTeacherUploadContext(user, { assignmentId });
  const unique = [...new Set(assetIds.map(String))];
  if (!unique.length || unique.length !== assetIds.length) throw new Response(JSON.stringify({ error: "页面顺序无效" }), { status: 400, headers: { "Content-Type": "application/json" } });
  const rows = await appEnv().DB.prepare(`SELECT asset_id FROM assignment_assets
    WHERE assignment_id = ? AND role = ? ORDER BY page_order`).bind(assignmentId, role).all<{ asset_id: string }>();
  if (rows.results.length !== unique.length || rows.results.some((row) => !unique.includes(row.asset_id))) {
    throw new Response(JSON.stringify({ error: "部分页面不存在或不属于当前作业" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  await appEnv().DB.batch(rows.results.map((row, index) => appEnv().DB.prepare(`UPDATE assignment_assets SET page_order = ?
    WHERE assignment_id = ? AND role = ? AND asset_id = ?`).bind(-index - 1, assignmentId, role, row.asset_id)));
  await appEnv().DB.batch(unique.map((assetId, index) => appEnv().DB.prepare(`UPDATE assignment_assets SET page_order = ?
    WHERE assignment_id = ? AND role = ? AND asset_id = ?`).bind(index, assignmentId, role, assetId)));
  await appEnv().DB.prepare("UPDATE homework_assignments SET template_confirmed = 0, updated_at = ? WHERE id = ? AND owner_user_id = ?")
    .bind(Date.now(), assignmentId, user.id).run();
}

export async function deleteAssignmentAsset(assignmentId: string, assetId: string, user: AuthUser) {
  await assertTeacherUploadContext(user, { assignmentId });
  const row = await appEnv().DB.prepare(`SELECT assignment_assets.role, homework_assets.r2_key FROM assignment_assets
    JOIN homework_assets ON homework_assets.id = assignment_assets.asset_id
    WHERE assignment_assets.assignment_id = ? AND assignment_assets.asset_id = ? AND homework_assets.owner_user_id = ?`)
    .bind(assignmentId, assetId, user.id).first<{ role: "question" | "answer"; r2_key: string }>();
  if (!row) throw new Response(JSON.stringify({ error: "模板页面不存在" }), { status: 404, headers: { "Content-Type": "application/json" } });
  await appEnv().DB.prepare("DELETE FROM assignment_assets WHERE assignment_id = ? AND asset_id = ?").bind(assignmentId, assetId).run();
  const remaining = await appEnv().DB.prepare("SELECT asset_id FROM assignment_assets WHERE assignment_id = ? AND role = ? ORDER BY page_order")
    .bind(assignmentId, row.role).all<{ asset_id: string }>();
  if (remaining.results.length) await reorderAssignmentAssets(assignmentId, row.role, remaining.results.map((item) => item.asset_id), user);
  await homeworkAssetsBucket().delete(row.r2_key);
  await appEnv().DB.prepare("DELETE FROM homework_assets WHERE id = ? AND owner_user_id = ?").bind(assetId, user.id).run();
  await appEnv().DB.prepare("UPDATE homework_assignments SET template_confirmed = 0, updated_at = ? WHERE id = ? AND owner_user_id = ?")
    .bind(Date.now(), assignmentId, user.id).run();
}

export async function homeworkAssetBytes(assetId: string) {
  const row = await appEnv().DB.prepare("SELECT id, r2_key, content_type, byte_size FROM homework_assets WHERE id = ?")
    .bind(assetId).first<{ id: string; r2_key: string; content_type: string; byte_size: number }>();
  if (!row) return null;
  const object = await requireBucket().get(row.r2_key);
  if (!object) return null;
  return { bytes: await object.arrayBuffer(), contentType: row.content_type, byteSize: Number(row.byte_size), etag: object.httpEtag };
}

export async function homeworkAssetDataUrl(assetId: string) {
  const asset = await homeworkAssetBytes(assetId);
  if (!asset) throw new Error("作业图片不存在");
  const bytes = new Uint8Array(asset.bytes); let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return `data:${asset.contentType};base64,${btoa(binary)}`;
}

export async function processHomeworkAssetCleanup(jobId: string) {
  const job = await appEnv().DB.prepare("SELECT r2_keys_json, status FROM homework_asset_cleanup_jobs WHERE id = ?")
    .bind(jobId).first<{ r2_keys_json: string; status: string }>();
  if (!job || job.status === "completed") return;
  const keys = [...new Set((JSON.parse(job.r2_keys_json) as unknown[]).map(String).filter(Boolean))];
  for (const key of keys) await requireBucket().delete(key);
  await appEnv().DB.prepare(`UPDATE homework_asset_cleanup_jobs SET status = 'completed', attempts = attempts + 1,
    last_error = '', updated_at = ? WHERE id = ?`).bind(Date.now(), jobId).run();
}

export async function recordHomeworkAssetCleanupFailure(jobId: string, error: unknown, final: boolean) {
  await appEnv().DB.prepare(`UPDATE homework_asset_cleanup_jobs SET status = ?, attempts = attempts + 1,
    last_error = ?, updated_at = ? WHERE id = ? AND status != 'completed'`)
    .bind(final ? "failed" : "pending", error instanceof Error ? error.message.slice(0, 500) : "R2 清理失败", Date.now(), jobId).run();
}

export async function scheduleHomeworkAssetCleanup(ownerUserId: string, rawKeys: string[]) {
  const keys = [...new Set(rawKeys.map(String).filter(Boolean))];
  if (!keys.length) return null;
  const id = crypto.randomUUID(); const now = Date.now();
  await appEnv().DB.prepare(`INSERT INTO homework_asset_cleanup_jobs
    (id, owner_user_id, r2_keys_json, status, attempts, last_error, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 0, '', ?, ?)`)
    .bind(id, ownerUserId, JSON.stringify(keys), now, now).run();
  try {
    if (appEnv().HOMEWORK_GRADING_QUEUE) await appEnv().HOMEWORK_GRADING_QUEUE.send({ kind: "cleanup_homework_assets", jobId: id });
    else await processHomeworkAssetCleanup(id);
  } catch (error) {
    try { await processHomeworkAssetCleanup(id); }
    catch (cleanupError) { await recordHomeworkAssetCleanupFailure(id, cleanupError, false); throw error; }
  }
  return id;
}

export async function canStudentReadAsset(assetId: string, student: StudentAuth) {
  const ownPage = await appEnv().DB.prepare(`SELECT 1 FROM submission_pages
    JOIN homework_submissions ON homework_submissions.id = submission_pages.submission_id
    WHERE homework_submissions.student_id = ? AND (submission_pages.original_asset_id = ? OR submission_pages.processed_asset_id = ?)`)
    .bind(student.studentId, assetId, assetId).first();
  if (ownPage) return true;
  const assignmentAsset = await appEnv().DB.prepare(`SELECT assignment_assets.role, homework_submissions.status AS submission_status
    FROM assignment_assets
    JOIN assignment_targets ON assignment_targets.assignment_id = assignment_assets.assignment_id
    LEFT JOIN homework_submissions ON homework_submissions.assignment_id = assignment_assets.assignment_id AND homework_submissions.student_id = assignment_targets.student_id
    JOIN homework_assignments ON homework_assignments.id = assignment_assets.assignment_id
    WHERE assignment_assets.asset_id = ? AND assignment_targets.student_id = ? AND homework_assignments.status IN ('published', 'closed')
    ORDER BY homework_submissions.version DESC LIMIT 1`).bind(assetId, student.studentId).first<{ role: string; submission_status: string | null }>();
  if (assignmentAsset?.role === "question") return true;
  if (assignmentAsset?.role === "answer" && assignmentAsset.submission_status === "published") return true;
  const document = await appEnv().DB.prepare("SELECT 1 FROM homework_assets a JOIN homework_submissions s ON s.id=a.upload_submission_id WHERE a.id=? AND a.role='submission_original' AND a.content_type='application/pdf' AND s.student_id=?").bind(assetId,student.studentId).first();
  if(document) return true;
  const revision = await appEnv().DB.prepare(`SELECT 1 FROM submission_page_revisions r JOIN homework_submissions s ON s.id=r.submission_id WHERE s.student_id=? AND (r.original_asset_id=? OR r.processed_asset_id=?)`).bind(student.studentId,assetId,assetId).first();
  if (revision) return true;
  const crop = await appEnv().DB.prepare(`SELECT 1 FROM student_wrong_questions
    WHERE student_id = ? AND answer_crop_asset_id = ? AND source_kind = 'assignment'`).bind(student.studentId, assetId).first();
  return Boolean(crop);
}

export async function canTeacherReadAsset(assetId: string, user: AuthUser) {
  return Boolean(await appEnv().DB.prepare("SELECT 1 FROM homework_assets WHERE id = ? AND owner_user_id = ?").bind(assetId, user.id).first());
}

export function homeworkAssetsDb() { return appEnv().DB; }
export function homeworkAssetsBucket() { return requireBucket(); }
