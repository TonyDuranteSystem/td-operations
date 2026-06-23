import { describe, it, expect } from "vitest"
import { pickMessageTextByTs } from "@/lib/ai-agent/slack-claude"

describe("pickMessageTextByTs (🧠 reaction message fetch)", () => {
  it("returns the trimmed text of the message whose ts matches", () => {
    const msgs = [{ ts: "100.1", text: "  hello  " }]
    expect(pickMessageTextByTs(msgs, "100.1")).toBe("hello")
  })

  it("picks the MATCHING ts even when it is not the first message (the thread-reply bug)", () => {
    // conversations.history/replies can return the parent first; we must match ts,
    // not blindly take [0]. Reacting to the reply must save the reply, not the parent.
    const msgs = [
      { ts: "100.1", text: "PARENT: should I email the client?" },
      { ts: "100.9", text: "REPLY: don't send it — verify the EIN first" },
    ]
    expect(pickMessageTextByTs(msgs, "100.9")).toBe("REPLY: don't send it — verify the EIN first")
  })

  it("returns null when no ts matches", () => {
    expect(pickMessageTextByTs([{ ts: "1.1", text: "x" }], "2.2")).toBeNull()
  })

  it("returns null for an empty/whitespace-only matched message", () => {
    expect(pickMessageTextByTs([{ ts: "1.1", text: "   " }], "1.1")).toBeNull()
  })

  it("returns null for undefined / empty input", () => {
    expect(pickMessageTextByTs(undefined, "1.1")).toBeNull()
    expect(pickMessageTextByTs([], "1.1")).toBeNull()
  })
})
