/**
 * The three "finish sharing a capture" calls, factored out of their pickers
 * so the same code path also powers the recent-destinations one-tap
 * shortcuts (step 8) — a quick-tap must do exactly what clicking the item in
 * the full picker does, never a second, slightly-different copy of the same
 * request.
 *
 * `resend` (2026-09-05, the "Share" button on an existing gallery picture):
 * every route's own idempotency guard treats a capture that already has a
 * destination as "already shared, reject" — correct for the original flow
 * (this exact capture has never been sent before, so a second attempt IS the
 * bug), wrong for a deliberate later re-share, which is exactly what "already
 * has a destination" now legitimately describes. Passing `resend: true`
 * tells the route this is intentional. See each route's own comment for why
 * the weaker idempotency posture on this ONE path (no atomic claim, just the
 * picker's existing busy-guard) is a reasoned trade-off: a re-share is a
 * multi-click, deliberately-reopened action, not the "network hiccup makes
 * an already-submitted click look like it didn't go through" pattern the
 * original guard exists to catch.
 */

export async function attachCaptureToNote(captureId: string, noteId: string, resend?: boolean): Promise<void> {
  const res = await fetch('/api/crm/staff-notes', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: noteId, action: 'attach_capture', capture_id: captureId, resend: resend || undefined }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not attach the picture. Please try again.')
  }
}

export async function sendCaptureToTeamChat(captureId: string, threadId: string, resend?: boolean): Promise<void> {
  const res = await fetch(`/api/captures/${captureId}/share-team-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId, resend: resend || undefined }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not send to team chat. Please try again.')
  }
}

export async function sendCaptureToPortalChat(
  captureId: string,
  // contact_id is null only for a "whole company" send (2026-09-06) — no
  // one specific person, always paired with a real account_id.
  target: { contact_id: string | null; account_id: string | null },
  resend?: boolean,
): Promise<void> {
  const res = await fetch(`/api/captures/${captureId}/share-portal-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...target, resend: resend || undefined }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not send it to the client. Please try again.')
  }
}
