import type { ContractView } from '@/lib/contracts/service-contract-view'

/** What GET /api/service-contracts/[entryId] returns. */
export type ContractPayload = ContractView & {
  viewer: { canApprove: boolean; name: string }
  aiConfigured: boolean
}

/** An error answer from our own API, with the server's own words (R099: never a generic "failed"). */
export class ApiError extends Error {
  status: number
  data: Record<string, unknown> | null
  constructor(message: string, status: number, data: Record<string, unknown> | null) {
    super(message)
    this.status = status
    this.data = data
  }
}

export async function request<T = unknown>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0, null)
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const msg = data && typeof data.error === 'string' && data.error ? data.error : `Something went wrong (error ${res.status}). Please try again.`
    throw new ApiError(msg, res.status, data)
  }
  return data as T
}

export const loadContract = (entryId: string) => request<ContractPayload>(`/api/service-contracts/${entryId}`)

/** How a version came to be, in plain words ("written by Claude", "started from version 1", …). */
export function sourceLabel(v: { source: string; note: string | null }): string {
  if (v.source === 'manual' && v.note && v.note.startsWith('Started from')) return v.note.charAt(0).toLowerCase() + v.note.slice(1)
  if (v.source === 'claude_draft') return 'written by Claude'
  if (v.source === 'claude_change') return 'changed by Claude'
  if (v.source === 'session') return 'written in a Claude session'
  return 'edited by hand'
}
