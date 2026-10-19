/**
 * Encrypts the Facebook Page key before it is stored (pure; server; TD Marketing, dev job 9aec66fa).
 * AES-256-GCM. The encryption key is derived from the Meta app secret (already a server-only secret on Vercel), so a copy of the database
 * alone never reveals the Page key. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url). A wrong secret, a changed value or any other format
 * decrypts to null (never throws), and the caller falls back to the Vercel setting and says "connect again".
 */
import crypto from "crypto"

const VERSION = "v1"

function derive(secret: string): Buffer {
  return crypto.createHash("sha256").update(`td-marketing-meta-page-key:v1:${secret}`, "utf8").digest()
}

export function encryptPageKey(plain: string, secret: string | null | undefined): string {
  if (!secret) throw new Error("the Meta app secret is not set, so a key cannot be stored safely")
  if (!plain) throw new Error("no key to store")
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", derive(secret), iv)
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()])
  return [VERSION, iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".")
}

export function decryptPageKey(blob: string | null | undefined, secret: string | null | undefined): string | null {
  if (!blob || !secret) return null
  const parts = blob.split(".")
  if (parts.length !== 4 || parts[0] !== VERSION) return null
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", derive(secret), Buffer.from(parts[1], "base64url"))
    d.setAuthTag(Buffer.from(parts[2], "base64url"))
    const plain = Buffer.concat([d.update(Buffer.from(parts[3], "base64url")), d.final()]).toString("utf8")
    return plain || null
  } catch {
    return null
  }
}
