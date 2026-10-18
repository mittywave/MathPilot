import { WRONG_QUESTION_DELETED, type AssignmentQuestion, type AuthUser, type HomeworkSubmission, type Question, type WrongQuestionEntry } from '../types';
import type { CompletedQuestion } from '../completed-homework-contract';
import { givenQuestion, hasReference, homeworkDb, readAssignmentQuestions } from './homework';
import { readLibrary, teacherNamespaceId } from './library';
import { assignmentQuestionToQuestion } from '../question-content';
import { homeworkAssetBytes, storeHomeworkAsset } from './homework-assets';
import { createQuestionMatcher } from '../question-identity';

type QuestionText = { stem?: string; options?: string[] };

// A mistake that counts: confirmed wrong, and not one of the duplicate copies a teacher deleted before questions had IDs.
const COUNTED = "o.active=1 AND json_extract(o.evidence_json,'$.dismissed') IS NULL";
// How many times a student got a question wrong (binds owner, student, question ID). The same photographed page handed
// in again is not another mistake, so mistakes on one page picture count once.
const MISTAKE_COUNT = `(SELECT COUNT(DISTINCT COALESCE(h.content_hash,o.grading_item_id)) FROM student_wrong_occurrences o
  LEFT JOIN grading_items g ON g.id=o.grading_item_id LEFT JOIN submission_pages p ON p.id=g.page_id LEFT JOIN homework_assets h ON h.id=p.original_asset_id
  WHERE o.owner_user_id=? AND o.student_id=? AND o.question_key=? AND ${COUNTED})`;
type Matcher = ReturnType<typeof createQuestionMatcher>;

// What a question is matched against: this teacher's library, then every question already in one of their students'
// wrong books. Read at most once per sync, and only when it is needed.
async function knownQuestions(user: AuthUser) {
  const matcher = createQuestionMatcher();
  const wrong = await homeworkDb().prepare(`SELECT source_question_id,json_extract(question_snapshot_json,'$.stem') AS stem,json_extract(question_snapshot_json,'$.options') AS options
    FROM student_wrong_questions WHERE owner_user_id=? AND source_question_id IN (SELECT question_id FROM question_codes) ORDER BY created_at`).bind(user.id).all<Record<string,unknown>>();
  const library = new Map<string, Question>((await readLibrary(user)).questions.map((question: Question) => [question.id, question]));
  for (const question of library.values()) matcher.add(question.id, question);
  for (const row of wrong.results as Array<Record<string,unknown>>) matcher.add(String(row.source_question_id), { stem: String(row.stem ?? ''), options: parseOptions(row.options) });
  return { matcher, library };
}
type Known = Awaited<ReturnType<typeof knownQuestions>>;

function parseOptions(value: unknown) {
  try { const options = JSON.parse(String(value ?? '[]')); return Array.isArray(options) ? options.map(String) : []; } catch { return []; }
}

/**
 * The one ID a question keeps across homework, wrong books and the library: a library question (or a wrong-book question
 * handed out again) keeps its own; a question whose paper printed its ID takes that one (printed, already checked);
 * anything else becomes the earlier question with the same content, else a new ID.
 */
function resolveQuestionKey(question: { id: string; source?: { id?: unknown } | null } & QuestionText, known: Set<string>, matcher: Matcher, printed: string | null = null) {
  const sourceId = typeof question.source?.id === 'string' ? question.source.id : '';
  const key = sourceId && known.has(sourceId) ? sourceId : printed ?? matcher.find(question) ?? question.id;
  matcher.add(key, question);
  return key;
}

