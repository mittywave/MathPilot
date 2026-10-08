-- 机构版：只有一个共用题库（library_id = 'public' 的当前版本），讲义也全员共用。
-- 个人题库里的模块、分类、题目和配图权限并入共用题库；个人库行本身保留为空壳。
-- 极少数 source_id 冲突的行会被 OR IGNORE 跳过并留在原个人库，不会丢失。

UPDATE OR IGNORE library_modules_v2
SET library_id = 'public',
    publication_id = (SELECT active_publication_id FROM libraries_v2 WHERE id = 'public'),
    row_id = 'public:' || COALESCE((SELECT active_publication_id FROM libraries_v2 WHERE id = 'public'), 'personal') || ':module:' || source_id
WHERE library_id LIKE 'personal:%';

UPDATE OR IGNORE library_categories_v2
SET library_id = 'public',
    publication_id = (SELECT active_publication_id FROM libraries_v2 WHERE id = 'public'),
    row_id = 'public:' || COALESCE((SELECT active_publication_id FROM libraries_v2 WHERE id = 'public'), 'personal') || ':category:' || source_id
WHERE library_id LIKE 'personal:%';

UPDATE OR IGNORE library_questions_v2
SET library_id = 'public',
    publication_id = (SELECT active_publication_id FROM libraries_v2 WHERE id = 'public'),
    row_id = 'public:' || COALESCE((SELECT active_publication_id FROM libraries_v2 WHERE id = 'public'), 'personal') || ':question:' || source_id
WHERE library_id LIKE 'personal:%';

INSERT OR IGNORE INTO asset_library_access (access_key, asset_id, library_id, publication_id, created_at)
SELECT 'public|' || COALESCE((SELECT active_publication_id FROM libraries_v2 WHERE id = 'public'), 'personal') || '|' || asset_id,
       asset_id, 'public', (SELECT active_publication_id FROM libraries_v2 WHERE id = 'public'), created_at
FROM asset_library_access WHERE library_id LIKE 'personal:%';

-- Handout items referenced either library; now there is only one.
UPDATE handouts SET items_json = REPLACE(items_json, '"scope":"mine"', '"scope":"public"')
WHERE items_json LIKE '%"scope":"mine"%';
