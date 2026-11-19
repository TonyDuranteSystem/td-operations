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

export interface BridgeGroup {
  jid: string
  name: string | null
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
    const item = raw as { jid?: unknown; name?: unknown }
    const jid = groupJidOf(typeof item.jid === "string" ? item.jid : null)
    if (!jid || seen.has(jid)) continue
    seen.add(jid)
    const name = typeof item.name === "string" ? item.name.trim().slice(0, MAX_NAME_LENGTH) : ""
    groups.push({ jid, name: name || null })
  }
  return { groups }
}
