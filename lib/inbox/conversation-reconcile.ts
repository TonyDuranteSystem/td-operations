/**
 * Inbox conversation reconciliation — the single source of truth for what the
 * Inbox list SHOWS, given (a) the latest server payload and (b) the client's
 * optimistic overrides (delete/restore/mark-read).
 *
 * Why this exists (Luca, 2026-07-13 → council bug-investigation):
 * The Gmail list is eventually-consistent (INBOX/UNREAD label index lags
 * 30–60s) and each server refetch used to FULLY REPLACE the shown list. A
 * refetch landing mid-lag — or one where a per-thread metadata fetch failed and
 * the thread was silently dropped — returned a SHORTER list that clobbered the
 * good one, so rows blinked out then reappeared. Restored emails vanished the
 * same way (an immediate refetch hit the untrash lag).
 *
 * The fix, in one place: NEVER let a lagging/partial server payload remove a row
 * the client is optimistically showing until the server AFFIRMATIVELY agrees,
 * stably. Optimistic intents are released only on confirmed server agreement
 * (with a TTL/staleness backstop as pure garbage-collection, never the primary
 * release). Pure + deterministic so the race conditions are unit-testable
 * (the council required tests as the primary proof — a browser can't reliably
 * reproduce Gmail's index lag).
 */
import type { InboxConversation } from "@/lib/types"
import { removesFromView, viewKey, type RowAction, type InboxView, type ViewScope } from "@/lib/inbox/view-query"

/** Server payload shape, extended with completeness signals (see the route). */
export interface ConversationsPayload {
  conversations: InboxConversation[]
  /**
   * Thread ids that ARE in the mailbox this round but whose metadata fetch
   * FAILED (rate-limit/timeout). Their absence from `conversations` means
   * "couldn't load", NOT "left the inbox" — so a hidden/pinned override must
   * NOT be released on their absence, and the client renders a stub row.
   */
  unenrichedIds?: string[]
  /**
   * The whole list is incomplete (e.g. a pagination page failed). When true, NO
   * absence is an affirmative removal — freeze all override releases this round.
   */
  partial?: boolean
}

export type OverrideKind = "hidden" | "pinned"

/** A delete (`hidden`) or restore (`pinned`) optimistic intent for one row.
 *
 *  Two different questions, two different fields — do not collapse them:
 *
 *  - **APPLY** ("is this override true in the list on screen?") is answered by
 *    `action` for a hide: it is a NEGATIVE claim, derivable from what we DID, and
 *    true in every view whose query the action removes the row from. A trash in
 *    the Inbox correctly hides the row in Starred too.
 *    For a pin, APPLY is answered by `originView`: a pin is a POSITIVE claim
 *    ("this row IS in this list") that the action cannot support (the snapshot
 *    carries no label set), so it holds ONLY in the list that produced it.
 *    Action-keying a pin would inject a never-starred email into Starred.
 *
 *  - **JUDGE** ("may this payload advance/release the override?") is answered by
 *    `originView` for BOTH kinds. Releasing needs the positive fact "this list
 *    would otherwise contain this row", and only the origin payload has it.
 *    `action` never carried that evidence: it answers "would the action remove the
 *    row IF it were here", which is not "it was here and now isn't". Reading it as
 *    the latter released a hide from a list the row was never in — Luca could
 *    bulk-delete in the Inbox, glance at a folder, and watch all 12 come back
 *    (council, 2026-07-16).
 *
 *  So: `action` = the claim; `originView` = the witness. */
export interface RowOverride {
  kind: OverrideKind
  /** The conversation this override is about. Carried ON the entry because the
   *  map is keyed by (id + originView) — one email can hold two overrides at once
   *  (a Restore hides it from Trash AND pins it into its destination). The key is
   *  OPAQUE: never parse the id back out of it. `viewKey` embeds raw search text,
   *  so a search for `a|b` would make any separator ambiguous and hand you the
   *  wrong id — which is a hide applied to the wrong email (council, 2026-07-16). */
  id: string
  /** `hidden` only — WHAT was done, so each view can decide whether it APPLIES. */
  action?: RowAction
  /** BOTH kinds — the `viewKey` of the list this override is a claim about. The
   *  only payload allowed to JUDGE it; for a pin, also the only list it applies
   *  in. (For a pin this reads better as "targetView": a Restore pins the row
   *  into its DESTINATION, which is not where the override was born.) */
  originView?: string
  /** For `pinned` (and as a fallback for `hidden`): last-known full row, so a
   *  restored email stays visible while Gmail re-indexes the untrash. */
  snapshot?: InboxConversation
  createdAt: number
  /** Consecutive server payloads that met this override's release condition. */
  agree: number
  /** Consecutive server payloads that AFFIRMATIVELY contradicted a pin (thread
   *  absent though the payload was complete) — restore-then-deleted-elsewhere. */
  disagree: number
  /** Set when released; a short tombstone suppresses one Gmail non-monotonic
   *  re-appearance cycle before the id is forgotten. */
  releasedAt?: number
}

