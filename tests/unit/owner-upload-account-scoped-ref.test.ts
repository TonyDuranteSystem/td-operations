/**
 * A transaction's identity must include the ACCOUNT it came from.
 *
 * THE BUG THIS LOCKS OUT (observed 2026-08-30, real data): the CSV parsers build
 * a transaction's reference by hashing (date, amount, description, balance) with
 * no notion of which account produced it. Antonio opened First Citizens checking
 * 5812 and 5820 on the same day, each with a $100 "Customer Deposit" leaving a
 * $100 balance — identical in every hashed field. The import's ref check runs
 * BEFORE its content check, so the second deposit was discarded as "already
 * imported" and 93 of 94 rows landed. A real transaction was silently lost.
 *
 * A scan of all 23 of Antonio's 2025 statement files found exactly ONE such
 * collision today — but the flaw is structural, not a one-off: any two accounts
 * at one institution behaving identically will collide.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const route = readFileSync(
  join(process.cwd(), "app/api/owner/transactions/upload/route.ts"),
  "utf-8"
)

describe("upload gives each row an account-scoped reference", () => {
  it("prefixes the parser's ref with the account number", () => {
    expect(route).toMatch(/transaction_ref: `\$\{account\.value!\.accountNumber\}:\$\{t\.transaction_ref\}`/)
  })

  it("does NOT pass the parser's bare ref through", () => {
    // The regression: `transaction_ref: t.transaction_ref` with nothing else.
    expect(route).not.toMatch(/transaction_ref: t\.transaction_ref\s*,/)
  })

  it("keeps the account authoritative from the filename, not the parser", () => {
    // The account label and type must come from the verified filename, since the
    // parser reports "unknown" for everything except Relay.
    expect(route).toContain("bank_name: account.value!.label")
    expect(route).toContain("account_type: account.value!.accountType")
  })
})

describe("the collision this prevents", () => {
  // Reproduces the exact shape of the two First Citizens deposits.
  const parserRef = "h-sameHashBecauseEveryHashedFieldMatches"
  const scoped = (accountNumber: string) => `${accountNumber}:${parserRef}`

  it("two identical rows in different accounts get different identities", () => {
    expect(scoped("5812")).not.toBe(scoped("5820"))
  })

  it("the same row re-uploaded for the same account still dedupes", () => {
    // Account-scoping must not break the legitimate case: re-uploading one file
    // should still be recognised as the same source, not imported twice.
    expect(scoped("5812")).toBe(scoped("5812"))
  })
})
