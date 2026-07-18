/**
 * Google Document AI Helper
 * Uses the same Service Account as Drive (GOOGLE_SA_KEY) to call Document AI OCR.
 *
 * Processor: td-document-ocr (ID: 1c600f9361e28081, region: us)
 * Project: 796202564410
 *
 * Flow:
 *   1. Download file from Drive as binary (ArrayBuffer)
 *   2. Base64-encode the content
 *   3. Send to Document AI ProcessDocument endpoint
 *   4. Return extracted text (+ per-page text for classification)
 */

import { SignJWT, importPKCS8 } from "jose"
import { selectWindow, isEmptyWindow, type PageRange } from "@/lib/docai-windows"

// ─── Configuration ──────────────────────────────────────────

interface SACredentials {
  client_email: string
  private_key: string
  token_uri: string
}

// Separate token cache for DocAI (different scope than Drive)
let cachedToken: { token: string; expiresAt: number } | null = null

function getCredentials(): SACredentials {
  const b64 = process.env.GOOGLE_SA_KEY
  if (!b64) throw new Error("GOOGLE_SA_KEY not configured")

  const json = Buffer.from(b64, "base64").toString("utf-8")
  return JSON.parse(json)
}

const DOCAI_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"
const IMPERSONATE_EMAIL = () =>
  process.env.GOOGLE_IMPERSONATE_EMAIL || "support@tonydurante.us"

const DOCAI_PROJECT = "796202564410"
const DOCAI_LOCATION = "us"
const DOCAI_PROCESSOR = "1c600f9361e28081"
const DOCAI_ENDPOINT = `https://us-documentai.googleapis.com/v1/projects/${DOCAI_PROJECT}/locations/${DOCAI_LOCATION}/processors/${DOCAI_PROCESSOR}:process`

// ─── Token Management ───────────────────────────────────────

/**
 * Get access token for Document AI API (cloud-platform scope).
 * Service Account direct auth (no DWD impersonation needed for DocAI).
 */
