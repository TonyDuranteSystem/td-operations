/**
 * The change feed for the Mac app (dev job 1992a087). The log itself is written by DATABASE TRIGGERS on the store tables and on
 * the CRM rows that decide an owner's name and group (migration 20261017-0100), so no code path — the CRM, an import, the Drive
 * pickup job, a purge — can change what Finder shows without leaving a row. Here we only READ it and decide what THIS login may be told.
 *
 * Cursor = "<txid>.<seq>" (opaque to the app). A late-committing row can never fall behind a cursor already handed out.
 */
import type { User } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isOwnerOnly } from "@/lib/auth"
import { mayOpenPrivateArea, ownersAreaUserId } from "@/lib/crm-store/structure"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export interface Cursor { txid: string; seq: number }
export interface AppChange {
  kind: "file" | "folder" | "owner"; id: string; op: "upsert" | "delete"
  ownerId: string | null; parentId: string | null; oldOwnerId: string | null; oldParentId: string | null; name: string | null
}
export interface ChangesPage { changes: AppChange[]; cursor: string | null; resync: boolean; hasMore: boolean }

export function parseCursor(s: unknown): Cursor | null {
  if (typeof s !== "string") return null
  const m = /^(\d{1,20})\.(\d{1,20})$/.exec(s)
  return m ? { txid: m[1], seq: Number(m[2]) } : null
}
export const formatCursor = (c: Cursor): string => `${c.txid}.${c.seq}`

export type Row = { seq: number | string; txid: string; item_kind: AppChange["kind"]; item_id: string; op: AppChange["op"]
  owner_id: string | null; parent_id: string | null; old_owner_id: string | null; old_parent_id: string | null; name: string | null; resync: boolean }

/** The newest safe cursor — a device that has just listed everything starts here. null = the log is empty. */
export async function changesHead(): Promise<string | null> {
  const { data, error } = await db().rpc("store_changes_head")
  if (error) throw new Error(`Could not read the change log (${error.message}).`)
  const r = (data ?? [])[0] as { txid: string; seq: number | string } | undefined
  return r ? formatCursor({ txid: r.txid, seq: Number(r.seq) }) : null
}

async function ownerFacts(ids: string[]): Promise<Map<string, OwnerFacts>> {
  const out = new Map<string, OwnerFacts>()
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await db().from("store_owners").select("id, kind, private_user_id, study_only").in("id", ids.slice(i, i + 150))
    if (error) throw new Error(`Could not read the storages (${error.message}).`)
    for (const o of (data ?? []) as Array<{ id: string; kind: string; private_user_id: string | null; study_only: boolean }>) out.set(o.id, o)
  }
  return out
}

export type OwnerFacts = { kind: string; private_user_id: string | null; study_only: boolean }

/**
 * PURE: what THIS login may be told.
 *  - Someone else's private area is never mentioned at all (not even its ids in a move).
 *  - A hidden study copy (or an unknown storage) never gets an upsert, but a DELETE is still delivered — without a name — so Finder drops
 *    whatever it was showing when a storage goes hidden or an item leaves.
 *  - A file or folder MOVED out of a place this login could see into one it cannot (a private area, a hidden storage) is delivered as a
 *    DELETE at the old place — otherwise Finder would keep a ghost there.
 *  - CONTRACT for the app: an `owner` upsert means "this storage appeared or changed — list it again from the top". Things written to a
 *    storage while it was hidden were (rightly) not delivered, so the full listing is how they arrive when it goes live.
 */
export function filterChanges(rows: Row[], owners: Map<string, OwnerFacts>, login: { id: string | null; ownerOnly: boolean }, ownersArea: string | null): AppChange[] {
  const mayPrivate = (o: OwnerFacts) => o.kind !== "private" || mayOpenPrivateArea(o.private_user_id, login, ownersArea)
  const seen = (o: OwnerFacts | undefined) => !!o && o.study_only === false && mayPrivate(o)
  const out: AppChange[] = []
  for (const r of rows) {
    const o = r.owner_id ? owners.get(r.owner_id) : undefined
    const old = r.old_owner_id ? owners.get(r.old_owner_id) : undefined
    const goneFromOld = (): AppChange => ({
      kind: r.item_kind, id: r.item_id, op: "delete", ownerId: r.old_owner_id ?? r.owner_id, parentId: r.old_parent_id ?? r.parent_id,
      oldOwnerId: null, oldParentId: null, name: null,
    })
    if (o && !mayPrivate(o)) {                                  // lands in someone else's private area
      if (r.op === "upsert" && seen(old)) out.push(goneFromOld())
      continue
    }
    const visible = seen(o)
    if (r.op === "upsert" && !visible) {                        // lands in a hidden / unknown storage
      if (seen(old)) out.push(goneFromOld())
      continue
    }
    const oldIdsOk = !old || mayPrivate(old)                    // never hand out ids from inside someone else's private area
    out.push({
      kind: r.item_kind, id: r.item_id, op: r.op, ownerId: r.owner_id, parentId: r.parent_id,
      oldOwnerId: oldIdsOk ? r.old_owner_id : null, oldParentId: oldIdsOk ? r.old_parent_id : null, name: visible ? r.name : null,
    })
  }
  return out
}

export async function changesSince(user: User, after: Cursor | null, limit = 500): Promise<ChangesPage> {
  const { data, error } = await db().rpc("store_changes_since", { p_after_txid: after ? after.txid : null, p_after_seq: after ? after.seq : 0, p_limit: limit })
  if (error) throw new Error(`Could not read the change log (${error.message}).`)
  const rows = (data ?? []) as Row[]
  if (rows.length === 1 && rows[0].resync) return { changes: [], cursor: null, resync: true, hasMore: false }
  const ids = Array.from(new Set(rows.flatMap((r) => [r.owner_id, r.old_owner_id]).filter((x): x is string => !!x)))
  const owners = await ownerFacts(ids)
  const login = { id: user.id, ownerOnly: isOwnerOnly(user) }
  const ownersArea = login.ownerOnly ? await ownersAreaUserId() : null
  const changes = filterChanges(rows, owners, login, ownersArea)
  const last = rows[rows.length - 1]
  const cursor = last ? formatCursor({ txid: last.txid, seq: Number(last.seq) }) : after ? formatCursor(after) : null
  return { changes, cursor, resync: false, hasMore: rows.length >= Math.max(1, Math.min(limit, 2000)) }
}

export interface WaitDeps {
  read: (after: Cursor | null) => Promise<ChangesPage>
  sleep: (ms: number) => Promise<void>
  now: () => number
  aborted: () => boolean
}
export const WAIT_TICK_MS = 1500

/**
 * "Tell me when something changes" (2026-10-28, Antonio: like Drive / Dropbox). Answers AT ONCE when there is anything to say (a change this login may
 * see, or a `resync`); otherwise keeps asking the log every WAIT_TICK_MS until something shows up, the wait is over, or the Mac hung up.
 * `waitMs` 0 = the plain answer. Rows this login may not see still move the cursor on (so they are not read again on every tick).
 */
export async function changesWaiting(after: Cursor | null, waitMs: number, deps: WaitDeps): Promise<ChangesPage> {
  const deadline = deps.now() + Math.max(0, waitMs)
  let from = after
  let page = await deps.read(from)
  while (waitMs > 0 && !page.resync && page.changes.length === 0 && !deps.aborted()) {
    const left = deadline - deps.now()
    if (left <= 0) break
    if (page.cursor) from = parseCursor(page.cursor) ?? from
    await deps.sleep(Math.min(WAIT_TICK_MS, left))
    page = await deps.read(from)
  }
  return page
}
