/**
 * TD Marketing password reset (dev job 9aec66fa): the real createOwnerReset / requestForgotPassword / completeReset code driven against a small in-memory database, a fake login system
 * and a fake mailbox. Each test is a way the reset could be misused or break.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { hashInviteToken, GENERIC_INVITE_ERROR as _unused, TRY_AGAIN_ERROR, WEAK_PASSWORD_ERROR } from "@/lib/marketing/invite-rules"

void _unused
type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}
let seq = 0
let tableMissing = false
/** tables whose reads fail, and whether giving a link back (used_at -> null) fails */
const readFails = new Set<string>()
let unclaimFails = false

function builder(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let op: "select" | "insert" | "update" | "delete" = "select"
  let payload: Row = {}
  let opts: { count?: string; head?: boolean } | undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {
    select: (_c?: string, o?: { count?: string; head?: boolean }) => { opts = o ?? opts; return b },
    insert: (p: Row) => { op = "insert"; payload = p; return b },
    update: (p: Row) => { op = "update"; payload = p; return b },
    delete: () => { op = "delete"; return b },
    eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return b },
    in: (c: string, v: unknown[]) => { filters.push(r => v.includes(r[c])); return b },
    is: (c: string, v: unknown) => { filters.push(r => (r[c] ?? null) === v); return b },
    gte: (c: string, v: string) => { filters.push(r => String(r[c]) >= v); return b },
    order: () => b, limit: () => b,
    maybeSingle: () => run().then(r => ({ data: (r.data as Row[] | null)?.[0] ?? null, error: r.error })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then: (res: any, rej: any) => run().then(res, rej),
  }
  async function run(): Promise<{ data: Row[] | null; count?: number; error: { code?: string; message?: string } | null }> {
    if (tableMissing && table === "marketing_password_resets") return { data: null, error: { code: "42P01", message: 'relation "marketing_password_resets" does not exist' } }
    const rows = (tables[table] ||= [])
    if (op === "select" && readFails.has(table)) return { data: null, error: { message: "database timeout" } }
    if (op === "update" && unclaimFails && payload.used_at === null) return { data: null, error: { message: "database timeout" } }
    if (op === "delete") {
      const gone = rows.filter(r => filters.every(f => f(r)))
      gone.forEach(r => rows.splice(rows.indexOf(r), 1))
      return { data: gone.map(r => ({ id: r.id })), error: null }
    }
    if (op === "insert") {
      if (table === "marketing_password_resets" && rows.some(r => r.user_id === payload.user_id && !r.used_at && !r.revoked_at)) return { data: null, error: { code: "23505", message: "duplicate" } }
      rows.push({ id: `id-${++seq}`, created_at: new Date().toISOString(), used_at: null, revoked_at: null, ...payload })
      return { data: null, error: null }
    }
    const hit = rows.filter(r => filters.every(f => f(r)))
    if (op === "update") { hit.forEach(r => Object.assign(r, payload)); return { data: hit.map(r => ({ id: r.id })), error: null } }
    if (opts?.head) return { data: null, count: hit.length, error: null }
    return { data: hit, error: null }
  }
  return b
}

type AuthUser = { id: string; email: string; banned_until?: string | null; app_metadata?: Row; user_metadata?: Row }
const users: Record<string, AuthUser> = {}
const updateUserById = vi.fn()
const getUserByIdFails: { status?: number } = {}
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (t: string) => builder(t),
    auth: { admin: {
      getUserById: async (id: string) => (getUserByIdFails.status ? { data: { user: null }, error: { status: getUserByIdFails.status, message: "x" } } : users[id] ? { data: { user: users[id] }, error: null } : { data: { user: null }, error: { status: 404, message: "not found" } }),
      updateUserById: (...a: unknown[]) => updateUserById(...a),
    } },
  },
}))
const alertForgotProblem = vi.fn(async (_email: string, _reason: string) => {})
vi.mock("@/lib/marketing/reset-alert", () => ({ alertForgotProblem: (e: string, r: string) => alertForgotProblem(e, r) }))
const findMarketing = vi.fn()
vi.mock("@/lib/auth-admin-helpers", () => ({ findMarketingAuthUserByEmail: (e: string) => findMarketing(e) }))
vi.mock("@/lib/config", () => ({ APP_BASE_URL: "https://app.example" }))
vi.mock("@/lib/marketing/settings", () => ({ getMarketingSetting: vi.fn(async () => ({})) }))
const sent: Array<{ raw: string }> = []
let sendFails = false
vi.mock("@/lib/gmail", () => ({ gmailPost: async (_p: string, body: { raw: string }) => { if (sendFails) throw new Error("gmail down"); sent.push(body); return {} } }))
vi.mock("@/lib/mcp/safe-send", () => ({
  safeSend: async (o: { idempotencyCheck: () => Promise<unknown>; sendFn: () => Promise<unknown>; postSendSteps: unknown[] }) => { await o.idempotencyCheck(); await o.sendFn(); return { alreadySent: false } },
}))

