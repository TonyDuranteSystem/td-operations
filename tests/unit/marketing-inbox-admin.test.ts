import { describe, it, expect, vi, beforeEach } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

const U1 = "11111111-1111-4111-8111-111111111111"
const U2 = "22222222-2222-4222-8222-222222222222"
const GONE = "99999999-9999-4999-8999-999999999999"

const state: { list: unknown; writes: unknown[]; pingOk: boolean } = { list: [], writes: [], pingOk: true }
vi.mock("@/lib/marketing/settings", () => ({
  getMarketingSetting: async () => state.list,
  setMarketingSetting: async (i: { value: unknown }) => { state.writes.push(i); state.list = i.value; return { ok: true, data: i.value } },
}))
vi.mock("@/lib/marketing/members", () => ({
  listMembers: async () => [
    { user_id: U1, email: "Rocco@tonydurante.us", status: "active", member_role: "owner" },
    { user_id: U2, email: "cristina@example.com", status: "active", member_role: "member" },
    { user_id: GONE, email: "old@example.com", status: "removed", member_role: "member" },
  ],
}))
vi.mock("@/lib/marketing/inbox/driver", () => ({ getMailDriver: async () => ({ ping: async (a: string) => (state.pingOk ? { ok: true } : { ok: false, error: `cannot open ${a}` }) }) }))

import { addMailbox, checkMailbox, removeMailbox, updateMailbox } from "@/lib/marketing/inbox/admin"

beforeEach(() => { state.list = []; state.writes = []; state.pingOk = true })

describe("checking an address before it is saved", () => {
  it("a good address is connected and defaults to the person it belongs to, writing nothing", async () => {
    const r = await checkMailbox("t", "Rocco@tonydurante.us")
    expect(r).toEqual({ ok: true, data: { address: "rocco@tonydurante.us", people: [U1] } })
    expect(state.writes).toHaveLength(0)
  })
  it("the CRM's mailboxes, other domains and unopenable addresses are refused", async () => {
    expect(await checkMailbox("t", "support@tonydurante.us")).toMatchObject({ ok: false, error: "This mailbox belongs to the CRM." })
    expect(await checkMailbox("t", "a@gmail.com")).toMatchObject({ ok: false })
    state.pingOk = false
    expect(await checkMailbox("t", "nobody@tonydurante.us")).toMatchObject({ ok: false, error: "cannot open nobody@tonydurante.us" })
  })
  it("an address already in the list is refused", async () => {
    state.list = [{ address: "rocco@tonydurante.us", people: [], signature: "" }]
    expect(await checkMailbox("t", "rocco@tonydurante.us")).toMatchObject({ ok: false, error: "That address is already added." })
  })
})

describe("saving an address", () => {
  it("saves with the people ticked, re-checking everything (a CRM address cannot be saved by skipping the check)", async () => {
    const r = await addMailbox({ teamId: "t", address: "rocco@tonydurante.us", people: [U1, U2], signature: " Rocco\r\nTD Marketing ", actor: "antonio@x" })
    expect(r.ok).toBe(true)
    expect(state.writes).toHaveLength(1)
    expect((state.writes[0] as { value: unknown[] }).value).toEqual([{ address: "rocco@tonydurante.us", people: [U1, U2], signature: "Rocco\nTD Marketing" }])
    expect(await addMailbox({ teamId: "t", address: "support@tonydurante.us", people: [], signature: "", actor: "a" })).toMatchObject({ ok: false })
    expect(state.writes).toHaveLength(1)
  })
  it("people must be members of the team (not strangers, not removed members)", async () => {
    expect(await addMailbox({ teamId: "t", address: "ale@tonydurante.us", people: ["00000000-0000-4000-8000-000000000000"], signature: "", actor: "a" })).toMatchObject({ ok: false, error: "Choose people from the team." })
    expect(await addMailbox({ teamId: "t", address: "ale@tonydurante.us", people: [GONE], signature: "", actor: "a" })).toMatchObject({ ok: false })
    expect(await addMailbox({ teamId: "t", address: "ale@tonydurante.us", people: "x", signature: "", actor: "a" })).toMatchObject({ ok: false })
    expect(state.writes).toHaveLength(0)
  })
  it("an address nobody is ticked for defaults to the person it belongs to", async () => {
    const r = await addMailbox({ teamId: "t", address: "rocco@tonydurante.us", people: undefined, signature: undefined, actor: "a" })
    expect(r.ok && r.data[0]).toEqual({ address: "rocco@tonydurante.us", people: [U1], signature: "" })
  })
  it("a signature is cut to 600 characters", async () => {
    const r = await addMailbox({ teamId: "t", address: "rocco@tonydurante.us", people: [], signature: "x".repeat(900), actor: "a" })
    expect(r.ok && r.data[0].signature.length).toBe(600)
  })
})

describe("changing and removing", () => {
  beforeEach(() => { state.list = [{ address: "rocco@tonydurante.us", people: [], signature: "" }, { address: "marketing@tonydurante.us", people: [U2], signature: "Team" }] })
  it("changes who may open one address and leaves the others alone", async () => {
    const r = await updateMailbox({ teamId: "t", address: "rocco@tonydurante.us", people: [U2], actor: "a" })
    expect(r.ok && r.data.map(b => b.people)).toEqual([[U2], [U2]])
    expect(await updateMailbox({ teamId: "t", address: "rocco@tonydurante.us", people: [GONE], actor: "a" })).toMatchObject({ ok: false })
    expect(await updateMailbox({ teamId: "t", address: "ghost@tonydurante.us", people: [], actor: "a" })).toMatchObject({ ok: false, error: "That address is not in the list." })
  })
  it("removes one address", async () => {
    const r = await removeMailbox({ teamId: "t", address: "marketing@tonydurante.us", actor: "a" })
    expect(r.ok && r.data.map(b => b.address)).toEqual(["rocco@tonydurante.us"])
    expect(await removeMailbox({ teamId: "t", address: "marketing@tonydurante.us", actor: "a" })).toMatchObject({ ok: false })
  })
})

describe("the wall between the Inbox and the CRM", () => {
  const root = process.cwd()
  const walk = (d: string, out: string[] = []): string[] => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e)) out.push(p) } return out }
  const files = [...walk(join(root, "lib/marketing/inbox")), ...walk(join(root, "app/api/marketing/inbox")), ...walk(join(root, "components/marketing/inbox")), ...walk(join(root, "app/marketing/(app)/inbox"))]
  it("no Marketing Inbox file reaches the CRM's inbox routes, its mailbox gate, its email index or its chats", () => {
    expect(files.length).toBeGreaterThan(10)
    for (const f of files) {
      const src = readFileSync(f, "utf8")
      expect(src, f).not.toMatch(/\/api\/inbox\//)
      expect(src, f).not.toMatch(/lib\/inbox\/mailbox-access|lib\/inbox\/mailbox"|email-index|email_index|email-store|messaging_groups|account_contacts/)
    }
  })
  it("the two CRM mailboxes are never named as something to open (only as the refused list)", () => {
    for (const f of files.filter(x => !x.endsWith("mailboxes.ts") && !x.endsWith("admin.ts") && !x.includes("fake-driver"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/support@tonydurante|antonio\.durante@/)
    }
  })
  it("every Inbox route goes through the one door (requireInbox) or the mailbox list", () => {
    for (const f of files.filter(x => x.includes("app/api/marketing/inbox") && x.endsWith("route.ts"))) {
      expect(readFileSync(f, "utf8"), f).toMatch(/requireInbox|requireMarketing\("inbox"\)/)
    }
  })
})
