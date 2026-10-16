/**
 * "Waiting on" kinds — the pure rules around the catalog list `step_wait_kinds` (dev job 40235e3c, Antonio 2026-10-16).
 * No database, no network. The server loader (lib/services/wait-kinds-load.ts) reads the rows and hands them to
 * `parseCatalogWaitKinds`; the builders resolve each step with `resolveWho`. The shapes (WaitKind, the built-in kinds,
 * "unset") live in types.ts, which the browser views import.
 *
 * A bad row never breaks a page and is never hidden: it is skipped and reported (`problems`), and the Calendar pages show
 * those problems in their warnings banner.
 */

import {
  BUILTIN_WAIT_KINDS,
  RESERVED_WAIT_SLUGS,
  UNSET,
  WAIT_SLUG_RE,
  catalogWaitKind,
  firstKindWith,
  waitKindOf,
  type WaitKind,
  type Who,
} from "@/lib/open-services/types"

export interface CatalogKindRow {
  slug: string
  display_name: string | null
  status: string
  metadata: Record<string, unknown> | null
}

/** The slug a name becomes: lower-case letters and digits joined by underscores, accents folded ("Società" → "societa"). */
export function slugFromName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
}

/** A slug the catalog may hold for a kind: right shape and not one of the built-in / reserved names. */
export function isUsableKindSlug(slug: string): boolean {
  return WAIT_SLUG_RE.test(slug) && !RESERVED_WAIT_SLUGS.includes(slug)
}

/**
 * Catalog rows → kinds. Active rows are offered everywhere; deprecated rows are kept (retired) so the steps that already use
 * them keep their meaning; draft / exception-only rows are ignored. A row with no behaviour (for example one added through the
 * generic catalog_add tool, which has no metadata field) is "someone else" (`other`); only `date` must be said out loud.
 */
export function parseCatalogWaitKinds(rows: readonly CatalogKindRow[]): { kinds: WaitKind[]; problems: string[] } {
  const kinds: WaitKind[] = []
  const problems: string[] = []
  for (const r of rows) {
    if (r.status !== "active" && r.status !== "deprecated") continue
    if (!isUsableKindSlug(r.slug)) {
      problems.push(`The waiting-on list has a kind named "${r.slug}" that cannot be used (reserved or wrongly written); it is ignored.`)
      continue
    }
    const raw = r.metadata?.behaviour
    let behaviour: "other" | "date" = "other"
    if (raw === "date") behaviour = "date"
    else if (raw !== undefined && raw !== null && raw !== "" && raw !== "other") {
      problems.push(`The waiting-on kind "${r.slug}" has behaviour "${String(raw)}", which a list kind cannot have; it is ignored.`)
      continue
    }
    const name = (r.display_name ?? "").trim() || r.slug
    kinds.push(catalogWaitKind(r.slug, name, behaviour, r.status === "deprecated"))
  }
  return { kinds, problems }
}

/**
 * Whose turn a step is, as the slug the job carries. The done step wins (nobody is waiting: it resolves to the kind with the
 * behaviour `none`, never to a typed slug); no setting → "unset"; a setting whose kind is no longer in the list → "unset" AND
 * `dangling` carries the slug, so the page can say so instead of quietly moving the job.
 */
export function resolveWho(
  kinds: readonly WaitKind[],
  waitingOn: string | null | undefined,
  isDoneStep: boolean,
): { who: Who; dangling: string | null } {
  if (isDoneStep) return { who: firstKindWith(kinds, "none")?.slug ?? BUILTIN_WAIT_KINDS.none.slug, dangling: null }
  if (typeof waitingOn !== "string" || waitingOn.trim() === "") return { who: UNSET, dangling: null }
  const kind = waitKindOf(kinds, waitingOn)
  return kind ? { who: kind.slug, dangling: null } : { who: UNSET, dangling: waitingOn }
}

/** The plain-words warning for jobs / steps that point at a kind that is no longer in the list. */
export function danglingWarning(count: number, slugs: readonly string[], unit: "job" | "step"): string {
  const shown = Array.from(new Set(slugs)).slice(0, 3).map(s => `"${s}"`).join(", ")
  return `${count} open ${unit}(s) use a "waiting on" kind that is no longer in the list (${shown}); they show as not set until the step is pointed at a kind that exists.`
}

/**
 * May a step be SAVED with this "waiting on" value? Empty is fine; so is the value it already has (a kind retired later must
 * never lock the editor on an unrelated save); otherwise it must be a built-in or an ACTIVE catalog kind.
 */
export function waitingOnSaveProblem(
  kinds: readonly WaitKind[],
  value: string | null | undefined,
  stored: string | null | undefined,
): string | null {
  if (value === null || value === undefined || value === "") return null
  if (value === (stored ?? null)) return null
  const kind = waitKindOf(kinds, value)
  if (kind && !kind.retired) return null
  return kind?.retired
    ? `"${kind.name}" has been retired from the waiting-on list. Pick another choice.`
    : `"${value}" is not in the waiting-on list. Pick one of the choices.`
}

/**
 * The choices of a step's "Waiting on" dropdown: every kind that is not retired, plus the step's CURRENT value when that kind is retired
 * or no longer exists (so the dropdown never shows "Not set" while the step really holds a value, and an unrelated save keeps it).
 */
export function waitingOnOptions(kinds: readonly WaitKind[], current: string | null | undefined): Array<{ value: string; label: string }> {
  const out = kinds.filter(k => !k.retired).map(k => ({ value: k.slug, label: k.name }))
  if (typeof current === "string" && current !== "" && !out.some(o => o.value === current)) {
    const kind = waitKindOf(kinds, current)
    out.push({ value: current, label: kind ? `${kind.name} (retired)` : `${current} (no longer in the list)` })
  }
  return out
}