/** Optimistic unread value for one row (separate lifecycle from hide/pin). */
export interface UnreadOverride {
  /** The value we optimistically wrote (0 for mark-read, ≥1 for mark-unread). */
  value: number
  /** The server's unread value at action time. We release the override once the
   *  server moves OFF this baseline (caught up to `value`, or genuine new
   *  activity) — never while it's still lagging AT the baseline. */
  baseline: number
  createdAt: number
}

export interface ReconcileConfig {
  /** GC backstop for hide/pin overrides (default 5 min). Never the primary release. */
  ttlMs: number
  /** GC backstop for unread overrides (default 5 min). */
  unreadTtlMs: number
  /** Consecutive agreeing complete payloads before a hide/pin releases. */
  stability: number
  /** After a `hidden` release, ignore a re-appearance of that id for this long. */
  tombstoneMs: number
  /** A `pinned` row the server keeps (completely) omitting is dropped after this. */
  stalePinMs: number
}

export const DEFAULT_RECONCILE_CONFIG: ReconcileConfig = {
  ttlMs: 5 * 60_000,
  unreadTtlMs: 5 * 60_000,
  stability: 2,
  tombstoneMs: 90_000,
  stalePinMs: 3 * 60_000,
}

const GMAIL_PREFIX = "gmail:"

/** True when the payload can be trusted to AFFIRMATIVELY exclude `id` (i.e. the
 *  thread genuinely left the inbox), vs. merely failing to load it this round. */
function affirmativelyAbsent(id: string, present: Set<string>, unenriched: Set<string>, partial: boolean): boolean {
  if (partial) return false
  if (present.has(id)) return false
  if (unenriched.has(id)) return false
  return true
}

/** Which list a payload was fetched for. STAMPED AT THE FETCH, never inferred:
 *  the reconcile is given the payload's own identity, not the app's current one.
 *
 *  Why this exists: `useQuery` keeps showing the previous list while a new one
 *  loads (`keepPreviousData`), and serves a cached list for a view instantly. So
 *  "the view the user is on" and "the view this payload came from" are routinely
 *  DIFFERENT — and every hole the council found on 2026-07-16 was an instance of
 *  judging one list's rows against another list's rules. Carrying the origin on
 *  the payload makes that state unrepresentable rather than merely guarded. */
export interface PayloadOrigin {
  view: InboxView
  scope: ViewScope
}

export interface ReconcileInput {
  payload: ConversationsPayload
  /** The list THIS payload came from. Everything is decided against it: which
   *  overrides apply to these rows, and which of them this payload may judge. */
  origin: PayloadOrigin
  /** Current hide/pin overrides, keyed by conversation id. */
  overrides: Map<string, RowOverride>
  /** Current unread overrides, keyed by conversation id. */
  unread: Map<string, UnreadOverride>
  /** Previously-shown enriched rows (id → row) — used to carry a row forward
   *  when the server couldn't enrich it this round (prefer real data over a stub). */
  prev: Map<string, InboxConversation>
  now: number
  config?: Partial<ReconcileConfig>
}

export interface ReconcileResult {
  /** The rows to render (already merged; hidden rows removed; pins kept). */
  visible: InboxConversation[]
  /** Updated hide/pin overrides (releases applied). */
  overrides: Map<string, RowOverride>
  /** Updated unread overrides (releases applied). */
  unread: Map<string, UnreadOverride>
}

/**
 * The single reconcile pass = advance releases (once per new server payload)
 * THEN build the visible list. Kept as one call for tests; the component splits
 * these so `computeVisibleList` can re-run on every render without advancing the
 * release counters (which must move exactly once per payload).
 */
export function reconcileConversations(input: ReconcileInput): ReconcileResult {
  const { overrides, unread } = advanceReleases(input)
  const visible = computeVisibleList({ ...input, overrides, unread })
  return { visible, overrides, unread }
}

/** Advance + release the hide/pin/unread overrides against ONE server payload.
 *  Call this exactly once per new payload (over-calling double-counts and
 *  releases too early). Returns the updated maps. */
