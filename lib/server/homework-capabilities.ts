import { env } from "cloudflare:workers";
import { buildCapabilityProfile, capabilityNodeFor, inferKnowledgeTags, normalizeCapabilityKeys, resolveKnowledgeTaxonomyKeys } from "../homework-capability-framework.mjs";
import type { AuthUser, CapabilityDimension, CapabilityEvidence, GradingItem, StudentCapabilityProfile } from "../types";
import { loadPublishedKnowledgeGraph, type LoadedKnowledgeGraph } from "./knowledge-graph";

type AppEnv = { DB: D1Database };
function appEnv(): AppEnv { return env as unknown as AppEnv; }
function parseJson<T>(value: unknown, fallback: T): T { try { return value == null ? fallback : JSON.parse(String(value)) as T; } catch { return fallback; } }

export async function replaceSubmissionCapabilityEvidence(input: {
  ownerUserId: string; studentId: string; assignmentId: string; submissionId: string; gradingItems: GradingItem[]; at?: number;
}, batch?: D1PreparedStatement[]) {
  // A profile toggle collects every published version with the flag in one transaction; ordinary outputs commit here.
  const statements = batch ?? [];
  statements.push(appEnv().DB.prepare("DELETE FROM student_capability_evidence WHERE submission_id = ? AND owner_user_id = ?")
    .bind(input.submissionId, input.ownerUserId));
  const questions = await appEnv().DB.prepare(`SELECT id, stem, type, knowledge_tags_json, taxonomy_keys_json, capability_keys_json
    FROM assignment_questions WHERE assignment_id = ?`).bind(input.assignmentId).all<Record<string, unknown>>();
  const questionById = new Map(questions.results.map((row) => [String(row.id), row])); const now = Date.now();
  const { index: graph } = await loadPublishedKnowledgeGraph();
  for (const item of input.gradingItems) {
    if (item.requiresReview || item.referenceVerified === false) continue;
    if (!(item.verdict === "correct" || item.verdict === "partial" || item.verdict === "incorrect")) continue;
    const question = questionById.get(item.assignmentQuestionId); if (!question) continue;
    const tags = parseJson<string[]>(question.knowledge_tags_json, []); const knowledgeTags = tags.length ? tags : inferKnowledgeTags(String(question.stem ?? ""));
    const storedTaxonomyKeys = parseJson<string[]>(question.taxonomy_keys_json, []);
    const taxonomyKeys = storedTaxonomyKeys.length ? storedTaxonomyKeys : resolveKnowledgeTaxonomyKeys(knowledgeTags, String(question.stem ?? ""), graph);
    const questionSkills = parseJson<string[]>(question.capability_keys_json, []);
    const skillKeys = normalizeCapabilityKeys([...questionSkills, ...item.capabilityKeys], { errorType: item.errorType, questionType: item.questionType });
    const nodes = new Map<string, { label: string; dimension: CapabilityDimension }>();
    for (const key of taxonomyKeys) {
      const node = capabilityNodeFor(key, "", graph); if (!node) continue;
      nodes.set(node.key, { label: node.label, dimension: "knowledge" });
      // Evidence on a fine-grained point also counts for its topic and domain.
      for (const parentKey of graph.hierarchy(node.key)) { const parent = graph.node(parentKey); if (parent) nodes.set(parent.key, { label: parent.label, dimension: "knowledge" }); }
    }
    for (const key of skillKeys) { const node = capabilityNodeFor(key, "", graph); if (node) nodes.set(key, { label: node.label, dimension: "skill" }); }
    for (const [key, node] of nodes) statements.push(appEnv().DB.prepare(`INSERT INTO student_capability_evidence
      (id, owner_user_id, student_id, assignment_id, submission_id, grading_item_id, capability_key, capability_label, dimension,
       verdict, confidence, diagnosis, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(grading_item_id, capability_key) DO UPDATE SET verdict = excluded.verdict, confidence = excluded.confidence,
        diagnosis = excluded.diagnosis, capability_label = excluded.capability_label, updated_at = excluded.updated_at`)
      .bind(crypto.randomUUID(), input.ownerUserId, input.studentId, input.assignmentId, input.submissionId, item.id, key, node.label, node.dimension,
        item.verdict, item.confidence, item.feedback || item.evidenceSummary || item.errorType, input.at ?? now, now));
  }
  if (!batch) await appEnv().DB.batch(statements);
}

async function profileEvidence(ownerUserId: string, studentId: string) {
  const rows = await appEnv().DB.prepare(`SELECT student_capability_evidence.*, assignment_questions.question_number
    FROM student_capability_evidence JOIN grading_items ON grading_items.id = student_capability_evidence.grading_item_id
    JOIN assignment_questions ON assignment_questions.id = grading_items.assignment_question_id
    WHERE student_capability_evidence.owner_user_id = ? AND student_capability_evidence.student_id = ?
    ORDER BY student_capability_evidence.created_at DESC`).bind(ownerUserId, studentId).all<Record<string, unknown>>();
  return rows.results.map((row) => ({ id: String(row.id), capabilityKey: String(row.capability_key), capabilityLabel: String(row.capability_label),
    dimension: row.dimension as CapabilityDimension, verdict: row.verdict as CapabilityEvidence["verdict"], confidence: Number(row.confidence),
    diagnosis: String(row.diagnosis ?? ""), assignmentId: String(row.assignment_id), submissionId: String(row.submission_id),
    gradingItemId: String(row.grading_item_id), questionNumber: String(row.question_number), createdAt: Number(row.created_at) }));
}

export async function readTeacherKnowledgeGraph(user: AuthUser, studentId = "", published?: LoadedKnowledgeGraph): Promise<StudentCapabilityProfile> {
  const { index: graph } = published ?? await loadPublishedKnowledgeGraph();
  if (!studentId) return buildCapabilityProfile([], { includeAllKnowledge: true, graph });
  const student = await appEnv().DB.prepare("SELECT id FROM students WHERE id = ? AND owner_user_id = ?").bind(studentId, user.id).first();
  if (!student) throw new Response(JSON.stringify({ error: "学生档案不存在" }), { status: 404, headers: { "Content-Type": "application/json" } });
  return buildCapabilityProfile(await profileEvidence(user.id, studentId), { studentId, includeAllKnowledge: true, graph });
}
