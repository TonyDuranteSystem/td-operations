/**
 * Which documents are "sensitive" for the Mac app. DECISION CHANGED 2026-10-17 (Antonio, evening): passports, IDs and ITIN papers MUST open
 * on the Macs ("passports, IDs and ITIN has to open"). They are no longer refused. What "sensitive" now means: the file is opened like any
 * other, but every open gets an EXTRA audit row, and the Mac keeps the copy only 2 minutes (other files: 15 minutes) — see keepSecondsFor.
 * PURE; the SERVER decides and tells the app in the file answer.
 *
 * Sensitive =
 *  1. the identity / ITIN document TYPES (slugs of the document-type catalog): passports, IDs, W-7 (and its certificate-of-acceptance
 *     copy), 1040-NR, ITIN letter / application / Schedule OI;
 *  2. ANY file with no type inside a PERSON's storage (an untyped file there could be a passport nobody has typed yet);
 *  3. an UNTYPED file anywhere else whose NAME looks like one of those papers (production has hundreds of untyped company files, some of
 *     them ITIN / W-7 material) — until someone types it, it opens in the CRM only.
 * The list is a decision of Antonio's; a type is added here only when he says so. (Not covered, on purpose: types like irs_notice_personal
 * — Antonio has not decided.)
 */
import { DEFAULT_SENSITIVE_TYPES } from "./settings"

/** The built-in list (the `sensitiveTypes` setting overrides it — Antonio decides what is on it). */
export const SENSITIVE_DOCUMENT_TYPES: readonly string[] = DEFAULT_SENSITIVE_TYPES

const SENSITIVE_NAME_PATTERNS: readonly RegExp[] = [
  /\bitin\b/, /\bw ?7\b/, /\bpassport\b/, /\bpassaporto\b/, /\bssn\b/, /social security/, /driver s? licen[cs]e/, /\bid (card|document)\b/,
  /\bidentit/, /carta d ?identit/, /permesso di soggiorno/, /codice fiscale/, /\b1040 ?nr\b/, /schedule oi\b/,
]

/** PURE: does a file NAME look like an identity / ITIN paper? Separators (_ - . parentheses) count as spaces. */
export function looksSensitiveByName(name: string | null | undefined): boolean {
  const n = (name ?? "").toLowerCase().replace(/[_\-.()\[\]'’]+/g, " ").replace(/\s+/g, " ").trim()
  return !!n && SENSITIVE_NAME_PATTERNS.some((re) => re.test(n))
}

export function isSensitiveForDevice(p: { documentType: string | null | undefined; ownerKind: string | null | undefined; name?: string | null }, types: readonly string[] = SENSITIVE_DOCUMENT_TYPES): boolean {
  const t = (p.documentType ?? "").trim().toLowerCase()
  if (t) return types.includes(t)
  if (p.ownerKind === "person") return true
  return looksSensitiveByName(p.name)
}

/** How long a Mac may keep the copy of an opened file (the `keepSecondsSensitive` / `keepSecondsNormal` settings; built-in 2 minutes / 15 minutes). */
export function keepSecondsFor(sensitive: boolean, s: { keepSecondsSensitive: number; keepSecondsNormal: number } = { keepSecondsSensitive: 120, keepSecondsNormal: 900 }): number {
  return sensitive ? s.keepSecondsSensitive : s.keepSecondsNormal
}
