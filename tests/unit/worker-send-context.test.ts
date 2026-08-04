/**
 * WIRING tests for the worker's per-call send/scope context.
 *
 * Why this file exists: tests/unit/client-scope.test.ts proves buildClientScope and
 * checkClientScope are correct — and every one of those tests passed for the entire
 * period the client boundary was DEAD. The route built the scope, spread it through
 * a variable (`sendRails`), and the inline context literal in callWorker never copied
 * it across, so the gate in executeWorkerTool read `undefined` and never fired. A
 * pure-function test cannot see that; only a test of the wiring can.
 *
 * So: these cases assert the CONTEXT CARRIES the control, and that the gate REFUSES
 * through the real executeWorkerTool entry point. Both halves are required — the
 * first catches a dropped field, the second catches a gate that stops being called.
 */

import { describe, it, expect } from "vitest"
import { buildWorkerSendContext, executeWorkerTool, resolveNestedToolCall } from "@/lib/ai-agent/worker-tools"
import { buildClientScope } from "@/lib/ai-agent/client-scope"

const A = "12dadc46-e431-4d11-9fe0-5c561d38737a" // the client whose screen is open
const B = "30c2cd96-03e4-43cf-9536-81d961b18b1d" // a DIFFERENT client
const CONTACT_A = "4e0e4026-1bf4-41e8-ba6c-e9db1e4ba2f8" // a contact of A

