/**
 * Gmail API Helper — for dashboard inbox
 * Reuses SA + DWD auth pattern from /lib/mcp/tools/gmail.ts
 * Impersonates support@tonydurante.us
 */

import { SignJWT, importPKCS8 } from "jose"

// ─── Configuration ──────────────────────────────────────

interface SACredentials {
  client_email: string
  private_key: string
  token_uri: string
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>()

function getCredentials(): SACredentials {
  const b64 = process.env.GOOGLE_SA_KEY
  if (!b64) throw new Error("GOOGLE_SA_KEY not configured")
  const json = Buffer.from(b64, "base64").toString("utf-8")
  return JSON.parse(json)
}

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
].join(" ")

const DEFAULT_EMAIL = () =>
  process.env.GOOGLE_IMPERSONATE_EMAIL || "support@tonydurante.us"

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1"

// ─── Token Management ───────────────────────────────────

export async function getGmailToken(
  asUser?: string
): Promise<{ token: string; userEmail: string }> {
  const userEmail = asUser || DEFAULT_EMAIL()
  const cached = tokenCache.get(userEmail)

  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return { token: cached.token, userEmail }
  }

  const creds = getCredentials()
  const now = Math.floor(Date.now() / 1000)

  const privateKey = await importPKCS8(creds.private_key, "RS256")
  const assertion = await new SignJWT({
    scope: GMAIL_SCOPES,
    sub: userEmail,
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
    throw new Error(`Gmail OAuth error ${res.status}: ${err}`)
  }

  const data = (await res.json()) as {
    access_token: string
    expires_in: number
  }
  tokenCache.set(userEmail, {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  })

  return { token: data.access_token, userEmail }
}

// ─── API Helpers ────────────────────────────────────────

export async function gmailGet(
  endpoint: string,
  params?: Record<string, string | string[]>,
  asUser?: string
) {
  const { token, userEmail } = await getGmailToken(asUser)
  const url = new URL(`${GMAIL_API}/users/${userEmail}${endpoint}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, item)
      } else {
        url.searchParams.set(k, v)
      }
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Gmail API ${res.status}: ${
        (err as { error?: { message?: string } }).error?.message ||
        res.statusText
      }`
    )
  }

  return res.json()
}

export async function gmailPost(
  endpoint: string,
  body: Record<string, unknown>,
  asUser?: string
) {
  const { token, userEmail } = await getGmailToken(asUser)

  const res = await fetch(`${GMAIL_API}/users/${userEmail}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Gmail API ${res.status}: ${
        (err as { error?: { message?: string } }).error?.message ||
        res.statusText
      }`
    )
  }

  return res.json()
}

// ─── DELETE ────────────────────────────────────────────

export async function gmailDelete(endpoint: string, asUser?: string) {
  const { token, userEmail } = await getGmailToken(asUser)
  const res = await fetch(`${GMAIL_API}/users/${userEmail}${endpoint}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Gmail DELETE ${res.status}: ${(err as { error?: { message?: string } }).error?.message || res.statusText}`)
  }
  // DELETE returns 204 No Content
  if (res.status === 204) return {}
  return res.json()
}

// ─── Attachment Download ────────────────────────────────

/**
 * Download a Gmail attachment as binary Buffer.
 * Returns the decoded binary data + metadata.
 */
export async function getGmailAttachment(
  messageId: string,
  attachmentId: string,
  asUser?: string,
): Promise<{ data: Buffer; size: number }> {
  const { token, userEmail } = await getGmailToken(asUser)

  const res = await fetch(
    `${GMAIL_API}/users/${userEmail}/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(
      `Gmail attachment ${res.status}: ${
        (err as { error?: { message?: string } }).error?.message || res.statusText
      }`
    )
  }

  const json = (await res.json()) as { data: string; size: number }
  // Gmail returns base64url-encoded data — convert to standard base64 then to Buffer
  const base64 = json.data.replace(/-/g, "+").replace(/_/g, "/")
  const buffer = Buffer.from(base64, "base64")
  return { data: buffer, size: json.size }
}

// ─── Email Parsing Helpers ──────────────────────────────

interface GmailHeader {
  name: string
  value: string
}

interface GmailPart {
  mimeType: string
  body?: { data?: string; size?: number }
  parts?: GmailPart[]
}

export interface GmailAPIMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet: string
  payload: {
    headers: GmailHeader[]
    mimeType: string
    body?: { data?: string; size?: number }
    parts?: GmailPart[]
  }
  internalDate: string
}

export function getHeader(
  headers: GmailHeader[] | undefined,
  name: string
): string {
  if (!headers) return ""
  return (
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ||
    ""
  )
}

export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(base64, "base64").toString("utf-8")
}

export function extractBody(payload: GmailAPIMessage["payload"]): string {
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data)
    // If the top-level body is HTML, strip tags
    if (payload.mimeType === "text/html" || decoded.trimStart().startsWith("<")) {
      return decoded
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    }
    return decoded
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBase64Url(part.body.data)
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = decodeBase64Url(part.body.data)
        return html
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/p>/gi, "\n\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .trim()
      }
    }
    for (const part of payload.parts) {
      if (part.parts) {
        const body = extractBody({
          headers: [],
          mimeType: part.mimeType,
          parts: part.parts,
        })
        if (body) return body
      }
    }
  }

  return ""
}
