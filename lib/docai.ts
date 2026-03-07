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
 * Download a file from Drive as binary (ArrayBuffer).
 * Used for PDFs and images before sending to Document AI.
 */
async function downloadFileAsBinary(fileId: string): Promise<{ data: ArrayBuffer; mimeType: string; name: string }> {
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

  // Check file size (DocAI limit: 20MB inline, we limit to 15MB to be safe)
  const size = meta.size ? parseInt(meta.size, 10) : 0
  if (size > 15 * 1024 * 1024) {
    throw new Error(`File too large for inline processing: ${(size / (1024 * 1024)).toFixed(1)}MB (max 15MB)`)
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
}

/**
 * OCR a file from Google Drive using Document AI.
 * Supports PDF, TIFF, GIF, JPEG, PNG, BMP, WEBP.
 */
export async function ocrDriveFile(fileId: string): Promise<OcrResult> {
  // 1. Download file from Drive
  const { data, mimeType, name } = await downloadFileAsBinary(fileId)

  // Validate MIME type
  const supportedMimes = [
    "application/pdf",
    "image/tiff", "image/gif", "image/jpeg", "image/png",
    "image/bmp", "image/webp",
  ]
  if (!supportedMimes.includes(mimeType)) {
    throw new Error(`Unsupported file type for OCR: ${mimeType}. Supported: PDF, TIFF, GIF, JPEG, PNG, BMP, WEBP`)
  }

  // 2. Base64 encode
  const base64Content = Buffer.from(data).toString("base64")

  // 3. Call Document AI
  const token = await getDocaiToken()

  const res = await fetch(DOCAI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      rawDocument: {
        content: base64Content,
        mimeType,
      },
      // Request full text and per-page text
      skipHumanReview: true,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Document AI error ${res.status}: ${err}`)
  }

  const result = (await res.json()) as {
    document?: {
      text?: string
      pages?: Array<{
        pageNumber?: number
        layout?: {
          textAnchor?: {
            textSegments?: Array<{ startIndex?: string; endIndex?: string }>
          }
          confidence?: number
        }
      }>
    }
  }

  const doc = result.document
  if (!doc) {
    throw new Error("Document AI returned no document")
  }

  const fullText = doc.text || ""

  // Extract per-page text using text anchors
  const pages: string[] = []
  let totalConfidence = 0
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
        totalConfidence += page.layout.confidence
        confidenceCount++
      }
    }
  }

  // If no per-page text was extracted, use full text as single page
  if (pages.length === 0 && fullText) {
    pages.push(fullText)
  }

  return {
    fullText,
    pages,
    pageCount: pages.length,
    fileName: name,
    mimeType,
    confidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
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
  const base64Content = Buffer.from(content).toString("base64")

  const token = await getDocaiToken()

  const res = await fetch(DOCAI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      rawDocument: {
        content: base64Content,
        mimeType,
      },
      skipHumanReview: true,
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Document AI error ${res.status}: ${err}`)
  }

  const result = (await res.json()) as {
    document?: {
      text?: string
      pages?: Array<{
        layout?: {
          textAnchor?: {
            textSegments?: Array<{ startIndex?: string; endIndex?: string }>
          }
          confidence?: number
        }
      }>
    }
  }

  const doc = result.document
  if (!doc) throw new Error("Document AI returned no document")

  const fullText = doc.text || ""
  const pages: string[] = []
  let totalConfidence = 0
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
        totalConfidence += page.layout.confidence
        confidenceCount++
      }
    }
  }

  if (pages.length === 0 && fullText) {
    pages.push(fullText)
  }

  return {
    fullText,
    pages,
    pageCount: pages.length,
    fileName,
    mimeType,
    confidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
  }
}
