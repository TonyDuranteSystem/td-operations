/**
 * The rule that closes the To-Do card leak: a per-entity card request must ALWAYS resolve to
 * exactly one entity filter, or be refused. The regression this guards is real — a
 * contact-scoped request used to match no branch and fall through to an unfiltered query that
 * returned every client's cards to the browser.
 */
import { describe, it, expect } from "vitest"
import { resolveEntityScope } from "@/lib/tasks/entity-scope"

const MSG = "11111111-1111-4111-8111-111111111111"
const ACCT = "22222222-2222-4222-8222-222222222222"
const CONTACT = "33333333-3333-4333-8333-333333333333"

describe("resolveEntityScope — never falls through to 'everything'", () => {
  it("REFUSES a request that names no entity (the leak path)", () => {
    const r = resolveEntityScope({})
    expect(r.scope).toBeNull()
    expect(r.error).toBeTruthy()
  })

  it("REFUSES when every param is empty or whitespace (?contact_id= must not scope to '')", () => {
    expect(resolveEntityScope({ messageId: "", accountId: "", contactId: "" }).scope).toBeNull()
    expect(resolveEntityScope({ contactId: "   " }).scope).toBeNull()
    expect(resolveEntityScope({ accountId: null, contactId: undefined }).scope).toBeNull()
  })

  it("scopes to the CONTACT — the case that used to fall through", () => {
    const r = resolveEntityScope({ contactId: CONTACT })
    expect(r.error).toBeNull()
    expect(r.scope).toEqual({ kind: "contact", column: "contact_id", value: CONTACT })
  })

  it("scopes to the account", () => {
    expect(resolveEntityScope({ accountId: ACCT }).scope).toEqual({
      kind: "account", column: "account_id", value: ACCT,
    })
  })

  it("scopes to the message", () => {
    expect(resolveEntityScope({ messageId: MSG }).scope).toEqual({
      kind: "message", column: "message_id", value: MSG,
    })
  })

  it("precedence is message > account > contact", () => {
    expect(resolveEntityScope({ messageId: MSG, accountId: ACCT, contactId: CONTACT }).scope?.kind).toBe("message")
    expect(resolveEntityScope({ accountId: ACCT, contactId: CONTACT }).scope?.kind).toBe("account")
  })

  it("trims a padded id rather than treating it as absent", () => {
    expect(resolveEntityScope({ contactId: `  ${CONTACT}  ` }).scope?.value).toBe(CONTACT)
  })

  it("ALWAYS returns either a scope or an error — never both null, never both set", () => {
    const cases: Parameters<typeof resolveEntityScope>[0][] = [
      {}, { messageId: MSG }, { accountId: ACCT }, { contactId: CONTACT },
      { messageId: "", accountId: ACCT }, { contactId: "  " },
    ]
    for (const c of cases) {
      const r = resolveEntityScope(c)
      expect(Boolean(r.scope) !== Boolean(r.error)).toBe(true)
    }
  })
})
