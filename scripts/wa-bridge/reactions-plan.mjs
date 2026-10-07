// Pure decision logic for the Mac reactions reader (dev job 5962e46d, Release 1 — phone → CRM). No I/O here: reactions.mjs
// reads GOWA's own records and talks to the CRM; this file decides WHAT to report, so every rule is unit-tested
// (tests/unit/wabridge-reactions-plan.test.ts) without touching the real WhatsApp files.
//
// WhatsApp allows one reaction per person per message, so in a 1:1 chat a message has at most two sides:
//   "client" (is_from_me = 0) and "line" (is_from_me = 1, the business phone itself). The side comes from is_from_me, NEVER
//   from the JID (a client's JID can be a hidden @lid id).
//
// STATE (kept by the Mac in a small JSON file):
//   acked:  { "<messageId>|<side>": { emoji, ts } }   what the CRM has explicitly acknowledged for each reaction
//   tries:  { key: n }                                  how often an "unmatched" report was retried (message not in the CRM yet)
//   absent: { key: n }                                  consecutive scans a previously reported reaction was missing
//   triedAt: { key: epochMs }                           when an "unmatched" (add) or "held" (removal) report was last sent (retry pacing)
//   triedSig: { key: "emoji|ts" }                       WHAT was reported then — a CHANGED reaction is never held back by the pacing
//
// The CRM answers PER ITEM; an item is acknowledged only on applied / noop / stale. held (bridge unhealthy) and unmatched
// (message not saved yet) are simply reported again next scan — unmatched up to MAX_UNMATCHED_TRIES, then dropped so a reaction
// on a message the CRM will never have (old history, a group message that slipped through) cannot be re-posted forever.

export const EXPECTED_REACTION_COLUMNS = [
  "message_id", "chat_jid", "device_id", "reactor_jid", "emoji", "is_from_me", "reaction_timestamp", "created_at", "updated_at",
]

/** Scans a vanished reaction must stay missing before it counts as removed (survives a half-written read). The reader scans every ~10 s, so 6 scans keeps the same ~1 minute of patience the original once-a-minute / 2-scan rule had. */
export const ABSENT_SCANS_BEFORE_REMOVAL = 6
/** Most removals one scan may report. The program holds only a handful of reactions, so a larger number is a read problem, not real. */
export const MAX_REMOVALS_PER_SCAN = 3
/** About 40 minutes: an unmatched report is retried at most once per UNMATCHED_RETRY_MS. */
export const MAX_UNMATCHED_TRIES = 40
/** A reaction on a message the CRM does not have yet is re-reported at most this often (the loop itself scans every ~10 s). */
export const UNMATCHED_RETRY_MS = 55_000
export const MAX_ITEMS_PER_BATCH = 200
/** An EMPTY file is distrusted as a failed read for this many scans in a row (about 10 minutes at one scan every 10 s); after that it is believed — every other protection (removal guard, parent check, debounce) still applies, and a file that really emptied can never wedge the reader. */
export const MAX_EMPTY_SCANS = 60

export const emptyState = () => ({ acked: {}, tries: {}, absent: {}, emptyScans: 0, triedAt: {}, triedSig: {} })

const keyOf = (messageId, side) => `${messageId}|${side}`
const digitsOfChat = (jid) => {
  const m = /^(\d{6,15})@s\.whatsapp\.net$/.exec(typeof jid === "string" ? jid : "")
  return m ? m[1] : null
}
const toIso = (t) => {
  if (typeof t !== "string") return undefined
  const ms = Date.parse(t.includes("T") ? t : t.replace(" ", "T").replace(/(\+00:00)?$/, "Z"))
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString()
}

/**
 * Turn the raw rows (message_reactions LEFT JOIN messages) into the current picture: one entry per (message, side),
 * 1:1 phone chats only, newest write wins if the program holds two rows for the same side.
 */