describe("buildWorkerSendContext — the controls survive the handoff", () => {
  it("REGRESSION: forwards clientScope (the field whose absence made the boundary dead)", () => {
    const scope = buildClientScope(`account:${A}`, [CONTACT_A])!
    const ctx = buildWorkerSendContext({ clientScope: scope })
    expect(ctx).toBeDefined()
    expect(ctx!.clientScope).toEqual(scope)
  })

  it("builds a context for a scope-only call — no send pin, boundary still enforced", () => {
    // The Portal Chats panel happens to also set a portal pin, so a bug here would
    // hide there. A read-only client-pinned surface has nothing else to save it.
    const ctx = buildWorkerSendContext({ clientScope: buildClientScope(`contact:${B}`)! })
    expect(ctx).toBeDefined()
    expect(ctx!.clientScope?.id).toBe(B)
  })

  it("forwards the portal pin, the email pin and the actor", () => {
    const ctx = buildWorkerSendContext({
      sendActor: "crm-portal:luca@tonydurante.us",
      pinnedPortalRecipient: { account_id: A },
      emailConfirmExempt: ["someone@example.com"],
    })
    expect(ctx!.actor).toBe("crm-portal:luca@tonydurante.us")
    expect(ctx!.pinnedPortalRecipient).toEqual({ account_id: A })
    expect(ctx!.emailConfirmExempt).toEqual(["someone@example.com"])
  })

  it("REGRESSION: forwards pinnedUploads — without it read_uploaded_file resolves nothing and long files stay unreadable", () => {
    // MANDATED by buildWorkerSendContext's own docblock. This field is the ONLY
    // gate on read_uploaded_file: the tool is offered because the pin exists, and
    // the executor resolves the model's ref against this very list. Drop it from
    // the builder and everything still typechecks — the tool is simply offered
    // and then answers "❌ No files were uploaded in this conversation" for a file
    // the staff member is looking at. That is the shape of failure this whole
    // job exists to fix (td-bug 2026-08-03, Luca's spreadsheet).
    const ctx = buildWorkerSendContext({
      pinnedUploads: [
        { ref: "up1", source: "worker_upload", locator: "worker-chat/abc.xlsx", name: "Tracking.xlsx" },
      ],
    })
    expect(ctx).toBeDefined()
    expect(ctx!.pinnedUploads).toEqual([
      { ref: "up1", source: "worker_upload", locator: "worker-chat/abc.xlsx", name: "Tracking.xlsx" },
    ])
  })

  it("builds a context for pinnedUploads ALONE — a plain upload turn has no send pin at all", () => {
    // The commonest case by far: staff drops a spreadsheet into the sidebar and
    // asks a question. No client pinned, no send rail. If that turn produced no
    // context, the pin would never reach the executor.
    const ctx = buildWorkerSendContext({
      pinnedUploads: [
        { ref: "up1", source: "worker_upload", locator: "worker-chat/abc.xlsx", name: "Tracking.xlsx" },
      ],
    })
    expect(ctx).toBeDefined()
    expect(ctx!.pinnedUploads?.[0]?.ref).toBe("up1")
  })

  it("forwards forceMailbox — the antonio@-impersonation control", () => {
    // MANDATED by buildWorkerSendContext's own docblock: every new control field must
    // be asserted here. Without this, dropping forceMailbox from the builder would
    // leave every executor-level test green (they pass the field directly) while a
    // team member could send as Antonio from a surface that cannot authorise it.
    const ctx = buildWorkerSendContext({ forceMailbox: "support" })
    expect(ctx).toBeDefined()
    expect(ctx!.forceMailbox).toBe("support")
  })

  it("forwards emailSendPrep — without it a new recipient cannot be frozen for confirmation", () => {
    const prep = { threadUuid: "t1", mailbox: "support@tonydurante.us", sendable: [] }
    const ctx = buildWorkerSendContext({ emailSendPrep: prep })
    expect(ctx).toBeDefined()
    expect(ctx!.emailSendPrep).toEqual(prep)
  })

  it("REGRESSION: forwards portalSendPrep — dropping it turns a confirmed send back into an automatic one", () => {
    // THIS EXACT BUG SHIPPED TO SANDBOX, 2026-07-31, and is the reason the rule at the
    // top of buildWorkerSendContext exists. The field was added to the send-context
    // type AND set on the Inbox rails; both typechecked; every pure-function test on
    // the freeze path passed. But this literal never copied it across, so the executor
    // saw no freeze context, fell through to the direct send, and a REAL portal message
    // reached a real client with no card and no confirmation — while the worker
    // reported "Message sent". A missing field here does not degrade a feature; it
    // removes the human from a client-facing send.
    const prep = { threadUuid: "t1", locale: "it" }
    const ctx = buildWorkerSendContext({ portalSendPrep: prep })
    expect(ctx).toBeDefined()
    expect(ctx!.portalSendPrep).toEqual(prep)
  })

  it("builds a context for portalSendPrep ALONE — the Inbox has no portal pin by design", () => {
    // The Inbox deliberately carries no pinned recipient (there is no client on an
    // email thread), so if the prep alone did not qualify as "a context worth
    // building", the whole card path would be unreachable on the one surface it is for.
    const ctx = buildWorkerSendContext({ portalSendPrep: { threadUuid: "t1", locale: "en" } })
    expect(ctx).toBeDefined()
    expect(ctx!.pinnedPortalRecipient).toBeNull()
  })

  it("forwards onBehalfOf (team-chat self-notification silencer) and builds a context for it alone", () => {
    // A dropped field here would silently revive Antonio's self-notifications —
    // the exact class of wiring bug this file exists for.
    const ctx = buildWorkerSendContext({ onBehalfOf: A })
    expect(ctx).toBeDefined()
    expect(ctx!.onBehalfOf).toBe(A)
  })

  it("onBehalfOf stays null when the surface does not know who is driving", () => {
    const ctx = buildWorkerSendContext({ sendActor: "team-chat:Antonio Durante" })
    // The audit label is NOT an identity — it must never populate onBehalfOf.
    expect(ctx!.onBehalfOf).toBeNull()
  })

  it("keeps an EMPTY confirm-exempt list as meaningful — [] (confirm every recipient) must never become undefined", () => {
    // [] means "refuse every address". Collapsing it to undefined means "unpinned",
    // which is the fail-OPEN direction on an Inbox turn whose thread could not be read.
    const ctx = buildWorkerSendContext({ emailConfirmExempt: [] })
    expect(ctx).toBeDefined()
    expect(ctx!.emailConfirmExempt).toEqual([])
    expect(ctx!.emailConfirmExempt).not.toBeUndefined()
  })

  it("returns undefined only when there is genuinely nothing to enforce", () => {
    expect(buildWorkerSendContext({})).toBeUndefined()
    expect(buildWorkerSendContext({ sendActor: null, clientScope: null })).toBeUndefined()
  })
})

