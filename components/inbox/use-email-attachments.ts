'use client'

/**
 * Paperclip / drag-drop / paste attachments for the Inbox email composers
 * (new email + reply). Modeled on components/chat/use-worker-attachments.ts —
 * same signed-URL direct-to-storage transport (the browser never posts bytes
 * to our API; a file base64'd into the request body would 413 at the platform
 * edge), same synchronous-ref staging discipline — but with EMAIL limits:
 * Gmail refuses messages over 25MB total after base64 overhead, so 18MB of
 * raw file bytes per email is the honest ceiling, per file and combined.
 *
 * Files land in the PRIVATE worker-attachments bucket under inbox-email/; the
 * send routes read them back by path with the service key and attach them to
 * the outgoing MIME. Nothing is ever served from a public URL.
 */

import { useCallback, useRef, useState } from 'react'
import { validateChatAttachment } from '@/lib/portal/chat-attachment'

/** A file staged in the composer, before/after its upload completes. */
export interface StagedEmailFile {
  /** Stable client-side id, so a removal targets the right row while uploads race. */
  localId: string
  name: string
  size: number
  mimeType: string
  /** Storage object path — present once the upload finishes. */
  path?: string
  error?: string
}

/** What the compose/reply POST expects in `attachments`. */
export interface EmailAttachmentPayload {
  path: string
  name: string
  mime_type: string
}

let counter = 0
const nextLocalId = () => `ea${++counter}-${Date.now()}`

export const MAX_EMAIL_FILES = 10
/** Mirrors MAX_EMAIL_ATTACHMENT_TOTAL_BYTES in lib/inbox/email-attachment-staging.ts.
 * Kept as a plain number rather than imported, because that module pulls in
 * server-only code. If one moves, move both. */
export const MAX_EMAIL_TOTAL_MB = 18
export const MAX_EMAIL_TOTAL_BYTES = MAX_EMAIL_TOTAL_MB * 1024 * 1024

export function useEmailAttachments() {
  const [files, setFiles] = useState<StagedEmailFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [limitNotice, setLimitNotice] = useState<string | null>(null)

  // Synchronous truth — see the WHY-A-REF war story in use-worker-attachments.ts
  // (updater-deferred acceptance silently dropped files while they still rendered).
  const filesRef = useRef<StagedEmailFile[]>([])

  /** Single write path — ref first (synchronous truth), then state (render). */
  const writeFiles = useCallback((next: (prev: StagedEmailFile[]) => StagedEmailFile[]) => {
    filesRef.current = next(filesRef.current)
    setFiles(filesRef.current)
  }, [])

  const remove = useCallback((localId: string) => {
    writeFiles((prev) => prev.filter((f) => f.localId !== localId))
    setLimitNotice(null)
  }, [writeFiles])

  const clear = useCallback(() => {
    writeFiles(() => [])
    setLimitNotice(null)
  }, [writeFiles])

  const add = useCallback(async (incoming: File[]) => {
    if (!incoming.length) return

    const room = Math.max(0, MAX_EMAIL_FILES - filesRef.current.length)
    const take = incoming.slice(0, room)
    const overflow = incoming.length - take.length
    const accepted: Array<{ entry: StagedEmailFile; file: File }> = take.map((file) => ({
      entry: {
        localId: nextLocalId(),
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
      },
      file,
    }))
    writeFiles((prev) => [...prev, ...accepted.map((a) => a.entry)])

    // Never swallow a file the user tried to attach.
    if (overflow > 0) {
      setLimitNotice(`Only ${MAX_EMAIL_FILES} files per email — ${overflow} not added.`)
    } else {
      setLimitNotice(null)
    }
    if (!accepted.length) return

    setUploading(true)
    await Promise.all(
      accepted.map(async ({ entry, file }) => {
        const fail = (error: string) =>
          writeFiles((prev) => prev.map((f) => (f.localId === entry.localId ? { ...f, error } : f)))

        // Same type policy as every other upload (executables blocked)...
        const validationError = validateChatAttachment(file.name, file.size, file.type)
        if (validationError) return fail(validationError)
        // ...but the EMAIL size ceiling, per file and across the batch. Checked
        // here so the user hears "too big" before the upload, not at send time.
        if (file.size > MAX_EMAIL_TOTAL_BYTES) {
          return fail(
            `Too large to email: ${(file.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_EMAIL_TOTAL_MB} MB — Gmail's limit). Send it via a Drive link instead.`,
          )
        }
        const otherBytes = filesRef.current
          .filter((f) => f.localId !== entry.localId && !f.error)
          .reduce((sum, f) => sum + f.size, 0)
        if (otherBytes + file.size > MAX_EMAIL_TOTAL_BYTES) {
          return fail(
            `Attachments exceed ${MAX_EMAIL_TOTAL_MB} MB combined (Gmail's limit). Remove a file first.`,
          )
        }

        try {
          const urlRes = await fetch('/api/inbox/attachments/upload-url', {
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
          writeFiles((prev) => prev.map((f) => (f.localId === entry.localId ? { ...f, path } : f)))
        } catch (err) {
          fail(err instanceof Error && err.message ? err.message : 'Upload failed. Please try again.')
        }
      }),
    )
    setUploading(false)
  }, [writeFiles])

  // Read at SEND time, not during render — consult the ref so an upload that
  // finished moments before the click counts, and a failed file is never
  // silently sent past its warning.
  /** Files that actually made it to storage — the only ones worth sending. */
  const uploaded = useCallback((): EmailAttachmentPayload[] => {
    return filesRef.current
      .filter((f): f is StagedEmailFile & { path: string } => Boolean(f.path) && !f.error)
      .map((f) => ({ path: f.path, name: f.name, mime_type: f.mimeType }))
  }, [])

  /** Files that failed. Sending must not silently drop them. */
  const failed = useCallback(() => filesRef.current.filter((f) => f.error), [])

  /** Paste handler: pull file blobs (a screenshot, a copied PDF) off the clipboard. */
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const pasted = Array.from(e.clipboardData?.files ?? [])
      if (!pasted.length) return
      e.preventDefault() // don't also paste the filename as text
      void add(pasted)
    },
    [add],
  )

  return { files, uploading, limitNotice, add, remove, clear, uploaded, failed, onPaste }
}

/** The shape the composers hand down to the chips row. */
export type EmailAttachments = ReturnType<typeof useEmailAttachments>
