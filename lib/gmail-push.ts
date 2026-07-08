/**
 * Real-time Gmail push (inbox Phase 3b).
 *
 * Gmail `users.watch` publishes to Pub/Sub topic `gmail-push` (GCP project
 * claude-gmail-connector-488713); a push subscription POSTs to
 * /api/webhooks/gmail-push with a Google-signed OIDC token (no shared
 * secrets). The webhook stores a wake-up row in `gmail_push_events`; the
 * dashboard listens via supabase_realtime and refetches unread state.
 *
 * Watches expire after ~7 days — the gmail-watch-renew cron re-registers
 * daily and keeps the push subscription pointed at the PROD endpoint. The
 * 5-minute email-monitor cron remains the delivery safety net.
 */

import { SignJWT, importPKCS8, jwtVerify, createRemoteJWKSet } from "jose"
import { gmailPost, getGoogleSACredentials } from "@/lib/gmail"
import { supabaseAdmin } from "@/lib/supabase-admin"

// gmail_watch_state is not in the generated Database types yet (types are
// regenerated from production after the prod DDL). Same escape hatch as
// lib/system-errors.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub"
const PUBSUB_API = "https://pubsub.googleapis.com/v1"
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs"

export const GMAIL_PUSH_TOPIC =
  process.env.GMAIL_PUSH_TOPIC ||
  "projects/claude-gmail-connector-488713/topics/gmail-push"
export const GMAIL_PUSH_SUBSCRIPTION_ID = "gmail-push-sub"

export const WATCHED_MAILBOXES: Record<string, string> = {
  support: "support@tonydurante.us",
  antonio: "antonio.durante@tonydurante.us",
}

/** Map the address Gmail reports back to our mailbox key. Pure — unit-tested. */
export function mailboxForAddress(emailAddress: string | null | undefined): string | null {
  if (!emailAddress) return null
  const normalized = emailAddress.toLowerCase().trim()
  for (const [key, addr] of Object.entries(WATCHED_MAILBOXES)) {
    if (addr === normalized) return key
  }
  return null
}

/** Decode a Pub/Sub push body into Gmail's notification. Pure — unit-tested. */
export function parsePushMessage(body: unknown): {
  emailAddress: string
  historyId: string
} | null {
  const data = (body as { message?: { data?: string } })?.message?.data
  if (!data) return null
  try {
    const json = JSON.parse(
      Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")
    ) as { emailAddress?: string; historyId?: number | string }
    if (!json.emailAddress || json.historyId === undefined) return null
    return { emailAddress: json.emailAddress, historyId: String(json.historyId) }
  } catch {
    return null
  }
}

// ─── Pub/Sub auth (SA itself, no impersonation) ─────────

let pubsubToken: { token: string; expiresAt: number } | null = null

async function getPubSubToken(): Promise<string> {
  if (pubsubToken && Date.now() < pubsubToken.expiresAt - 5 * 60 * 1000) {
    return pubsubToken.token
  }
  const creds = getGoogleSACredentials()
  const now = Math.floor(Date.now() / 1000)
  const privateKey = await importPKCS8(creds.private_key, "RS256")
  const assertion = await new SignJWT({ scope: PUBSUB_SCOPE })
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
    throw new Error(`Pub/Sub OAuth error ${res.status}: ${await res.text()}`)
  }
  const data = (await res.json()) as { access_token: string; expires_in: number }
  pubsubToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
  return data.access_token
}

// ─── Subscription management (idempotent) ───────────────

/**
 * Ensure the push subscription exists and points at `endpointUrl`, with an
 * OIDC token minted as our SA (audience = endpoint URL). Safe to call on
 * every cron run.
 */
export async function ensurePushSubscription(endpointUrl: string): Promise<void> {
  const creds = getGoogleSACredentials()
  const projectId = creds.project_id
  if (!projectId) throw new Error("GOOGLE_SA_KEY has no project_id")
  const token = await getPubSubToken()
  const subName = `projects/${projectId}/subscriptions/${GMAIL_PUSH_SUBSCRIPTION_ID}`

  const pushConfig = {
    pushEndpoint: endpointUrl,
    oidcToken: { serviceAccountEmail: creds.client_email, audience: endpointUrl },
  }

  const createRes = await fetch(`${PUBSUB_API}/${subName}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ topic: GMAIL_PUSH_TOPIC, pushConfig, ackDeadlineSeconds: 20 }),
  })
  if (createRes.ok) return

  if (createRes.status === 409) {
    // Already exists — keep its push config in sync
    const modifyRes = await fetch(`${PUBSUB_API}/${subName}:modifyPushConfig`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pushConfig }),
    })
    if (!modifyRes.ok) {
      throw new Error(`modifyPushConfig ${modifyRes.status}: ${await modifyRes.text()}`)
    }
    return
  }
  throw new Error(`create subscription ${createRes.status}: ${await createRes.text()}`)
}

// ─── Gmail watch management ─────────────────────────────

/** Register (or refresh) the INBOX watch for one mailbox and persist state. */
export async function registerWatch(mailbox: "support" | "antonio"): Promise<{
  historyId: string
  expiration: string
}> {
  const emailAddress = WATCHED_MAILBOXES[mailbox]
  const result = (await gmailPost(
    "/watch",
    {
      topicName: GMAIL_PUSH_TOPIC,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    },
    emailAddress
  )) as { historyId: string; expiration: string }

  await db.from("gmail_watch_state").upsert({
    mailbox,
    email_address: emailAddress,
    history_id: String(result.historyId),
    expiration: new Date(parseInt(result.expiration)).toISOString(),
    updated_at: new Date().toISOString(),
  })

  return result
}

// ─── Webhook auth ───────────────────────────────────────

const jwks = createRemoteJWKSet(new URL(GOOGLE_CERTS))

/**
 * Verify the Pub/Sub push OIDC token: Google-signed, issued to OUR service
 * account, with the webhook URL as audience. Fails closed.
 */
export async function verifyPushOidc(
  authorizationHeader: string | null,
  expectedAudience: string
): Promise<boolean> {
  if (!authorizationHeader?.startsWith("Bearer ")) return false
  try {
    const { payload } = await jwtVerify(authorizationHeader.slice(7), jwks, {
      issuer: "https://accounts.google.com",
      audience: expectedAudience,
    })
    const creds = getGoogleSACredentials()
    return (
      payload.email === creds.client_email &&
      (payload.email_verified === true || payload.email_verified === "true")
    )
  } catch {
    return false
  }
}