export function currentReactions(rows) {
  const out = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (typeof r !== "object" || r === null) continue // a junk row is skipped, never allowed to crash the scan
    const chat = digitsOfChat(r.chat_jid)
    if (!chat || typeof r.message_id !== "string" || !r.message_id) continue
    if (typeof r.emoji !== "string" || r.emoji === "") continue // an empty emoji row is not a reaction
    const side = Number(r.is_from_me) === 1 ? "line" : "client"
    const key = keyOf(r.message_id, side)
    const prev = out.get(key)
    if (prev && String(prev.updated_at) >= String(r.updated_at)) continue
    out.set(key, {
      key, ext_id: r.message_id, chat, side, emoji: r.emoji, ts: String(r.reaction_timestamp ?? ""), updated_at: String(r.updated_at ?? ""),
    })
  }
  return out
}

/** Message ids of reactions the CRM knows about that are NOT in the current picture — the Mac checks which of these parents still exist. */
export function absentMessageIds(current, state) {
  const ids = new Set()
  for (const key of Object.keys(state.acked)) if (!current.has(key)) ids.add(key.slice(0, key.lastIndexOf("|")))
  return [...ids]
}

/**
 * Decide this scan's report.
 *  rows              raw rows from the store
 *  state             previous state (see top)
 *  existingParentIds Set of message ids (from absentMessageIds) that STILL exist in the program's messages table
 * Returns { skip, reason, items, keys, guard, nextState } — `keys[i]` is the state key of `items[i]`, used by applyResults.
 * skip = true means "treat this scan as a failed read": nothing is reported, no state moves (the beat stops so the CRM knows).
 */
export function planScan({ rows, state, existingParentIds, acceptRemovals = false, now = Date.now() }) {
  const st = { acked: { ...state.acked }, tries: { ...state.tries }, absent: { ...state.absent }, emptyScans: 0, triedAt: { ...(state.triedAt ?? {}) }, triedSig: { ...(state.triedSig ?? {}) } }
  const current = currentReactions(rows)
  const ackedCount = Object.keys(st.acked).length

  // A store that suddenly shows NOTHING while we reported reactions before is probably a failed or reset read — distrust it for a
  // while (MAX_EMPTY_SCANS), never "everything was removed" at once. After that it is believed, still behind the guards below.
  if (current.size === 0 && ackedCount > 0 && (Array.isArray(rows) ? rows.length : 0) === 0) {
    const n = (state.emptyScans ?? 0) + 1
    if (n <= MAX_EMPTY_SCANS) {
      return { skip: true, reason: `empty read while reactions were reported before (${n}/${MAX_EMPTY_SCANS})`, items: [], keys: [], guard: { tripped: false, removals: 0 }, nextState: { ...state, emptyScans: n } }
    }
  }

  const items = []
  const keys = []

  // Adds and changes: anything not acknowledged as exactly this emoji + time.
  for (const c of current.values()) {
    delete st.absent[c.key]
    const a = st.acked[c.key]
    if (a && a.emoji === c.emoji && a.ts === c.ts) continue
    // Reported before and the CRM said "I do not have that message yet": wait before asking again.
    if (st.tries[c.key] && st.triedSig[c.key] === `${c.emoji}|${c.ts}` && now - (st.triedAt[c.key] ?? 0) < UNMATCHED_RETRY_MS) continue
    const it = { ext_id: c.ext_id, chat: c.chat, side: c.side, op: "set", emoji: c.emoji }
    const iso = toIso(c.ts)
    if (iso) it.reacted_at = iso
    items.push(it)
    keys.push(c.key)
  }

  // Removals: reported before, now missing, parent message still there, missing for ABSENT_SCANS_BEFORE_REMOVAL scans in a row.
  const wantRemoval = []
  for (const key of Object.keys(st.acked)) {
    if (current.has(key)) continue
    const messageId = key.slice(0, key.lastIndexOf("|"))
    if (!existingParentIds.has(messageId)) {
      // The message itself is gone (deleted / history reset): that is not a reaction removal — forget it, report nothing.
      delete st.acked[key]; delete st.absent[key]; delete st.tries[key]
      continue
    }
    st.absent[key] = (st.absent[key] ?? 0) + 1
    // A removal the CRM HELD (bridge unhealthy) is asked again at most once per UNMATCHED_RETRY_MS, not every scan.
    if (st.absent[key] >= ABSENT_SCANS_BEFORE_REMOVAL && !(st.triedAt[key] && now - st.triedAt[key] < UNMATCHED_RETRY_MS)) wantRemoval.push(key)
  }

  const guard = { tripped: false, removals: wantRemoval.length }
  if (wantRemoval.length > 0) {
    if (wantRemoval.length > MAX_REMOVALS_PER_SCAN && !acceptRemovals) {
      guard.tripped = true // too many at once: refuse them all this scan, keep counting, a person decides
    } else {
      for (const key of wantRemoval) {
        const sep = key.lastIndexOf("|")
        const messageId = key.slice(0, sep)
        const side = key.slice(sep + 1)
        const chat = state.acked[key]?.chat ?? st.acked[key]?.chat
        if (!chat) { delete st.acked[key]; delete st.absent[key]; continue }
        items.push({ ext_id: messageId, chat, side, op: "remove" })
        keys.push(key)
      }
    }
  }

  // The chat of every acknowledged reaction is kept in state so a later removal can name it.
  for (const c of current.values()) if (st.acked[c.key]) st.acked[c.key] = { ...st.acked[c.key], chat: c.chat }

  return { skip: false, reason: null, items, keys, guard, nextState: st, current }
}

