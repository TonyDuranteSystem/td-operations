import { describe, it, expect } from "vitest"
import { renderChannelCanvasMarkdown, type ChannelFollowRow } from "@/lib/ai-agent/slack-thread-follows"

describe("renderChannelCanvasMarkdown", () => {
  it("shows an empty-state nudge when nothing is followed in the channel", () => {
    const out = renderChannelCanvasMarkdown([])
    expect(out).toContain("# 🗂️ Followed conversations")
    expect(out).toContain("No followed conversations in this channel yet")
    expect(out).toContain("👀")
  })

  it("renders a clickable thread deep link per followed thread", () => {
    const rows: ChannelFollowRow[] = [
      { label: "Partner portal — Alba / Davide Priori referral", channelId: "C0DEV", threadTs: "1782200000.111111", createdAt: null },
    ]
    const out = renderChannelCanvasMarkdown(rows)
    expect(out).toContain(
      "[Partner portal — Alba / Davide Priori referral](https://tdoperationsworkspace.slack.com/archives/C0DEV/p1782200000111111?thread_ts=1782200000.111111&cid=C0DEV)",
    )
  })

  it("collapses whitespace and caps the label length", () => {
    const long = "x".repeat(200)
    const out = renderChannelCanvasMarkdown([
      { label: `line1\n\n  line2   ${long}`, channelId: "C", threadTs: "1.2", createdAt: null },
    ])
    // label is single-line and <= 80 chars inside the [..] segment
    const m = out.match(/\[([^\]]*)\]/)
    expect(m).not.toBeNull()
    expect(m![1].length).toBeLessThanOrEqual(80)
    expect(m![1]).not.toContain("\n")
  })

  it("falls back to 'conversation' when the label is empty", () => {
    const out = renderChannelCanvasMarkdown([{ label: "", channelId: "C", threadTs: "1.2", createdAt: null }])
    expect(out).toContain("[conversation](")
  })
})
