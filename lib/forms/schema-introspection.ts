/**
 * Zod schema → FieldSpec — pure-TS introspection helper used by the
 * workflow editor's schema-driven form renderer.
 *
 * Why a normalization step? React components shouldn't reach into Zod's
 * `_def` internals — that's brittle and would entangle the UI layer with
 * Zod version specifics. This module owns the brittle bit: it walks a
 * `ZodTypeAny` and returns a clean `FieldSpec` tree the renderer consumes.
 * Bumping Zod = touch only this file.
 *
 * SUPPORTED v1 shapes (all that today's 22 handler param schemas use):
 *   - z.string() / z.string().min(N) / .max() — text field
 *   - z.number() / .int() / .min() / .max() — number field
 *   - z.boolean() — checkbox
 *   - z.enum([...]) — dropdown
 *   - z.literal(value) — read-only constant
 *   - z.array(z.string()) — repeatable text inputs (chips)
 *   - z.object({...}).strict()|.passthrough()|default — nested section
 *   - z.record(z.string(), z.unknown()) — arbitrary key/value, rendered as JSON textarea
 *   - z.union of scalar primitives [string|number|boolean|null] — typed value picker
 *   - z.optional() / z.nullable() / z.default() — wrapping modifiers (recursed into innerType)
 *
 * Anything else returns kind='unsupported' with a `reason` string so the
 * editor falls back to a raw JSON textarea + Zod-on-save validation. The
 * fallback keeps the editor usable for novel handlers while we add support
 * incrementally.
 */

import type { ZodTypeAny } from "zod"

export interface FieldMeta {
  /** Human label. Defaults to the field key humanized; can be overridden via z.describe(). */
  label: string
  /** True when the field MUST be filled (not optional/nullable/default). */
  required: boolean
  /** Default value from z.default(), or undefined. */
  defaultValue?: unknown
  /** Free-form description text from z.describe(), surfaced as helper text. */
  description?: string
}

export type FieldSpec =
  | ({ kind: "string"; minLength?: number; maxLength?: number } & FieldMeta)
  | ({ kind: "number"; min?: number; max?: number; integer?: boolean } & FieldMeta)
  | ({ kind: "boolean" } & FieldMeta)
  | ({ kind: "enum"; options: ReadonlyArray<string> } & FieldMeta)
  | ({ kind: "literal"; value: string | number | boolean | null } & FieldMeta)
  | ({ kind: "array_of_strings" } & FieldMeta)
  | ({ kind: "object"; fields: Record<string, FieldSpec>; strict: boolean } & FieldMeta)
  | ({ kind: "record" } & FieldMeta) // arbitrary {[k:string]: unknown}
  | ({
      kind: "scalar_union"
      allowed: ReadonlyArray<"string" | "number" | "boolean" | "null">
    } & FieldMeta)
  | ({ kind: "unsupported"; reason: string } & FieldMeta)

interface IntrospectionContext {
  /** Field key (for object children) — feeds the default label. */
  key?: string
}