import { completeReset, createOwnerReset, requestForgotPassword } from "@/lib/marketing/password-reset"
import { GENERIC_RESET_ERROR } from "@/lib/marketing/reset-rules"
import type { Actor } from "@/lib/marketing/members"

const TEAM = "team-1"
const PASSWORD = "A-long-enough-password-1"
const owner: Actor = { kind: "owner", userId: "00000000-0000-4000-8000-000000000001", label: "owner@td.us", permissions: [] }
const admin: Actor = { kind: "admin", userId: "00000000-0000-4000-8000-000000000009", label: "antonio@td.us", permissions: [] }
const decoded = () => sent.map(s => Buffer.from(s.raw, "base64url").toString("utf8")).join("\n")
const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]{43})/.exec(Buffer.from(/\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/.exec(text)?.[1]?.replace(/\r\n/g, "") ?? "", "base64").toString("utf8"))?.[1] ?? ""
const resetRows = () => tables.marketing_password_resets ?? []

function addLogin(id: string, email: string, role: string | undefined, memberRole: "owner" | "member" | null, status = "active", extra: Partial<AuthUser> = {}) {
  users[id] = { id, email, app_metadata: { role }, user_metadata: { full_name: "Rocco Resta" }, ...extra }
  if (memberRole) tables.marketing_team_members.push({ team_id: TEAM, user_id: id, member_role: memberRole, status, token_version: 1, bundle: null, permissions: [] })
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  for (const k of Object.keys(users)) delete users[k]
  sent.length = 0; sendFails = false; tableMissing = false; getUserByIdFails.status = undefined
  readFails.clear(); unclaimFails = false; alertForgotProblem.mockClear()
  updateUserById.mockReset(); updateUserById.mockResolvedValue({ error: null })
  findMarketing.mockReset()
  tables.marketing_team_members = []
  tables.marketing_teams = [{ id: TEAM, status: "active" }]
  tables.marketing_password_resets = []
  addLogin("00000000-0000-4000-8000-000000000001", "owner@td.us", "marketing", "owner")
  addLogin("00000000-0000-4000-8000-000000000002", "rocco@example.test", "marketing", "member")
  findMarketing.mockImplementation(async (e: string) => Object.values(users).find(u => u.email === e && u.app_metadata?.role === "marketing") ?? null)
})

