/**
 * Describing a tool's SETTINGS to the assistant.
 *
 * THE BUG THIS FIXES (root-caused 2026-07-29, Luca's PDF report of 2026-07-27).
 * `find_tool` returned a tool's name and description and nothing else. So when the
 * assistant reached `pdf_create` through the bridge it never learned that a
 * `letterhead` setting exists, nor that passing an empty string removes the header —
 * even though the tool's own parameter description says exactly that. It called the
 * tool with the obvious fields (title, body), the default letterhead was applied, and
 * Luca could repeat "remove the Tony Durante LLC header" indefinitely without effect:
 * the instruction had nowhere to land.
 *
 * That blindness is not specific to PDFs. EVERY tool reached through the bridge was
 * invoked with guessed parameters, so any behaviour that lives behind an unguessed
 * setting was silently unreachable, and the failure always looked like the assistant
 * ignoring the request rather than not knowing the knob was there.
 *
 * WHAT THIS DOES: turns a tool's zod shape into a compact, readable settings list.
 * Deliberately compact — this text is appended to every search hit, so verbosity is
 * paid on every lookup. One line per setting: name, required marker, base type, and
 * the first sentence of its own description.
 */

import { z } from "zod"

/** One setting of a tool, flattened for display. */
export interface ToolParam {
  name: string
  /** Base type after unwrapping optional/nullable/default wrappers, e.g. "string". */
  type: string
  required: boolean
  /** The tool author's own `.describe()` text, capped (never sentence-cut). May be empty. */
  description: string
}

/**
 * Longest description we keep per setting.
 *
 * NOT a sentence cut, deliberately — the ACTIONABLE clause is routinely the last
 * sentence, not the first ("Sender line at the very top. Defaults to … . Pass "" for a
 * bare document." — the third sentence is the one Luca needed). Sized from the real
 * catalog: 24 param descriptions exceed 160 chars, and cutting at 140 amputated
 * `crm_create_task.category`'s list of allowed values mid-word, on a FREE-TEXT field
 * with no validation to reject the fragment. 200 clears all but the essay-length ones.
 */
const PARAM_DESCRIPTION_CAP = 200

/** Most settings we list for one tool before saying how many were left out. */
const MAX_PARAMS_SHOWN = 12

/**
 * Zod kinds whose value may legitimately be OMITTED by the caller.
 *
 * Requiredness is decided STRUCTURALLY, from the outer wrapper, NOT from
 * `isOptional()`. In zod 4 `isOptional()` is implemented as `safeParse(undefined)
 * .success`, and `z.any()` accepts undefined — so `offer_create`'s `services` and
 * `cost_summary` (both bare `z.any()`, both genuinely required) were rendered WITHOUT
 * the required marker. Telling the assistant that the two fields which make an offer
 * an offer are optional is the same class of wrong parameter contract this whole file
 * exists to fix.
 */
const OMITTABLE_TYPES = new Set([
  "optional", "nullish", "default", "prefault", "catch",
  "ZodOptional", "ZodDefault", "ZodCatch",
])

/**
 * Wrapper types that decorate another schema without changing what you pass.
 *
 * Named EXPLICITLY rather than "unwrap whatever inner schema you find": ZodArray keeps
 * its ELEMENT under `_def.type`, and a generic unwrap descends into it and reports
 * `z.array(z.string())` as a plain string — which is worse than saying nothing, because
 * the assistant then passes a bare value where a list is required. Caught by the
 * array + enum tests, which failed on exactly that.
 */
const WRAPPER_TYPES = new Set([
  // zod 4 (installed here) reports lowercase kinds on `_def.type`…
  "optional", "nullable", "default", "prefault", "catch", "readonly", "pipe", "nonoptional",
  // …zod 3 used `_def.typeName`. Both accepted so a version bump doesn't silently
  // turn every setting into "value" — the failure would be invisible, since the
  // output still renders, just uselessly.
  "ZodOptional", "ZodNullable", "ZodDefault", "ZodEffects", "ZodCatch", "ZodBranded",
  "ZodReadonly", "ZodPipeline",
])

/** The kind of a schema, across zod 3 (`typeName`) and zod 4 (`type`). */
function kindOf(schema: z.ZodTypeAny | undefined): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)?._def
  return def?.typeName ?? def?.type ?? ""
}

/**
 * Strip zod's wrappers to reach the type that matters.
 *
 * `z.string().optional()` reports its own type as ZodOptional, which tells the
 * assistant nothing about what to pass. Bounded rather than recursive-forever: a
 * pathological chain of wrappers stops at 10 rather than spinning.
 */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur = schema
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const def = (cur as any)?._def
    if (!def || !WRAPPER_TYPES.has(kindOf(cur))) return cur
    const inner = def.innerType ?? def.schema ?? def.in
    if (!inner || typeof inner !== "object" || !("_def" in inner)) return cur
    cur = inner as z.ZodTypeAny
  }
  return cur
}