function humanize(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

interface ZodDef {
  type?: string
  innerType?: ZodTypeAny
  // schema is used by ZodEffects / refinements in some versions
  schema?: ZodTypeAny
  element?: ZodTypeAny
  options?: ZodTypeAny[]
  values?: ReadonlyArray<string>
  valueType?: ZodTypeAny
  keyType?: ZodTypeAny
  checks?: Array<{ kind?: string; value?: unknown }>
  defaultValue?: unknown | (() => unknown)
  description?: string
  shape?: () => Record<string, ZodTypeAny>
  catchall?: ZodTypeAny
}

function getDef(s: ZodTypeAny): ZodDef {
  return (s as unknown as { _def: ZodDef })._def
}

function getDescription(s: ZodTypeAny): string | undefined {
  return (s as unknown as { description?: string }).description
}

function readDefaultValue(s: ZodTypeAny): unknown {
  const def = getDef(s)
  const raw = def.defaultValue
  if (typeof raw === "function") {
    try {
      return (raw as () => unknown)()
    } catch {
      return undefined
    }
  }
  return raw
}

/**
 * Peel optional / nullable / default wrappers down to the "real" schema,
 * tracking whether the original was optional/nullable/had-a-default.
 */
function peel(s: ZodTypeAny): {
  inner: ZodTypeAny
  optional: boolean
  nullable: boolean
  defaultValue?: unknown
} {
  let cur = s
  let optional = false
  let nullable = false
  let defaultValue: unknown
  // Defensive depth limit so we never loop on a self-referencing schema.
  for (let i = 0; i < 8; i++) {
    const def = getDef(cur)
    if (def.type === "optional") {
      optional = true
      cur = def.innerType ?? cur
      continue
    }
    if (def.type === "nullable") {
      nullable = true
      cur = def.innerType ?? cur
      continue
    }
    if (def.type === "default") {
      defaultValue = readDefaultValue(cur)
      cur = def.innerType ?? cur
      continue
    }
    break
  }
  return { inner: cur, optional, nullable, defaultValue }
}

export interface IntrospectOptions {
  /** Forced label override (else derives from key or schema description). */
  label?: string
  /** Field key (for object children). */
  key?: string
}

/**
 * Convert a Zod schema into a FieldSpec for the renderer.
 *
 * Caller-supplied `opts.key` becomes the default field label (humanized).
 * `opts.label` wins if set. `z.describe()` text becomes the field's help text.
 */
export function introspect(schema: ZodTypeAny, opts: IntrospectOptions = {}): FieldSpec {
  const ctx: IntrospectionContext = { key: opts.key }
  const { inner, optional, nullable, defaultValue } = peel(schema)
  const required = !optional && !nullable && defaultValue === undefined
  const description = getDescription(inner) ?? getDescription(schema)
  const label = opts.label ?? (ctx.key ? humanize(ctx.key) : "Value")

  const meta: FieldMeta = {
    label,
    required,
    defaultValue,
    description,
  }

  const def = getDef(inner)
  // Zod v4 exposes constraint info via public properties on the schema
  // itself (`.minLength`, `.maxLength`, `.minValue`, `.maxValue`, `.isInt`,
  // `.values` for literals). The `_def.checks` array is opaque in v4 and
  // not stable to introspect.
  const innerPub = inner as unknown as {
    minLength?: number | null
    maxLength?: number | null
    minValue?: number | bigint | null
    maxValue?: number | bigint | null
    isInt?: boolean
    values?: ReadonlyArray<string | number | boolean | null>
    options?: ReadonlyArray<string>
  }
  switch (def.type) {
    case "string": {
      const minLength = typeof innerPub.minLength === "number" ? innerPub.minLength : undefined
      const maxLength = typeof innerPub.maxLength === "number" ? innerPub.maxLength : undefined
      return { kind: "string", ...meta, minLength, maxLength }
    }
    case "number": {
      const min = typeof innerPub.minValue === "number" ? innerPub.minValue : undefined
      const max = typeof innerPub.maxValue === "number" ? innerPub.maxValue : undefined
      const integer = innerPub.isInt === true
      return { kind: "number", ...meta, min, max, integer }
    }
    case "boolean":
      return { kind: "boolean", ...meta }
    case "enum": {
      const options = innerPub.options ?? (innerPub.values as ReadonlyArray<string>) ?? []
      return { kind: "enum", ...meta, options }
    }
    case "literal": {
      // Zod v4: literals carry `_def.values` (array). For single-value
      // literals (the only kind we explicitly support) take the first.
      const values = (def as unknown as { values?: unknown[] }).values ?? []
      const val: unknown = values[0]
      let literalValue: string | number | boolean | null = null
      if (val === null) literalValue = null
      else if (typeof val === "string") literalValue = val
      else if (typeof val === "number") literalValue = val
      else if (typeof val === "boolean") literalValue = val
      return { kind: "literal", ...meta, value: literalValue }
    }
    case "array": {
      const element = def.element
      if (!element) return { kind: "unsupported", ...meta, reason: "array element missing" }
      const elDef = getDef(element)
      if (elDef.type === "string") {
        return { kind: "array_of_strings", ...meta }
      }
      return {
        kind: "unsupported",
        ...meta,
        reason: `array of '${elDef.type ?? "unknown"}' not supported by the form renderer (v1 supports only array of strings — use the JSON fallback)`,
      }
    }
    case "object": {
      const shape =
        typeof def.shape === "function"
          ? def.shape()
          : ((inner as unknown as { shape: Record<string, ZodTypeAny> }).shape ?? {})
      const fields: Record<string, FieldSpec> = {}
      for (const [k, child] of Object.entries(shape)) {
        fields[k] = introspect(child, { key: k })
      }
      // Zod v4: strict mode is encoded by `_def.catchall._def.type === 'never'`.
      // Passthrough = catchall.type === 'unknown'. Default (strip) = no catchall.
      const catchallType = def.catchall ? getDef(def.catchall).type : undefined
      const strict = catchallType === "never"
      return { kind: "object", ...meta, fields, strict }
    }
    case "record":
      // We don't render a per-key editor for arbitrary records — fall back to
      // JSON textarea. Future: introspect known key shapes.
      return { kind: "record", ...meta }
    case "union": {
      const options = def.options ?? []
      // Recognize the scalar-union pattern (string|number|boolean|null) used
      // by chain.update_*_field for the `value` field.
      const scalarKinds = new Set(["string", "number", "boolean", "null"])
      const optionKinds = options.map((o) => getDef(o).type ?? "")
      const allScalar = optionKinds.every((k) => scalarKinds.has(k))
      if (allScalar && options.length > 0) {
        return {
          kind: "scalar_union",
          ...meta,
          allowed: optionKinds.filter((k): k is "string" | "number" | "boolean" | "null" =>
            scalarKinds.has(k),
          ),
        }
      }
      return {
        kind: "unsupported",
        ...meta,
        reason: `union of [${optionKinds.join(",")}] not supported by the form renderer — use the JSON fallback`,
      }
    }
    default:
      return {
        kind: "unsupported",
        ...meta,
        reason: `Zod type '${def.type ?? "unknown"}' not supported by the form renderer`,
      }
  }
}
