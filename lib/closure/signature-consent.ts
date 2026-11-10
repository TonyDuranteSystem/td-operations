/**
 * The client's signature for the EIN closure letter, drawn in the closure wizard (Company Closure part F, step 2; dev job a6bbea09).
 *
 * The signature travels like any other wizard upload: the browser draws a PNG, uploads it straight to the wizard bucket under the field
 * `signature_image` (the answers hold the PATH), the closure filing puts it in the client's storage package next to the documents, and the
 * letter builder (lib/closure/ein-closure-package.ts) puts it above the owner's name. This file is the part the SERVER owns:
 *   - the consent text the client saw (one constant, shown in the wizard AND recorded here — a client's request cannot supply its own);
 *   - the record of the consent: when, and from which address / browser (the wizard saves no audit data of its own);
 *   - nothing is recorded for a client who did not sign, and a client-supplied consent record is always thrown away.
 * A signature is NEVER taken from anywhere else (a passport photo is not a signature on this letter).
 * No imports: the texts are bundled into the browser too.
 */

/** The wizard field that holds the drawn signature (an array with one storage path, like every wizard file field). */
export const CLOSURE_SIGNATURE_FIELD = 'signature_image'

export const CLOSURE_SIGNATURE_CONSENT_EN =
  'By drawing and saving my signature I confirm that I am the owner of the company named above, and I authorize Tony Durante LLC to place my signature on this letter asking the IRS to close the EIN of that company and to send it to the IRS.'
export const CLOSURE_SIGNATURE_CONSENT_IT =
  'Disegnando e salvando la mia firma confermo di essere il titolare della società indicata sopra e autorizzo Tony Durante LLC ad apporre la mia firma su questa lettera con cui si chiede all’IRS di chiudere l’EIN di tale società e a inviarla all’IRS.'

/** The keys the server writes next to the answers (anything the client sent under these names is removed first). */
export const CLOSURE_SIGNATURE_RECORD_KEYS = ['signature_consent', 'signature_consent_locale', 'signature_signed_at', 'signature_ip', 'signature_user_agent', 'signature_for'] as const

/** The wizard sends which language the client SAW the consent in ('it' / 'en'); the server maps it to its own constant text and then removes this hint. */
export const CLOSURE_SIGNATURE_LOCALE_HINT = 'signature_locale'

/**
 * The wizard sends what the client SAW above the pad (company, EIN, owner — `signatureFingerprint` of the answers at the moment of drawing).
 * At submit the server compares it with the answers being submitted: a client who changed the company, the EIN or the owner AFTER drawing has
 * signed a letter that no longer says what they sent, so the signature is refused and they draw it again. The server then writes the
 * fingerprint of what was submitted next to the consent (`signature_for`) — the letter maker compares it with the letter it prints.
 */
export const CLOSURE_SIGNATURE_SEEN_HINT = 'signature_seen'

/** The wizard path scheme for this field: `closure/<id>/signature_image_<unique>_<file>` (lib: app/api/portal/wizard-upload-url). */
const SIGNATURE_PATH = /^closure\/[^/]+\/signature_image_[^/]+$/

/** The storage paths of the drawn signature in the answers — only real wizard-minted paths of this field count. */
export function signaturePathsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []
  return list.filter((p): p is string => typeof p === 'string' && SIGNATURE_PATH.test(p))
}

/** Letters and digits only (any alphabet) — "ZZQA Città & Café Test, L.L.C." and "zzqa citta and cafe test llc" are the same company to a human. */
export function normalizeCompanyName(name: unknown): string {
  const t = (typeof name === 'string' ? name : '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    // letters that do not split into a base letter + a mark
    .replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/ı/g, 'i').replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe')
    .replace(/\bl\.?\s?l\.?\s?c\.?(?![a-z])/g, ' llc ')
    .replace(/[\u0000-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u00bf\u2000-\u206f]/g, ' ') // drop ASCII/Latin-1 punctuation and symbols, KEEP letters of every alphabet (a Cyrillic or Greek name must not become empty)
  const words = t.split(/\s+/).filter(Boolean)
  while (words.length > 1 && /^(llc|inc|corp|corporation|ltd|co|company)$/.test(words[words.length - 1])) words.pop()
  return words.join('')
}

/** The 9 digits of an EIN, or '' ("88-1234567", "881234567" → "881234567"). */
export function einDigits(ein: unknown): string {
  const d = (typeof ein === 'string' ? ein : '').replace(/\D/g, '')
  return d.length === 9 ? d : ''
}

const ownerOf = (a: Record<string, unknown>): string => {
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() : '')
  const owner = `${s('owner_first_name')} ${s('owner_last_name')}`.trim()
  return (owner || `${s('first_name')} ${s('last_name')}`.trim()).toLowerCase().replace(/\s+/g, ' ')
}

/** What the letter says above the signature: company, EIN, owner — in one comparable string. */
export function signatureFingerprint(a: Record<string, unknown>): string {
  return `${normalizeCompanyName(a.llc_name)}|${einDigits(a.llc_ein)}|${ownerOf(a)}`
}

/** True when the company name and the EIN of two fingerprints agree (the owner's spelling may differ by a letter without making it another letter). */
export function sameSignedCompany(fpA: string, fpB: string): boolean {
  const [nameA, einA] = fpA.split('|')
  const [nameB, einB] = fpB.split('|')
  return !!nameA && nameA === nameB && !!einA && einA === einB
}

