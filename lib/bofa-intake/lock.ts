/**
 * Bank of America intake — the "one-time link" rule, as pure functions.
 *
 * The first browser to open a link is locked in: a random secret is put in that browser's cookie
 * and only its SHA-256 hash is stored. The same browser can refresh or come back until it submits;
 * any other browser sees "already used". A submitted or revoked link is dead for everyone.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto"

export type LinkStatus = "pending" | "opened" | "completed" | "revoked"

export type LinkDecision =
  | { access: "claim" } // never opened — this visitor becomes the owner
  | { access: "owner" } // same browser that opened it
  | { access: "used" } // completed, revoked, or opened by someone else

export function cookieName(token: string): string {
  return `bofa_${token.slice(0, 16)}`
}

export function newSecret(): string {
  return randomBytes(24).toString("hex")
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

export function decideAccess(
  row: { status: LinkStatus; opener_hash: string | null },
  presentedSecret: string | null,
): LinkDecision {
  if (row.status === "completed" || row.status === "revoked") return { access: "used" }
  if (row.status === "pending" || !row.opener_hash) return { access: "claim" }
  if (!presentedSecret) return { access: "used" }
  const a = Buffer.from(hashSecret(presentedSecret))
  const b = Buffer.from(row.opener_hash)
  if (a.length !== b.length) return { access: "used" }
  return timingSafeEqual(a, b) ? { access: "owner" } : { access: "used" }
}
