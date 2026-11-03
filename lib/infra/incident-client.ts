'use client'

/**
 * The browser's copy of "is Supabase having an incident?". One place asks (the bar, or a failing upload on demand); everything that wants to explain a failure reads it.
 * Staff see the details; a client sees only { uploadsDown } — never the cause.
 */
import { useEffect, useState } from 'react'
import { failureHint, type SupabaseIncident } from '@/lib/infra/supabase-status'

export type IncidentState =
  | { audience: 'staff'; incident: SupabaseIncident | null; others: number }
  | { audience: 'client'; uploadsDown: boolean }
  | { unknown: true }
  | null

let state: IncidentState = null
const listeners = new Set<() => void>()
export function getIncidentState(): IncidentState { return state }
function set(next: IncidentState) { state = next; for (const fn of Array.from(listeners)) { try { fn() } catch { /* ignore */ } } }

/** The status address that this person's login is allowed to call. */
export function statusUrlForPath(pathname: string): string {
  if (pathname.startsWith('/marketing')) return '/api/marketing/supabase-status'
  if (pathname.startsWith('/portal')) return '/api/portal/supabase-status'
  return '/api/infra/supabase-status'
}

/** Asks the server now and remembers the answer (a failure to ask is "unknown", never "all clear"). */
export async function refreshIncident(pathname?: string): Promise<IncidentState> {
  const path = pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '/')
  try {
    const res = await fetch(statusUrlForPath(path), { cache: 'no-store' })
    if (!res.ok) { set({ unknown: true }); return state }
    set((await res.json()) as IncidentState)
  } catch { set({ unknown: true }) }
  return state
}

/** The live state (updated by the bar's polling). */
export function useIncidentState(): IncidentState {
  const [, bump] = useState(0)
  useEffect(() => { const f = () => bump(n => n + 1); listeners.add(f); return () => { listeners.delete(f) } }, [])
  return state
}

/** The line to show for a failed upload: when Supabase has an open storage incident it says so (staff only); otherwise the ordinary message. */
export function incidentHintFor(s: IncidentState): string | null {
  return s && 'audience' in s && s.audience === 'staff' && s.incident ? failureHint(s.incident) : null
}

/** Asks the server right now (the bar may not have polled yet) and explains a failed upload. */
export async function explainUploadFailure(fallback: string): Promise<string> {
  return incidentHintFor(await refreshIncident()) ?? fallback
}
