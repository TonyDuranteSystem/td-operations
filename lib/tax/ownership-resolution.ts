/**
 * Ownership % resolution (Slice 7 / W6, master plan §4).
 *
 * Three sources can state a member's ownership percentage, in PRECEDENCE order:
 *   1. prior-year K-1s (item J ending %) — the filed truth
 *   2. the wizard's member list (the client's fresh statement)
 *   3. account_contacts.ownership_pct (CRM, often stale or null)
 *
 * resolveOwnership merges them by person (normalized-name match), takes the
 * highest-precedence value per person, and reports CONFLICTS (sources that
 * materially disagree) and GAPS (members with no % anywhere). K-1 generation
 * is BLOCKED while gaps exist or the total isn't 100% — gate 5 consumes this.
 *
 * The resolved set is meant to be SYNCED BACK to account_contacts (W6 found
 * both real MMLLC clients had NULLs there) — the write happens in the
 * orchestration layer, not here; this module stays pure.
 */

export interface OwnershipSource {
  name: string
  pct: number | null
}

export interface ResolveOwnershipInput {
  /** From a VALIDATED prior return only (quarantined extractions don't reach here). */
  priorK1s: OwnershipSource[]
  /** From the wizard's additional_members rows (member_name + member_ownership_pct). */
  wizardMembers: OwnershipSource[]
  /** From account_contacts (contact display name + ownership_pct). */
  accountContacts: Array<OwnershipSource & { contact_id: string }>
}

export interface ResolvedMember {
  name: string
  pct: number | null
  source: "prior_k1" | "wizard" | "account_contacts" | "none"
  /** Set when the person matched an account_contacts row — the sync-back target. */
  contact_id: string | null
}

export interface OwnershipConflict {
  name: string
  values: Array<{ source: ResolvedMember["source"]; pct: number }>
  message: string
}

export interface OwnershipResolution {
  members: ResolvedMember[]
  conflicts: OwnershipConflict[]
  /** Members with no % from any source — blocks K-1 generation. */
  missing: string[]
  totalPct: number
  /** True when every member has a % and the total is 100 ±0.5. */
  complete: boolean
}

/** Normalize a person name for matching: case, spacing, accents. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    // eslint-disable-next-line no-misleading-character-class -- stripping combining marks is the point
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Same person? Exact normalized match, or all tokens of the shorter name
 *  appear in the longer (handles "Sofia Marinoni" vs "Sofia A. Marinoni"). */
export function sameName(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const ta = na.split(" ")
  const tb = nb.split(" ")
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  return shorter.length >= 2 && shorter.every(t => longer.includes(t))
}

const CONFLICT_TOLERANCE = 0.5

