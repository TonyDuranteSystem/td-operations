/**
 * The two "finish sharing a capture" calls, factored out of their pickers so
 * the same code path also powers the recent-destinations one-tap shortcuts
 * (step 8) — a quick-tap must do exactly what clicking the item in the full
 * picker does, never a second, slightly-different copy of the same request.
 */

export async function attachCaptureToNote(captureId: string, noteId: string): Promise<void> {
  const res = await fetch('/api/crm/staff-notes', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: noteId, action: 'attach_capture', capture_id: captureId }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not attach the picture. Please try again.')
  }
}

export async function sendCaptureToTeamChat(captureId: string, threadId: string): Promise<void> {
  const res = await fetch(`/api/captures/${captureId}/share-team-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId }),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not send to team chat. Please try again.')
  }
}

export async function sendCaptureToPortalChat(
  captureId: string,
  target: { contact_id: string; account_id: string | null },
): Promise<void> {
  const res = await fetch(`/api/captures/${captureId}/share-portal-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target),
  })
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not send it to the client. Please try again.')
  }
}
