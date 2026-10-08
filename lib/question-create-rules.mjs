const SERVER_FIELDS = new Set(['createdAt', 'updatedAt', 'createdBy', 'createdByEmail', 'canEdit', 'taxonomyKeys']);
const ASSET_URL = /\/api\/assets\/([0-9a-f-]{36})/gi;

// Creation retries must preserve content and never replace an existing question.
// Server timestamps, taxonomy inference and storage IDs are not user edits.
export function questionCreationContent(question, assetHashes = new Map()) {
  function normalize(value) {
    if (typeof value === 'string') return value.replace(ASSET_URL, (url, id) => assetHashes.get(id) ? `asset:${assetHashes.get(id)}` : url);
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined).map(key => [key, normalize(value[key])]));
    return value;
  }
  return JSON.stringify(normalize(Object.fromEntries(Object.entries(question).filter(([key]) => !SERVER_FIELDS.has(key)))));
}