export function advanceReleases(input: ReconcileInput): {
  overrides: Map<string, RowOverride>
  unread: Map<string, UnreadOverride>
} {
  const cfg = { ...DEFAULT_RECONCILE_CONFIG, ...(input.config ?? {}) }
  const { payload, now } = input
  const partial = payload.partial === true
  const serverRows = payload.conversations ?? []
  const present = new Set(serverRows.map((c) => c.id))
  const unenriched = new Set((payload.unenrichedIds ?? []).map((id) => (id.startsWith(GMAIL_PREFIX) ? id : `${GMAIL_PREFIX}${id}`)))

  const nextOverrides = new Map<string, RowOverride>()
  const nextUnread = new Map<string, UnreadOverride>()
  const payloadView = viewKey(input.origin.view, input.origin.scope)

  // ── 1. Advance / release hide & pin overrides ──────────────────────────
  // `key` is OPAQUE (id + originView) — the row is always `ov.id`. One email can
  // hold two entries here: a Restore hides it from Trash and pins it into its
  // destination, and each is judged only by its own list.
  for (const [key, ov] of Array.from(input.overrides)) {
    const id = ov.id
    // Tombstone phase: already released, just suppressing re-appearance briefly.
    if (ov.releasedAt != null) {
      if (now - ov.releasedAt <= cfg.tombstoneMs) {
        nextOverrides.set(key, ov) // keep suppressing (hidden) for one more cycle
      }
      continue
    }

    // GC backstop: an override the server never confirmed within the TTL.
    // A HIDE must not simply vanish here — dropping it bare lets the row pop
    // straight back if Gmail is still lagging, which is the whole bug. Retire it
    // THROUGH the tombstone instead, so the release is always monotone. This is
    // the normal end for a hide no payload can confirm: archive-from-a-folder
    // legitimately leaves the row in that list, so no view can ever witness it.
    if (now - ov.createdAt > cfg.ttlMs) {
      if (ov.kind === "hidden") nextOverrides.set(key, { ...ov, releasedAt: now })
      continue // a pin just expires — the row is real, the server owns it now
    }

    // Only the list an override was BORN in may judge it. Absence from any other
    // list is not evidence: the row was never there to leave. Everything else is
    // carried forward UNTOUCHED — never advanced, never dropped.
    if (ov.originView !== payloadView) {
      nextOverrides.set(key, ov)
      continue
    }

    if (ov.kind === "hidden") {
      // Release a delete only when the server AFFIRMATIVELY no longer has it,
      // stable across `stability` complete payloads. Then tombstone briefly.
      if (affirmativelyAbsent(id, present, unenriched, partial)) {
        const agree = ov.agree + 1
        if (agree >= cfg.stability) {
          nextOverrides.set(key, { ...ov, agree, releasedAt: now })
        } else {
          nextOverrides.set(key, { ...ov, agree })
        }
      } else {
        // Still present / unenriched / partial → NOT confirmed gone; hold hide.
        nextOverrides.set(key, { ...ov, agree: 0 })
      }
    } else {
      // pinned (restored): release once the server AFFIRMATIVELY contains it,
      // stable. If the server AFFIRMATIVELY lacks it (complete payload) for a
      // sustained window, it was deleted elsewhere → drop the pin.
      if (present.has(id)) {
        const agree = ov.agree + 1
        if (agree >= cfg.stability) {
          // Confirmed back — release the pin (row now comes from the server).
          continue
        }
        nextOverrides.set(key, { ...ov, agree, disagree: 0 })
      } else if (affirmativelyAbsent(id, present, unenriched, partial)) {
        const disagree = ov.disagree + 1
        // Deleted-elsewhere: sustained affirmative absence past the stale cap.
        if (disagree >= cfg.stability && now - ov.createdAt > cfg.stalePinMs) {
          continue // drop the pin — it's genuinely gone
        }
        nextOverrides.set(key, { ...ov, agree: 0, disagree })
      } else {
        // Unenriched or partial → unknown; keep the pin, reset both counters.
        nextOverrides.set(key, { ...ov, agree: 0, disagree: 0 })
      }
    }
  }

  // ── 2. Advance / release unread overrides ──────────────────────────────
  const serverById = new Map(serverRows.map((c) => [c.id, c]))
  for (const [id, uo] of Array.from(input.unread)) {
    if (now - uo.createdAt > cfg.unreadTtlMs) continue // GC backstop
    const serverRow = serverById.get(id)
    // Keep the override until the server's unread value MOVES OFF the baseline
    // (the value it had at action time). While it lags AT the baseline we hold
    // the optimistic value; once it changes (caught up, or new activity) the
    // server is authoritative and we release.
    if (serverRow && serverRow.unread !== uo.baseline) {
      continue // released — server moved off baseline
    }
    // Not in this payload (unenriched/partial) OR still at baseline → hold.
    nextUnread.set(id, uo)
  }

  return { overrides: nextOverrides, unread: nextUnread }
}

