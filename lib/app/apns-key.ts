/**
 * TD Social — is the Apple alert key set? (pure, no imports; dev job 2072bc3e, Step 2 pull request C2; Council-reviewed plan of 5 Nov 2026.)
 *
 * The FIRST switch of the phone leg: no key, nothing happens, and nothing is read or loaded. This file has no imports so the two existing alert senders can
 * ask it on every alert at no cost. The three values are set by Antonio in the Vercel project (never printed, never logged, never in the repo):
 *   APNS_KEY_ID      the key's 10-character id (shown in his Apple account)
 *   APNS_TEAM_ID     his team's 10-character id
 *   APNS_PRIVATE_KEY the text of the .p8 file (a Vercel value may hold the line breaks as the two characters \n; both forms are accepted)
 */
export interface ApnsKey { keyId: string; teamId: string; privateKey: string }

const ID_RE = /^[A-Z0-9]{10}$/

/** The key text as PEM with real line breaks, or null when it does not look like a private key at all. */
export function normalizePrivateKey(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null
  const text = raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim()
  if (!/^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE KEY-----$/.test(text)) return null
  return text
}

/** All three values present and shaped right, else null. Anything else means "no key": the phone leg does nothing. */
export function readApnsKey(env: Record<string, string | undefined> = process.env): ApnsKey | null {
  const keyId = (env.APNS_KEY_ID ?? "").trim()
  const teamId = (env.APNS_TEAM_ID ?? "").trim()
  const privateKey = normalizePrivateKey(env.APNS_PRIVATE_KEY)
  if (!ID_RE.test(keyId) || !ID_RE.test(teamId) || !privateKey) return null
  return { keyId, teamId, privateKey }
}

/** The cheap first line of the phone leg: are the three values even present? (No parsing, no key material touched.) */
export function apnsConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY)
}
