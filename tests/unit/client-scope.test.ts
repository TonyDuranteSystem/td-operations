/**
 * Client-scope enforcement (dev job a6c3d75b, council Security blocker).
 * On a client-pinned screen the worker must not read a DIFFERENT client.
 */

import { describe, it, expect } from "vitest"
import { buildClientScope, checkClientScope } from "@/lib/ai-agent/client-scope"

const A = "12dadc46-e431-4d11-9fe0-5c561d38737a" // client in scope
const B = "30c2cd96-03e4-43cf-9536-81d961b18b1d" // a different client
const CONTACT = "4e0e4026-1bf4-41e8-ba6c-e9db1e4ba2f8" // a contact of A

describe("buildClientScope", () => {
  it("parses the canonical key", () => {
    expect(buildClientScope(`account:${A}`)).toMatchObject({ kind: "account", id: A })
    expect(buildClientScope(`contact:${B}`)).toMatchObject({ kind: "contact", id: B })
  })
  it("rejects anything else", () => {
    for (const s of ["", "lead:" + A, "account:", "garbage", `account:${A} extra`]) {
      expect(buildClientScope(s), s).toBeNull()
    }
  })
  it("carries the client's related ids as allowed", () => {
    const s = buildClientScope(`account:${A}`, [CONTACT])!
    expect(s.allowedIds).toContain(A)
    expect(s.allowedIds).toContain(CONTACT)
  })
})

describe("checkClientScope", () => {
  const scope = buildClientScope(`account:${A}`, [CONTACT])!

  it("allows the client in scope", () => {
    expect(checkClientScope("search_payments", { account_id: A }, scope).allowed).toBe(true)
    expect(checkClientScope("portal_chat_read", { contact_id: CONTACT }, scope).allowed).toBe(true)
  })

  it("REFUSES a different client — the actual exposure", () => {
    const v = checkClientScope("get_client_360", { account_id: B }, scope)
    expect(v.allowed).toBe(false)
    expect(v.reason).toContain("DIFFERENT client")
  })

  it("refuses free-form SQL that names another client's id", () => {
    const v = checkClientScope("run_sql_query", { query: `select * from payments where account_id = '${B}'` }, scope)
    expect(v.allowed).toBe(false)
  })

  it("allows SQL that names only the client in scope", () => {
    expect(checkClientScope("run_sql_query", { query: `select * from payments where account_id = '${A}'` }, scope).allowed).toBe(true)
  })

  it("allows lookups that name no client at all (kb, templates, schema)", () => {
    expect(checkClientScope("search_kb", { query: "refund policy" }, scope).allowed).toBe(true)
    expect(checkClientScope("run_sql_query", { query: "select table_name from information_schema.tables" }, scope).allowed).toBe(true)
  })

  it("fails OPEN on a surface with no client pinned (Inbox, Slack, sidebar)", () => {
    expect(checkClientScope("get_client_360", { account_id: B }, null).allowed).toBe(true)
  })

  /** The honest residual: a broad query with no id cannot be scoped by inspection. */
  it("KNOWN GAP: an un-targeted broad query is not blocked (documented, not silent)", () => {
    expect(checkClientScope("run_sql_query", { query: "select * from accounts limit 50" }, scope).allowed).toBe(true)
  })
})
