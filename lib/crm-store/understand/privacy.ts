/**
 * File Understanding — small pure helpers about IDs and names (job 685467b5).
 */

/** Hide anything that looks like an ID / tax / account number before text is stored or shown in a report. */
export function maskIds(text: string): string {
  return text
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[number]")
    .replace(/\b\d{2}-\d{7}\b/g, "[number]")
    .replace(/\b\d{4}([ -]\d{4}){2,}\b/g, "[number]")
    .replace(/\b[A-Z]{1,2}\d{6,9}\b/g, "[number]")
    .replace(/\d[\d -]{5,}\d/g, (m) => (m.replace(/\D/g, "").length >= 7 ? "[number]" : m))
}

const LEGAL = new Set(["llc", "inc", "corp", "corporation", "co", "ltd", "limited", "company", "the", "and", "of", "srl", "spa", "lp", "llp", "pllc", "pc"])
const strip = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()

/** The words that identify an owner (legal suffixes and filler dropped): "DIECI DIECI COMPANY LLC" → dieci. */
export function ownerTokens(name: string | null | undefined): string[] {
  if (!name) return []
  return Array.from(new Set(strip(name).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !LEGAL.has(w))))
}

/** Does this text name the owner — every identifying word of the owner appears in it? null = the owner has no usable name. */
export function textNamesOwner(text: string, ownerName: string | null | undefined, aiCompany?: string | null): boolean | null {
  const tokens = ownerTokens(ownerName)
  if (tokens.length === 0) return null
  const hay = strip(text)
  if (tokens.every((t) => hay.includes(t))) return true
  if (aiCompany) {
    const a = ownerTokens(aiCompany)
    if (a.length > 0 && a.length === tokens.length && a.every((t) => tokens.includes(t))) return true
  }
  return false
}
