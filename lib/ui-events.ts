/**
 * Dashboard live-update bus — SERVER side (emit).
 *
 * Call `emitUiEvent(kind)` after a server write that other open tabs should
 * see immediately (Antonio 2026-07-08: no hard refresh across tabs/machines).
 * Best-effort and non-blocking: an emit failure never fails the request.
 *
 * Client side: components/dashboard/ui-event-listener.tsx subscribes to
 * ui_events via supabase_realtime and maps kinds to react-query
 * invalidations / DOM events (see UI_EVENT_QUERY_KEYS there).
 *
 * KINDS (add here as surfaces are wired):
 *  - 'todo'  — To-Do / action-board cards or columns changed
 *  - 'tasks' — CRM tasks changed
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

// ui_events is not in the generated Database types yet (regenerated from
// production after the prod DDL). Same escape hatch as lib/system-errors.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export type UiEventKind = "todo" | "tasks"

export async function emitUiEvent(
  kind: UiEventKind,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    await db.from("ui_events").insert({ kind, payload: payload ?? null })
  } catch (err) {
    console.warn(`[ui-events] emit '${kind}' failed (non-fatal):`, err)
  }
}
