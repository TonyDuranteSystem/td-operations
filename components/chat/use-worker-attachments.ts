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

/** The server reads at most this many attachments per turn. */
export const MAX_FILES = 5
/**
 * Mirrors MAX_ATTACHMENT_BYTES in lib/ai-agent/attachment-reader.ts. Kept as a
 * plain number rather than imported, because that module pulls in server-only
 * code. If one moves, move both.
 */
export const MAX_WORKER_FILE_MB = 20
export const MAX_WORKER_FILE_BYTES = MAX_WORKER_FILE_MB * 1024 * 1024

export function useWorkerAttachments() {
  const [files, setFiles] = useState<StagedAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [limitNotice, setLimitNotice] = useState<string | null>(null)

  const remove = useCallback((localId: string) => {
    setFiles((prev) => prev.filter((f) => f.localId !== localId))
    setLimitNotice(null)
  }, [])

  const clear = useCallback(() => {
    setFiles([])
    setLimitNotice(null)
  }, [])

  const add = useCallback(async (incoming: File[]) => {
    if (!incoming.length) return

    // The cap must be computed against the CURRENT list, inside the updater.
    // Reading `files.length` from the closure lets two fast pastes each see the
    // pre-render count and stage 5 apiece — the server then reads only the first
    // 5 and drops the rest, which is exactly the "the worker ignored my file"
    // outcome this cap exists to prevent.
    const accepted: Array<{ entry: StagedAttachment; file: File }> = []
    let overflow = 0
    setFiles((prev) => {
      const room = Math.max(0, MAX_FILES - prev.length)
      const take = incoming.slice(0, room)
      overflow = incoming.length - take.length
      for (const file of take) {
        accepted.push({
          entry: {
            localId: nextLocalId(),
            name: file.name,
            size: file.size,
            mimeType: file.type || 'application/octet-stream',
          },
          file,
        })
      }
      return [...prev, ...accepted.map((a) => a.entry)]
    })

    // Never swallow a file the user tried to attach.
    if (overflow > 0) {
      setLimitNotice(`Only ${MAX_FILES} files at a time — ${overflow} not added.`)
    } else {
      setLimitNotice(null)
    }
    if (!accepted.length) return

    const staged = accepted.map((a) => a.entry)
    const files_ = accepted.map((a) => a.file)
    setUploading(true)

    await Promise.all(
      staged.map(async (entry, i) => {
        const file = files_[i]
        const fail = (error: string) =>
          setFiles((prev) => prev.map((f) => (f.localId === entry.localId ? { ...f, error } : f)))

        // Same type policy as every other chat upload (executables blocked).
        const validationError = validateChatAttachment(file.name, file.size, file.type)
        if (validationError) return fail(validationError)
        // ...but a tighter SIZE limit: chat allows 100MB, and the worker's reader
        // refuses anything over 20MB. Without this the upload goes green and the
        // worker then says it can't read the file — success followed by refusal.
        if (file.size > MAX_WORKER_FILE_BYTES) {
          return fail(`Too large for the worker to read: ${(file.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_WORKER_FILE_MB} MB).`)
        }

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
  }, [])

  /** Files that actually made it to storage — the only ones worth sending. */
  const uploaded = useCallback((): UploadedAttachment[] => {
    return files
      .filter((f): f is StagedAttachment & { path: string } => Boolean(f.path) && !f.error)
      .map((f) => ({ path: f.path, name: f.name, mime_type: f.mimeType, size: f.size }))
  }, [files])

  /** Files that failed. Sending must not silently drop them. */
  const failed = useCallback(() => files.filter((f) => f.error), [files])

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
  return { files, uploading, limitNotice, add, remove, clear, uploaded, failed, onPaste }
}

/** The shape the panel hands down to the composer and the drop zone. */
export type WorkerAttachments = ReturnType<typeof useWorkerAttachments>
