'use client'

import { typeCouldWaitIn, type WaitSummary } from '@/lib/flows/storage-step-rules'

/**
 * Browser side of "a workspace step is waiting for this document" (dev job e3215801): which document types ANY workspace upload box takes is read
 * from the server (it is built from the stage layouts, not written here), kept for a minute, and used to skip the check for an ordinary file.
 * A list that cannot be loaded (an error, a nonsense answer, no answer within 5 seconds) is `null`, and null means "check everything" — never
 * "check nothing"; the check itself fails closed on the server. A page that is told by the server that its list was out of date calls
 * `resetWaitSummary()` so the next upload reads a fresh one.
 */
const KEEP_MS = 60 * 1000
const LOAD_TIMEOUT_MS = 5000
let memo: { at: number; value: Promise<WaitSummary | null> } | null = null

function isSummary(v: unknown): v is WaitSummary {
  const s = v as WaitSummary | null
  return !!s && Array.isArray(s.types) && Array.isArray(s.vagueTypes) && s.types.every((t) => typeof t === 'string') && s.vagueTypes.every((t) => typeof t === 'string')
}

/** Forget the loaded list: the next upload reads it again. */
export function resetWaitSummary(): void {
  memo = null
}

export function loadWaitSummary(): Promise<WaitSummary | null> {
  if (memo && Date.now() - memo.at < KEEP_MS) return memo.value
  const abort = typeof AbortController !== 'undefined' ? new AbortController() : null
  const loading = fetch('/api/crm/admin-actions/workspace-types', { cache: 'no-store', ...(abort ? { signal: abort.signal } : {}) })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (isSummary(j?.summary) ? (j.summary as WaitSummary) : null))
    .catch(() => null)
  const value = new Promise<WaitSummary | null>((resolve) => {
    const timer = setTimeout(() => {
      abort?.abort()
      resolve(null)
    }, LOAD_TIMEOUT_MS)
    void loading.then((v) => {
      clearTimeout(timer)
      resolve(v)
    })
  })
  memo = { at: Date.now(), value }
  // a failed load is not remembered: the next upload tries again
  void value.then((v) => {
    if (v === null && memo?.value === value) memo = null
  })
  return value
}

/** Could a file of this Storage type ever be a workspace step's document? (true when the list is unknown). */
export async function typeCouldWaitNow(documentType: string | null): Promise<boolean> {
  return typeCouldWaitIn(await loadWaitSummary(), documentType)
}
