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
export const CLOSURE_SIGNATURE_RECORD_KEYS = ['signature_consent', 'signature_consent_locale', 'signature_signed_at', 'signature_ip', 'signature_user_agent'] as const

/** The wizard sends which language the client SAW the consent in ('it' / 'en'); the server maps it to its own constant text and then removes this hint. */
export const CLOSURE_SIGNATURE_LOCALE_HINT = 'signature_locale'

/** The wizard path scheme for this field: `closure/<id>/signature_image_<unique>_<file>` (lib: app/api/portal/wizard-upload-url). */
const SIGNATURE_PATH = /^closure\/[^/]+\/signature_image_[^/]+$/

/** The storage paths of the drawn signature in the answers — only real wizard-minted paths of this field count. */
export function signaturePathsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : []
  return list.filter((p): p is string => typeof p === 'string' && SIGNATURE_PATH.test(p))
}

/**
 * Called by the wizard submit for a closure, BEFORE the answers are stored. Keeps exactly one signature path and writes the consent record
 * with the server's own clock, text and the caller's address; with no valid signature, drops the field and every consent key.
 * Mutates `data`; returns whether the client signed.
 */
export function applyClosureSignatureConsent(
  data: Record<string, unknown>,
  ctx: { ip: string | null; userAgent: string | null; now: Date },
): { signed: boolean } {
  const locale: 'en' | 'it' = data[CLOSURE_SIGNATURE_LOCALE_HINT] === 'it' ? 'it' : 'en'
  delete data[CLOSURE_SIGNATURE_LOCALE_HINT]
  for (const k of CLOSURE_SIGNATURE_RECORD_KEYS) delete data[k]
  const paths = signaturePathsOf(data[CLOSURE_SIGNATURE_FIELD])
  if (paths.length === 0) {
    delete data[CLOSURE_SIGNATURE_FIELD]
    return { signed: false }
  }
  data[CLOSURE_SIGNATURE_FIELD] = [paths[paths.length - 1]] // a second drawing replaces the first
  data.signature_consent = locale === 'it' ? CLOSURE_SIGNATURE_CONSENT_IT : CLOSURE_SIGNATURE_CONSENT_EN
  data.signature_consent_locale = locale
  data.signature_signed_at = ctx.now.toISOString()
  data.signature_ip = ctx.ip
  data.signature_user_agent = ctx.userAgent ? ctx.userAgent.slice(0, 300) : null
  return { signed: true }
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

/** Largest signature picture the letter will embed (a drawn pad is a few KB; this only stops an odd file). */
export const MAX_SIGNATURE_BYTES = 1_500_000
