/**
 * Team Workspace — client-side attachment upload (browser-only).
 *
 * Mirrors lib/portal/chat-attachment.ts::uploadChatAttachment but targets the
 * team upload-url route (thread-scoped, not account/contact-scoped). Reuses the
 * SAME validation rules so team and client chat never drift on size/type policy.
 */
import type { ChatAttachment } from '@/lib/types'
import { validateChatAttachment, CHAT_ATTACHMENT_MAX_MB } from '@/lib/portal/chat-attachment'

/** Max files that can ride on a single chat message. */
export const CHAT_ATTACHMENT_MAX_COUNT = 5

export interface ChatFileIntake {
  /** Files that passed validation and fit under the per-message cap. */
  accepted: File[]
  /** Names of files rejected (blocked type, or empty/folder). */
  rejected: string[]
  /** How many valid files were dropped because the cap was already reached. */
  overflow: number
}

/**
 * Normalize + validate a batch of incoming files (paperclip pick, drag-drop, or
 * paste) before they are staged in the composer. Pure — no React, no upload.
 *
 * - Nameless pasted blobs (some browsers give a clipboard image an empty name)
 *   get a synthesized `pasted-<ts>.<ext>` name so the upload route (which
 *   requires a file_name) and the block-list both have something to work with.
 * - Empty files / dropped folders (size 0) are rejected — they otherwise create
 *   a permanent failed-send loop.
 * - Everything else runs the shared active-content block-list.
 * - The per-message cap is applied against how many files are ALREADY staged.
 */
export function prepareChatFiles(
  incoming: File[],
  currentCount: number,
  cap: number = CHAT_ATTACHMENT_MAX_COUNT,
): ChatFileIntake {
  const valid: File[] = []
  const rejected: string[] = []

  for (const original of incoming) {
    let file = original
    if (!file.name) {
      const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'png'
      file = new File([original], `pasted-${Date.now()}.${ext}`, { type: original.type })
    }
    if (file.size === 0) {
      rejected.push(file.name || 'item')
      continue
    }
    if (validateChatAttachment(file.name, file.size, file.type)) {
      rejected.push(file.name)
      continue
    }
    valid.push(file)
  }

  const room = Math.max(0, cap - currentCount)
  return {
    accepted: valid.slice(0, room),
    rejected,
    overflow: Math.max(0, valid.length - room),
  }
}

/**
 * Best-effort telemetry for an upload that failed after retries (2026-08-31,
 * dev job — Luca's td-bug "Failed to fetch" report). Mirrors
 * components/offers/create-offer-dialog.tsx's reportDialogError — same
 * fire-and-forget POST to /api/system-errors/report, never throws, never
 * blocks the send. This is the ONLY way this class of failure (a raw
 * browser-level network error on the direct-to-Storage PUT) becomes visible
 * to us at all — it happens entirely client-side and never reaches our own
 * server, so without this it leaves no trace anywhere.
 */
function reportTeamAttachmentError(payload: { route: string; message: string; thread_id: string; file_name: string }) {
  try {
    void fetch('/api/system-errors/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        route: payload.route,
        message: payload.message,
        page_path: window.location.pathname,
        context: { thread_id: payload.thread_id, file_name: payload.file_name },
      }),
    }).catch(() => {})
  } catch {
    // ignore — reporting is best-effort
  }
}

/**
 * A network-level fetch failure (the browser's own TypeError — connection
 * dropped, DNS blip, momentary offline) is usually gone a second later.
 * Retries ONLY that case — a completed response with a bad status (413, a
 * JSON error body, etc.) is a real answer from the server and is NOT retried
 * here; the caller still handles those exactly as before.
 */
async function fetchWithNetworkRetry(input: string, init: RequestInit, attempts = 3, delayMs = 800): Promise<Response> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(input, init)
    } catch (err) {
      if (attempt === attempts) throw err
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt))
    }
  }
  // Unreachable — the loop above always returns or throws on its last attempt.
  throw new Error('Upload failed. Please check your connection and try again.')
}

/**
 * Upload a single file to team-chat storage via a signed URL.
 * Throws Error(<user-friendly message>) on any failure (R099 — callers surface
 * err.message directly instead of a generic toast). A network-level failure
 * (as opposed to a completed error response) is quietly retried a couple of
 * times first — most such failures are a passing blip, and the composer
 * already keeps the typed text + staged files for the user, so a transparent
 * retry means most people never see an error at all.
 */
export async function uploadTeamAttachment(file: File, threadId: string): Promise<ChatAttachment> {
  const validationError = validateChatAttachment(file.name, file.size, file.type)
  if (validationError) throw new Error(validationError)

  let urlRes: Response
  try {
    urlRes = await fetchWithNetworkRetry('/api/team/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: threadId, file_name: file.name }),
    })
  } catch (err) {
    reportTeamAttachmentError({
      route: 'team-chat:upload-url',
      message: err instanceof Error ? err.message : String(err),
      thread_id: threadId,
      file_name: file.name,
    })
    throw new Error("Couldn't reach the server to start the upload. Your message and files are still here — check your connection and press Send to try again.")
  }
  if (!urlRes.ok) {
    const d = await urlRes.json().catch(() => ({}))
    throw new Error(d.error || 'Could not start the upload. Please try again.')
  }
  const { signedUrl, publicUrl } = await urlRes.json()
  if (!signedUrl || !publicUrl) {
    throw new Error('Could not start the upload. Please try again.')
  }

  let putRes: Response
  try {
    putRes = await fetchWithNetworkRetry(signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    })
  } catch (err) {
    reportTeamAttachmentError({
      route: 'team-chat:upload-put',
      message: err instanceof Error ? err.message : String(err),
      thread_id: threadId,
      file_name: file.name,
    })
    throw new Error("Couldn't upload the file — the connection was interrupted. Your message and files are still here — press Send to try again.")
  }
  if (!putRes.ok) {
    if (putRes.status === 413) {
      throw new Error(`File too large. Maximum allowed: ${CHAT_ATTACHMENT_MAX_MB} MB.`)
    }
    throw new Error('Upload failed. Please check your connection and try again.')
  }

  return {
    url: publicUrl,
    name: file.name,
    mime_type: file.type || undefined,
    size: file.size,
  }
}
