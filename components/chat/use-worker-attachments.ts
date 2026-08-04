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

import { useCallback, useRef, useState } from 'react'
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
/**
 * Mirrors MAX_IMAGE_BYTES in lib/ai-agent/attachment-reader.ts. An IMAGE has a
 * tighter ceiling than a document: over this the reader cannot build a vision
 * block at all and returns a "too large to look at" note instead.
 *
 * Checked here for the same reason the 20MB limit is — otherwise a phone photo of
 * a passport or an EIN letter (routinely 6-12MB) uploads green, sends, and the
 * assistant then says it cannot see it. Success followed by refusal is the failure
 * this file's size check exists to prevent; it was only preventing it for the
 * document limit.
 */
export const MAX_WORKER_IMAGE_MB = 5
export const MAX_WORKER_IMAGE_BYTES = MAX_WORKER_IMAGE_MB * 1024 * 1024

export function useWorkerAttachments() {
  const [files, setFiles] = useState<StagedAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [limitNotice, setLimitNotice] = useState<string | null>(null)

  /**
   * The authoritative list, updated SYNCHRONOUSLY.
   *
   * ⛔ WHY A REF AND NOT JUST STATE — this was a live bug, reproduced in a browser
   * on sandbox 2026-07-27. The accept/reject decision used to be computed INSIDE
   * the `setFiles` updater, and the upload loop then read the array that updater
   * had filled. React only evaluates an updater eagerly while the hook's update
   * queue is EMPTY; once anything else is queued (a remove, a clear, a second
   * attach in the same breath) it is deferred to the render pass. The code after
   * `setFiles` then saw an EMPTY accepted list, returned early, and never started
   * the upload — while the row still rendered, because the updater did eventually
   * run. Observable result: a file staged and stuck on "Uploading…" for ever, no
   * network request, no error, and it is silently dropped from the turn.
   *
   * The ref makes acceptance deterministic while KEEPING the property the updater
   * was there for: it is written before this call returns, so two fast pastes see
   * each other's count and cannot each stage a full five.
   */
  const filesRef = useRef<StagedAttachment[]>([])

  /** Single write path — ref first (synchronous truth), then state (render). */
  const writeFiles = useCallback((next: (prev: StagedAttachment[]) => StagedAttachment[]) => {
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

  /**
   * Put files BACK on the composer after a turn failed to send.
   *
   * The composer clears optimistically the moment a send starts, which is the
   * right feel — but it meant a failed turn ATE the attachment: the bubble in
   * the history still showed "📎 Tracking.xlsx", the staged file was gone, and
   * typing "try again" posted a message with NO file while the screen implied
   * otherwise. Luca hit exactly this after a transient provider overload
   * (td-bug 2026-08-03) and reasonably concluded the file was the problem.
   *
   * The uploaded bytes are still in the bucket, so restoring the refs is enough;
   * nothing is re-uploaded.
   */
  const restore = useCallback((items: UploadedAttachment[]) => {
    if (!items.length) return
    writeFiles((prev) => {
      const known = new Set(prev.map((f) => f.path).filter(Boolean))
      const revived = items
        .filter((i) => !known.has(i.path))
        .map((i) => ({
          localId: `restored-${i.path}`,
          name: i.name,
          size: i.size ?? 0,
          mimeType: i.mime_type ?? "application/octet-stream",
          path: i.path,
        }))
      return [...prev, ...revived].slice(0, MAX_FILES)
    })
  }, [writeFiles])

  const add = useCallback(async (incoming: File[]) => {
    if (!incoming.length) return

    // Room is computed against the ref, so it reflects files staged microseconds
    // ago by a still-unrendered call.
    const room = Math.max(0, MAX_FILES - filesRef.current.length)
    const take = incoming.slice(0, room)
    const overflow = incoming.length - take.length
    const accepted: Array<{ entry: StagedAttachment; file: File }> = take.map((file) => ({
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
          writeFiles((prev) => prev.map((f) => (f.localId === entry.localId ? { ...f, error } : f)))

        // Same type policy as every other chat upload (executables blocked).
        const validationError = validateChatAttachment(file.name, file.size, file.type)
        if (validationError) return fail(validationError)
        // ...but a tighter SIZE limit: chat allows 100MB, and the worker's reader
        // refuses anything over 20MB. Without this the upload goes green and the
        // worker then says it can't read the file — success followed by refusal.
        if (file.size > MAX_WORKER_FILE_BYTES) {
          return fail(`Too large for the worker to read: ${(file.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_WORKER_FILE_MB} MB).`)
        }
        // Images have their own, lower ceiling — see MAX_WORKER_IMAGE_BYTES.
        // Keyed on the declared type: the server sniffs the real bytes, so a
        // mislabelled file is still caught there; this is the early, honest warning.
        if (file.type.startsWith('image/') && file.size > MAX_WORKER_IMAGE_BYTES) {
          return fail(
            `Image too large for the worker to look at: ${(file.size / 1024 / 1024).toFixed(1)} MB (max ${MAX_WORKER_IMAGE_MB} MB). Screenshot it or export it smaller.`,
          )
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
          writeFiles((prev) => prev.map((f) => (f.localId === entry.localId ? { ...f, path } : f)))
        } catch (err) {
          fail(err instanceof Error && err.message ? err.message : 'Upload failed. Please try again.')
        }
      }),
    )
    setUploading(false)
  }, [writeFiles])

  // These two are read at SEND time, not during render, so they consult the ref
  // rather than rendered state: an upload that completed moments before the click
  // must count, and a file that just failed must not be silently sent past its
  // warning. `files` remains the render source.
  /** Files that actually made it to storage — the only ones worth sending. */
  const uploaded = useCallback((): UploadedAttachment[] => {
    return filesRef.current
      .filter((f): f is StagedAttachment & { path: string } => Boolean(f.path) && !f.error)
      .map((f) => ({ path: f.path, name: f.name, mime_type: f.mimeType, size: f.size }))
  }, [])

  /** Files that failed. Sending must not silently drop them. */
  const failed = useCallback(() => filesRef.current.filter((f) => f.error), [])

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
  return { files, uploading, limitNotice, add, remove, clear, restore, uploaded, failed, onPaste }
}

/** The shape the panel hands down to the composer and the drop zone. */
export type WorkerAttachments = ReturnType<typeof useWorkerAttachments>
