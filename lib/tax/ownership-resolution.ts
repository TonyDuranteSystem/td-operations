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
  // Collect every distinct person across all three sources.
  type Entry = { name: string; bySource: Partial<Record<ResolvedMember["source"], number>>; contact_id: string | null }
  const entries: Entry[] = []
  const findEntry = (name: string): Entry | undefined => entries.find(e => sameName(e.name, name))

  const add = (src: ResolvedMember["source"], s: OwnershipSource, contactId?: string) => {
    let entry = findEntry(s.name)
    if (!entry) {
      entry = { name: s.name, bySource: {}, contact_id: null }
      entries.push(entry)
    }
    if (s.pct !== null && Number.isFinite(s.pct)) entry.bySource[src] = s.pct
    if (contactId) entry.contact_id = contactId
  }

  for (const k of input.priorK1s) add("prior_k1", k)
  for (const m of input.wizardMembers) add("wizard", m)
  for (const c of input.accountContacts) add("account_contacts", c, c.contact_id)

  const PRECEDENCE: ResolvedMember["source"][] = ["prior_k1", "wizard", "account_contacts"]
  const members: ResolvedMember[] = []
  const conflicts: OwnershipConflict[] = []
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
