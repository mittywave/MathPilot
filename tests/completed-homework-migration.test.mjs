import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
test('migration preserves manual/partial history and backfills only confirmed incorrect occurrences',()=>{
 const db=new DatabaseSync(':memory:');
 try{
  for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')&&f<'0017').sort())db.exec(readFileSync('migrations/'+file,'utf8'));
  db.exec(`INSERT INTO users VALUES('u','u@local.test','x','x',1,'member',1);
   INSERT INTO students VALUES('s','u','迁移测试学生','','',1,1);
   INSERT INTO libraries_v2(id,kind,owner_user_id,created_at) VALUES('p','personal','u',1);
   INSERT INTO homework_assignments(id,owner_user_id,title,status,created_at,updated_at) VALUES('a','u','旧作业','published',1,1);
   INSERT INTO assignment_questions(id,assignment_id,question_number,page_number,type,stem,answer,created_at,updated_at,sort_order) VALUES('q1','a','1',1,'填空题','2+3','5',1,1,0),('q2','a','2',1,'解答题','过程题','见解析',1,1,1);
   INSERT INTO homework_submissions(id,assignment_id,student_id,version,status,submitted_by_type,submitted_by_id,created_at,updated_at) VALUES('sub','a','s',1,'published','teacher','u',1,1);
   INSERT INTO grading_items(id,submission_id,assignment_question_id,verdict,requires_review,created_at,updated_at) VALUES('g1','sub','q1','incorrect',0,1,1),('g2','sub','q2','partial',0,1,1);
   INSERT INTO student_wrong_questions(id,owner_user_id,student_id,source_scope,source_library_id,source_question_id,question_snapshot_json,mistake_count,last_wrong_at,created_at,updated_at,source_kind,assignment_id,grading_item_id)
    VALUES('manual','u','s','mine','p','old','{}',3,1,1,1,'library',NULL,NULL),('w1','u','s','mine','p','q1','{}',9,1,1,1,'assignment','a','g1'),('w2','u','s','mine','p','q2','{}',2,1,1,1,'assignment','a','g2');`);
  db.exec(readFileSync('migrations/0017_completed_homework_wrong_occurrences.sql','utf8'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM student_wrong_questions').get().n,3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM student_wrong_questions WHERE archived_at IS NULL').get().n,1);
  assert.equal(db.prepare("SELECT mistake_count FROM student_wrong_questions WHERE id='w1'").get().mistake_count,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM student_wrong_occurrences WHERE active=1').get().n,1);
  assert.equal(db.prepare("SELECT input_mode FROM homework_assignments WHERE id='a'").get().input_mode,'template');
  assert.equal(db.prepare("SELECT reference_source FROM assignment_questions WHERE id='q1'").get().reference_source,'provided');
 }finally{db.close();}
});
