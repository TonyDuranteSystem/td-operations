/**
 * TD Communication chat attachments — client-side upload via signed URL.
 * Mirrors lib/portal/chat-attachment.ts but scoped to a conversation_id. Reuses
 * the shared validation (size cap + active-content block-list) so the two chats
 * never drift on policy.
 */
import { validateChatAttachment, CHAT_ATTACHMENT_MAX_MB } from '@/lib/portal/chat-attachment'
import type { CommAttachment } from './types'

export { validateChatAttachment, CHAT_ATTACHMENT_MAX_MB }

export async function uploadCommAttachment(
  file: File,
  conversationId: string,
): Promise<CommAttachment> {
  const validationError = validateChatAttachment(file.name, file.size, file.type)
  if (validationError) throw new Error(validationError)

  const urlRes = await fetch('/api/conversations/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: conversationId, file_name: file.name }),
  })
  if (!urlRes.ok) {
    const d = await urlRes.json().catch(() => ({}))
    throw new Error(d.error || 'Could not start the upload. Please try again.')
  }
  const { signedUrl, publicUrl } = await urlRes.json()
  if (!signedUrl || !publicUrl) throw new Error('Could not start the upload. Please try again.')

  const putRes = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!putRes.ok) {
    if (putRes.status === 413) throw new Error(`File too large. Maximum allowed: ${CHAT_ATTACHMENT_MAX_MB} MB.`)
    throw new Error('Upload failed. Please check your connection and try again.')
  }

  return { url: publicUrl, name: file.name, mime_type: file.type || undefined, size: file.size }
}
