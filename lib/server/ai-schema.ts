/** Validate the JSON Schema subset used by this application's AI contracts.
 * No dynamic code generation (Workers disallow eval); unsupported keywords fail
 * closed when a provider cannot enforce the schema itself.
 */
type Schema = Record<string, unknown>;
const supported = new Set([
  "type", "properties", "required", "additionalProperties", "items", "enum",
  "anyOf", "oneOf", "allOf", "const", "minimum", "maximum", "minItems", "maxItems",
  "minLength", "maxLength", "description", "title", "$schema", "default",
]);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Report schema-owned paths only: never echo model text, values or extra keys. */
export function aiSchemaIssue(value: unknown, schema: unknown, path = '$', depth = 0): string | null {
  if (matchesAiSchema(value, schema, depth)) return null;
  if (!object(schema) || depth > 64) return `${path}：结构约束无效`;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !matchesAiSchema(value, {type: schema.type})) return `${path}：类型应为 ${types.join(' / ')}`;
  if (object(value)) {
    const properties = object(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.hasOwn(value, key)) return `${path}.${key}：缺少必填字段`;
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const issue = aiSchemaIssue(value[key], child, `${path}.${key}`, depth + 1);
      if (issue) return issue;
    }
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(properties, key))) return `${path}：包含未定义字段`;
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      const issue = aiSchemaIssue(value[i], schema.items, `${path}[${i}]`, depth + 1);
      if (issue) return issue;
    }
  }
  return `${path}：不符合字段约束`;
}
export function matchesAiSchema(value: unknown, schema: unknown, depth = 0): boolean {
  if (schema === true) return true;
  if (schema === false || !object(schema) || depth > 64) return false;
  if (Object.keys(schema).some(key => !supported.has(key))) return false;
  const match = (v: unknown, s: unknown) => matchesAiSchema(v, s, depth + 1);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(s => match(value, s))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(s => match(value, s)).length !== 1) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every(s => match(value, s))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) return false;
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some(type => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return object(value);
    if (type === "integer") return typeof value === "number" && Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    return (type === "string" || type === "boolean") && typeof value === type;
  })) return false;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && [...value].length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && [...value].length > schema.maxLength) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every(item => match(item, schema.items))) return false;
  }
  if (object(value)) {
    const properties = object(schema.properties) ? schema.properties as Record<string, Schema> : {};
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== "string" || !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) { if (!match(item, properties[key])) return false; }
      else if (schema.additionalProperties === false) return false;
      else if (object(schema.additionalProperties) && !match(item, schema.additionalProperties)) return false;
    }
  }
  return true;
}