async function getDocaiToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) {
    return cachedToken.token
  }

  const creds = getCredentials()
  const now = Math.floor(Date.now() / 1000)

  const privateKey = await importPKCS8(creds.private_key, "RS256")
  const assertion = await new SignJWT({
    scope: DOCAI_SCOPE,
    // No 'sub' — DocAI uses SA directly, not impersonation
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(creds.client_email)
    .setAudience(creds.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey)

  const res = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`DocAI OAuth error ${res.status}: ${err}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  return data.access_token
}

/**
 * Get access token for Drive API (drive scope + impersonation).
 * Separate from the google-drive.ts cache to avoid conflicts.
 */
let cachedDriveToken: { token: string; expiresAt: number } | null = null

async function getDriveToken(): Promise<string> {
  if (cachedDriveToken && Date.now() < cachedDriveToken.expiresAt - 5 * 60 * 1000) {
    return cachedDriveToken.token
  }

  const creds = getCredentials()
  const now = Math.floor(Date.now() / 1000)

  const privateKey = await importPKCS8(creds.private_key, "RS256")
  const assertion = await new SignJWT({
    scope: DRIVE_SCOPE,
    sub: IMPERSONATE_EMAIL(),
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(creds.client_email)
    .setAudience(creds.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey)

  const res = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Drive OAuth error ${res.status}: ${err}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedDriveToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  return data.access_token
}

// ─── Drive File Download (binary) ───────────────────────────

const DRIVE_API = "https://www.googleapis.com/drive/v3"

/**
 * Per-REQUEST inline ceiling for Document AI (their documented limit is 20MB of
 * BASE64; base64 inflates by 4/3, so ~15MB of raw bytes is the safe raw figure).
 * This is the default for every existing caller — unchanged behaviour.
 */
export const DOCAI_INLINE_MAX_BYTES = 15 * 1024 * 1024

/**
 * Ceiling for a file we download in order to SPLIT it locally. Higher than the
 * inline ceiling because the inline limit is a per-REQUEST constraint, not a
 * per-FILE one: a 35-page scan can be far larger than any single window we send.
 *
 * 40MB is deliberately conservative. Peak memory for this path is roughly 7x the
 * file (raw buffer + pdf-lib object graph + copied window + base64 + the JSON
 * copy of that base64 + the fetch serialization), so 40MB implies a ~280MB peak.
 * An OOM here is NOT a catchable exception — it kills the invocation, so the
 * caller's try/catch never runs and the "reading FAILED is not the same as the
 * document being empty" contract is lost. Hence a pre-download metadata check
 * rather than discovering the size by dying.
 *
 * TODO(measure): instrument heapUsed around a real 35-page scan and raise only
 * against that measurement — this number is arithmetic, not observation.
 */
export const DOCAI_SPLIT_MAX_BYTES = 40 * 1024 * 1024

/**
 * Download a file from Drive as binary (ArrayBuffer).
 * Used for PDFs and images before sending to Document AI.
 */
async function downloadFileAsBinary(
  fileId: string,
  opts: { maxBytes?: number } = {},
): Promise<{ data: ArrayBuffer; mimeType: string; name: string }> {
  const maxBytes = opts.maxBytes ?? DOCAI_INLINE_MAX_BYTES
  const token = await getDriveToken()

  // Get metadata first
  const metaRes = await fetch(
    `${DRIVE_API}/files/${fileId}?fields=name,mimeType,size&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!metaRes.ok) {
    throw new Error(`Drive metadata ${metaRes.status}: ${metaRes.statusText}`)
  }
  const meta = (await metaRes.json()) as { name: string; mimeType: string; size?: string }

  // Check file size BEFORE downloading — an oversize file must be a returned
  // error, never an out-of-memory kill (which no catch block can observe).
  // NOTE: the phrase "too large" is load-bearing — lib/itin/finalize-approval.ts
  // string-matches it to tell staff "file too large for OCR" rather than dumping
  // a raw error at them. Do not reword it without updating that branch.
  const size = meta.size ? parseInt(meta.size, 10) : 0
  if (size > maxBytes) {
    throw new Error(`File too large for inline processing: ${(size / (1024 * 1024)).toFixed(1)}MB (max ${Math.round(maxBytes / (1024 * 1024))}MB)`)
  }

  // Download binary content
  const dataRes = await fetch(
    `${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!dataRes.ok) {
    throw new Error(`Drive download ${dataRes.status}: ${dataRes.statusText}`)
  }

  const data = await dataRes.arrayBuffer()
  return { data, mimeType: meta.mimeType, name: meta.name }
}

// ─── Document AI OCR ────────────────────────────────────────

export interface OcrResult {
  /** Full extracted text from all pages */
  fullText: string
  /** Text per page (index 0 = page 1) */
  pages: string[]
  /** Number of pages processed */
  pageCount: number
  /** File name from Drive */
  fileName: string
  /** File MIME type */
  mimeType: string
  /** Confidence score (0-1, average across pages) */
  confidence: number
  /**
   * TRUE page count of the source document, from the local split — set only on a
   * WINDOWED read. `pageCount` above is the number of pages OCR'd, which on a
   * windowed read is the WINDOW's size, not the document's. Conflating the two
   * makes the reader report "this document has 15 pages" for a 35-page return.
   */
  documentPageCount?: number
  /** Absolute 1-based page number of `pages[0]`. 1 on a non-windowed read. */
  windowStart?: number
}

/** Raw Document AI response shape (the subset we consume). */
interface DocaiResponse {
  document?: {
    text?: string
    pages?: Array<{
      pageNumber?: number
      layout?: {
        textAnchor?: { textSegments?: Array<{ startIndex?: string; endIndex?: string }> }
        confidence?: number
      }
    }>
  }
}

/**
 * Turn one Document AI response into per-page text + confidence. PURE.
 *
 * Extracted because this logic existed VERBATIM TWICE (ocrDriveFile and
 * ocrRawContent) — the council flagged that a third copy would guarantee the
 * copies drift, and the path that would not get the fix is the one feeding
 * passport/ITIN identity writeback.
 *
 * Anchor safety: startIndex/endIndex are offsets into THIS response's own
 * `text`. They are resolved here, inside the response that produced them, and
 * never across a concatenation — slicing merged text with per-response anchors
 * silently returns another page's content with no error.
 */
function parseDocaiDocument(doc: NonNullable<DocaiResponse["document"]>): {
  fullText: string
  pages: string[]
  confidenceSum: number
  confidenceCount: number
} {
  const fullText = doc.text || ""
  const pages: string[] = []
  let confidenceSum = 0
  let confidenceCount = 0

  if (doc.pages) {
    for (const page of doc.pages) {
      const segments = page.layout?.textAnchor?.textSegments || []
      let pageText = ""
      for (const seg of segments) {
        const start = parseInt(seg.startIndex || "0", 10)
        const end = parseInt(seg.endIndex || "0", 10)
        pageText += fullText.slice(start, end)
      }
      pages.push(pageText)

      if (page.layout?.confidence !== undefined) {
        confidenceSum += page.layout.confidence
        confidenceCount++
      }
    }
  }

  // No per-page anchors came back — fall back to one page holding everything.
  // Callers doing page arithmetic MUST notice this (pages.length no longer
  // matches the input page count) rather than indexing into a collapsed array.
  if (pages.length === 0 && fullText) pages.push(fullText)

  return { fullText, pages, confidenceSum, confidenceCount }
}

/** POST one document's bytes to Document AI and parse the response. */
async function processWithDocai(
  content: ArrayBuffer | Buffer,
  mimeType: string,
): Promise<ReturnType<typeof parseDocaiDocument>> {
  const base64Content = Buffer.from(content as ArrayBuffer).toString("base64")
  const token = await getDocaiToken()

  const res = await fetch(DOCAI_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      rawDocument: { content: base64Content, mimeType },
      skipHumanReview: true,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Document AI error ${res.status}: ${err}`)
  }

  const result = (await res.json()) as DocaiResponse
  const doc = result.document
  if (!doc) throw new Error("Document AI returned no document")
  return parseDocaiDocument(doc)
}

