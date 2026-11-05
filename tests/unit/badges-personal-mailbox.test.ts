/**
 * /api/dashboard/badges — the Inbox's red number counts only the mailboxes THAT login may open (dev job 1e82504b).
 *
 * antonio@ is Antonio's PERSONAL mailbox (admin only — lib/inbox/mailbox-access.ts). The number used to add it for every
 * dashboard login, so a team login saw a number its own Inbox could never show — and the response carried the count of a
 * mailbox it must not read. Promises under test:
 *   • a team login: support@ only; antonio@ is never even asked for; nothing about it leaves the server
 *   • the admin: support@ + antonio@
 *   • no login found, or the login lookup failing: support@ only (fails closed)
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const gmailGetMock = vi.fn()
vi.mock("@/lib/gmail", () => ({ gmailGet: (...a: unknown[]) => gmailGetMock(...a) }))

// every table read answers "nothing" — this test is about the Gmail numbers only
function chain(): Record<string, unknown> {
  const b: Record<string, unknown> = {}
  const self = () => b
  for (const m of ["select", "eq", "is", "in", "neq", "gt", "limit", "order"]) b[m] = self
  b.maybeSingle = async () => ({ data: null, error: null })
  b.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 })
  return b
}
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => chain(), rpc: async () => ({ data: [], error: null }) }),
}))

let lookup: () => Promise<{ data: { user: unknown } }> = async () => ({ data: { user: null } })
vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ auth: { getUser: () => lookup() } }) }))

vi.mock("@/lib/inbox/whatsapp-unread", () => ({ getWhatsappUnread: async () => 0 }))
vi.mock("@/lib/marketing/guard", () => ({ adminMemberContext: async () => ({ ok: false }) }))
vi.mock("@/lib/marketing/menu-unread", () => ({ marketingChatUnread: async () => 0 }))

import { GET } from "@/app/api/dashboard/badges/route"

const SUPPORT = "support@tonydurante.us"
const ANTONIO = "antonio.durante@tonydurante.us"

beforeEach(() => {
  gmailGetMock.mockReset()
  gmailGetMock.mockImplementation(async (_endpoint: string, _params: unknown, asUser: string) => ({
    messagesUnread: asUser === ANTONIO ? 40 : 3,
  }))
})

const ask = () => GET(new Request("http://localhost/api/dashboard/badges"))
const askedFor = (address: string) => gmailGetMock.mock.calls.some((c) => c[2] === address)

describe("the Inbox red number follows the mailbox rule", () => {
  it("a team login gets support@ only — antonio@ is never asked for and no count of it leaves the server", async () => {
    lookup = async () => ({ data: { user: { id: "u-team", email: "luca@tonydurante.us", app_metadata: { role: "team" } } } })
    const body = await (await ask()).json()
    expect(body.inbox).toBe(3)
    expect(askedFor(SUPPORT)).toBe(true)
    expect(askedFor(ANTONIO)).toBe(false)
    expect(body._debug.antonioUnread).toBe(0)
  })

  it("the admin gets support@ + antonio@", async () => {
    lookup = async () => ({ data: { user: { id: "u-admin", email: ANTONIO, app_metadata: { role: "admin" } } } })
    const body = await (await ask()).json()
    expect(body.inbox).toBe(43)
    expect(askedFor(ANTONIO)).toBe(true)
  })

  it("an admin by role (not by address) is also counted the same way the Inbox lets them in", async () => {
    lookup = async () => ({ data: { user: { id: "u-2", email: "jodi@tonydurante.us", app_metadata: { role: "admin" } } } })
    expect((await (await ask()).json()).inbox).toBe(43)
  })

  it("no login found → support@ only (fails closed)", async () => {
    lookup = async () => ({ data: { user: null } })
    const body = await (await ask()).json()
    expect(body.inbox).toBe(3)
    expect(askedFor(ANTONIO)).toBe(false)
  })

  it("the login lookup failing → support@ only (fails closed)", async () => {
    lookup = async () => { throw new Error("auth down") }
    const body = await (await ask()).json()
    expect(body.inbox).toBe(3)
    expect(askedFor(ANTONIO)).toBe(false)
  })

  it("a user whose metadata merely SAYS admin (user_metadata) is not admin — only app_metadata counts", async () => {
    lookup = async () => ({ data: { user: { id: "u-3", email: "x@tonydurante.us", app_metadata: { role: "team" }, user_metadata: { role: "admin" } } } })
    const body = await (await ask()).json()
    expect(body.inbox).toBe(3)
    expect(askedFor(ANTONIO)).toBe(false)
  })
})
