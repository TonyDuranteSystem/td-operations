/**
 * The language written on a lead made through a booking link. contacts.language is dirty (English, Italian, null, "en", "Italiano", "Italian / Englis"...);
 * leads.language is canonical ("Italian" / "English"). A value we cannot read as one of the two is NOT written (the lead then has none, as for any booking that did not say).
 */
export function normalizeLeadLanguage(raw: unknown): "Italian" | "English" | null {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  if (!s) return null
  if (/^(it|ita|ital|italian|italiano|italiana)(\b|[^a-z])/.test(s)) return "Italian"
  if (/^(en|eng|engl|english|inglese)(\b|[^a-z])/.test(s)) return "English"
  return null
}
