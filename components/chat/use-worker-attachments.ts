'use client'

/**
 * Paste / drag-drop attachments for the CRM worker panels.
 *
 * Shared by the Inbox panel and the Portal Chats Worker tab so the two can't
 * drift on size limits, error copy, or upload target — the panels themselves
 * are already near-duplicates and drift there has bitten us before.
 *
 * Files go straight to the PRIVATE worker-attachments bucket through a signed
 * URL; the browser never posts bytes to our API (a screenshot base64'd into the
 * request body would 413 at the platform edge). We hand the worker the object
 * PATH and the server reads it back with the service key.
 */

import { useCallback, useState } from 'react'
import { validateChatAttachment } from '@/lib/portal/chat-attachment'

/** A file staged in the composer, before/after its upload completes. */
export interface StagedAttachment {
  /** Stable client-side id, so a removal targets the right row while uploads race. */
  localId: string
  name: string
  size: number
  mimeType: string
  /** Storage object path — present once the upload finishes. */
  path?: string
  error?: string
}

/** What the worker-chat POST expects. */
export interface UploadedAttachment {
  path: string
  name: string
  mime_type: string
  size: number
}

let counter = 0
const nextLocalId = () => `f${++counter}-${Date.now()}`

export function useWorkerAttachments() {
  const [files, setFiles] = useState<StagedAttachment[]>([])
  const [uploading, setUploading] = useState(false)

  const remove = useCallback((localId: string) => {
    setFiles((prev) => prev.filter((f) => f.localId !== localId))
  }, [])

  const clear = useCallback(() => setFiles([]), [])

  const add = useCallback(async (incoming: File[]) => {
    if (!incoming.length) return
    // Cap at 5 — the server reads at most 5 per turn and silently dropping the
    // rest would read as "the worker ignored my file".
    const staged: StagedAttachment[] = []
    for (const file of incoming) {
      if (files.length + staged.length >= 5) break
      staged.push({
        localId: nextLocalId(),
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
      })
    }
    setFiles((prev) => [...prev, ...staged])
    setUploading(true)

    await Promise.all(
      staged.map(async (entry, i) => {
        const file = incoming[i]
        const fail = (error: string) =>
          setFiles((prev) => prev.map((f) => (f.localId === entry.localId ? { ...f, error } : f)))

        // Same policy as every other chat upload — one source of truth.
        const validationError = validateChatAttachment(file.name, file.size, file.type)
        if (validationError) return fail(validationError)

        try {
          const urlRes = await fetch('/api/inbox/worker-chat/upload-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_name: file.name, file_size: file.size, mime_type: file.type }),
          })
          if (!urlRes.ok) {
            // R099 — surface the server's reason, never a generic "upload failed".
            const d = await urlRes.json().catch(() => ({}))
            return fail(d.error || 'Could not start the upload. Please try again.')
          }
          const { signedUrl, path } = await urlRes.json()
          if (!signedUrl || !path) return fail('Could not start the upload. Please try again.')

          const putRes = await fetch(signedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          })
          if (!putRes.ok) {
            return fail(
              putRes.status === 413
                ? 'File too large for the storage bucket.'
                : 'Upload failed. Please check your connection and try again.',
            )
          }
          setFiles((prev) => prev.map((f) => (f.localId === entry.localId ? { ...f, path } : f)))
        } catch (err) {
          fail(err instanceof Error && err.message ? err.message : 'Upload failed. Please try again.')
        }
      }),
    )
    setUploading(false)
  }, [files.length])

  /** Files that actually made it to storage — the only ones worth sending. */
  const uploaded = useCallback((): UploadedAttachment[] => {
    return files
      .filter((f): f is StagedAttachment & { path: string } => Boolean(f.path) && !f.error)
      .map((f) => ({ path: f.path, name: f.name, mime_type: f.mimeType, size: f.size }))
  }, [files])

  /** Paste handler: pull image blobs (a screenshot) out of the clipboard. */
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const pasted = Array.from(e.clipboardData?.files ?? [])
      if (!pasted.length) return
      e.preventDefault() // don't also paste the filename as text
      void add(pasted)
    },
    [add],
  )

  // NOTE: drag-and-drop is NOT handled here. The drop target is the whole panel
  // (see worker-dropzone.tsx) — a file dropped outside a registered target makes
  // the browser navigate away from the page, so the thin composer strip was the
  // wrong place for it.
  return { files, uploading, add, remove, clear, uploaded, onPaste }
}

/** The shape the panel hands down to the composer and the drop zone. */
export type WorkerAttachments = ReturnType<typeof useWorkerAttachments>
