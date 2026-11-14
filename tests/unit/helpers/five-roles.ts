/**
 * The five-role behaviour pattern for an admin-only route (Booking page). A route is called as admin, team, partner, client, marketing and anonymous with a database
 * that THROWS on any use: everyone but the admin must get a 403 and must never reach the database. Test helper only — holds no real data.
 */
export interface FakeUser { id: string; email: string; app_metadata: Record<string, unknown>; user_metadata?: Record<string, unknown> }

export const ROLES: Record<string, FakeUser | null> = {
  admin: { id: "u-admin", email: "antonio.durante@tonydurante.us", app_metadata: { role: "admin" } },
  team: { id: "u-team", email: "support@tonydurante.us", app_metadata: { role: "team" } },
  partner: { id: "u-partner", email: "partner@example.com", app_metadata: { role: "partner" } },
  client: { id: "u-client", email: "client@example.com", app_metadata: { role: "client" } },
  marketing: { id: "u-mkt", email: "marketing@example.com", app_metadata: { role: "marketing" } },
  anonymous: null,
  // user_metadata is writable by the account holder: claiming admin there must change nothing
  selfDeclaredAdmin: { id: "u-liar", email: "liar@example.com", app_metadata: { role: "client" }, user_metadata: { role: "admin" } },
}

export const NON_ADMIN_ROLES = Object.keys(ROLES).filter((r) => r !== "admin")

/** A database stand-in that fails the test the moment anything touches it. */
export function throwingDb(onTouch: () => void) {
  return new Proxy({}, { get() { onTouch(); throw new Error("the database was touched before the admin check passed") } })
}