describe("client boundary — enforced through the real executeWorkerTool entry point", () => {
  const scope = buildClientScope(`account:${A}`, [CONTACT_A])!
  const ctx = buildWorkerSendContext({ clientScope: scope })!

  it("REFUSES a lookup naming a different client (the actual exposure)", async () => {
    const out = await executeWorkerTool(
      "get_client_360",
      { account_id: B },
      new Set(["get_client_360"]),
      null,
      null,
      ctx,
    )
    expect(out).toMatch(/❌/)
    expect(out).toMatch(/DIFFERENT client/i)
    // The refusal must NOT echo the foreign id back — that would hand the model
    // (and anything shaping it) confirmation that the id resolves to a real client.
    expect(out).not.toMatch(new RegExp(B))
  })

  it("REFUSES raw SQL naming a different client", async () => {
    const out = await executeWorkerTool(
      "run_sql_query",
      { query: `select * from payments where account_id = '${B}'` },
      new Set(["run_sql_query"]),
      null,
      null,
      ctx,
    )
    expect(out).toMatch(/❌/)
  })

  it("fails OPEN when the surface is genuinely not client-pinned (unchanged behaviour)", async () => {
    // No scope → no boundary. Asserted so a future change that starts refusing on
    // unpinned surfaces is a visible decision, not a silent capability regression.
    const unpinned = buildWorkerSendContext({ sendActor: "slack:antonio" })!
    const out = await executeWorkerTool(
      "get_client_360",
      { account_id: B },
      new Set([]), // not offered → refused for a DIFFERENT reason than scope
      null,
      null,
      unpinned,
    )
    expect(out).not.toMatch(/different client|not on this screen|out of scope/i)
  })
})

describe("nested bridge calls cannot slip past the client boundary", () => {
  const scope = buildClientScope(`account:${A}`, [CONTACT_A])!
  const ctx = buildWorkerSendContext({ clientScope: scope })!

  it("unwraps use_tool so guards judge the call that will actually run", () => {
    expect(resolveNestedToolCall("use_tool", { name: "crm_get_client_summary", params: { account_id: B } }))
      .toEqual({ name: "crm_get_client_summary", params: { account_id: B } })
  })

  it("leaves an ordinary call untouched", () => {
    expect(resolveNestedToolCall("doc_search", { q: "x" })).toEqual({ name: "doc_search", params: { q: "x" } })
  })

  it("degrades safely on a malformed wrapper rather than inventing a call", () => {
    expect(resolveNestedToolCall("use_tool", {}).name).toBe("use_tool")
    expect(resolveNestedToolCall("use_tool", { name: "x", params: "not-an-object" }).params).toEqual({})
  })

  it("REGRESSION: a foreign client id nested inside use_tool is REFUSED", async () => {
    // The bypass: the outer call's top-level keys are "name"/"params", neither of which
    // is a client id, so the boundary saw nothing to object to and let it through.
    const out = await executeWorkerTool(
      "use_tool",
      { name: "crm_get_client_summary", params: { account_id: B } },
      new Set(["use_tool"]),
      null,
      null,
      ctx,
    )
    expect(out).toMatch(/❌/)
    expect(out).toMatch(/DIFFERENT client/i)
  })

  it("REGRESSION: foreign-client raw SQL nested inside use_tool is REFUSED", async () => {
    // The SQL branch keyed off the OUTER name, so it never fired for a wrapped call.
    const out = await executeWorkerTool(
      "use_tool",
      { name: "crm_query", params: { query: `select * from payments where account_id = '${B}'` } },
      new Set(["use_tool"]),
      null,
      null,
      ctx,
    )
    expect(out).toMatch(/❌/)
  })

  it("still allows the client actually in scope through the wrapper", async () => {
    const out = await executeWorkerTool(
      "use_tool",
      { name: "crm_get_client_summary", params: { account_id: A } },
      new Set(["use_tool"]),
      null,
      null,
      ctx,
    )
    expect(out).not.toMatch(/DIFFERENT client/i)
  })
})