export interface OcrDriveFileOptions {
  /**
   * Inclusive 1-based page range to read. PDF only. When set, the file is split
   * locally and ONLY that window is sent to Document AI — which is what makes a
   * document longer than Google's 15-page synchronous limit readable at all.
   *
   * OPT-IN by design: every existing caller omits it and keeps the exact
   * whole-document behaviour. That matters beyond back-compat — a windowing
   * DEFAULT would silently feed truncated documents to the identity-writeback
   * paths (passport, ITIN) and to the stored-text pipeline.
   */
  pages?: PageRange
  /** Override the per-request page cap. Defaults to Google's synchronous limit. */
  pageLimit?: number
  /** Override the download size ceiling. Defaults differ for windowed vs whole-file reads. */
  maxBytes?: number
}

/**
 * OCR a file from Google Drive using Document AI.
 * Supports PDF, TIFF, GIF, JPEG, PNG, BMP, WEBP.
 *
 * Without `opts.pages` this behaves exactly as it always has: one call, whole
 * file, subject to the 15MB inline ceiling.
 */
export async function ocrDriveFile(
  fileId: string,
  opts: OcrDriveFileOptions = {},
): Promise<OcrResult> {
  const windowed = !!opts.pages

  // 1. Download. A windowed read is allowed a larger file, because the inline
  //    ceiling constrains each REQUEST we send, not the file we split locally.
  const { data, mimeType, name } = await downloadFileAsBinary(fileId, {
    maxBytes: windowed ? (opts.maxBytes ?? DOCAI_SPLIT_MAX_BYTES) : opts.maxBytes,
  })

  // Validate MIME type
  const supportedMimes = [
    "application/pdf",
    "image/tiff", "image/gif", "image/jpeg", "image/png",
    "image/bmp", "image/webp",
  ]
  if (!supportedMimes.includes(mimeType)) {
    throw new Error(`Unsupported file type for OCR: ${mimeType}. Supported: PDF, TIFF, GIF, JPEG, PNG, BMP, WEBP`)
  }

  // 2. Windowed path — PDF ONLY. pdf-lib cannot load a raster image, so every
  //    non-PDF keeps the exact single-call path it has always had. Routing
  //    images through the splitter would break fax receipts and ID photos,
  //    which read fine today.
  if (windowed && mimeType === "application/pdf") {
    return ocrPdfWindow(Buffer.from(data), mimeType, name, opts.pages as PageRange, opts.pageLimit)
  }

  // 3. Unwindowed path — byte-identical to the behaviour every existing caller
  //    has always had. All 14 call sites pass no options and land here.
  const parsed = await processWithDocai(data, mimeType)
  return {
    fullText: parsed.fullText,
    pages: parsed.pages,
    pageCount: parsed.pages.length,
    fileName: name,
    mimeType,
    confidence: parsed.confidenceCount > 0 ? parsed.confidenceSum / parsed.confidenceCount : 0,
    documentPageCount: parsed.pages.length,
    windowStart: 1,
  }
}

