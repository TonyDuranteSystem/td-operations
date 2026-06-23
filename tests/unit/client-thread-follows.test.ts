import { describe, it, expect } from "vitest"
import {
  renderFollowDigestText,
  renderCanvasMarkdown,
  type FollowDigestRow,
} from "@/lib/ai-agent/client-thread-follows"

describe("renderFollowDigestText", () => {
  it("shows an empty-state nudge when nothing is followed", () => {
    const out = renderFollowDigestText([])
    expect(out).toContain("not following any open conversations")
    expect(out).toContain("👀 Follow")
  })

  it("renders a clickable permalink per followed conversation + a count", () => {
    const rows: FollowDigestRow[] = [
      {
        clientName: "Mat Digital Solution LLC",
        topic: "billing",
        openedAt: "2026-06-22T14:46:19Z",
        permalink: "https://x.slack.com/archives/C0/p1782139579094809?thread_ts=1782139579.094809&cid=C0",
      },
    ]
    const out = renderFollowDigestText(rows)
    expect(out).toContain("Your followed conversations* (1)")
    // Slack mrkdwn link: <url|label> — label is plain (no nested bold)
    expect(out).toContain(
      "<https://x.slack.com/archives/C0/p1782139579094809?thread_ts=1782139579.094809&cid=C0|Mat Digital Solution LLC · billing>",
    )
    expect(out).toContain("opened")
  })

  it("falls back to plain text when a permalink is missing", () => {
    const rows: FollowDigestRow[] = [
      { clientName: "Zhang Holding LLC", topic: "tax", openedAt: null, permalink: null },
    ]
    const out = renderFollowDigestText(rows)
    expect(out).toContain("• Zhang Holding LLC · tax")
    expect(out).not.toContain("<http")
  })

  it("counts multiple rows", () => {
    const rows: FollowDigestRow[] = [
      { clientName: "A LLC", topic: "banking", openedAt: null, permalink: null },
      { clientName: "B LLC", topic: "formation", openedAt: null, permalink: null },
    ]
    expect(renderFollowDigestText(rows)).toContain("(2)")
  })
})

describe("renderCanvasMarkdown", () => {
  it("renders an empty-state line when nothing is open", () => {
    const out = renderCanvasMarkdown([])
    expect(out).toContain("# 🗂️ Followed client conversations")
    expect(out).toContain("Nobody is following any open conversations")
  })

  it("renders markdown links ([label](url)) that open each thread", () => {
    const rows: FollowDigestRow[] = [
      {
        clientName: "Zhang Holding LLC",
        topic: "tax",
        openedAt: "2026-06-22T16:00:00Z",
        permalink: "https://x.slack.com/archives/C0/p1?thread_ts=1&cid=C0",
      },
    ]
    const out = renderCanvasMarkdown(rows)
    expect(out).toContain("[Zhang Holding LLC · tax](https://x.slack.com/archives/C0/p1?thread_ts=1&cid=C0)")
    expect(out).toContain("opened")
  })

  it("falls back to plain text when a permalink is missing", () => {
    const out = renderCanvasMarkdown([{ clientName: "A LLC", topic: "banking", openedAt: null, permalink: null }])
    expect(out).toContain("- A LLC · banking")
    expect(out).not.toContain("](http")
  })
})
