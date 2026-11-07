/**
 * The default name of the document a workspace's e-sign panel opens the signing editor with (Tax Return: "Tax Return 2025 - Beta LLC").
 * It comes from the panel's stage layout (`rename`, a template with {company_name} and {year}), so a service is set up by data, not code.
 * A missing token is DROPPED (never printed as a blank gap or as the raw {token}); the result is trimmed and its spaces collapsed.
 * Returns undefined when there is no template or nothing is left — the panel then keeps its own default.
 *
 * Pure and client-safe.
 */
export function esignDocName(template: string | null | undefined, tokens: { company_name?: string | null; year?: number | string | null }): string | undefined {
  if (!template || !template.trim()) return undefined
  const company = (tokens.company_name ?? '').toString().trim()
  const year = tokens.year === null || tokens.year === undefined ? '' : String(tokens.year).trim()
  const out = template
    .replace(/\{company_name\}/g, company)
    .replace(/\{year\}/g, year)
    .replace(/\s+/g, ' ')
    .replace(/\s+([-–—])\s*$/g, '') // a dangling separator left by a dropped token
    .replace(/^\s*[-–—]\s+/g, '')
    .trim()
  return out || undefined
}
