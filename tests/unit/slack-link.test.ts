/**
 * Slack permalink parsing (dev job a6c3d75b) — the capability gap Antonio hit
 * when he pasted a Slack link and the worker could only say "I can't".
 */

import { describe, it, expect } from "vitest"
import { parseSlackPermalink, containsSlackLink } from "@/lib/ai-agent/slack-link"

describe("parseSlackPermalink", () => {
  it("parses a top-level message link, splitting the timestamp correctly", () => {
    const got = parseSlackPermalink("https://tonydurante.slack.com/archives/C09ABCD1234/p1752859200123456")
    expect(got).toEqual({ channelId: "C09ABCD1234", ts: "1752859200.123456" })
  })

  it("parses a thread-reply link and keeps the parent thread", () => {
    const got = parseSlackPermalink(
      "https://tonydurante.slack.com/archives/C09ABCD1234/p1752859200123456?thread_ts=1752859100.000100&cid=C09ABCD1234",
    )
    expect(got).toEqual({
      channelId: "C09ABCD1234",
      ts: "1752859200.123456",
      threadTs: "1752859100.000100",
    })
  })

  it("finds a link inside a sentence or markdown", () => {
    expect(parseSlackPermalink("look at this https://td.slack.com/archives/C1/p1752859200123456 please")?.channelId).toBe("C1")
    expect(parseSlackPermalink("[msg](https://td.slack.com/archives/C2/p1752859200123456)")?.channelId).toBe("C2")
  })

  it("returns null for anything that is not a permalink — never guesses", () => {
    for (const s of [
      "",
      "   ",
      "https://example.com/archives/C1/p1752859200123456",
      "https://td.slack.com/archives/C1/1752859200123456",
      "https://td.slack.com/archives/C1/p123",
      "just some text",
    ]) {
      expect(parseSlackPermalink(s), s).toBeNull()
    }
  })

  it("containsSlackLink mirrors it", () => {
    expect(containsSlackLink("https://td.slack.com/archives/C1/p1752859200123456")).toBe(true)
    expect(containsSlackLink("no link here")).toBe(false)
  })
})