/** A short, human type name: "string", "number", "string[]", "enum(a|b)". */
export function typeNameOf(schema: z.ZodTypeAny): string {
  const base = unwrap(schema)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (base as any)?._def
  switch (kindOf(base)) {
    case "string":
    case "ZodString":
      return "string"
    case "number":
    case "ZodNumber":
      return "number"
    case "boolean":
    case "ZodBoolean":
      return "boolean"
    case "array":
    case "ZodArray": {
      // zod 4 keeps the element on `element`; zod 3 kept it on `type`.
      const el = def?.element ?? def?.type
      return `${el && typeof el === "object" ? typeNameOf(el as z.ZodTypeAny) : "any"}[]`
    }
    case "enum":
    case "ZodEnum": {
      // zod 4 stores an entries OBJECT; zod 3 stored a values ARRAY.
      const vals: string[] = Array.isArray(def?.values)
        ? def.values
        : def?.entries && typeof def.entries === "object"
          ? Object.values(def.entries as Record<string, string>)
          : []
      // Enumerate the choices — the assistant guessing "inbound" for "Inbound" is a
      // failure this catalog has already produced once.
      return vals.length ? `enum(${vals.slice(0, 8).join("|")}${vals.length > 8 ? "|…" : ""})` : "enum"
    }
    case "object":
    case "ZodObject":
    case "record":
    case "ZodRecord":
      return "object"
    default:
      return "value"
  }
}

/**
 * A description, whitespace-collapsed and length-capped.
 *
 * Deliberately NOT split on sentences — see PARAM_DESCRIPTION_CAP. Anyone "fixing"
 * this to take the first sentence reintroduces Luca's bug.
 */
export function shortDescription(text: string | undefined): string {
  const collapsed = (text ?? "").replace(/\s+/g, " ").trim()
  if (!collapsed) return ""
  return collapsed.length > PARAM_DESCRIPTION_CAP
    ? `${collapsed.slice(0, PARAM_DESCRIPTION_CAP).trimEnd()}…`
    : collapsed
}

/**
 * Flatten a tool's zod shape into its settings.
 *
 * Reads the description off the OUTER schema, because tools write
 * `z.string().optional().describe(...)` — the text lives on the optional wrapper, not
 * on the string underneath it.
 */
export function describeZodShape(shape: Record<string, z.ZodTypeAny> | undefined): ToolParam[] {
  if (!shape) return []
  return Object.entries(shape).map(([name, schema]) => ({
    name,
    type: typeNameOf(schema),
    required: isRequired(schema),
    description: shortDescription(schema?.description),
  }))
}

/**
 * Is this setting mandatory?
 *
 * Structural: optional ONLY when the outermost wrapper is one that permits omission.
 * `isOptional()` is used solely as a fallback for a kind we do not recognise, because
 * on its own it reports `z.any()` — required in every tool that uses it — as optional.
 */
export function isRequired(schema: z.ZodTypeAny | undefined): boolean {
  if (!schema) return true
  const kind = kindOf(schema)
  if (OMITTABLE_TYPES.has(kind)) return false
  // A recognised NON-omittable kind is required, full stop — do not let isOptional()
  // override it (that is exactly the z.any() trap).
  if (kind) return true
  return typeof schema.isOptional === "function" ? !schema.isOptional() : true
}

/**
 * Render settings as indented lines under a search hit. Empty string when the tool
 * takes none, so the caller can append unconditionally.
 */
export function formatToolParams(params: readonly ToolParam[]): string {
  if (!params.length) return ""
  // REQUIRED FIRST, then declaration order. Without this the cap slices in declaration
  // order, so a required setting declared 13th is replaced by "…and N more" and the
  // assistant is told a mandatory field does not exist — the very failure this module
  // fixes, relocated. `offer_create` declares 35+ params with `entity_type` at #25;
  // that one decides SMLLC vs MMLLC and therefore which agreements are generated.
  // A stable sort, so ties keep the author's ordering.
  const ordered = params
    .map((p, i) => ({ p, i }))
    .sort((a, b) => Number(b.p.required) - Number(a.p.required) || a.i - b.i)
    .map((r) => r.p)
  const shown = ordered.slice(0, MAX_PARAMS_SHOWN)
  const lines = shown.map((p) => {
    const head = `    - ${p.name}${p.required ? "*" : ""} (${p.type})`
    return p.description ? `${head}: ${p.description}` : head
  })
  if (params.length > shown.length) {
    lines.push(`    - …and ${params.length - shown.length} more`)
  }
  return lines.join("\n")
}
