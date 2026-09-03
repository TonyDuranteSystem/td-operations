import { describe, it, expect, vi, beforeEach } from "vitest"

// Keep the real getHeader/isOwnMailboxAddress/extractAllEmailAddresses —
// only gmailGet needs to be a mock (network I/O).
vi.mock("@/lib/gmail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/gmail")>()
  return { ...actual, gmailGet: vi.fn() }
})

import { gmailGet } from "@/lib/gmail"
import { resolveReplyTarget, ReplyTargetError } from "../../lib/inbox/reply-target"

const ASUSER = "support@tonydurante.us"
const THREAD_ID = "thread-1"

function msg(id: string, threadId: string, headers: Record<string, string>) {
  return {
    id,
    threadId,
    labelIds: [],
    snippet: "",
    payload: {
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      mimeType: "text/plain",
    },
    internalDate: "0",
  }
}

const clientMsg = msg("m-client", THREAD_ID, {
  From: "Dragos Popescu <dragos@payset.io>",
  To: ASUSER,
  Subject: "Bank question",
  "Message-ID": "<client-1@payset.io>",
  References: "",
  Date: "Mon, 1 Sep 2026 10:00:00 -0400",
})
const ownMsg = msg("m-own", THREAD_ID, {
  From: ASUSER,
  To: "dragos@payset.io",
  Subject: "Re: Bank question",
  "Message-ID": "<own-1@tonydurante.us>",
  References: "<client-1@payset.io>",
  Date: "Mon, 1 Sep 2026 11:00:00 -0400",
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe("resolveReplyTarget — explicit messageId", () => {
  it("fetches and derives every field from the ONE targeted message", async () => {
    vi.mocked(gmailGet).mockResolvedValue(clientMsg)
    const target = await resolveReplyTarget({ threadId: THREAD_ID, messageId: "m-client", asUser: ASUSER })
    expect(gmailGet).toHaveBeenCalledWith("/messages/m-client", { format: "full" }, ASUSER)
    expect(target.from).toBe("Dragos Popescu <dragos@payset.io>")
    expect(target.messageIdHeader).toBe("<client-1@payset.io>")
  })

  it("rejects a message that belongs to a DIFFERENT thread (stale/tampered target)", async () => {
    vi.mocked(gmailGet).mockResolvedValue(msg("m-other", "different-thread", { From: "dragos@payset.io" }))
    await expect(
      resolveReplyTarget({ threadId: THREAD_ID, messageId: "m-other", asUser: ASUSER })
    ).rejects.toBeInstanceOf(ReplyTargetError)
  })

  it("rejects replying to one of OUR OWN messages when a real client message exists elsewhere in the thread — the normal 'reply to a point I made earlier' click that would misdirect", async () => {
    // The route fetches the target message directly, then — only because it
    // resolved to our own address — fetches the thread to check whether
    // some OTHER message should have been targeted instead.
    vi.mocked(gmailGet).mockImplementation(async (endpoint) => {
      if (endpoint === "/messages/m-own") return ownMsg
      if (endpoint === `/threads/${THREAD_ID}`) return { messages: [clientMsg, ownMsg] }
      throw new Error(`unexpected gmailGet(${endpoint})`)
    })
    await expect(
      resolveReplyTarget({ threadId: THREAD_ID, messageId: "m-own", asUser: ASUSER })
    ).rejects.toThrow(/sent by us/)
  })
})

describe("resolveReplyTarget — default (no messageId)", () => {
  it("picks the newest message NOT sent by us — the actual root-cause fix (both real incidents were an ordinary reply, not a deliberate old-message pick)", async () => {
    // Thread: client message, then OUR reply is the literal newest.
    vi.mocked(gmailGet).mockResolvedValue({ messages: [clientMsg, ownMsg] })
    const target = await resolveReplyTarget({ threadId: THREAD_ID, asUser: ASUSER })
    expect(target.from).toBe("Dragos Popescu <dragos@payset.io>")
  })

  it("falls back to the literal newest message when EVERY message in the thread is ours (nothing else to target)", async () => {
    const own2 = msg("m-own-2", THREAD_ID, { From: ASUSER, To: "dragos@payset.io", Subject: "Following up" })
    vi.mocked(gmailGet).mockResolvedValue({ messages: [ownMsg, own2] })
    const target = await resolveReplyTarget({ threadId: THREAD_ID, asUser: ASUSER })
    expect(target.from).toBe(ASUSER)
  })
})

describe("resolveReplyTarget — Reply-All Cc list", () => {
  const multiParty = msg("m-multi", THREAD_ID, {
    From: '"Dragos Popescu" <dragos@payset.io>',
    To: "support@tonydurante.us, antonio.durante@tonydurante.us",
    Cc: '"Jane Smith" <jane@example.com>, "Popescu, Filip" <filip@payset.io>',
    Subject: "Update",
    "Message-ID": "<multi-1@payset.io>",
    References: "",
  })

  it("mode 'reply' produces no Cc list", async () => {
    vi.mocked(gmailGet).mockResolvedValue(multiParty)
    const target = await resolveReplyTarget({ threadId: THREAD_ID, messageId: "m-multi", mode: "reply", asUser: ASUSER })
    expect(target.cc).toEqual([])
  })

  it("mode 'replyAll' collects To+Cc, excludes our own mailboxes and the primary sender, survives a comma inside a display name", async () => {
    vi.mocked(gmailGet).mockResolvedValue(multiParty)
    const target = await resolveReplyTarget({ threadId: THREAD_ID, messageId: "m-multi", mode: "replyAll", asUser: ASUSER })
    // support@ and antonio.durante@ (our own) excluded; dragos@ excluded (he's the primary To).
    // filip@ survives even though "Popescu, Filip" has a comma in the display name.
    expect(target.cc.sort()).toEqual(["filip@payset.io", "jane@example.com"])
  })

  it("dedupes an address that appears in both To and Cc", async () => {
    const dupe = msg("m-dupe", THREAD_ID, {
      From: "dragos@payset.io",
      To: "support@tonydurante.us, jane@example.com",
      Cc: "jane@example.com",
    })
    vi.mocked(gmailGet).mockResolvedValue(dupe)
    const target = await resolveReplyTarget({ threadId: THREAD_ID, messageId: "m-dupe", mode: "replyAll", asUser: ASUSER })
    expect(target.cc).toEqual(["jane@example.com"])
  })
})
