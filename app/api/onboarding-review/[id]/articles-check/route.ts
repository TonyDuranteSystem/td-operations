/**
 * GET /api/onboarding-review/[id]/articles-check
 *
 * The State Filing ID check on the onboarding review screen (dev job 64d2be64, Antonio 2026-11-04): finds the Articles of Organization
 * the client uploaded in the wizard, reads the Filing ID off it with the same reader the formation upload window uses, and returns
 * short-lived links to the real document so the card can open it in a floating window. The reader only PREFILLS — staff confirm or
 * correct the number against the document before the review can be confirmed.
 *
 * GET → { success, has_articles, documents: [{ path, file_name, url, mime_type }], read_number, read_from, read_note }
 *   has_articles false  → the client uploaded nothing in the Articles slot (nothing to check against)
 *   read_number         → the Filing ID the reader found, or null (it found none, or could not read the file)
 *   read_from           → the path of the file the number was read from (the card opens that one first)
 *   read_note           → when nothing was read: WHY, in plain words, if it is known (ran out of time, file too large, unreadable)
 * The documents come back even when the reading failed, so staff can always open them. [id] = onboarding_submissions.id.
 * Read-only, staff-only; the reading has a time budget and skips very large files — a slow scan never costs staff the documents.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { createSignedUrlMap } from '@/lib/storage/signed-urls'
import { DOCAI_INLINE_MAX_BYTES, ocrRawContent } from '@/lib/docai'
import { parseFilingId } from '@/lib/articles-parse'
import { articlesUploads, mimeTypeFromFileName, ownedUploadPaths, pickOcrMimeType } from '@/lib/flows/onboarding-articles'

const UPLOAD_BUCKET = 'onboarding-uploads'
// A client can upload several files into the Articles slot; the reader looks at the first few, in upload order, until one gives a number.
const MAX_FILES_READ = 3
// The whole reading stops after this long (the platform limit is 60 s and the screen must still get the documents back), and one file
// never gets more than PER_FILE_MS of it.
const READ_BUDGET_MS = 40_000
const PER_FILE_MS = 25_000

class ReaderTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReaderTimeout('reader timed out')), ms)
    work.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

const NOTE_SUFFIX = 'Open it and type the number from the real document.'
const NOTE_TIMEOUT = `The reader ran out of time on this document. ${NOTE_SUFFIX}`
const NOTE_TOO_LARGE = `This file is too large for the reader (over ${Math.round(DOCAI_INLINE_MAX_BYTES / (1024 * 1024))} MB). ${NOTE_SUFFIX}`
const NOTE_UNREADABLE = `The reader could not read this file. ${NOTE_SUFFIX}`

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const startedAt = Date.now()
  try {
    const { data: sub, error } = await supabaseAdmin
      .from('onboarding_submissions')
      .select('token, contact_id, account_id, offer_id, lead_id, upload_paths')
      .eq('id', params.id)
      .single()
    if (error || !sub) {
      return NextResponse.json({ success: false, error: 'Submission not found' }, { status: 404 })
    }

    const { owned } = ownedUploadPaths(sub, (sub.upload_paths as string[] | null) || [])
    const articles = articlesUploads(owned)
    if (articles.length === 0) {
      return NextResponse.json({ success: true, has_articles: false, documents: [], read_number: null, read_from: null, read_note: null })
    }

    // a failure to make the links must not take the documents list (or the reading) down with it — the screen shows "link could not be made"
    let signed = new Map<string, string>()
    try {
      signed = await createSignedUrlMap(UPLOAD_BUCKET, articles)
    } catch {
      signed = new Map()
    }
    const documents = articles.map((path) => {
      const fileName = path.replace(/^\/+/, '').split('/').pop() || path
      return { path, file_name: fileName, url: signed.get(path) || null, mime_type: mimeTypeFromFileName(fileName) }
    })

    let readNumber: string | null = null
    let readFrom: string | null = null
    // the first reason a file could not be read; only used when no file gave a number
    let readNote: string | null = null
    const note = (text: string) => { if (!readNote) readNote = text }
    for (const doc of documents.slice(0, MAX_FILES_READ)) {
      const remaining = READ_BUDGET_MS - (Date.now() - startedAt)
      if (remaining <= 1000) { note(NOTE_TIMEOUT); break }
      try {
        const { data, error: dlErr } = await withTimeout(supabaseAdmin.storage.from(UPLOAD_BUCKET).download(doc.path), Math.min(PER_FILE_MS, remaining))
        if (dlErr || !data) { note(NOTE_UNREADABLE); continue }
        if (data.size > DOCAI_INLINE_MAX_BYTES) { note(NOTE_TOO_LARGE); continue }
        const buf = Buffer.from(await data.arrayBuffer())
        const left = READ_BUDGET_MS - (Date.now() - startedAt)
        const ocr = await withTimeout(
          ocrRawContent(
            buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
            pickOcrMimeType(data.type, doc.mime_type),
            doc.file_name,
          ),
          Math.min(PER_FILE_MS, Math.max(left, 1000)),
        )
        const found = ocr?.fullText ? parseFilingId(ocr.fullText) : null
        if (found) {
          readNumber = found
          readFrom = doc.path
          readNote = null
          break
        }
      } catch (e) {
        // one slow or unreadable file must not hide the documents — the card then says why nothing was read
        note(e instanceof ReaderTimeout ? NOTE_TIMEOUT : NOTE_UNREADABLE)
      }
    }

    return NextResponse.json(
      { success: true, has_articles: true, documents, read_number: readNumber, read_from: readFrom, read_note: readNumber ? null : readNote },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    )
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
