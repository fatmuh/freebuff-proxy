// ─── JSON Schema Normalization ─────────────────────────────────
// Port of Go's schema normalization logic.
// Rewrites tool parameter schemas into a conservative JSON Schema
// subset that the upstream backend can parse:
//   - Resolves local $ref values
//   - Simplifies nullable constructs (anyOf/oneOf with null)
//   - Normalizes type field (array → first non-null)
//   - Cleans enum (removes nulls, deduplicates)
//   - Removes "nullable" field

const MAX_DEPTH = 12

// ─── Public API ────────────────────────────────────────────────

export function normalizeToolSchemas(tools: unknown[]): void {
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const toolMap = tool as Record<string, unknown>
    const fn = toolMap.function
    if (!fn || typeof fn !== 'object') continue
    const fnMap = fn as Record<string, unknown>
    const params = fnMap.parameters
    if (!params || typeof params !== 'object') continue
    const defs = extractDefinitions(params as Record<string, unknown>)
    fnMap.parameters = normalizeSchemaMap(params as Record<string, unknown>, defs, MAX_DEPTH)
  }
}

// ─── Internal Helpers ──────────────────────────────────────────

function extractDefinitions(schema: Record<string, unknown>): Record<string, unknown> | null {
  const merged: Record<string, unknown> = {}
  let hasAny = false

  for (const key of ['definitions', '$defs']) {
    const d = schema[key]
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      Object.assign(merged, d as Record<string, unknown>)
      hasAny = true
    }
  }
  return hasAny ? merged : null
}

function mergeDefinitions(
  parent: Record<string, unknown> | null,
  local: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!parent) return local
  if (!local) return parent
  return { ...parent, ...local }
}

function normalizeSchemaValue(
  value: unknown,
  defs: Record<string, unknown> | null,
  maxDepth: number,
): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return normalizeSchemaMap(value as Record<string, unknown>, defs, maxDepth)
  }
  if (Array.isArray(value)) {
    return normalizeSchemaSlice(value, defs, maxDepth)
  }
  return value
}

function normalizeSchemaMap(
  node: Record<string, unknown>,
  defs: Record<string, unknown> | null,
  maxDepth: number,
): Record<string, unknown> {
  if (maxDepth <= 0) return JSON.parse(JSON.stringify(node))

  // Merge any local definitions
  defs = mergeDefinitions(defs, extractDefinitions(node))

  // Try to resolve $ref
  const replaced = tryResolveRef(node, defs)
  if (replaced && typeof replaced === 'object' && !Array.isArray(replaced)) {
    return normalizeSchemaMap(replaced as Record<string, unknown>, defs, maxDepth - 1)
  }

  // Recursively normalize all values
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    normalized[key] = normalizeSchemaValue(value, defs, maxDepth - 1)
  }

  // Clean up
  delete normalized.definitions
  delete normalized.$defs
  delete normalized.nullable

  simplifyNullableCombinator(normalized, 'anyOf')
  simplifyNullableCombinator(normalized, 'oneOf')
  normalizeTypeField(normalized)
  normalizeEnumField(normalized)
  normalizeConstField(normalized)

  return normalized
}

function normalizeSchemaSlice(
  slice: unknown[],
  defs: Record<string, unknown> | null,
  maxDepth: number,
): unknown[] {
  if (maxDepth <= 0) return JSON.parse(JSON.stringify(slice))
  return slice.map(v => normalizeSchemaValue(v, defs, maxDepth - 1))
}

function simplifyNullableCombinator(
  schema: Record<string, unknown>,
  key: string,
): void {
  const options = schema[key]
  if (!Array.isArray(options)) return

  // Filter out null schemas
  const filtered = options.filter(opt => {
    if (opt && typeof opt === 'object' && !Array.isArray(opt)) {
      return !isNullSchema(opt as Record<string, unknown>)
    }
    return true
  })

  if (filtered.length === 0) {
    delete schema[key]
    return
  }

  if (filtered.length === 1 && filtered[0] && typeof filtered[0] === 'object' && !Array.isArray(filtered[0])) {
    // Merge the single option back into the schema
    const single = filtered[0] as Record<string, unknown>
    delete schema[key]
    Object.assign(schema, single)
    return
  }

  schema[key] = filtered
}

function normalizeTypeField(schema: Record<string, unknown>): void {
  const rawType = schema.type
  if (rawType === undefined) return
  if (typeof rawType === 'string') return // already fine

  if (!Array.isArray(rawType)) return

  // Keep first non-null type
  const nonNull = rawType.filter(t => typeof t === 'string' && t !== 'null' && t.trim()) as string[]
  if (nonNull.length === 0) {
    delete schema.type
  } else {
    schema.type = nonNull[0]
  }
}

function normalizeEnumField(schema: Record<string, unknown>): void {
  const enumValues = schema.enum
  if (!Array.isArray(enumValues)) return

  const filtered: unknown[] = []
  const seen = new Set<string>()

  for (const entry of enumValues) {
    if (entry === null || entry === undefined) continue
    const key = `${typeof entry}:${String(entry)}`
    if (seen.has(key)) continue
    seen.add(key)
    filtered.push(entry)
  }

  if (filtered.length === 0) {
    delete schema.enum
  } else {
    schema.enum = filtered
  }
}

function normalizeConstField(schema: Record<string, unknown>): void {
  if ('const' in schema && schema.const === null) {
    delete schema.const
  }
}

function isNullSchema(schema: Record<string, unknown>): boolean {
  const type = schema.type
  if (type === 'null') return true
  if ('const' in schema && schema.const === null) return true
  const enumValues = schema.enum
  if (Array.isArray(enumValues) && enumValues.length === 1 && enumValues[0] === null) return true
  return false
}

function tryResolveRef(
  node: Record<string, unknown>,
  defs: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const ref = node.$ref
  if (typeof ref !== 'string' || Object.keys(node).length !== 1) return null

  let name: string | null = null
  if (ref.startsWith('#/definitions/')) {
    name = ref.slice('#/definitions/'.length)
  } else if (ref.startsWith('#/$defs/')) {
    name = ref.slice('#/$defs/'.length)
  }
  if (!name || !defs) return null

  const def = defs[name]
  if (!def) return null
  if (def && typeof def === 'object' && !Array.isArray(def)) {
    return JSON.parse(JSON.stringify(def)) // clone
  }
  return null
}
