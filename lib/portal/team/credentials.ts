/**
 * Team member credentials the SYSTEM makes (dev job e5d5400d, Antonio 2026-10-22: no email for team members; the owner gets a
 * list with usernames and a Reset password button, and a ready-to-send handover message).
 *
 * Pure and client-safe except `generatePassword` (uses node/web crypto, fine on both).
 */

// No 0/O, 1/l/I: nothing that is easy to misread when it is typed from a message.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

/** 12 characters from an unambiguous alphabet, shown as 3 groups of 4 so it is easy to read out: `Kx7m-Qp3a-Zr9d`. */
export function generatePassword(randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  const need = 12
  const out: string[] = []
  // Rejection sampling so every character is equally likely (no modulo bias).
  const limit = 256 - (256 % PASSWORD_ALPHABET.length)
  while (out.length < need) {
    const bytes = randomBytes(need * 2)
    for (let i = 0; i < bytes.length && out.length < need; i++) {
      const b = bytes[i]
      if (b >= limit) continue
      out.push(PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length])
    }
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4, 8).join('')}-${out.slice(8, 12).join('')}`
}

function defaultRandomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n)
  globalThis.crypto.getRandomValues(a)
  return a
}

/** `Marco Rossi` -> `marco.rossi`; accents and odd characters dropped; empty falls back to `team`. Must satisfy the username rule (3-30: letters, numbers, dot, dash, underscore). */
export function usernameFromName(displayName: string): string {
  const base = (displayName ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 24)
  return base.length >= 3 ? base : (base ? `${base}.team` : 'team').slice(0, 24)
}

/**
 * A username as an exact (case-insensitive) pattern for ilike: `_`, `%` and `\` mean "any one letter", "anything" and the escape
 * in a LIKE pattern, so `a_b` used to match `a.b` too, and the lookup then found two people and signed neither in.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** First free username: `marco.rossi`, then `marco.rossi2`, `marco.rossi3`... */
export async function suggestUsername(displayName: string, isTaken: (usernameLower: string) => Promise<boolean>): Promise<string> {
  const base = usernameFromName(displayName)
  if (!(await isTaken(base))) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}${i}`
    if (!(await isTaken(candidate))) return candidate
  }
  // 98 taken in a row is very unlikely; try random endings, but never hand back one nobody checked.
  for (let i = 0; i < 10; i++) {
    const candidate = `${base}${Math.floor(Math.random() * 9000) + 1000}`
    if (!(await isTaken(candidate))) return candidate
  }
  throw new Error('Could not find a free username — please type one yourself')
}
