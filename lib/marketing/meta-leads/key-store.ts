/**
 * Where the Facebook Page key lives (server; TD Marketing, dev job 9aec66fa). The "Connect Meta" button saves it ENCRYPTED in the database
 * (table marketing_meta_connection); the lead intake reads it from there and falls back to the Vercel setting when there is nothing stored
 * (or it can no longer be decrypted, for example after the app secret was changed). The database handle is injected so every branch is tested.
 */
import { decryptPageKey, encryptPageKey } from "@/lib/marketing/meta-leads/key-crypto"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the marketing tables are newer than the generated types
export type KeyDb = { from: (t: string) => any }

export interface StoredConnection {
  pageId: string
  pageName: string | null
  userId: string | null
  userName: string | null
  longLived: boolean
  connectedBy: string | null
  obtainedAt: string
  /** false when the stored key could not be decrypted (the app secret changed): the admin must connect again. */
  readable: boolean
}

export interface StoredKey { pageId: string; key: string }

const COLS = "page_id, page_name, page_key_enc, user_id, user_name, long_lived, connected_by, obtained_at"

/** Every stored connection, WITHOUT the keys (for the admin screen). */
export async function listConnections(db: KeyDb, appSecret: string | null | undefined): Promise<StoredConnection[]> {
  const { data, error } = await db.from("marketing_meta_connection").select(COLS).order("obtained_at", { ascending: false })
  if (error || !Array.isArray(data)) return []
  return data.map((r: Record<string, unknown>) => ({
    pageId: String(r.page_id), pageName: (r.page_name as string) ?? null, userId: (r.user_id as string) ?? null, userName: (r.user_name as string) ?? null,
    longLived: r.long_lived === true, connectedBy: (r.connected_by as string) ?? null, obtainedAt: String(r.obtained_at),
    readable: decryptPageKey(r.page_key_enc as string, appSecret) !== null,
  }))
}

/** The stored key for one Page, or the only stored key when no Page is named. null = nothing usable (the caller falls back to Vercel). Never throws. */
export async function readStoredKey(db: KeyDb, appSecret: string | null | undefined, pageId?: string | null): Promise<StoredKey | null> {
  try {
    const q = db.from("marketing_meta_connection").select("page_id, page_key_enc")
    const { data, error } = pageId ? await q.eq("page_id", pageId) : await q.order("obtained_at", { ascending: false }).limit(2)
    if (error || !Array.isArray(data) || data.length === 0) return null
    if (!pageId && data.length > 1) return null // several Pages and none named: never guess
    const row = data[0] as { page_id: string; page_key_enc: string }
    const key = decryptPageKey(row.page_key_enc, appSecret)
    return key ? { pageId: String(row.page_id), key } : null
  } catch {
    return null
  }
}

export interface SaveInput {
  pageId: string
  pageName: string | null
  key: string
  userId: string | null
  userName: string | null
  longLived: boolean
  connectedBy: string
}

/** Save (or replace) the key for one Page. Returns an error message in plain words, or null when saved. */
export async function saveStoredKey(db: KeyDb, appSecret: string | null | undefined, i: SaveInput, now: Date = new Date()): Promise<string | null> {
  let enc: string
  try { enc = encryptPageKey(i.key, appSecret) } catch (e) { return e instanceof Error ? e.message : "the key could not be encrypted" }
  const row = {
    page_id: i.pageId, page_name: i.pageName, page_key_enc: enc, user_id: i.userId, user_name: i.userName,
    long_lived: i.longLived, connected_by: i.connectedBy, obtained_at: now.toISOString(), updated_at: now.toISOString(),
  }
  const existing = await db.from("marketing_meta_connection").select("page_id").eq("page_id", i.pageId).maybeSingle()
  if (existing.error) return /does not exist|relation|schema cache/i.test(existing.error.message ?? "") ? "The database table for the connection does not exist yet. Run the SQL for it first." : "The key could not be saved."
  const write = existing.data ? await db.from("marketing_meta_connection").update(row).eq("page_id", i.pageId) : await db.from("marketing_meta_connection").insert(row)
  return write.error ? "The key could not be saved." : null
}
