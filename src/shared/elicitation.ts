/** Empty MCP forms are also used for tool permission requests. Forms with
 * inputs need an editor and validation before we can offer acceptance. */
export function canAcceptEmptyElicitation(params: Record<string, any>): boolean {
  if (params.mode !== 'form') return false;
  const schema = params.requestedSchema;
  if (!schema || schema.type !== 'object' || !schema.properties || Array.isArray(schema.properties) || typeof schema.properties !== 'object') return false;
  if (Object.keys(schema.properties).length !== 0) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0)) return false;
  // Do not silently accept an unknown constraint that could invalidate {}.
  const supported = new Set(['$schema', 'type', 'title', 'description', 'properties', 'required', 'additionalProperties']);
  return Object.keys(schema).every(key => supported.has(key)) && (schema.additionalProperties === undefined || typeof schema.additionalProperties === 'boolean');
}
