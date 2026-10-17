-- Membership keeps using students.class_name; this table also preserves empty classes.
CREATE TABLE student_classes (
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  PRIMARY KEY (owner_user_id, name)
);

INSERT INTO student_classes (owner_user_id, name)
SELECT DISTINCT owner_user_id, class_name FROM students WHERE class_name <> '';
