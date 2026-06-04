/**
 * AI-agent enum normalization (lib/ai-agent/enum-normalization.ts).
 *
 * Pins the canonical DB values (verified against pg_enum 2026-06-04) and the
 * flexible-input → canonical-value mapping that keeps the AI-agent tools from
 * throwing 22P02 on writes or silently mis-filtering on searches.
 */

import { describe, it, expect } from "vitest"
import {
  TASK_PRIORITY_VALUES,
  TASK_STATUS_VALUES,
  TASK_CATEGORY_VALUES,
  SERVICE_STATUS_VALUES,
  CONVERSATION_CHANNEL_VALUES,
  ACCOUNT_STATUS_VALUES,
  PAYMENT_STATUS_VALUES,
  DEAL_STAGE_VALUES,
  LEAD_STATUS_VALUES,
  TAX_RETURN_STATUS_VALUES,
  normalizeTaskPriority,
  normalizeTaskStatus,
  normalizeTaskCategory,
  normalizeServiceStatus,
  normalizeConversationChannel,
  normalizeAccountStatus,
  normalizePaymentStatus,
  normalizeDealStage,
  normalizeLeadStatus,
  normalizeTaxReturnStatus,
  normalizeToolParams,
} from "@/lib/ai-agent/enum-normalization"

describe("enum-normalization — canonical value sets match the DB", () => {
  it("task_priority", () => {
    expect(TASK_PRIORITY_VALUES).toEqual(["Urgent", "High", "Normal", "Low"])
  })
  it("task_status", () => {
    expect(TASK_STATUS_VALUES).toEqual(["To Do", "In Progress", "Waiting", "Done", "Cancelled"])
  })
  it("task_category includes the real 12 values and none of the old invalid ones", () => {
    expect(TASK_CATEGORY_VALUES).toContain("Internal")
    expect(TASK_CATEGORY_VALUES).toContain("Filing")
    expect(TASK_CATEGORY_VALUES).not.toContain("Admin")
    expect(TASK_CATEGORY_VALUES).not.toContain("Tax")
    expect(TASK_CATEGORY_VALUES).not.toContain("Billing")
  })
})

describe("normalizeTaskPriority", () => {
  it("maps the historical bug values to canonical", () => {
    expect(normalizeTaskPriority("medium")).toBe("Normal") // the core bug
    expect(normalizeTaskPriority("low")).toBe("Low")
    expect(normalizeTaskPriority("high")).toBe("High")
    expect(normalizeTaskPriority("urgent")).toBe("Urgent")
  })
  it("is case-insensitive and trims", () => {
    expect(normalizeTaskPriority("NORMAL")).toBe("Normal")
    expect(normalizeTaskPriority("  High  ")).toBe("High")
  })
  it("accepts canonical values unchanged (idempotent)", () => {
    for (const v of TASK_PRIORITY_VALUES) expect(normalizeTaskPriority(v)).toBe(v)
  })
  it("returns null for unrecognized / non-string input", () => {
    expect(normalizeTaskPriority("banana")).toBeNull()
    expect(normalizeTaskPriority("")).toBeNull()
    expect(normalizeTaskPriority(undefined)).toBeNull()
    expect(normalizeTaskPriority(5)).toBeNull()
  })
})

describe("normalizeTaskStatus", () => {
  it("maps common synonyms", () => {
    expect(normalizeTaskStatus("todo")).toBe("To Do")
    expect(normalizeTaskStatus("to-do")).toBe("To Do")
    expect(normalizeTaskStatus("in progress")).toBe("In Progress")
    expect(normalizeTaskStatus("inprogress")).toBe("In Progress")
    expect(normalizeTaskStatus("done")).toBe("Done")
    expect(normalizeTaskStatus("completed")).toBe("Done")
    expect(normalizeTaskStatus("canceled")).toBe("Cancelled")
  })
  it("accepts canonical values unchanged", () => {
    for (const v of TASK_STATUS_VALUES) expect(normalizeTaskStatus(v)).toBe(v)
  })
  it("rejects unknown", () => {
    expect(normalizeTaskStatus("Bogus")).toBeNull()
  })
})

describe("normalizeTaskCategory", () => {
  it("accepts all canonical categories case-insensitively", () => {
    for (const v of TASK_CATEGORY_VALUES) {
      expect(normalizeTaskCategory(v.toLowerCase())).toBe(v)
    }
  })
  it("maps follow-up synonyms", () => {
    expect(normalizeTaskCategory("followup")).toBe("Follow-up")
    expect(normalizeTaskCategory("follow up")).toBe("Follow-up")
  })
  it("returns null for the old invalid defaults", () => {
    expect(normalizeTaskCategory("Admin")).toBeNull()
    expect(normalizeTaskCategory("Tax")).toBeNull()
  })
})