export function resolveOwnership(input: ResolveOwnershipInput): OwnershipResolution {
  type Entry = { name: string; bySource: Partial<Record<ResolvedMember["source"], number>>; contact_id: string | null }
  const entries: Entry[] = []
  const findEntry = (name: string): Entry | undefined => entries.find(e => sameName(e.name, name))
  const conflicts: OwnershipConflict[] = []

  const add = (src: ResolvedMember["source"], s: OwnershipSource, contactId?: string) => {
    let entry = findEntry(s.name)
    if (!entry) {
      entry = { name: s.name, bySource: {}, contact_id: null }
      entries.push(entry)
    }
    if (s.pct !== null && Number.isFinite(s.pct)) entry.bySource[src] = s.pct
    if (contactId) entry.contact_id = contactId
  }

  // THE CLIENT'S DECLARED LIST IS THE ROSTER (2026-06-12, Antonio's catch:
  // a CRM contact not declared in the wizard became a phantom 100% partner
  // on top of the declared 50/50 — percentages summed to 200%). When the
  // wizard declares members, prior K-1s and CRM records only SUPPLY
  // percentages for declared members; a person they mention who is NOT
  // declared becomes a staff-review conflict (possible mid-year exit, §706),
  // never an automatic member. Without a wizard list (staff context, no
  // submission yet) all sources merge as before.
  const hasWizardRoster = input.wizardMembers.length > 0
  const inRoster = (name: string) => input.wizardMembers.some(m => sameName(m.name, name))

  for (const m of input.wizardMembers) add("wizard", m)
  for (const k of input.priorK1s) {
    if (hasWizardRoster && !inRoster(k.name)) {
      conflicts.push({ name: k.name, values: k.pct !== null ? [{ source: "prior_k1", pct: k.pct }] : [], message: `${k.name} is on the prior year's K-1s but NOT in this year's member list — confirm whether they exited the company (mid-year changes affect every K-1).` })
      continue
    }
    add("prior_k1", k)
  }
  for (const c of input.accountContacts) {
    if (hasWizardRoster && !inRoster(c.name)) {
      conflicts.push({ name: c.name, values: c.pct !== null ? [{ source: "account_contacts", pct: c.pct }] : [], message: `${c.name} is linked to the company in our records but NOT in this year's member list — staff should confirm.` })
      continue
    }
    add("account_contacts", c, c.contact_id)
  }

  const PRECEDENCE: ResolvedMember["source"][] = ["prior_k1", "wizard", "account_contacts"]
  const members: ResolvedMember[] = []
  const missing: string[] = []

  for (const e of entries) {
    const stated = PRECEDENCE.flatMap(src =>
      e.bySource[src] !== undefined ? [{ source: src, pct: e.bySource[src] as number }] : [],
    )
    const winner = stated[0] ?? null
    if (!winner) missing.push(e.name)

    const distinct = new Set(stated.map(s => Math.round(s.pct * 100)))
    if (stated.length > 1 && distinct.size > 1) {
      const spread = Math.max(...stated.map(s => s.pct)) - Math.min(...stated.map(s => s.pct))
      if (spread > CONFLICT_TOLERANCE) {
        conflicts.push({
          name: e.name,
          values: stated,
          message: `${e.name}: ${stated.map(s => `${s.pct}% (${s.source})`).join(" vs ")} — resolved to ${winner!.pct}% (${winner!.source}); staff should confirm.`,
        })
      }
    }

    members.push({
      name: e.name,
      pct: winner?.pct ?? null,
      source: winner?.source ?? "none",
      contact_id: e.contact_id,
    })
  }

  const totalPct = members.reduce((s, m) => s + (m.pct ?? 0), 0)
  const complete = missing.length === 0 && members.length > 0 && Math.abs(totalPct - 100) <= CONFLICT_TOLERANCE

  return { members, conflicts, missing, totalPct, complete }
}

/**
 * True only when ownership was actually ENTERED but doesn't add up to 100%
 * — never when it simply hasn't been entered yet. A brand-new entity (zero
 * members) or one still missing a percentage for someone is "still being set
 * up", not broken; only a stated total that's provably wrong is (2026-08-22,
 * Antonio, round-5 bug-hunter finding — a real client attested a return with
 * two members entered at 60%/60%). Getting this distinction wrong is exactly
 * what would have hard-locked a brand-new or single-member entity out of the
 * tool entirely, with no way back in — see this session's council review.
 */
export function ownershipIsBroken(o: OwnershipResolution): boolean {
  return o.members.length > 0 && o.missing.length === 0 && Math.abs(o.totalPct - 100) > CONFLICT_TOLERANCE
}

/**
 * Antonio's required message shape (2026-08-22): name the problem, every
 * member and their %, and say what to do — never a generic "something's
 * wrong". Returns null when ownership isn't broken. This is the ONE place
 * that wording is written, so gate 5 and every route that blocks on it can
 * never show a different message than the one that actually blocked them.
 */
export function describeBrokenOwnership(o: OwnershipResolution): string | null {
  if (!ownershipIsBroken(o)) return null
  const parts = o.members.map(m => `${m.name} (${m.pct}%)`).join(", ")
  return `Ownership percentages don't add up to 100% — they total ${o.totalPct}%: ${parts}. Fix the ownership before this can continue.`
}