describe("createOwnerReset", () => {
  it("an owner makes a link for a member: only the HASH is stored, the link carries the token, it lasts a day", async () => {
    const r = await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000002", actor: owner })
    expect(r.ok).toBe(true)
    const url = r.data!.resetUrl
    const token = /token=([A-Za-z0-9_-]{43})$/.exec(url)![1]
    expect(url.startsWith("https://app.example/marketing/reset?token=")).toBe(true)
    expect(resetRows()).toHaveLength(1)
    expect(resetRows()[0].token_hash).toBe(hashInviteToken(token))
    expect(JSON.stringify(resetRows())).not.toContain(token)
    expect(resetRows()[0].requested_by).toBe("owner@td.us")
    expect(new Date(r.data!.expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 3600 * 1000)
    expect(r.data!.email).toBe("rocco@example.test")
  })
  it("a new link cancels the earlier open one for the same login", async () => {
    await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000002", actor: owner })
    await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000002", actor: owner })
    expect(resetRows()).toHaveLength(2)
    expect(resetRows().filter(r => !r.revoked_at && !r.used_at)).toHaveLength(1)
  })
  it("refused: yourself, a team owner (unless Antonio), a paused or unknown person, and a login that is not a marketing login", async () => {
    addLogin("00000000-0000-4000-8000-000000000003", "owner2@td.us", "marketing", "owner")
    addLogin("00000000-0000-4000-8000-000000000004", "p@example.test", "marketing", "member", "paused")
    addLogin("00000000-0000-4000-8000-000000000005", "antonio@td.us", "admin", "owner")
    addLogin("00000000-0000-4000-8000-000000000006", "c@example.test", "client", "member")
    expect((await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000001", actor: owner })).ok).toBe(false)
    expect((await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000003", actor: owner })).ok).toBe(false)
    expect((await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000004", actor: owner })).ok).toBe(false)
    expect((await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-00000000000a", actor: owner })).ok).toBe(false)
    expect((await createOwnerReset({ teamId: TEAM, userId: "not-a-uuid-but-unknown", actor: owner })).ok).toBe(false)
    expect((await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000005", actor: admin })).ok).toBe(false)
    expect((await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000006", actor: admin })).ok).toBe(false)
    expect(resetRows()).toHaveLength(0)
  })
  it("Antonio may make one for a team owner", async () => {
    addLogin("00000000-0000-4000-8000-000000000003", "owner2@td.us", "marketing", "owner")
    expect((await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000003", actor: admin })).ok).toBe(true)
  })
  it("a member without the manage-team right cannot", async () => {
    const plain: Actor = { kind: "member", userId: "00000000-0000-4000-8000-000000000008", label: "m2@td.us", permissions: ["leads.read"] }
    const r = await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000002", actor: plain })
    expect(r.ok).toBe(false)
    expect(resetRows()).toHaveLength(0)
  })
  it("a person of ANOTHER team cannot be reached", async () => {
    users["00000000-0000-4000-8000-000000000007"] = { id: "00000000-0000-4000-8000-000000000007", email: "o@example.test", app_metadata: { role: "marketing" } }
    tables.marketing_team_members.push({ team_id: "team-2", user_id: "00000000-0000-4000-8000-000000000007", member_role: "member", status: "active", token_version: 1 })
    expect((await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000007", actor: owner })).ok).toBe(false)
  })
  it("the hourly limit stops a flood", async () => {
    for (let i = 0; i < 20; i++) resetRows().push({ id: `x${i}`, requested_by: "owner@td.us", created_at: new Date().toISOString(), user_id: `u${i}` })
    const r = await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000002", actor: owner })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Too many/)
  })
  it("when the database step has not been run, it says so plainly", async () => {
    tableMissing = true
    const r = await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000002", actor: owner })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not ready yet/)
  })
})

describe("requestForgotPassword", () => {
  it("an address that is not an email is the only thing that says no", async () => {
    expect((await requestForgotPassword({ email: "nonsense" })).valid).toBe(false)
    expect((await requestForgotPassword({ email: 42 })).valid).toBe(false)
  })
  it("an unknown address: same answer, nothing stored, nothing sent", async () => {
    const r = await requestForgotPassword({ email: "nobody@example.test" })
    expect(r.valid).toBe(true)
    expect(resetRows()).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })
  it("a team member gets ONE email, at the address of his own login, with a link that matches the stored hash and lasts an hour", async () => {
    const r = await requestForgotPassword({ email: " Rocco@Example.test ", lang: "it" })
    expect(r.valid).toBe(true)
    expect(sent).toHaveLength(1)
    const mime = decoded()
    expect(mime).toContain("To: rocco@example.test")
    const token = tokenFrom(mime)
    expect(token).toHaveLength(43)
    expect(resetRows()).toHaveLength(1)
    expect(resetRows()[0].token_hash).toBe(hashInviteToken(token))
    expect(resetRows()[0].requested_by).toBe("self")
    expect(new Date(String(resetRows()[0].expires_at)).getTime() - Date.now()).toBeLessThan(61 * 60 * 1000)
  })
  it("a paused member, a removed member, a login with no membership, or a switched-off team gets nothing", async () => {
    addLogin("p", "paused@example.test", "marketing", "member", "paused")
    addLogin("r", "removed@example.test", "marketing", "member", "removed")
    addLogin("n", "nomember@example.test", "marketing", null)
    for (const e of ["paused@example.test", "removed@example.test", "nomember@example.test"]) await requestForgotPassword({ email: e })
    tables.marketing_teams = [{ id: TEAM, status: "paused" }]
    await requestForgotPassword({ email: "rocco@example.test" })
    expect(sent).toHaveLength(0)
    expect(resetRows()).toHaveLength(0)
  })
  it("a closed (banned) login gets nothing", async () => {
    addLogin("b", "banned@example.test", "marketing", "member", "active", { banned_until: new Date(Date.now() + 86400000).toISOString() })
    await requestForgotPassword({ email: "banned@example.test" })
    expect(sent).toHaveLength(0)
  })
  it("the third request in an hour still works, the fourth is silently ignored (same answer)", async () => {
    for (let i = 0; i < 5; i++) expect((await requestForgotPassword({ email: "rocco@example.test" })).valid).toBe(true)
    expect(sent).toHaveLength(3)
    expect(resetRows().filter(r => !r.revoked_at && !r.used_at)).toHaveLength(1)
  })
  it("if the email cannot be sent the link is removed, Antonio is told, and the answer to the person does not change", async () => {
    sendFails = true
    const r = await requestForgotPassword({ email: "rocco@example.test" })
    expect(r.valid).toBe(true)
    expect(resetRows()).toHaveLength(0)
    expect(alertForgotProblem).toHaveBeenCalledTimes(1)
    expect(alertForgotProblem.mock.calls[0][0]).toBe("rocco@example.test")
    expect(alertForgotProblem.mock.calls[0][1]).toMatch(/could not be sent.*gmail down/)
  })
  it("failed sends do not use up the three requests an hour", async () => {
    sendFails = true
    for (let i = 0; i < 5; i++) await requestForgotPassword({ email: "rocco@example.test" })
    expect(resetRows()).toHaveLength(0)
    sendFails = false
    await requestForgotPassword({ email: "rocco@example.test" })
    expect(sent).toHaveLength(1)
    expect(resetRows()).toHaveLength(1)
  })
  it("a link made by the team owner that is still open is NOT replaced by the person's own request (no email, the owner's link keeps working)", async () => {
    const made = await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000002", actor: owner })
    const ownerToken = /token=(.+)$/.exec(made.data!.resetUrl)![1]
    expect((await requestForgotPassword({ email: "rocco@example.test" })).valid).toBe(true)
    expect(sent).toHaveLength(0)
    expect(resetRows()).toHaveLength(1)
    expect(resetRows()[0].revoked_at).toBeNull()
    expect(alertForgotProblem).not.toHaveBeenCalled()
    expect((await completeReset({ token: ownerToken, password: PASSWORD })).ok).toBe(true)
  })
  it("an owner link that has expired, was used or was cancelled does not block the person's own request", async () => {
    await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000002", actor: owner })
    resetRows()[0].expires_at = new Date(Date.now() - 1000).toISOString()
    await requestForgotPassword({ email: "rocco@example.test" })
    expect(sent).toHaveLength(1)
    // the person's own earlier link IS replaced by a newer one of his own
    await requestForgotPassword({ email: "rocco@example.test" })
    expect(sent).toHaveLength(2)
    expect(resetRows().filter(r => !r.revoked_at && !r.used_at)).toHaveLength(1)
  })
  it("every other problem is told to Antonio, never to the person: the team cannot be read, the link cannot be stored, the lookup crashes, the database step is missing", async () => {
    readFails.add("marketing_team_members")
    expect((await requestForgotPassword({ email: "rocco@example.test" })).valid).toBe(true)
    expect(alertForgotProblem.mock.calls.at(-1)![1]).toMatch(/team could not be read/)
    readFails.clear(); readFails.add("marketing_password_resets")
    await requestForgotPassword({ email: "rocco@example.test" })
    expect(alertForgotProblem.mock.calls.at(-1)![1]).toMatch(/earlier link could not be checked/)
    readFails.clear(); tableMissing = true
    await requestForgotPassword({ email: "rocco@example.test" })
    expect(alertForgotProblem.mock.calls.at(-1)![1]).toMatch(/not ready yet/)
    tableMissing = false
    findMarketing.mockRejectedValueOnce(new Error("listUsers failed"))
    expect((await requestForgotPassword({ email: "rocco@example.test" })).valid).toBe(true)
    expect(alertForgotProblem.mock.calls.at(-1)![1]).toMatch(/unexpected error: listUsers failed/)
    expect(alertForgotProblem).toHaveBeenCalledTimes(4)
    expect(sent).toHaveLength(0)
  })
  it("an address that is not a login at all, a paused member and a client are never reported to Antonio", async () => {
    addLogin("p", "paused@example.test", "marketing", "member", "paused")
    addLogin("c", "client@example.test", "client", "member")
    for (const e of ["nobody@example.test", "paused@example.test", "client@example.test"]) await requestForgotPassword({ email: e })
    expect(alertForgotProblem).not.toHaveBeenCalled()
  })
})

describe("completeReset", () => {
  async function makeLink(): Promise<string> {
    const r = await createOwnerReset({ teamId: TEAM, userId: "00000000-0000-4000-8000-000000000002", actor: owner })
    return /token=(.+)$/.exec(r.data!.resetUrl)![1]
  }

  it("happy path: the password is changed, the link is used up, a second try fails", async () => {
    const token = await makeLink()
    const r = await completeReset({ token, password: PASSWORD })
    expect(r.ok).toBe(true)
    expect(r.data!.email).toBe("rocco@example.test")
    // one call: the new password AND a bumped remember-this-device version (starts at 0), keeping everything else in app_metadata (the role)
    expect(updateUserById).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002", { password: PASSWORD, app_metadata: { role: "marketing", mfa_rd_version: 1 } })
    expect(resetRows()[0].used_at).toBeTruthy()
    updateUserById.mockClear()
    const again = await completeReset({ token, password: PASSWORD })
    expect(again.ok).toBe(false)
    expect(updateUserById).not.toHaveBeenCalled()
  })
  it("a short password is told so and the link is NOT used up", async () => {
    const token = await makeLink()
    const r = await completeReset({ token, password: "short" })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/at least 12/)
    expect(resetRows()[0].used_at).toBeNull()
  })
  it("a password the login system refuses gives the link back", async () => {
    const token = await makeLink()
    updateUserById.mockResolvedValue({ error: { code: "weak_password", message: "weak" } })
    const r = await completeReset({ token, password: PASSWORD })
    expect(r.error).toBe(WEAK_PASSWORD_ERROR)
    expect(resetRows()[0].used_at).toBeNull()
  })
  it("a temporary failure gives the link back too", async () => {
    const token = await makeLink()
    updateUserById.mockResolvedValue({ error: { message: "database timeout" } })
    const r = await completeReset({ token, password: PASSWORD })
    expect(r.error).toBe(TRY_AGAIN_ERROR)
    expect(resetRows()[0].used_at).toBeNull()
  })
  it("every failure of the link itself gives the same generic answer", async () => {
    const token = await makeLink()
    const generic = (await completeReset({ token: "x".repeat(43), password: PASSWORD })).error
    expect(generic).toBeTruthy()
    expect((await completeReset({ token: undefined, password: PASSWORD })).error).toBe(generic)
    resetRows()[0].expires_at = new Date(Date.now() - 1000).toISOString()
    expect((await completeReset({ token, password: PASSWORD })).error).toBe(generic)
    expect(updateUserById).not.toHaveBeenCalled()
  })
  it("a link that was cancelled by a newer one no longer works", async () => {
    const first = await makeLink()
    await makeLink()
    expect((await completeReset({ token: first, password: PASSWORD })).ok).toBe(false)
    expect(updateUserById).not.toHaveBeenCalled()
  })
  it("if the person was paused or the team switched off after the link was made, it is cancelled and nothing changes", async () => {
    const token = await makeLink()
    tables.marketing_team_members.find(m => m.user_id === "00000000-0000-4000-8000-000000000002")!.status = "paused"
    expect((await completeReset({ token, password: PASSWORD })).ok).toBe(false)
    expect(updateUserById).not.toHaveBeenCalled()
    expect(resetRows()[0].revoked_at).toBeTruthy()
  })
  it("if the login's email changed or the login became another kind, it is cancelled and nothing changes", async () => {
    const token = await makeLink()
    users["00000000-0000-4000-8000-000000000002"].email = "someone-else@example.test"
    expect((await completeReset({ token, password: PASSWORD })).ok).toBe(false)
    const token2 = await makeLink()
    users["00000000-0000-4000-8000-000000000002"].email = "rocco@example.test"
    users["00000000-0000-4000-8000-000000000002"].app_metadata = { role: "client" }
    expect((await completeReset({ token: token2, password: PASSWORD })).ok).toBe(false)
    expect(updateUserById).not.toHaveBeenCalled()
  })
  it("a login that no longer exists: cancelled; a login lookup that failed for another reason: link given back", async () => {
    const token = await makeLink()
    delete users["00000000-0000-4000-8000-000000000002"]
    expect((await completeReset({ token, password: PASSWORD })).ok).toBe(false)
    expect(resetRows()[0].revoked_at).toBeTruthy()
    users["00000000-0000-4000-8000-000000000002"] = { id: "00000000-0000-4000-8000-000000000002", email: "rocco@example.test", app_metadata: { role: "marketing" } }
    const token2 = await makeLink()
    getUserByIdFails.status = 500
    const r = await completeReset({ token: token2, password: PASSWORD })
    expect(r.error).toBe(TRY_AGAIN_ERROR)
    expect(resetRows().at(-1)!.used_at).toBeNull()
  })
  it("a version that was already bumped goes up by one, and a reset keeps the rest of app_metadata", async () => {
    users["00000000-0000-4000-8000-000000000002"].app_metadata = { role: "marketing", mfa_rd_version: 3, provider: "email" }
    const token = await makeLink()
    expect((await completeReset({ token, password: PASSWORD })).ok).toBe(true)
    expect(updateUserById).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002", { password: PASSWORD, app_metadata: { role: "marketing", mfa_rd_version: 4, provider: "email" } })
  })
  it("a failed READ is not 'no longer eligible': the link is given back, not cancelled", async () => {
    const token = await makeLink()
    readFails.add("marketing_team_members")
    const r = await completeReset({ token, password: PASSWORD })
    expect(r.error).toBe(TRY_AGAIN_ERROR)
    expect(resetRows()[0].used_at).toBeNull()
    expect(resetRows()[0].revoked_at).toBeNull()
    expect(updateUserById).not.toHaveBeenCalled()
    readFails.clear(); readFails.add("marketing_teams")
    expect((await completeReset({ token, password: PASSWORD })).error).toBe(TRY_AGAIN_ERROR)
    expect(resetRows()[0].revoked_at).toBeNull()
    readFails.clear()
    expect((await completeReset({ token, password: PASSWORD })).ok).toBe(true)
  })
  it("if the link itself cannot be read, nothing is touched and the person is told to try again", async () => {
    const token = await makeLink()
    readFails.add("marketing_password_resets")
    expect((await completeReset({ token, password: PASSWORD })).error).toBe(TRY_AGAIN_ERROR)
    readFails.clear()
    expect(resetRows()[0].used_at).toBeNull()
    expect((await completeReset({ token, password: PASSWORD })).ok).toBe(true)
  })
  it("if the link cannot be given back, the person is told to ask for a new one (not 'try again' on a dead link)", async () => {
    const token = await makeLink()
    updateUserById.mockResolvedValue({ error: { message: "database timeout" } })
    unclaimFails = true
    const r = await completeReset({ token, password: PASSWORD })
    expect(r.error).toBe(GENERIC_RESET_ERROR)
    expect(resetRows()[0].used_at).toBeTruthy()
  })
  it("two people using the same link together: only one changes the password", async () => {
    const token = await makeLink()
    const [a, b] = await Promise.all([completeReset({ token, password: PASSWORD }), completeReset({ token, password: PASSWORD + "2" })])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(updateUserById).toHaveBeenCalledTimes(1)
  })
})
