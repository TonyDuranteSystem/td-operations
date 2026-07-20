/**
 * Making a catalog tool's fixed-choice values forgiving about capitalisation.
 *
 * THE BUG THIS FIXES (measured 2026-07-20, real assistant, real requests). Older "agent"
 * tools already run their parameters through normalisation before validation, so writing
 * "medium" where the system wants "Normal" just works. Catalog tools — the much larger
 * set the assistant reaches through the tool finder — never got that treatment: their
 * parameters go straight into a strict schema check.
 *
 * The result was not an error the staff member ever saw. The assistant proposed logging a
 * conversation with direction "inbound", the check rejected it for wanting "Inbound", it
 * retried, burned its turns guessing, and finally gave up and asked the staff member to do
 * it by hand. From the outside it looked like the assistant simply would not act.
 *
 * So: before validating, any value that matches one of the allowed choices apart from
 * capitalisation is rewritten to the exact allowed spelling.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not guess. "inbound" → "Inbound" is a
 * change of letter case and nothing else; "incoming" stays "incoming" and is rejected, as
 * it should be, because mapping near-synonyms is how a proposal quietly becomes a
 * different action than the one described. Nor does it touch anything but fixed-choice
 * fields — free text, ids and numbers pass through untouched.
 *
 * WHY IT RUNS AT PROPOSE TIME, before the values are frozen and hashed: the confirmation
 * card shows the stored values, and what is stored is what will run. Correcting the case
 * afterwards would mean the card showed one spelling and the system used another.
 */

import { z } from 'zod'

/** Unwrap optional/nullable/default layers to the type underneath. */
function unwrap(schema: unknown): unknown {
  let current = schema
  // Bounded: these wrappers nest at most a few deep (.optional().default() is two).
  for (let i = 0; i < 6; i++) {
    const def = (current as { _def?: { innerType?: unknown } })?._def
    if (!def?.innerType) break
    current = def.innerType
  }
  return current
}

/** The allowed spellings for a fixed-choice field, or null if it isn't one. */
function enumOptions(schema: unknown): string[] | null {
  const inner = unwrap(schema)
  if (inner instanceof z.ZodEnum) {
    // `options` is typed differently across zod versions; read it structurally so a
    // dependency bump cannot silently turn this into a no-op.
    const opts = (inner as unknown as { options?: unknown }).options
    if (!Array.isArray(opts)) return null
    return opts.filter((o): o is string => typeof o === 'string')
  }
  return null
}

/**
 * Rewrite fixed-choice values to their exact allowed spelling where they differ only by
 * case. Everything else is returned untouched.
 *
 * Pure: takes the schema shape and the params, returns a new object. The caller decides
 * whether to use it, which keeps this testable without the tool registry or a database.
 */
export function coerceBridgeParams(
  schemaShape: Record<string, unknown> | undefined,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!schemaShape || !params) return params ?? {}
  const out: Record<string, unknown> = { ...params }

  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== 'string') continue
    const options = enumOptions(schemaShape[key])
    if (!options?.length) continue
    if (options.includes(value)) continue // already exact — leave it alone
    const match = options.find((o) => o.toLowerCase() === value.trim().toLowerCase())
    // No match → leave the original in place so validation still rejects it. Silently
    // substituting a "close enough" option would change the action the card describes.
    if (match) out[key] = match
  }
  return out
}