async function codedIds(ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await homeworkDb().prepare('SELECT question_id FROM question_codes WHERE question_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids)).all<{ question_id: string }>();
  return new Set<string>((rows.results as Array<{ question_id: string }>).map((row) => row.question_id));
}

// A school sub-question (5-3(2)) is read on its own; the ID beside it names its whole question.
const isSubQuestion = (number: string) => /\([^()]+\)$/.test(number);

// The question a printed ID names, if that ID is this teacher's question and the question read from the paper is it:
// a digit misread from a photo must not file a mistake under, or grade it against, another question.
async function printedKey(printed: string, question: QuestionText, part: boolean, matcher: Matcher) {
  if (!/^\d{1,7}$/.test(printed)) return null;
  const row = await homeworkDb().prepare('SELECT question_id FROM question_codes WHERE number=?').bind(Number(printed)).first<{ question_id: string }>();
  return row && matcher.confirms(row.question_id, question, part) ? row.question_id : null;
}

// A known question's own content: the library's copy, else its wrong-book copy (this student's, else the latest).
async function knownQuestion(known: Known, user: AuthUser, key: string, studentId: string): Promise<Question | null> {
  const library = known.library.get(key);
  if (library) return library;
  const row = await homeworkDb().prepare('SELECT question_snapshot_json FROM student_wrong_questions WHERE owner_user_id=? AND source_question_id=? ORDER BY student_id=? DESC,updated_at DESC LIMIT 1')
    .bind(user.id, key, studentId).first<{ question_snapshot_json: string }>();
  return row ? JSON.parse(row.question_snapshot_json) as Question : null;
}

// What a known question is graded with: its own answer, as when it is handed out. A question only in wrong books has
// its copy's answer only when that is a reference already verified for it. Without one, it is solved as any other.
async function knownReference(user: AuthUser, key: string, question: Question, inLibrary: boolean) {
  if (!hasReference(question)) return null;
  const reference = { answer: String(question.answer ?? ''), analysis: String(question.analysis ?? '') };
  if (inLibrary) return { ...reference, source: 'provided', evidence: '题库原题答案' };
  const row = await homeworkDb().prepare(`SELECT q.reference_source,q.reference_evidence FROM assignment_questions q JOIN homework_assignments a ON a.id=q.assignment_id
    WHERE a.owner_user_id=? AND q.question_key=? AND q.reference_verified=1 AND q.answer=? ORDER BY q.updated_at DESC LIMIT 1`)
    .bind(user.id, key, reference.answer).first<{ reference_source: string; reference_evidence: string }>();
  return row ? { ...reference, source: row.reference_source, evidence: row.reference_evidence } : null;
}

/**
 * The uploaded questions, by number, that were read whole beside a printed ID naming them: each is that question handed
 * in on paper, with its own answer when it has one. A sub-question is read and solved on its own, as before.
 */
export async function printedQuestions(user: AuthUser, studentId: string, questions: CompletedQuestion[]) {
  const found = new Map<string, { question: Question; reference: Awaited<ReturnType<typeof knownReference>> }>();
  const whole = questions.filter((question) => question.printed_id && !isSubQuestion(question.question_number));
  if (!whole.length) return found;
  const known = await knownQuestions(user);
  for (const read of whole) {
    const key = await printedKey(read.printed_id!, read, false, known.matcher);
    const question = key ? await knownQuestion(known, user, key, studentId) : null;
    if (key && question) found.set(read.question_number, { question: givenQuestion({ ...question, id: key }), reference: await knownReference(user, key, question, known.library.has(key)) });
  }
  return found;
}

/**
 * Wrong books written before question IDs were keyed by the homework question, so one question handed out twice sits in a
 * wrong book twice. Give every recorded homework question its ID and fold each student's copies into one entry: the
 * active one, else the newest, with every mistake counted. Runs once per teacher; afterwards every wrong question has a code.
 */
export async function ensureWrongQuestionKeys(user: AuthUser) {
  const db = homeworkDb();
  const pending = await db.prepare(`SELECT 1 FROM student_wrong_questions WHERE owner_user_id=? AND source_question_id NOT IN (SELECT question_id FROM question_codes) LIMIT 1`)
    .bind(user.id).first();
  const unkeyed = pending ?? await db.prepare(`SELECT 1 FROM student_wrong_occurrences WHERE owner_user_id=? AND question_key='' AND active=1
    AND assignment_question_id IN (SELECT id FROM assignment_questions) LIMIT 1`).bind(user.id).first();
  if (!unkeyed) return;
  const [questionRows, wrongRows] = await db.batch([
    db.prepare(`SELECT q.id,q.stem,q.options_json,q.source_json,q.question_key FROM assignment_questions q JOIN homework_assignments a ON a.id=q.assignment_id
      WHERE a.owner_user_id=? AND (q.id IN (SELECT assignment_question_id FROM student_wrong_occurrences WHERE owner_user_id=?)
        OR q.id IN (SELECT source_question_id FROM student_wrong_questions WHERE owner_user_id=?)) ORDER BY q.created_at,q.id`).bind(user.id,user.id,user.id),
    db.prepare(`SELECT id,student_id,source_library_id,source_question_id,question_snapshot_json,archived_at,archive_reason,last_wrong_at FROM student_wrong_questions
      WHERE owner_user_id=? ORDER BY created_at,id`).bind(user.id),
  ]) as unknown as Array<{ results: Array<Record<string,unknown>> }>;
  const questions = questionRows.results.map((row) => ({ id: String(row.id), stem: String(row.stem), options: parseOptions(row.options_json),
    source: row.source_json ? JSON.parse(String(row.source_json)) as Question : null, key: String(row.question_key ?? '') }));
  const known = await codedIds([...questions.flatMap((question) => typeof question.source?.id === 'string' ? [question.source.id] : []), ...wrongRows.results.map((row) => String(row.source_question_id))]);
  // Questions already keyed seed the matcher first, so later ones join them rather than the other way round.
  const { matcher } = await knownQuestions(user);
  for (const question of questions) if (question.key) matcher.add(question.key, question);
  const keys = new Map<string, string>();
  for (const question of questions) keys.set(question.id, question.key || resolveQuestionKey(question, known, matcher));
  // A wrong question not from homework (an old library pick) keeps its ID.
  const keyOf = (row: Record<string,unknown>) => keys.get(String(row.source_question_id)) ?? String(row.source_question_id);
  const groups = new Map<string, Array<Record<string,unknown>>>();
  for (const row of wrongRows.results) {
    const group = `${row.student_id}|${row.source_library_id}|${keyOf(row)}`;
    groups.set(group, [...groups.get(group) ?? [], row]);
  }
  const statements: D1PreparedStatement[] = [];
  for (const [id, key] of keys) {
    statements.push(db.prepare('UPDATE assignment_questions SET question_key=? WHERE id=?').bind(key, id),
      db.prepare('UPDATE student_wrong_occurrences SET question_key=? WHERE assignment_question_id=? AND owner_user_id=?').bind(key, id, user.id));
  }
  const kept: Array<{ row: Record<string,unknown>; key: string }> = [];
  for (const rows of groups.values()) {
    const [keep, ...rest] = [...rows].sort((a, b) => Number(a.archived_at != null) - Number(b.archived_at != null) || Number(b.last_wrong_at) - Number(a.last_wrong_at));
    for (const row of rest) {
      statements.push(db.prepare('DELETE FROM student_wrong_questions WHERE id=? AND owner_user_id=?').bind(row.id, user.id));
      // A copy the teacher deleted was a duplicate of the one kept: its mistakes are not counted again.
      if (row.archive_reason === WRONG_QUESTION_DELETED) statements.push(db.prepare(`UPDATE student_wrong_occurrences SET evidence_json=json_set(evidence_json,'$.dismissed',json('true'))
        WHERE owner_user_id=? AND student_id=? AND assignment_question_id=?`).bind(user.id, row.student_id, row.source_question_id));
    }
    kept.push({ row: keep, key: keyOf(keep) });
  }
  for (const { row, key } of kept) {
    const snapshot = { ...JSON.parse(String(row.question_snapshot_json)) as Question, id: key };
    statements.push(db.prepare(`UPDATE student_wrong_questions SET source_question_id=?,question_snapshot_json=?,
        mistake_count=CASE WHEN source_kind='assignment' THEN COALESCE(NULLIF(${MISTAKE_COUNT},0),mistake_count) ELSE mistake_count END
      WHERE id=? AND owner_user_id=?`).bind(key, JSON.stringify(snapshot), user.id, row.student_id, key, row.id, user.id),
      db.prepare('INSERT OR IGNORE INTO question_codes(question_id) VALUES(?)').bind(key));
  }
  // One transaction: a teacher never sees a wrong book half folded.
  await db.batch(statements);
}

/** A grading item is the idempotency key; correction changes membership, never creates another attempt. */
export async function syncSubmissionWrongBook(submission: HomeworkSubmission, user: AuthUser) {
  const db = homeworkDb();
  await ensureWrongQuestionKeys(user);
  const questions = await readAssignmentQuestions(submission.assignmentId, user);
  const sourceLibraryId = await teacherNamespaceId(user);
  type StoredRow = { id: string; question_key: string; printed_id: string | null };
  const storedRows = await db.prepare("SELECT id,question_key,json_extract(input_evidence_json,'$.printed_id') AS printed_id FROM assignment_questions WHERE assignment_id=?")
    .bind(submission.assignmentId).all<StoredRow>();
  const storedKeys = new Map<string, string>((storedRows.results as StoredRow[]).map((row) => [row.id, row.question_key]));
  const printedIds = new Map<string, string>((storedRows.results as StoredRow[]).flatMap((row) => row.printed_id ? [[row.id, String(row.printed_id)] as [string, string]] : []));
  let context: Known | null = null, known: Set<string> | null = null;
  // A question gets its ID the first time it is got wrong; it keeps it through later corrections and re-gradings.
  async function questionKey(question: AssignmentQuestion) {
    const stored = storedKeys.get(question.id);
    if (stored) return stored;
    known ??= await codedIds(questions.flatMap((item: AssignmentQuestion) => typeof item.source?.id === 'string' ? [item.source.id] : []));
    context ??= await knownQuestions(user);
    const printed = printedIds.get(question.id) ?? (typeof question.source?.code === 'string' ? question.source.code : '');
    const key = resolveQuestionKey(question, known, context.matcher, await printedKey(printed, question, isSubQuestion(question.questionNumber), context.matcher));
    storedKeys.set(question.id, key);
    await db.batch([db.prepare('UPDATE assignment_questions SET question_key=? WHERE id=?').bind(key, question.id),
      db.prepare('UPDATE student_wrong_occurrences SET question_key=? WHERE assignment_question_id=? AND owner_user_id=?').bind(key, question.id, user.id)]);
    return key;
  }
  // A corrected page inventory can withdraw misidentified questions. Keep their
  // evidence/history, but never leave them active just because the new loop omits them.
  await db.batch([
    db.prepare("UPDATE student_wrong_occurrences SET active=0,updated_at=? WHERE submission_id=? AND owner_user_id=? AND grading_item_id NOT IN (SELECT value FROM json_each(?))")
      .bind(Date.now(),submission.id,user.id,JSON.stringify(submission.gradingItems.map(item=>item.id))),
    db.prepare(`UPDATE student_wrong_questions SET archived_at=?,archive_reason='重新识别后题目已撤回',updated_at=?
      WHERE assignment_id=? AND student_id=? AND owner_user_id=? AND source_kind='assignment' AND archived_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM student_wrong_occurrences o WHERE o.question_key=student_wrong_questions.source_question_id AND o.student_id=student_wrong_questions.student_id AND o.owner_user_id=student_wrong_questions.owner_user_id AND ${COUNTED})`)
      .bind(Date.now(),Date.now(),submission.assignmentId,submission.studentId,user.id),
  ]);
  for (const item of submission.gradingItems) {
    const template = questions.find(q => q.id === item.assignmentQuestionId);
    if (!template) throw new Error('批改对应的题目记录不存在');
    // A wrong answer enters the book on a verified reference answer, or on the teacher's own cross.
    const active = item.verdict === 'incorrect' && !item.requiresReview && (item.referenceVerified !== false || item.teacherMark === 'incorrect');
    const key = active ? await questionKey(template) : storedKeys.get(template.id) ?? '';
    const previous = await db.prepare('SELECT active,evidence_json FROM student_wrong_occurrences WHERE grading_item_id=? AND owner_user_id=?')
      .bind(item.id,user.id).first<{active:number;evidence_json:string}>();
    const oldEvidence = previous ? JSON.parse(previous.evidence_json) as Partial<WrongQuestionEntry> : {};
    const page = submission.pages.find(p => p.id === item.pageId);
    // An assigned question enters the book as it was handed out (library formatting, pictures and analysis intact); an
    // uploaded one that is a known question as that question, not as read from the photo.
    const canonical = !template.source && key && key !== template.id ? await knownQuestion(context ??= await knownQuestions(user), user, key, submission.studentId) : null;
    const question = canonical ? { ...canonical, id: key, originalImage: page?.originalUrl, updatedAt: Date.now() }
      : template.source ? { ...template.source, id: key || template.id, originalImage: page?.originalUrl, createdAt: template.createdAt, updatedAt: Date.now() }
      : { ...assignmentQuestionToQuestion(template,{title:submission.assignmentTitle,createdAt:template.createdAt,updatedAt:Date.now(),originalImage:page?.originalUrl}), id: key || template.id };
    let answerCropAssetId = oldEvidence.answerCropAssetId ?? null;
    if (active && !answerCropAssetId && page && item.bbox) {
      const bytes = await homeworkAssetBytes(page.processedAssetId);
      if (bytes?.contentType === 'image/jpeg') {
        try {
          const {cropHomeworkJpeg} = await import('./homework-crop');
          const crop = cropHomeworkJpeg(bytes.bytes,item.bbox);
          const asset = await storeHomeworkAsset({ownerUserId:user.id,studentId:submission.studentId,bytes:crop,contentType:'image/jpeg',originalName:`第${item.questionNumber}题学生原答.jpg`,role:'answer_crop'});
          answerCropAssetId=asset.id;
        } catch { /* The full original page remains available if a crop cannot be generated. */ }
      }
    }
    const now=Date.now();
    const evidence={question,studentAnswer:item.studentAnswer,feedback:item.feedback,answerCropAssetId,submissionId:submission.id,gradingItemId:item.id,assignmentId:submission.assignmentId,sourcePath:`作业 / ${submission.assignmentTitle}`};
    await db.batch([
      db.prepare(`INSERT INTO student_wrong_occurrences(grading_item_id,owner_user_id,student_id,assignment_id,assignment_question_id,submission_id,active,evidence_json,created_at,updated_at,question_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(grading_item_id) DO UPDATE SET active=excluded.active,updated_at=excluded.updated_at,question_key=excluded.question_key,
          evidence_json=CASE WHEN json_extract(student_wrong_occurrences.evidence_json,'$.dismissed') IS NULL THEN excluded.evidence_json ELSE json_set(excluded.evidence_json,'$.dismissed',json('true')) END`)
        .bind(item.id,user.id,submission.studentId,submission.assignmentId,item.assignmentQuestionId,submission.id,active?1:0,JSON.stringify(evidence),item.createdAt,now,key),
      db.prepare('UPDATE grading_items SET wrong_book_applied_at=? WHERE id=? AND submission_id=? AND wrong_book_applied_at IS NULL').bind(now,item.id,submission.id),
    ]);
    // Never asked wrong, so it has no ID and nothing in the wrong book to withdraw.
    if (!key) continue;
    const newest = await db.prepare(`SELECT o.evidence_json,o.created_at,o.grading_item_id,s.id AS submission_id,g.student_answer,g.feedback,a.title AS assignment_title
      FROM student_wrong_occurrences o JOIN grading_items g ON g.id=o.grading_item_id JOIN homework_submissions s ON s.id=o.submission_id JOIN homework_assignments a ON a.id=o.assignment_id
      WHERE o.owner_user_id=? AND o.student_id=? AND o.question_key=? AND ${COUNTED} ORDER BY o.created_at DESC,o.grading_item_id DESC LIMIT 1`)
      .bind(user.id,submission.studentId,key).first<Record<string,unknown>>();
    if (!newest) {
      await db.prepare(`UPDATE student_wrong_questions SET archived_at=?,archive_reason='批改已修正或待处理',updated_at=?
        WHERE owner_user_id=? AND student_id=? AND source_question_id=? AND source_kind='assignment' AND archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM student_wrong_occurrences o WHERE o.owner_user_id=? AND o.student_id=? AND o.question_key=? AND ${COUNTED})`)
        .bind(now,now,user.id,submission.studentId,key,user.id,submission.studentId,key).run();
      continue;
    }
    // Migration-created occurrences may only have the original grading item, so reconstruct their evidence.
    const latest = JSON.parse(String(newest.evidence_json)) as Partial<typeof evidence>;
    const payload = latest.question ? latest : {...evidence,studentAnswer:String(newest.student_answer),feedback:String(newest.feedback),submissionId:String(newest.submission_id),gradingItemId:String(newest.grading_item_id),sourcePath:`作业 / ${newest.assignment_title}`};
    // A teacher's deletion holds through re-syncs of older grading; only a mistake made after it brings the question back.
    await db.prepare('INSERT OR IGNORE INTO question_codes(question_id) VALUES(?)').bind(key).run();
    await db.prepare(`INSERT INTO student_wrong_questions(id,owner_user_id,student_id,source_scope,source_library_id,source_question_id,source_path,question_snapshot_json,mistake_count,last_wrong_at,created_at,updated_at,source_kind,assignment_id,submission_id,grading_item_id,student_answer,feedback,answer_crop_asset_id)
      VALUES(?,?,?,'mine',?,?,?,?,${MISTAKE_COUNT},?,?,?,'assignment',?,?,?,?,?,?)
      ON CONFLICT(student_id,source_library_id,source_question_id) DO UPDATE SET source_kind='assignment',source_path=excluded.source_path,question_snapshot_json=excluded.question_snapshot_json,
        mistake_count=excluded.mistake_count,last_wrong_at=excluded.last_wrong_at,updated_at=excluded.updated_at,assignment_id=excluded.assignment_id,
        submission_id=excluded.submission_id,grading_item_id=excluded.grading_item_id,student_answer=excluded.student_answer,feedback=excluded.feedback,answer_crop_asset_id=excluded.answer_crop_asset_id,
        archived_at=CASE WHEN student_wrong_questions.archive_reason=? AND excluded.last_wrong_at<=student_wrong_questions.archived_at THEN student_wrong_questions.archived_at END,
        archive_reason=CASE WHEN student_wrong_questions.archive_reason=? AND excluded.last_wrong_at<=student_wrong_questions.archived_at THEN student_wrong_questions.archive_reason ELSE '' END`)
      .bind(crypto.randomUUID(),user.id,submission.studentId,sourceLibraryId,key,payload.sourcePath,JSON.stringify({ ...payload.question, id: key }),
        user.id,submission.studentId,key,Number(newest.created_at),now,now,submission.assignmentId,payload.submissionId,payload.gradingItemId,payload.studentAnswer,payload.feedback,payload.answerCropAssetId??null,WRONG_QUESTION_DELETED,WRONG_QUESTION_DELETED).run();
  }
}