/** Build the rows to render from a payload + the (already-advanced) overrides.
 *  Pure and side-effect-free — safe to call on every render. */
export function computeVisibleList(input: ReconcileInput): InboxConversation[] {
  const { payload } = input
  const serverRows = payload.conversations ?? []
  const unenriched = new Set((payload.unenrichedIds ?? []).map((id) => (id.startsWith(GMAIL_PREFIX) ? id : `${GMAIL_PREFIX}${id}`)))
  const nextOverrides = input.overrides
  const nextUnread = input.unread

  const payloadView = viewKey(input.origin.view, input.origin.scope)

  // Apply a hide ONLY in views whose query the action actually removes the row
  // from — judged against the view THIS payload came from, since these are its
  // rows. This is the SINGLE place the predicate is applied, so tombstoned ids
  // inherit it — otherwise a hide released+tombstoned in the Inbox would keep
  // re-hiding the row in Trash for the whole tombstone window.
  const hidden = new Set<string>()
  for (const ov of Array.from(nextOverrides.values())) {
    if (ov.kind === "hidden" && removesFromView(ov.action ?? "trash", input.origin.view)) {
      hidden.add(ov.id) // includes tombstoned ids
    }
  }

  const visible: InboxConversation[] = []
  const seen = new Set<string>()

  for (const row of serverRows) {
    if (hidden.has(row.id)) continue
    const uo = nextUnread.get(row.id)
    visible.push(uo ? { ...row, unread: uo.value } : row)
    seen.add(row.id)
  }

  // Carry forward rows the server DIDN'T enrich this round (present-but-failed):
  // prefer the previously-shown real row; else a marked stub so it's never hidden.
  for (const id of Array.from(unenriched)) {
    if (seen.has(id) || hidden.has(id)) continue
    const prevRow = input.prev.get(id)
    if (prevRow) {
      const uo = nextUnread.get(id)
      visible.push(uo ? { ...prevRow, unread: uo.value } : prevRow)
      seen.add(id)
    } else {
      visible.push(makeStub(id))
      seen.add(id)
    }
  }

  // Inject pinned (restored) rows the server hasn't caught up to yet — ONLY in
  // the view that produced the snapshot. A pin asserts "this row belongs in THIS
  // list"; we have no evidence for that anywhere else, and injecting it would
  // render the row into a list it may not belong to (a never-starred email
  // appearing in Starred after an Undo).
  // A pin whose row is ALSO hidden here loses: the hide is the newer, explicit
  // intent (delete-then-restore-then-delete-again), and showing a row the user
  // just deleted is the worse failure.
  for (const ov of Array.from(nextOverrides.values())) {
    if (ov.kind !== "pinned" || ov.originView !== payloadView) continue
    if (seen.has(ov.id) || hidden.has(ov.id)) continue
    const row = ov.snapshot ?? input.prev.get(ov.id)
    if (row) {
      visible.push(row)
      seen.add(ov.id)
    }
  }

  // PINNED (starred) first in folder views — the client-side mirror of
  // inbox_thread_page's ORDER BY (dev job 76b521ea). Without this the merge
  // re-sorted purely by date and un-floated what the server just floated.
  // Search / archived / trash stay chronological BY DESIGN (a pin is a
  // work-queue marker for the lists you triage, not a global re-ordering).
  const pinBand = input.origin.view.kind === "inbox" || input.origin.view.kind === "label"
  visible.sort((a, b) => {
    if (pinBand) {
      const s = (b.starred ? 1 : 0) - (a.starred ? 1 : 0)
      if (s !== 0) return s
    }
    return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  })

  return visible
}

/** A placeholder row for a thread the server couldn't enrich — shown, never
 *  hidden, and visibly marked so it can't masquerade as a fully-loaded email. */
export function makeStub(id: string): InboxConversation {
  return {
    id,
    channel: "gmail",
    name: "Loading…",
    preview: "Couldn't load this email — retrying.",
    unread: 0,
    lastMessageAt: new Date(0).toISOString(),
    subject: "",
    accountId: null,
    accountName: null,
    hasAttachment: false,
    colorMark: null,
    partial: true,
  }
}

// ── Override constructors (used by the shell's mutation handlers) ──────────

