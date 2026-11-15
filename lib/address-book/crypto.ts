/**
 * The Personal book is stored as ONE encrypted payload per person (address_book_personal.payload_enc). Pure; server only.
 * AES-256-GCM, key derived from a server-only secret (env ADDRESS_BOOK_PERSONAL_KEY), so a copy of the database, or any tool that can read the table, shows scrambled text.
 * The owner's id is bound in as additional authenticated data: a payload copied onto another owner's row fails to open.
 * Format: `v1.<iv>.<tag>.<ciphertext>` (base64url). A wrong secret, another owner, a changed value or any other format opens to null (never throws on read).
 * Same shape as lib/marketing/meta-leads/key-crypto.ts, with the owner binding added.
 */
import crypto from "crypto"

const VERSION = "v1"
export const PERSONAL_KEY_ENV = "ADDRESS_BOOK_PERSONAL_KEY"
const MIN_SECRET_LENGTH = 32

function derive(secret: string): Buffer {
  return crypto.createHash("sha256").update(`td-address-book-personal:v1:${secret}`, "utf8").digest()
}

/** The secret from the server environment, or null when it is missing or too short to trust. The Personal book is switched off while this is null. */
export function personalSecretFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const s = (env[PERSONAL_KEY_ENV] ?? "").trim()
  return s.length >= MIN_SECRET_LENGTH ? s : null
}

export function encryptPersonal(plain: string, secret: string | null | undefined, ownerId: string): string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) throw new Error("the Personal book key is not set, so nothing can be stored safely")
  if (!ownerId) throw new Error("no owner to store this person for")
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", derive(secret), iv)
  c.setAAD(Buffer.from(ownerId, "utf8"))
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()])
  return [VERSION, iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".")
}

export function decryptPersonal(blob: string | null | undefined, secret: string | null | undefined, ownerId: string): string | null {
  if (!blob || !secret || secret.length < MIN_SECRET_LENGTH || !ownerId) return null
  const parts = blob.split(".")
  if (parts.length !== 4 || parts[0] !== VERSION) return null
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", derive(secret), Buffer.from(parts[1], "base64url"))
    d.setAAD(Buffer.from(ownerId, "utf8"))
    d.setAuthTag(Buffer.from(parts[2], "base64url"))
    return Buffer.concat([d.update(Buffer.from(parts[3], "base64url")), d.final()]).toString("utf8")
  } catch {
    return null
  }
}

export function encryptPersonalJson(value: unknown, secret: string | null | undefined, ownerId: string): string {
  return encryptPersonal(JSON.stringify(value), secret, ownerId)
}

export function decryptPersonalJson<T = unknown>(blob: string | null | undefined, secret: string | null | undefined, ownerId: string): T | null {
  const plain = decryptPersonal(blob, secret, ownerId)
  if (plain === null) return null
  try {
    return JSON.parse(plain) as T
  } catch {
    return null
  }
}
