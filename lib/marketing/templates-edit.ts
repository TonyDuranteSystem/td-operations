/**
 * TD Marketing — changing the team's message templates (pure; dev job 9aec66fa, round 2 step 4). Only the team owner may (checked by the route); this file holds the rules: what a save, a reset
 * and a delete do to the team's `team_templates` setting, and what is refused. A built-in template can be edited and reset but never deleted; a template the owner created can be edited and deleted.
 * No database here.
 */
import { DEFAULT_TEMPLATES, unknownPlaceholder, type TeamTemplates } from "@/lib/marketing/templates"

export type TemplateAction =
  | { action: "save"; key?: string; label?: string; it?: string; en?: string }
  | { action: "reset"; key: string }
  | { action: "delete"; key: string }

export const MAX_TEMPLATES = 80
export const isBuiltIn = (key: string): boolean => DEFAULT_TEMPLATES.some(t => t.key === key)

export type EditResult = { ok: true; value: TeamTemplates; key: string } | { ok: false; error: string; status: 400 | 404 }
const bad = (error: string, status: 400 | 404 = 400): EditResult => ({ ok: false, error, status })

/** A new key for a template the owner creates: letters, digits and underscores only, unique in this team. */
export function newTemplateKey(existing: TeamTemplates, seed = Date.now(), rand = () => Math.random()): string {
  let n = seed
  for (;;) {
    // the time plus a few random characters: two owners creating a template in the same millisecond still get different keys
    const k = `t_${n.toString(36)}${Math.floor(rand() * 36 ** 3).toString(36).padStart(3, "0")}`
    if (!(k in existing) && !isBuiltIn(k)) return k
    n++
  }
}

const clean = (s: unknown): string | undefined => (typeof s === "string" && s.trim() ? s.trim() : undefined)

/** Apply one change to the team's templates. Never changes `current`; returns the new set. */
export function applyTemplateEdit(current: TeamTemplates, input: TemplateAction, seed?: number): EditResult {
  const next: TeamTemplates = { ...current }

  if (input.action === "reset") {
    if (!isBuiltIn(input.key)) return bad("Only a built-in template can be reset.")
    delete next[input.key]
    return { ok: true, value: next, key: input.key }
  }

  if (input.action === "delete") {
    if (isBuiltIn(input.key)) return bad("A built-in template cannot be deleted. You can edit it, or reset it to the original.")
    if (!(input.key in current)) return bad("That template does not exist any more. Reload the page.", 404)
    delete next[input.key]
    return { ok: true, value: next, key: input.key }
  }

  // save: a change to an existing template (merged field by field), or a new one
  const label = clean(input.label), it = clean(input.it), en = clean(input.en)
  for (const text of [it, en]) {
    const u = text ? unknownPlaceholder(text) : null
    if (u !== null) return bad(`"{${u}}" is not a placeholder. Use {name}, {setter} or {when}.`)
  }
  if (input.key) {
    const key = input.key
    if (!isBuiltIn(key) && !(key in current)) return bad("That template does not exist any more. Reload the page.", 404)
    if (!(key in current) && Object.keys(current).length >= MAX_TEMPLATES) return bad("There are too many templates. Delete one you do not use.")
    const merged = { ...(current[key] ?? {}) }
    // for a built-in, a field sent empty goes back to the original wording; for the owner's own, a name and one text must stay
    if (input.label !== undefined) { if (label) merged.label = label; else delete merged.label }
    if (input.it !== undefined) { if (it) merged.it = it; else delete merged.it }
    if (input.en !== undefined) { if (en) merged.en = en; else delete merged.en }
    if (!isBuiltIn(key)) {
      if (!merged.label) return bad("Give the template a name.")
      if (!merged.it && !merged.en) return bad("Write the message in Italian or in English.")
    }
    if (Object.keys(merged).length === 0) delete next[key]
    else next[key] = merged
    return { ok: true, value: next, key }
  }
  if (!label) return bad("Give the template a name.")
  if (!it && !en) return bad("Write the message in Italian or in English.")
  if (Object.keys(current).length >= MAX_TEMPLATES) return bad("There are too many templates. Delete one you do not use.")
  const key = newTemplateKey(current, seed)
  next[key] = { label, ...(it ? { it } : {}), ...(en ? { en } : {}) }
  return { ok: true, value: next, key }
}