/** Split a plan into CRM-sized batches (items and keys together). */
export function toBatches(items, keys, size = MAX_ITEMS_PER_BATCH) {
  const out = []
  for (let i = 0; i < items.length; i += size) out.push({ items: items.slice(i, i + size), keys: keys.slice(i, i + size) })
  return out
}

/**
 * Fold the CRM's per-item answers into the state. results = [{ i, r }] against the batch's own item order.
 *  applied | noop | stale  → acknowledged (a removal clears the entry)
 *  held                     → not acknowledged, reported again next scan
 *  unmatched                → retried up to MAX_UNMATCHED_TRIES scans, then acknowledged-to-drop
 *  invalid                  → dropped (re-sending the same bad item can never succeed)
 */
export function applyResults({ state, plan, results, current, now = Date.now() }) {
  const st = { acked: { ...state.acked }, tries: { ...state.tries }, absent: { ...state.absent }, emptyScans: state.emptyScans ?? 0, triedAt: { ...(state.triedAt ?? {}) }, triedSig: { ...(state.triedSig ?? {}) } }
  const byIndex = new Map((results ?? []).map((x) => [x.i, x.r]))
  plan.items.forEach((item, idx) => {
    const key = plan.keys[idx]
    const r = byIndex.get(idx)
    if (item.op === "remove") {
      if (r === "applied" || r === "noop" || r === "stale" || r === "invalid") { delete st.acked[key]; delete st.absent[key]; delete st.tries[key]; delete st.triedAt[key]; delete st.triedSig[key] }
      else if (r === "held") st.triedAt[key] = now
      return
    }
    const cur = current?.get(key)
    if (r === "applied" || r === "noop" || r === "stale") {
      st.acked[key] = { emoji: item.emoji, ts: cur?.ts ?? "", chat: item.chat }
      delete st.tries[key]; delete st.triedAt[key]; delete st.triedSig[key]
    } else if (r === "unmatched") {
      st.tries[key] = (st.tries[key] ?? 0) + 1
      st.triedAt[key] = now
      st.triedSig[key] = `${item.emoji}|${cur?.ts ?? ""}`
      if (st.tries[key] >= MAX_UNMATCHED_TRIES) { st.acked[key] = { emoji: item.emoji, ts: cur?.ts ?? "", chat: item.chat }; delete st.tries[key]; delete st.triedAt[key]; delete st.triedSig[key] }
    } else if (r === "invalid") {
      st.acked[key] = { emoji: item.emoji, ts: cur?.ts ?? "", chat: item.chat }
    } // held / no answer → try again next scan
  })
  return st
}

/** The layout the reader was written for. Anything else → stop and say so (fail closed), never guess. */
export function fingerprintOk(columns) {
  const have = [...new Set(columns)].sort().join(",")
  const want = [...EXPECTED_REACTION_COLUMNS].sort().join(",")
  return have === want
}