describe("normalizeServiceStatus", () => {
  it("handles casing and synonyms", () => {
    expect(normalizeServiceStatus("not started")).toBe("Not Started")
    expect(normalizeServiceStatus("waiting client")).toBe("Waiting Client")
    expect(normalizeServiceStatus("complete")).toBe("Completed")
  })
  it("accepts canonical values unchanged", () => {
    for (const v of SERVICE_STATUS_VALUES) expect(normalizeServiceStatus(v)).toBe(v)
  })
})

describe("normalizeConversationChannel", () => {
  it("handles casing and synonyms", () => {
    expect(normalizeConversationChannel("whatsapp")).toBe("WhatsApp")
    expect(normalizeConversationChannel("call")).toBe("Phone")
    expect(normalizeConversationChannel("in person")).toBe("In-Person")
  })
  it("accepts canonical values unchanged", () => {
    for (const v of CONVERSATION_CHANNEL_VALUES) expect(normalizeConversationChannel(v)).toBe(v)
  })
  it("returns null for unknown channels", () => {
    expect(normalizeConversationChannel("Pigeon")).toBeNull()
  })
})

describe("search-filter normalizers", () => {
  it("account status", () => {
    expect(normalizeAccountStatus("active")).toBe("Active")
    expect(normalizeAccountStatus("pending")).toBe("Pending Formation")
    for (const v of ACCOUNT_STATUS_VALUES) expect(normalizeAccountStatus(v)).toBe(v)
  })
  it("payment status", () => {
    expect(normalizePaymentStatus("paid")).toBe("Paid")
    expect(normalizePaymentStatus("unpaid")).toBe("Pending")
    for (const v of PAYMENT_STATUS_VALUES) expect(normalizePaymentStatus(v)).toBe(v)
  })
  it("deal stage", () => {
    expect(normalizeDealStage("won")).toBe("Closed Won")
    expect(normalizeDealStage("closed won")).toBe("Closed Won")
    for (const v of DEAL_STAGE_VALUES) expect(normalizeDealStage(v)).toBe(v)
  })
  it("lead status", () => {
    expect(normalizeLeadStatus("new")).toBe("New")
    expect(normalizeLeadStatus("converted")).toBe("Converted")
    for (const v of LEAD_STATUS_VALUES) expect(normalizeLeadStatus(v)).toBe(v)
  })
  it("tax return status (no aliases, case-insensitive exact)", () => {
    expect(normalizeTaxReturnStatus("data received")).toBe("Data Received")
    expect(normalizeTaxReturnStatus("tr filed")).toBe("TR Filed")
    for (const v of TAX_RETURN_STATUS_VALUES) expect(normalizeTaxReturnStatus(v)).toBe(v)
  })
})

describe("normalizeToolParams", () => {
  it("normalizes create_task priority + category", () => {
    const out = normalizeToolParams("create_task", {
      task_title: "X",
      priority: "medium",
      category: "filing",
    }) as Record<string, unknown>
    expect(out.priority).toBe("Normal")
    expect(out.category).toBe("Filing")
    expect(out.task_title).toBe("X") // untouched
  })

  it("normalizes update_task status", () => {
    const out = normalizeToolParams("update_task", { task_id: "t", status: "todo" }) as Record<string, unknown>
    expect(out.status).toBe("To Do")
  })

  it("leaves an unrecognized value unchanged so validation can flag it", () => {
    const out = normalizeToolParams("update_task", { task_id: "t", status: "Bogus" }) as Record<string, unknown>
    expect(out.status).toBe("Bogus")
  })

  it("does not mutate the input object", () => {
    const input = { task_title: "X", priority: "high" }
    const out = normalizeToolParams("create_task", input) as Record<string, unknown>
    expect(input.priority).toBe("high") // original untouched
    expect(out.priority).toBe("High")
    expect(out).not.toBe(input) // new object returned
  })

  it("returns the same reference for tools with no enum-backed params", () => {
    const input = { to: "a@b.c", subject: "S", body: "B" }
    const out = normalizeToolParams("send_email", input)
    expect(out).toBe(input) // identity → params_hash stays stable
  })

  it("returns the same reference when nothing needs changing", () => {
    const input = { task_title: "X", priority: "Normal" }
    const out = normalizeToolParams("create_task", input)
    expect(out).toBe(input)
  })

  it("ignores non-object params", () => {
    expect(normalizeToolParams("create_task", null)).toBeNull()
    expect(normalizeToolParams("create_task", "x")).toBe("x")
  })
})
