'use client'

import { typeCouldWaitIn, type WaitSummary } from '@/lib/flows/storage-step-rules'

/**
 * Browser side of "a workspace step is waiting for this document" (dev job e3215801): which document types ANY workspace upload box takes is read
 * from the server (it is built from the stage layouts, not written here), kept for a few minutes, and used to skip the check for an ordinary file.
 * A list that cannot be loaded is `null`, and null means "check everything" — never "check nothing"; the check itself fails closed on the server.
 */
const KEEP_MS = 5 * 60 * 1000
let memo: { at: number; value: Promise<WaitSummary | null> } | null = null

function isSummary(v: unknown): v is WaitSummary {
  const s = v as WaitSummary | null
  return !!s && Array.isArray(s.types) && Array.isArray(s.vagueTypes) && s.types.every((t) => typeof t === 'string') && s.vagueTypes.every((t) => typeof t === 'string')
}

export function loadWaitSummary(): Promise<WaitSummary | null> {
  if (memo && Date.now() - memo.at < KEEP_MS) return memo.value
  const value = fetch('/api/crm/admin-actions/workspace-types', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (isSummary(j?.summary) ? (j.summary as WaitSummary) : null))
    .catch(() => null)
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
