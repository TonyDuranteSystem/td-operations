/**
 * Fax — personal papers (the protection that outlived the old auto-filing).
 *
 * Until 2026-10-20 this file also decided WHERE a faxed upload was copied by reading the company and the year out of the file name
 * (dev job 264bb882, S1d). That guessing is gone: staff now choose in the "Where should this be saved?" window
 * (`components/storage/save-where-dialog.tsx`, rules in `lib/crm-store/save-where.ts`, checks in `lib/crm-store/save-destination.ts`).
 * What stays is the protection for a PERSON's own paper:
 *   - an identity / residence paper (passport, ID, visa, I-94, birth certificate, SSN, W-7/ITIN, proof of address …) is never saved
 *     in a company's or a person's storage from the Fax tool;
 *   - an SS-4 or a 1040-family return is saved where staff chose, but is NEVER listed on a company's Documents tab.
 */

/** Identity and residence papers: they belong to ONE person and never go into a company's or a person's storage from here. */
const IDENTITY = /(passport|passaporto|id[ _-]?card|identity|driver|licen[cs]e|carta d.identit|birth cert|\bvisa\b|\bi-?94\b|\bw-?7\b|\bitin\b|\bssn\b|social security|proof of address|utility bill|\bw-?8-?ben\b|\b8843\b)/i
/** Forms that carry a person's tax id: SS-4 names a responsible person; 1040 / 1040-NR are an individual's return. */
const PERSONAL_FORM = /(\bss-?4\b|\b1040(?:-?(?:nr|sr|x))?\b)/i

export type PersonalKind = "identity" | "form" | null

/** Pure: is this file name a person's own paper? "identity" = never in client storage; "form" = saved, but kept off the company's Documents tab. */
export function personalKind(fileName: string): PersonalKind {
  if (IDENTITY.test(fileName)) return "identity"
  if (PERSONAL_FORM.test(fileName)) return "form"
  return null
}

/**
 * A person's own paper in either sense. CONSERVATIVE: a company return (1120, 1065, 5472 …) is not personal. Used by the
 * "Don't save" copy (a personal paper keeps the bucket copy but is attached to NO company).
 */
export function looksPersonal(fileName: string): boolean {
  return personalKind(fileName) !== null
}
