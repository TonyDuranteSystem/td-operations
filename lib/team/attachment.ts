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