/**
 * The map key for an override: the row + the list the claim is about.
 *
 * OPAQUE — never parse it. The id lives on the entry (`ov.id`). `viewKey` embeds
 * raw search text, so any separator can appear inside it and splitting would hand
 * back a wrong id — i.e. a hide applied to an email the user never touched.
 */
export function overrideKey(id: string, view: string): string {
  return `${id}\u0000${view}`
}

/** A delete/archive/untrash intent — the row is GONE from every view this action
 *  removes it from.
 *  `action` makes the hide portable across views — always pass the real one
 *  ('archive' hides ONLY in inbox-scoped views; 'trash' hides everywhere but
 *  Trash; 'untrash' removes it from Trash alone).
 *  `originView` is the list it was done in — the ONLY one allowed to confirm it.
 *  The snapshot lets a later Undo pin the exact row back. */
export function makeHiddenOverride(now: number, id: string, action: RowAction, originView: string, snapshot?: InboxConversation): RowOverride {
  return { kind: "hidden", id, action, originView, snapshot, createdAt: now, agree: 0, disagree: 0 }
}

/** `originView` (a `viewKey`) is REQUIRED: a pin only holds in the ONE list it
 *  claims the row is in — for a Restore that is the DESTINATION, not where the
 *  action happened. */
export function makePinnedOverride(now: number, id: string, originView: string, snapshot?: InboxConversation): RowOverride {
  return { kind: "pinned", id, originView, snapshot, createdAt: now, agree: 0, disagree: 0 }
}

/**
 * Move a row between two lists — the shape of BOTH "Restore from Trash" and the
 * Undo of a delete (a trash IS a move to Trash).
 *
 * A move is not a new kind of override: it is the two we already have, emitted
 * together. The row LEAVES `from` (a hide, witnessed by `from`'s payload) and
 * APPEARS in `to` (a pin, witnessed by `to`'s payload). Each half has exactly one
 * witness, and each releases on its own clock — which is correct: Trash and the
 * Inbox catch up at different times and there is no reason to couple them. A
 * single entry spanning two views would need two agree counters, two tombstones
 * and a "half-released" state — two overrides wearing one struct (council,
 * 2026-07-16: "if your plan grows a third override kind, you have taken a wrong
 * turn").
 *
 * `to` may be null when the destination isn't a list we can name (e.g. restoring
 * while the destination view was never loaded) — then only the hide is emitted
 * and the row simply appears when the server catches up.
 */
export function makeMoveOverrides(args: {
  now: number
  id: string
  action: RowAction
  from: string
  to: string | null
  snapshot?: InboxConversation
}): Array<[string, RowOverride]> {
  const { now, id, action, from, to, snapshot } = args
  const out: Array<[string, RowOverride]> = [
    [overrideKey(id, from), makeHiddenOverride(now, id, action, from, snapshot)],
  ]
  if (to && to !== from) {
    out.push([overrideKey(id, to), makePinnedOverride(now, id, to, snapshot)])
  }
  return out
}

/** Shallow-equal check for two override maps — lets the client skip a state
 *  write (and the render it triggers) when a reconcile released nothing.
 *
 *  Compares EVERY decision-bearing field, including `action`/`originView` which
 *  `advanceReleases` never touches. Those two are what "equal" would quietly lie
 *  about: the same id can legitimately be re-stamped with a different origin (a
 *  row deleted, restored, then deleted again from another list), and a caller that
 *  skipped the write would keep the stale claim. Cheap; do not narrow it back to
 *  "the fields the reconcile happens to mutate today". */
export function overrideMapsEqual(a: Map<string, RowOverride>, b: Map<string, RowOverride>): boolean {
  if (a.size !== b.size) return false
  for (const [id, ov] of Array.from(a)) {
    const o = b.get(id)
    if (
      !o ||
      o.kind !== ov.kind ||
      o.agree !== ov.agree ||
      o.disagree !== ov.disagree ||
      o.releasedAt !== ov.releasedAt ||
      o.action !== ov.action ||
      o.originView !== ov.originView
    ) {
      return false
    }
  }
  return true
}

export function unreadMapsEqual(a: Map<string, UnreadOverride>, b: Map<string, UnreadOverride>): boolean {
  if (a.size !== b.size) return false
  for (const [id, uo] of Array.from(a)) {
    const o = b.get(id)
    if (!o || o.value !== uo.value || o.baseline !== uo.baseline) return false
  }
  return true
}

export function makeUnreadOverride(value: number, baseline: number, now: number): UnreadOverride {
  return { value, baseline, createdAt: now }
}
