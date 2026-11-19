/**
 * The phone's WhatsApp GROUPS, as the Mac reports them (`bridge.groups`): one `{ jid, name }` per group.
 *
 * Pure parsing only — the receiver route verifies the signature and then hands the clean list to the
 * `wabridge_apply_groups` database function. A group a client creates (or adds us to) therefore shows up
 * in the Inbox within a minute, before anyone has written in it.
 */
import { groupJidOf, isFreshTs } from "@/lib/messaging/wabridge"

export const MAX_GROUP_ITEMS = 500
const MAX_NAME_LENGTH = 200

/** One person in a group, as the phone lists them. `phone` is null when WhatsApp hides the number behind a linked id. */
export interface GroupMember {
  phone: string | null
  name: string | null
  admin: boolean
}

export interface BridgeGroup {
  jid: string
  name: string | null
  /** The group's members. Absent (undefined) = the Mac did not report them (older script); the stored list is then left alone. */
  members?: GroupMember[]
}

export const MAX_GROUP_MEMBERS = 300

/** Keeps only well-formed members: a real-looking number (or none), a short name, a plain admin flag; drops repeats of the same number. */
export function normalizeMembers(raw: unknown): GroupMember[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: GroupMember[] = []
  const seen = new Set<string>()
  for (const m of raw.slice(0, MAX_GROUP_MEMBERS)) {
    if (typeof m !== "object" || m === null) continue
    const item = m as { phone?: unknown; name?: unknown; admin?: unknown }
    const digits = typeof item.phone === "string" ? item.phone.replace(/\D/g, "") : ""
    const phone = digits.length >= 6 && digits.length <= 15 ? digits : null
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 120) : ""
    if (phone) {
      if (seen.has(phone)) continue
      seen.add(phone)
    } else if (!name) {
      continue // nothing to show for this member
    }
    out.push({ phone, name: name || null, admin: item.admin === true })
  }
  return out
}

export function parseGroupsBatch(body: unknown, now: Date): { groups: BridgeGroup[] } | { error: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as { ts?: unknown; groups?: unknown }
  if (!isFreshTs(b.ts, now, 10 * 60_000) || !Array.isArray(b.groups) || b.groups.length > MAX_GROUP_ITEMS) {
    return { error: "Invalid groups batch" }
  }
  const seen = new Set<string>()
  const groups: BridgeGroup[] = []
  for (const raw of b.groups) {
    if (typeof raw !== "object" || raw === null) continue
    const item = raw as { jid?: unknown; name?: unknown; members?: unknown }
    const jid = groupJidOf(typeof item.jid === "string" ? item.jid : null)
    if (!jid || seen.has(jid)) continue
    seen.add(jid)
    const name = typeof item.name === "string" ? item.name.trim().slice(0, MAX_NAME_LENGTH) : ""
    const members = normalizeMembers(item.members)
    groups.push({ jid, name: name || null, ...(members ? { members } : {}) })
  }
  return { groups }
}
