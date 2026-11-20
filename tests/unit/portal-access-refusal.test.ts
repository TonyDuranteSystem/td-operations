import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { pickLoginTarget, resolveLoginTarget, MARKED_MEMBER_REFUSAL, EVERYONE_MARKED_REFUSAL } from "@/lib/members/portal-access-refusal"

const open = (id: string) => ({ contact_id: id, access_revoked_at: null })
const marked = (id: string) => ({ contact_id: id, access_revoked_at: "2026-11-01T00:00:00Z" })

describe("pickLoginTarget", () => {
  it("a named person with the mark is refused", () => {
    expect(pickLoginTarget([open("a"), marked("b")], "b")).toEqual({ contactId: "b", refusal: MARKED_MEMBER_REFUSAL })
  })

  it("a named person without the mark is allowed", () => {
    expect(pickLoginTarget([open("a"), marked("b")], "a")).toEqual({ contactId: "a" })
  })

  it("a named person who is not linked at all is allowed (unchanged behaviour)", () => {
    expect(pickLoginTarget([open("a")], "zzz")).toEqual({ contactId: "zzz" })
  })

  it("nobody named: the first person who still has access is picked, never a marked one", () => {
    expect(pickLoginTarget([marked("a"), open("b"), open("c")])).toEqual({ contactId: "b" })
  })

  it("nobody named and everyone is marked: refused", () => {
    expect(pickLoginTarget([marked("a"), marked("b")])).toEqual({ refusal: EVERYONE_MARKED_REFUSAL })
  })

  it("nobody named and nobody linked: no target and no refusal (the caller says 'no contacts linked')", () => {
    expect(pickLoginTarget([])).toEqual({})
  })

  it("the refusals tell the team what to do next, in plain words", () => {
    expect(MARKED_MEMBER_REFUSAL).toMatch(/Give access/)
    expect(MARKED_MEMBER_REFUSAL).toMatch(/still an owner/)
    expect(EVERYONE_MARKED_REFUSAL).toMatch(/Give access/)
  })

  it("resolveLoginTarget reads the links through the injected reader", async () => {
    const t = await resolveLoginTarget("acc", "b", async () => [open("a"), marked("b")])
    expect(t.refusal).toBe(MARKED_MEMBER_REFUSAL)
  })
})

describe("wiring: both ways of making a login ask first", () => {
  const root = path.resolve(__dirname, "..", "..")
  const route = fs.readFileSync(path.join(root, "app/api/portal/admin/create-user/route.ts"), "utf8")
  const mcp = fs.readFileSync(path.join(root, "lib/mcp/tools/portal.ts"), "utf8")

  it("the staff create-user route resolves the person through the refusal helper and answers 409 on a refusal", () => {
    expect(route).toMatch(/resolveLoginTarget\(account_id, contact_id\)/)
    expect(route).toMatch(/target\.refusal[\s\S]{0,120}status: 409/)
  })

  it("the staff route no longer lists a company the person has no access to on their login", () => {
    expect(route).toMatch(/\.is\('access_revoked_at', null\)/)
  })

  it("the MCP portal_create_user tool resolves the person through the same helper", () => {
    expect(mcp).toMatch(/resolveLoginTarget\(account_id, contact_id\)/)
    expect(mcp).toMatch(/loginTarget\?\.refusal/)
  })
})
