/**
 * Team Workspace — client-side attachment upload (browser-only).
 *
 * Mirrors lib/portal/chat-attachment.ts::uploadChatAttachment but targets the
 * team upload-url route (thread-scoped, not account/contact-scoped). Reuses the
 * SAME validation rules so team and client chat never drift on size/type policy.
 */
import type { ChatAttachment } from '@/lib/types'
import { validateChatAttachment, CHAT_ATTACHMENT_MAX_MB } from '@/lib/portal/chat-attachment'

/**
 * Upload a single file to team-chat storage via a signed URL.
 * Throws Error(<user-friendly message>) on any failure (R099 — callers surface
 * err.message directly instead of a generic toast).
 */
export async function uploadTeamAttachment(file: File, threadId: string): Promise<ChatAttachment> {
  const validationError = validateChatAttachment(file.name, file.size, file.type)
  if (validationError) throw new Error(validationError)

  const urlRes = await fetch('/api/team/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId, file_name: file.name }),
  })
  if (!urlRes.ok) {
    const d = await urlRes.json().catch(() => ({}))
    throw new Error(d.error || 'Could not start the upload. Please try again.')
  }
  const { signedUrl, publicUrl } = await urlRes.json()
  if (!signedUrl || !publicUrl) {
    throw new Error('Could not start the upload. Please try again.')
  }

  const putRes = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
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