/**
 * Called by the wizard submit for a closure, BEFORE the answers are stored. Keeps exactly one signature path and writes the consent record
 * with the server's own clock, text and the caller's address; with no valid signature, drops the field and every consent key.
 * Mutates `data`; returns whether the client signed, and `changedAfterSigning` when the client drew it for other company details than the ones
 * they are now sending (the signature is then NOT kept — they must draw it again).
 */
export function applyClosureSignatureConsent(
  data: Record<string, unknown>,
  ctx: { ip: string | null; userAgent: string | null; now: Date },
): { signed: boolean; changedAfterSigning?: boolean } {
  const locale: 'en' | 'it' = data[CLOSURE_SIGNATURE_LOCALE_HINT] === 'it' ? 'it' : 'en'
  // what the client saw when drawing: the box sends it; a form re-opened from a SENT closure carries the server's own fingerprint of what was sent
  // (`signature_for`, saved with the answers) — the same fact, so it stands in when the hint was not sent
  const seenHint = typeof data[CLOSURE_SIGNATURE_SEEN_HINT] === 'string' ? (data[CLOSURE_SIGNATURE_SEEN_HINT] as string) : null
  const claimedFor = typeof data.signature_for === 'string' ? (data.signature_for as string) : null
  const seen = seenHint ?? claimedFor
  delete data[CLOSURE_SIGNATURE_LOCALE_HINT]
  delete data[CLOSURE_SIGNATURE_SEEN_HINT]
  for (const k of CLOSURE_SIGNATURE_RECORD_KEYS) delete data[k]
  const paths = signaturePathsOf(data[CLOSURE_SIGNATURE_FIELD])
  if (paths.length === 0) {
    delete data[CLOSURE_SIGNATURE_FIELD]
    return { signed: false }
  }
  const submitted = signatureFingerprint(data)
  // the wizard always sends what the client saw; a request without it (an old tab) or with other details is not a signature for THIS letter
  if (seen === null || seen !== submitted) {
    delete data[CLOSURE_SIGNATURE_FIELD]
    return { signed: false, changedAfterSigning: true }
  }
  data[CLOSURE_SIGNATURE_FIELD] = [paths[paths.length - 1]] // a second drawing replaces the first
  data.signature_consent = locale === 'it' ? CLOSURE_SIGNATURE_CONSENT_IT : CLOSURE_SIGNATURE_CONSENT_EN
  data.signature_consent_locale = locale
  data.signature_signed_at = ctx.now.toISOString()
  data.signature_ip = ctx.ip
  data.signature_user_agent = ctx.userAgent ? ctx.userAgent.slice(0, 300) : null
  data.signature_for = submitted
  return { signed: true }
}

/**
 * The answers WITHOUT the server-written consent record and the wizard's hints — for the duplicate-send check: the record carries the server's
 * clock, so two sends of the same form would never look the same (and a double click would make a second job).
 */
export function withoutSignatureRecord<T>(data: T): T {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const a = { ...(data as Record<string, unknown>) }
  for (const k of CLOSURE_SIGNATURE_RECORD_KEYS) delete a[k]
  delete a[CLOSURE_SIGNATURE_LOCALE_HINT]
  delete a[CLOSURE_SIGNATURE_SEEN_HINT]
  return a as T
}

/**
 * The answers as STAFF read them (the workspace's "Closure wizard answers" box): the technical consent record (address, browser, fingerprint) is
 * not a set of answers — it stays in the database as the audit record, and the box shows one plain line instead.
 */
export function presentClosureAnswers(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const a = { ...(data as Record<string, unknown>) }
  const signedAt = typeof a.signature_signed_at === 'string' ? a.signature_signed_at : ''
  const locale = a.signature_consent_locale === 'it' ? 'Italian' : 'English'
  const had = signedAt && typeof a.signature_consent === 'string'
  for (const k of CLOSURE_SIGNATURE_RECORD_KEYS) delete a[k]
  delete a[CLOSURE_SIGNATURE_LOCALE_HINT]
  delete a[CLOSURE_SIGNATURE_SEEN_HINT]
  if (had) {
    const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(signedAt))
    a.signature_drawn = `Yes — drawn by the client on ${day} (consent shown in ${locale})`
  }
  return a
}

/** First address of an x-forwarded-for header (the client's), or null. */
export function clientIpFromForwardedFor(header: string | null | undefined): string | null {
  const first = (header ?? '').split(',')[0]?.trim()
  return first ? first.slice(0, 64) : null
}

/** A PNG starts with these 8 bytes — the letter only embeds a real PNG. */
export function looksLikePng(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return bytes.length > 8 && sig.every((b, i) => bytes[i] === b)
}

/** Width and height from the PNG header (the first chunk is always IHDR), or null when the bytes are not a PNG with a readable header. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!looksLikePng(bytes) || bytes.length < 24) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = dv.getUint32(16)
  const height = dv.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** A drawn pad is a few hundred pixels wide; a picture over this is not a drawing (and a huge one could exhaust the server when it is decoded). */
export const MAX_SIGNATURE_PIXELS = 4000

/** Largest signature picture the letter will embed (a drawn pad is a few KB; this only stops an odd file). */
export const MAX_SIGNATURE_BYTES = 1_500_000
