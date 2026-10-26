/**
 * CRM Store — "save a REPLACEMENT file when the original is locked" (dev job bd21e833 follow-up).
 *
 * A file that is signed / a passport or ID / replaced / amended takes no new current version (database trigger
 * `store_files_version_lock`). A flow that produces a new copy of such a document (a re-scanned passport, a regenerated lease PDF, a
 * re-signed SS-4) must NEVER lose the new copy and must not reach for the lock error as a failure. The rule here:
 *   1. try the normal save under the usual caller key (a first save, a retry, a same-bytes re-save all land here);
 *   2. if the store refuses because the file is locked, find the NEWEST live file in the replacement chain of that caller key;
 *      - same bytes as that newest file → nothing to do ("unchanged");
 *      - different bytes → save the new copy as a NEW file under `<key>:<sha8>`, marked as the replacement of the newest file
 *        (`supersedes`): the old copy stays untouched, the new one is the current one, a retry of the same bytes is "unchanged".
 * Pure helpers (key, name) and the chain lookup are separate so they are unit-tested without a database.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { sha256Hex, type WriteResult } from "./writer"
import { isLockRefusal } from "./lock-errors"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export interface ChainHead { ownerId?: string | null; fileId: string; versionId: string | null; sha256: string | null; name: string; live: boolean; documentType?: string | null; periodYear?: number | null }

export interface ReplacementDeps {
  /** the newest file of the replacement chain that starts at the file saved under `callerKey` (null = no such file) */
  chainHead: (callerKey: string) => Promise<ChainHead | null>
  /** after a replacement was saved: hide the replaced file from the client (its CRM row stays, for history) */
  retire?: (replacedFileId: string) => Promise<void>
}

/** Longest replacement chain followed (a guard against a loop in the data, not a limit anyone should meet). */
export const MAX_CHAIN_HOPS = 200

/** Follow `next` from `start` to the END of the chain; a visited set stops a cycle, the cap stops anything else. */
export async function walkChainToEnd(start: string, next: (id: string) => Promise<string | null>, cap: number = MAX_CHAIN_HOPS): Promise<string> {
  const seen = new Set<string>([start])
  let cur = start
  for (let hop = 0; hop < cap; hop++) {
    const n = await next(cur)
    if (!n || seen.has(n)) break
    seen.add(n)
    cur = n
  }
  return cur
}

/** The caller key of a replacement copy: the original key plus the first 8 characters of its SHA-256. */
export function replacementKey(baseKey: string, sha256: string): string {
  return `${baseKey}:${sha256.slice(0, 8)}`
}

/** "passport.pdf" → "passport (replaced 2026-10-25).pdf" (the store adds " (2)" on a name clash). */
export function replacementName(name: string, now: Date = new Date()): string {
  const m = /(\.[A-Za-z0-9]{1,10})$/.exec(name)
  const ext = m ? m[1] : ""
  const base = ext ? name.slice(0, name.length - ext.length) : name
  return `${base} (new copy ${now.toISOString().slice(0, 10)})${ext}`.slice(0, 250)
}

export const defaultReplacementDeps: ReplacementDeps = {
  chainHead: async (callerKey) => {
    const { data: f } = await db().from("store_files").select("id").eq("caller_key", callerKey).neq("state", "purged").maybeSingle()
    if (!f) return null
    const cur = await walkChainToEnd(f.id as string, async (id) => {
      const { data: next } = await db().from("store_files").select("id").eq("supersedes_file_id", id).eq("state", "live").order("created_at", { ascending: false }).limit(1)
      return next && next.length > 0 ? (next[0].id as string) : null
    })
    const { data: head } = await db().from("store_files").select("id, owner_id, name, state, current_version_id, document_type, period_year").eq("id", cur).maybeSingle()
    if (!head) return null
    let sha: string | null = null
    if (head.current_version_id) {
      const { data: v } = await db().from("store_file_versions").select("sha256").eq("id", head.current_version_id).maybeSingle()
      sha = (v?.sha256 as string | undefined) ?? null
    }
    return { ownerId: (head.owner_id as string | null) ?? null, fileId: head.id as string, versionId: (head.current_version_id as string | null) ?? null, sha256: sha, name: head.name as string, live: head.state === "live", documentType: (head.document_type as string | null) ?? null, periodYear: (head.period_year as number | null) ?? null }
  },
}

defaultReplacementDeps.retire = async (replacedFileId) => {
  const { setClientVisibility } = await import("./browse")
  await setClientVisibility(replacedFileId, false, null, { silent: true, suppressChat: true })
}

export type ReplacementResult = WriteResult & { replacedFileId?: string }

export async function saveWithReplacement(p: {
  baseKey: string
  bytes: Buffer
  name: string
  /** the actual save: the same call the flow already makes, parameterised by key / supersedes / name */
  save: (a: { callerKey: string; supersedesFileId: string | null; name: string; documentType?: string | null; periodYear?: number | null }) => Promise<WriteResult>
  deps?: ReplacementDeps
  now?: Date
  /** the owner the NEW file is saved in: a file in another owner cannot be "replaced" (the store refuses), so it is saved as a fresh file */
  ownerId?: string | null
}): Promise<ReplacementResult> {
  try {
    return await p.save({ callerKey: p.baseKey, supersedesFileId: null, name: p.name })
  } catch (e) {
    if (!isLockRefusal(e)) throw e
    const sha = sha256Hex(p.bytes)
    const head = await (p.deps ?? defaultReplacementDeps).chainHead(p.baseKey)
    if (!head || !head.live) throw e // nothing live to replace: let the caller report the refusal in plain words
    if (head.sha256 === sha) return { status: "unchanged", fileId: head.fileId, versionId: head.versionId, name: head.name }
    // the replacement must carry the replaced file's document type and year (the store refuses an amendment of another kind), even
    // when staff re-typed the file since it was saved
    // the old file lives in ANOTHER owner (re-homed since): the store cannot mark it replaced — save a fresh file, never an error
    if (p.ownerId && head.ownerId && head.ownerId !== p.ownerId) {
      return await p.save({ callerKey: replacementKey(p.baseKey, sha), supersedesFileId: null, name: p.name })
    }
    const w = await p.save({
      callerKey: replacementKey(p.baseKey, sha), supersedesFileId: head.fileId, name: replacementName(p.name, p.now),
      documentType: head.documentType ?? undefined, periodYear: head.periodYear ?? undefined,
    })
    // the replaced file's CRM row would still be shown next to the new one ("X Signed.pdf" AND "X (new copy …).pdf"): hide it, keep it for history
    if (w.status === "created") {
      try { await (p.deps ?? defaultReplacementDeps).retire?.(head.fileId) } catch (e) {
        console.warn("[crm-store] the replaced file stays visible to the client:", e instanceof Error ? e.message : e)
      }
    }
    return { ...w, replacedFileId: head.fileId }
  }
}