/**
 * OCR one page-window of a PDF: split locally, send ONLY that window.
 *
 * The local split is what makes a long scan readable at all — Document AI's
 * synchronous endpoint refuses the whole document, and its own page parameter
 * cannot help because the refusal happens before any page selection.
 */
async function ocrPdfWindow(
  buffer: Buffer,
  mimeType: string,
  name: string,
  requested: PageRange,
  pageLimit?: number,
): Promise<OcrResult> {
  const { PDFDocument } = await import("pdf-lib")

  // Read the TRUE page count locally — free, instant, and the only number that
  // can honestly answer "how long is this document?" when we OCR part of it.
  let src: import("pdf-lib").PDFDocument
  let documentPageCount: number
  try {
    // NOTE: no `ignoreEncryption` here, deliberately. That flag lets pdf-lib load
    // a password-protected file whose streams are still encrypted, producing
    // blank pages that OCR to nothing — which the reader would then report as
    // "no text, maybe a poor scan" for a document that is simply locked. Letting
    // the load THROW keeps "locked" distinguishable from "blank".
    src = await PDFDocument.load(buffer)
    documentPageCount = src.getPageCount()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/encrypt/i.test(msg)) {
      throw new Error("This PDF is password-protected, so its pages cannot be read.")
    }
    throw new Error(`This PDF could not be opened for page selection: ${msg}`)
  }

  const selection = selectWindow(requested, documentPageCount, pageLimit)
  const [start, end] = selection.window

  if (isEmptyWindow(selection.window)) {
    return {
      fullText: "",
      pages: [],
      pageCount: 0,
      fileName: name,
      mimeType,
      confidence: 0,
      documentPageCount,
      windowStart: start,
    }
  }

  // Copy just this window into its own PDF.
  const out = await PDFDocument.create()
  const indices: number[] = []
  for (let p = start; p <= end; p++) indices.push(p - 1) // 1-based → 0-based
  const copied = await out.copyPages(src, indices)
  copied.forEach((p) => out.addPage(p))
  const windowBytes = Buffer.from(await out.save())

  // The inline ceiling applies to what we SEND, not to the source file.
  // DOCAI_INLINE_MAX_BYTES is already the RAW-byte figure derived from Google's
  // 20MB base64 limit (20 ÷ 4/3 ≈ 15), so compare raw bytes directly.
  if (windowBytes.length > DOCAI_INLINE_MAX_BYTES) {
    throw new Error(
      `Pages ${start}-${end} are too large to read in one pass (${(windowBytes.length / (1024 * 1024)).toFixed(1)}MB). Ask for fewer pages at a time.`,
    )
  }

  const parsed = await processWithDocai(windowBytes, mimeType)

  return {
    fullText: parsed.fullText,
    pages: parsed.pages,
    pageCount: parsed.pages.length,
    fileName: name,
    mimeType,
    confidence: parsed.confidenceCount > 0 ? parsed.confidenceSum / parsed.confidenceCount : 0,
    documentPageCount,
    windowStart: start,
  }
}

/**
 * OCR from raw content (already downloaded file).
 * Useful when you have the binary data from another source.
 */
export async function ocrRawContent(
  content: ArrayBuffer,
  mimeType: string,
  fileName: string,
): Promise<OcrResult> {
  const parsed = await processWithDocai(content, mimeType)
  return {
    fullText: parsed.fullText,
    pages: parsed.pages,
    pageCount: parsed.pages.length,
    fileName,
    mimeType,
    confidence: parsed.confidenceCount > 0 ? parsed.confidenceSum / parsed.confidenceCount : 0,
    documentPageCount: parsed.pages.length,
    windowStart: 1,
  }
}
