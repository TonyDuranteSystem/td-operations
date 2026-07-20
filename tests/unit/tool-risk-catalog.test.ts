/**
 * THE BUILD GATE for the tool allow-list (dev job 74701b48).
 *
 * The old classifier guessed a tool's risk from its NAME, so adding a tool to the
 * catalog silently granted it whatever the guess said — and the guess auto-approved 106
 * of 216 tools, including one that emails every client's EIN to a model-chosen address
 * and one that overwrites a client's filed P&L.
 *
 * The guess is gone; the allow-list is now the only route to auto-run. This file exists
 * so that stays true: it reads the REGISTERED catalog off disk and fails when a tool is
 * on the allow-list without existing, or when the allow-list drifts from what a human
 * actually reviewed.
 *
 * If this test fails because you added a tool: read its handler and answer BOTH
 * questions — (1) does it change anything, including via a parameter that defaults to
 * true or an inverted `dry_run`; (2) does what it RETURNS carry credentials, a bearer
 * link, another client's records, or bulk tax IDs. Only then decide. Do NOT add a name
 * to make the test pass.
 */

import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"
import { READ_TOOLS, HARD_BLOCKED_TOOLS, classifyTool, decideAction } from "@/lib/ai-agent/tool-risk"

/** Every tool name registered with the MCP server, read from source. */
function registeredToolNames(): Set<string> {
  const dir = join(process.cwd(), "lib/mcp/tools")
  const names = new Set<string>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue
    const src = readFileSync(join(dir, file), "utf8")
    // BOTH quote styles: a single-quoted registration would otherwise be invisible
    // to this gate — and a tool the gate cannot see is a tool nobody reviewed.
    const re = /server\.tool\(\s*\n?\s*['"]([a-z0-9_]+)['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src)) !== null) names.add(m[1])
  }
  return names
}

const REGISTERED = registeredToolNames()

describe("tool catalog ↔ allow-list", () => {
  it("finds the catalog (guards against the extraction silently breaking)", () => {
    // If the regex stops matching, every other assertion here passes vacuously.
    expect(REGISTERED.size).toBeGreaterThan(150)
  })

  it("every allow-listed tool actually exists — a typo protects nothing", () => {
    const ghosts = Array.from(READ_TOOLS).filter((n) => !REGISTERED.has(n))
    expect(ghosts, `allow-listed but not registered: ${ghosts.join(", ")}`).toEqual([])
  })

  it("every hard-blocked tool actually exists", () => {
    const ghosts = Array.from(HARD_BLOCKED_TOOLS).filter((n) => !REGISTERED.has(n))
    expect(ghosts, `hard-blocked but not registered: ${ghosts.join(", ")}`).toEqual([])
  })

  it("REGRESSION GATE: a tool is auto-runnable ONLY by being on the reviewed list", () => {
    // The core invariant. Every registered tool either auto-runs because a human put it
    // on the list, or it asks. There is no third path any more.
    const autoRunnable = Array.from(REGISTERED).filter((n) => decideAction(n).decision === "auto")
    const unreviewed = autoRunnable.filter((n) => !READ_TOOLS.has(n))
    expect(unreviewed, `auto-running without review: ${unreviewed.join(", ")}`).toEqual([])
  })

  it("a newly added tool asks first, purely by not being listed", () => {
    expect(decideAction("some_brand_new_tool_nobody_classified").decision).toBe("approval")
    // Even one whose name would previously have read as harmless.
    expect(decideAction("client_summary_get_list_report").decision).toBe("approval")
  })

  it("hard-blocked beats everything, including the allow-list", () => {
    for (const n of Array.from(HARD_BLOCKED_TOOLS)) {
      expect(decideAction(n).decision, n).toBe("blocked")
    }
  })
})

describe("the specific tools that were auto-running and should not have been", () => {
  // Each of these was classified READ by the old name heuristic. They are the reason
  // the heuristic was deleted; if any regresses to auto, the rewrite has been undone.
  const MUST_NOT_AUTO = [
    ["tax_extension_list", "sends a CSV of every client's EIN to a model-chosen address"],
    ["sysdoc_read", "reads system docs including platform credentials"],
    ["signature_request_get", "returns a link that signs a legal document as the client"],
    ["gmail_read_attachment", "opens an attachment in any mailbox and writes to Drive"],
    ["bank_statement_pnl", "overwrites the client's filed P&L (upload_to_drive defaults true)"],
    ["lead_search", "returns offer_link, a contract-signing bearer URL"],
    ["lead_get", "returns offer_link, a contract-signing bearer URL"],
    ["msg_list_channels", "returns messaging provider config"],
    ["crm_search_contacts", "returns ITIN, DOB and passport data in bulk"],
    ["crm_search_payments", "returns pay_token, a live bearer payment link"],
    ["doc_get", "prints raw OCR of passports and tax returns"],
    ["kb_get", "looks like a read; bumps a usage counter"],
    ["cb_get_call", "returns the meeting transcript and a recording URL"],
    ["cal_get_event_details", "returns invitee PII and a reschedule URL"],
    ["storage_read", "returns the body of any file in the bucket"],
    ["docai_ocr_file", "OCRs any Drive file by id"],
    ["gmail_labels", "enumerates any mailbox via as_user"],
    ["whop_list_payments", "returns customer card brand, last4 and billing addresses"],
  ] as const

  for (const [name, why] of MUST_NOT_AUTO) {
    it(`${name} requires approval — ${why}`, () => {
      expect(REGISTERED.has(name), `${name} is no longer registered; update this test`).toBe(true)
      expect(decideAction(name).decision).not.toBe("auto")
    })
  }
})

describe("parameter escalation", () => {
  it("catches a STRING-valued send flag — the shape the old check missed entirely", () => {
    // isTruthyFlag only accepted true/1, so an email address never escalated.
    expect(classifyTool("some_list_tool", { send_to_email: "a@b.com" }).tier).toBe("EXTERNAL")
  })

  it("catches a flag whose real name only CONTAINS the listed one", () => {
    // The list says "send_email"; the real param is "send_to_email". Exact matching
    // never fired. Same for save_to_drive vs save_to_drive_folder_id.
    expect(classifyTool("x_tool", { save_to_drive_folder_id: "1AbC" }).tier).toBe("EXTERNAL")
  })

  it("escalates an allow-listed tool when called with a sending flag", () => {
    expect(decideAction("doc_search").decision).toBe("auto")
    expect(decideAction("doc_search", { send_email: true }).decision).toBe("approval")
  })

  it("does NOT escalate when the flag is explicitly switched off", () => {
    // false/""/0 mean the caller turned the behaviour off; that must stay auto.
    expect(decideAction("doc_search", { send_email: false }).decision).toBe("auto")
    expect(decideAction("doc_search", { send_to_email: "" }).decision).toBe("auto")
  })

  it("an empty array is not a set flag; a populated one is", () => {
    expect(decideAction("doc_search", { attachments: [] }).decision).toBe("auto")
    expect(classifyTool("doc_search", { send_email: ["x"] }).tier).toBe("EXTERNAL")
  })
})
