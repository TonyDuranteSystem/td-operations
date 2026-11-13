/**
 * A standing scan over the Booking page's own files: every API route must open with the shared admin gate, and nothing booking-related may fall back to the weaker
 * staff checks. Pure (the test reads the files and passes the text in). It FAILS on dead code too: the gate must be the FIRST await of each exported handler.
 * The behaviour test (tests/unit/booking-admin-gate.test.ts) is the real proof; this scan keeps a future route from forgetting the gate at all.
 */

const HANDLERS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const
const WEAK = [/requireStaffRoute/, /isDashboardUser/, /isStaffUser/, /\bisTeam\s*\(/]

export function adminRouteViolations(fileName: string, source: string): string[] {
  const problems: string[] = []
  for (const w of WEAK) if (w.test(source)) problems.push(`${fileName}: uses a weaker check (${w.source}) — booking routes are admin-only`)
  const exported = HANDLERS.filter((m) => new RegExp(`export\\s+async\\s+function\\s+${m}\\b`).test(source))
  if (exported.length === 0 && /\bexport\s+(?:const|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/.test(source)) problems.push(`${fileName}: a handler is exported in a form this scan cannot read — use "export async function"`)
  for (const m of exported) {
    const start = source.search(new RegExp(`export\\s+async\\s+function\\s+${m}\\b`))
    const body = source.slice(start)
    const open = body.indexOf("{", body.indexOf(")"))
    const rest = open >= 0 ? body.slice(open + 1) : ""
    const firstAwait = rest.search(/\bawait\b/)
    const head = firstAwait >= 0 ? rest.slice(firstAwait, firstAwait + 60) : ""
    const gate = m === "GET" ? /^await\s+requireAdmin(?:Json)?Route\(/ : /^await\s+requireAdminJsonRoute\(/
    if (!gate.test(head)) problems.push(`${fileName}: ${m} does not open with ${m === "GET" ? "await requireAdminRoute()" : "await requireAdminJsonRoute(req)"}`)
  }
  return problems
}

/** Pages and layouts of the Booking page: the admin check must be there (the middleware's admin-only list cannot be edited, so the page guards itself). */
export function adminPageViolations(fileName: string, source: string): string[] {
  const problems: string[] = []
  for (const w of WEAK) if (w.test(source)) problems.push(`${fileName}: uses a weaker check (${w.source}) — the Booking page is admin-only`)
  if (!/isSecureAdmin\s*\(/.test(source)) problems.push(`${fileName}: never calls isSecureAdmin() (every booking page and layout must)`)
  return problems
}
