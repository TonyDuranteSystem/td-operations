/**
 * Which files are a person's ID papers (passport, ID card, driver's licence …) — the ones that stay in the PERSON's own storage
 * and never go into a company's (Antonio, 2026-10-21). Two views of the same rule:
 *   - isIdFieldName: a stored upload name starts with its form field ({field}_{unique}_{file}) — the banking package uses it;
 *   - looksLikeIdPaper: a staff-moved file keeps any name, so ANY ID word in it counts (over-blocking only refuses a move).
 */
const ID_FIELD = /^(passport|member_passport|owner_passport|selfie|id[_-]|photo[_-]?id|identity|proof[_-]of[_-]identity|national[_-]?id|driver|drivers[_-]|licen[sc]e|visa|residence[_-]?permit|ssn|itin)/i
const ID_WORD = /(passport|passaporto|identity|identit[aà]|carta\s*d.?\s*identit|id[\s_-]*card|national[\s_-]*id|driver|patente|licen[sc]e|residence[\s_-]*permit|permesso\s*di\s*soggiorno|\bssn\b|social\s*security)/i

export function isIdFieldName(storedName: string): boolean {
  return ID_FIELD.test(storedName)
}

export function looksLikeIdPaper(name: string): boolean {
  return ID_FIELD.test(name) || ID_WORD.test(name)
}
