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
 *  - 'notes' — staff sticky notes created/edited/shared/snoozed/archived
 *  - 'whatsapp' — the WhatsApp Inbox changed: a message arrived, a reply's status changed, a phone reaction was applied,
 *                 media became playable, chat names changed. Emitted by app/api/wa-bridge/[channelId]/route.ts.
 *                 The listener refreshes only the WhatsApp list + open chat (lib/ui-event-whatsapp-keys.ts). Payload: none, EXCEPT
 *                 `{ inbound: n }` when n fresh CUSTOMER messages arrived — the dashboard then plays the person's chosen tone
 *                 (lib/whatsapp-sound.ts, lib/messaging/inbound-sound.ts; dev job c84dfb4d). Never message text or names.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

// ui_events is not in the generated Database types yet (regenerated from
// production after the prod DDL). Same escape hatch as lib/system-errors.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export type UiEventKind = "todo" | "tasks" | "notes" | "whatsapp"

export async function emitUiEvent(
  kind: UiEventKind,
  payload?: Record<string, unknown>
): Promise<void> {
  try {
    // supabase-js RETURNS a rejected insert ({ error }) instead of throwing — log it, or live updates could stop silently
    // (RLS, a missing table / publication in some environment, an outage).
    const { error } = await db.from("ui_events").insert({ kind, payload: payload ?? null })
    if (error) console.warn(`[ui-events] emit '${kind}' rejected (non-fatal):`, error.message ?? error)
  } catch (err) {
    console.warn(`[ui-events] emit '${kind}' failed (non-fatal):`, err)
  }
}
