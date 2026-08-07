/**
 * Backup codes for staff MFA (dev job de4564ee) — generation + hashing.
 * Node runtime only (API routes); never imported by middleware.
 *
 * Council constraints:
 *  - Codes are 130-bit crypto.getRandomValues output rendered as Crockford
 *    base32 (26 chars, grouped for readability) — NEVER user-chosen, never
 *    Math.random. That entropy is what makes unsalted SHA-256 storage
 *    acceptable (Security review).
 *  - One-shot recovery semantics live in the consuming route, not here.
 */

import { createHash, randomBytes } from 'node:crypto'

export const BACKUP_CODE_COUNT = 10

// Crockford base32 — no I, L, O, U: unambiguous when read from paper.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_CHARS = 26 // 26 × 5 bits = 130 bits

/** One code like "3F9KM-Q7XVA-58RTC-2HJWB-DNZE0-P" (26 chars in groups of 5). */
function generateOneCode(): string {
  const bytes = randomBytes(CODE_CHARS)
  let out = ''
  for (let i = 0; i < CODE_CHARS; i++) {
    out += ALPHABET[bytes[i] % 32]
    if ((i + 1) % 5 === 0 && i !== CODE_CHARS - 1) out += '-'
  }
  return out
}

/** Strip separators/whitespace, uppercase — tolerant of hand-typed input. */
export function normalizeBackupCode(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}

export function hashBackupCode(raw: string): string {
  return createHash('sha256').update(normalizeBackupCode(raw)).digest('hex')
}

export function generateBackupCodes(): { codes: string[]; hashes: string[] } {
  const codes: string[] = []
  const hashes: string[] = []
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = generateOneCode()
    codes.push(code)
    hashes.push(hashBackupCode(code))
  }
  return { codes, hashes }
}
