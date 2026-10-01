import type { AuthUser, HomeworkSubmission, WrongQuestionEntry } from '../types';
import { homeworkDb, readAssignment } from './homework';
import { resolveLibraryContext } from './library';
import { assignmentQuestionToQuestion } from '../question-content';
import { homeworkAssetBytes, storeHomeworkAsset } from './homework-assets';

/** A grading item is the idempotency key; correction changes membership, never creates another attempt. */
export async function syncSubmissionWrongBook(submission: HomeworkSubmission, user: AuthUser) {
  const db = homeworkDb();
  const assignment = await readAssignment(submission.assignmentId, user);
  const context = await resolveLibraryContext(user, 'mine');
  for (const item of submission.gradingItems) {
    const template = assignment.questions.find(q => q.id === item.assignmentQuestionId);
    if (!template) throw new Error('批改对应的题目记录不存在');
    const active = item.verdict === 'incorrect' && !item.requiresReview && item.referenceVerified !== false;
    const previous = await db.prepare('SELECT active,evidence_json FROM student_wrong_occurrences WHERE grading_item_id=? AND owner_user_id=?')
      .bind(item.id,user.id).first<{active:number;evidence_json:string}>();
    const oldEvidence = previous ? JSON.parse(previous.evidence_json) as Partial<WrongQuestionEntry> : {};
    const page = submission.pages.find(p => p.id === item.pageId);
    const original = assignment.assets.find(a => a.role === 'question' && a.pageOrder === template.pageNumber - 1);
    const question = assignmentQuestionToQuestion(template,{title:submission.assignmentTitle,createdAt:template.createdAt,updatedAt:Date.now(),originalImage:original?.url ?? page?.originalUrl});
    let answerCropAssetId = oldEvidence.answerCropAssetId ?? null;
    if (active && !answerCropAssetId && page && item.bbox) {
      const bytes = await homeworkAssetBytes(page.processedAssetId);
      if (bytes?.contentType === 'image/jpeg') {
        try {
          const {cropHomeworkJpeg} = await import('./homework-crop');
          const crop = cropHomeworkJpeg(bytes.bytes,item.bbox);
          const asset = await storeHomeworkAsset({ownerUserId:user.id,studentId:submission.studentId,bytes:crop,contentType:'image/jpeg',originalName:`第${item.questionNumber}题学生原答.jpg`,role:'answer_crop',pageOrder:0});
          answerCropAssetId=asset.id;
        } catch { /* The full original page remains available if a crop cannot be generated. */ }
      }
    }
    const now=Date.now();
    const evidence={question,studentAnswer:item.studentAnswer,feedback:item.feedback,answerCropAssetId,submissionId:submission.id,gradingItemId:item.id,assignmentId:submission.assignmentId,sourcePath:`作业 / ${submission.assignmentTitle}`};
    await db.batch([
      db.prepare(`INSERT INTO student_wrong_occurrences(grading_item_id,owner_user_id,student_id,assignment_id,assignment_question_id,submission_id,active,evidence_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(grading_item_id) DO UPDATE SET active=excluded.active,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`)
        .bind(item.id,user.id,submission.studentId,submission.assignmentId,item.assignmentQuestionId,submission.id,active?1:0,JSON.stringify(evidence),item.createdAt,now),
      db.prepare('UPDATE grading_items SET wrong_book_applied_at=? WHERE id=? AND submission_id=? AND wrong_book_applied_at IS NULL').bind(now,item.id,submission.id),
    ]);
    const newest = await db.prepare(`SELECT o.evidence_json,o.created_at,o.grading_item_id,s.id AS submission_id,g.student_answer,g.feedback,a.title AS assignment_title
      FROM student_wrong_occurrences o JOIN grading_items g ON g.id=o.grading_item_id JOIN homework_submissions s ON s.id=o.submission_id JOIN homework_assignments a ON a.id=o.assignment_id
      WHERE o.owner_user_id=? AND o.student_id=? AND o.assignment_question_id=? AND o.active=1 ORDER BY o.created_at DESC,o.grading_item_id DESC LIMIT 1`)
      .bind(user.id,submission.studentId,item.assignmentQuestionId).first<Record<string,unknown>>();
    if (!newest) {
      await db.prepare(`UPDATE student_wrong_questions SET archived_at=?,archive_reason='批改已修正或待处理',updated_at=?
        WHERE owner_user_id=? AND student_id=? AND source_question_id=? AND source_kind='assignment' AND NOT EXISTS(SELECT 1 FROM student_wrong_occurrences o WHERE o.owner_user_id=? AND o.student_id=? AND o.assignment_question_id=? AND o.active=1)`)
        .bind(now,now,user.id,submission.studentId,item.assignmentQuestionId,user.id,submission.studentId,item.assignmentQuestionId).run();
      continue;
    }
    // Migration-created occurrences may only have the original grading item, so reconstruct their evidence.
    const latest = JSON.parse(String(newest.evidence_json)) as Partial<typeof evidence>;
    const payload = latest.question ? latest : {...evidence,studentAnswer:String(newest.student_answer),feedback:String(newest.feedback),submissionId:String(newest.submission_id),gradingItemId:String(newest.grading_item_id),sourcePath:`作业 / ${newest.assignment_title}`};
    const newlyWrong = active && !previous?.active;
    await db.prepare(`INSERT INTO student_wrong_questions(id,owner_user_id,student_id,source_scope,source_library_id,source_question_id,source_path,question_snapshot_json,mistake_count,note,mastered,last_wrong_at,created_at,updated_at,source_kind,assignment_id,submission_id,grading_item_id,student_answer,feedback,answer_crop_asset_id)
      VALUES(?,?,?,'mine',?,?,?,?,(SELECT COUNT(*) FROM student_wrong_occurrences WHERE owner_user_id=? AND student_id=? AND assignment_question_id=? AND active=1),'',0,?,?,?,'assignment',?,?,?,?,?,?)
      ON CONFLICT(student_id,source_library_id,source_question_id) DO UPDATE SET source_kind='assignment',source_path=excluded.source_path,question_snapshot_json=excluded.question_snapshot_json,
        mistake_count=excluded.mistake_count,mastered=CASE WHEN ? THEN 0 ELSE student_wrong_questions.mastered END,last_wrong_at=excluded.last_wrong_at,updated_at=excluded.updated_at,assignment_id=excluded.assignment_id,
        submission_id=excluded.submission_id,grading_item_id=excluded.grading_item_id,student_answer=excluded.student_answer,feedback=excluded.feedback,answer_crop_asset_id=excluded.answer_crop_asset_id,archived_at=NULL,archive_reason=''`)
      .bind(crypto.randomUUID(),user.id,submission.studentId,context.libraryId,item.assignmentQuestionId,payload.sourcePath,JSON.stringify(payload.question),
        user.id,submission.studentId,item.assignmentQuestionId,Number(newest.created_at),now,now,submission.assignmentId,payload.submissionId,payload.gradingItemId,payload.studentAnswer,payload.feedback,payload.answerCropAssetId??null,newlyWrong?1:0).run();
  }
}
