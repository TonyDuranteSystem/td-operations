import { describe, it, expect, vi, beforeEach } from "vitest"

// Keep the real getHeader/isOwnMailboxAddress/extractAllEmailAddresses —
// only gmailGet needs to be a mock (network I/O).
vi.mock("@/lib/gmail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/gmail")>()
  return { ...actual, gmailGet: vi.fn() }
})

import { gmailGet } from "@/lib/gmail"
import { resolveReplyTarget, buildThreadQuotes, ReplyTargetError } from "../../lib/inbox/reply-target"

const ASUSER = "support@tonydurante.us"
const THREAD_ID = "thread-1"

function msg(id: string, threadId: string, headers: Record<string, string>, internalDate = "0") {
  return {
    id,
    threadId,
    labelIds: [],
    snippet: "",
    payload: {
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      mimeType: "text/plain",
    },
    internalDate,
  }
}

const clientMsg = msg("m-client", THREAD_ID, {
  From: "Dragos Popescu <dragos@payset.io>",
  To: ASUSER,
  Subject: "Bank question",
  "Message-ID": "<client-1@payset.io>",
  References: "",
  Date: "Mon, 1 Sep 2026 10:00:00 -0400",
}, "1")
const ownMsg = msg("m-own", THREAD_ID, {
  From: ASUSER,
  To: "dragos@payset.io",
  Subject: "Re: Bank question",
  "Message-ID": "<own-1@tonydurante.us>",
  References: "<client-1@payset.io>",
  Date: "Mon, 1 Sep 2026 11:00:00 -0400",
}, "2")

beforeEach(() => {
  vi.clearAllMocks()
})

describe("resolveReplyTarget — explicit messageId", () => {
  it("fetches and derives every field from the ONE targeted message", async () => {
    vi.mocked(gmailGet).mockResolvedValue(clientMsg)
    const target = await resolveReplyTarget({ threadId: THREAD_ID, messageId: "m-client", asUser: ASUSER })
    expect(gmailGet).toHaveBeenCalledWith("/messages/m-client", { format: "full" }, ASUSER)
    // Inbound case is unchanged from before: the full "Name <addr>" string,
    // so encodeAddressHeader can still RFC-2047-encode the display name.
    expect(target.replyToAddresses).toEqual(["Dragos Popescu <dragos@payset.io>"])
    expect(target.quotedFrom).toBe("Dragos Popescu <dragos@payset.io>")
    expect(target.messageIdHeader).toBe("<client-1@payset.io>")
  })

  it("rejects a message that belongs to a DIFFERENT thread (stale/tampered target)", async () => {
    vi.mocked(gmailGet).mockResolvedValue(msg("m-other", "different-thread", { From: "dragos@payset.io" }))
    await expect(
      resolveReplyTarget({ threadId: THREAD_ID, messageId: "m-other", asUser: ASUSER })
    ).rejects.toBeInstanceOf(ReplyTargetError)
  })

  // Antonio, 2026-09-03 (dev job 208f39ad): explicitly replying to one of our
  // OWN sent messages is now ALLOWED — it used to hard-reject. Must address
  // the reply to that message's own recipient, never back to us, while the
  // quote underneath still correctly credits US as the author.
  it("picking our own sent message addresses the reply to THAT message's own recipient, not to us — and still quotes US as the author", async () => {
    vi.mocked(gmailGet).mockResolvedValue(ownMsg)
    const target = await resolveReplyTarget({ threadId: THREAD_ID, messageId: "m-own", asUser: ASUSER })
    expect(target.replyToAddresses).toEqual(["dragos@payset.io"])
    expect(target.quotedFrom).toBe(ASUSER)
  })

  it("a sent message with MULTIPLE original recipients addresses the reply to all of them", async () => {
    const ownMulti = msg("m-own-multi", THREAD_ID, {
      From: ASUSER,
      To: "dragos@payset.io, jane@example.com",
      Subject: "Update for both of you",
    })
    vi.mocked(gmailGet).mockResolvedValue(ownMulti)
    const target = await resolveReplyTarget({ threadId: THREAD_ID, messageId: "m-own-multi", asUser: ASUSER })
    expect(target.replyToAddresses.sort()).toEqual(["dragos@payset.io", "jane@example.com"])
  })

  it("a sent message whose only recipient is one of OUR OTHER own aliases falls back to addressing us (nothing else to target)", async () => {
    const internalOnly = msg("m-internal", THREAD_ID, {
      From: "antonio.durante@tonydurante.us",
      To: "support@tonydurante.us",
      Subject: "Internal note",
    })
    vi.mocked(gmailGet).mockResolvedValue(internalOnly)
    const target = await resolveReplyTarget({ threadId: THREAD_ID, messageId: "m-internal", asUser: ASUSER })
    expect(target.replyToAddresses).toEqual(["antonio.durante@tonydurante.us"])
  })

  it("toOverride replaces the resolved recipient(s) outright", async () => {
    vi.mocked(gmailGet).mockResolvedValue(clientMsg)
    const target = await resolveReplyTarget({
      threadId: THREAD_ID,
      messageId: "m-client",
      asUser: ASUSER,
      toOverride: ["someone-else@example.com"],
    })
    expect(target.replyToAddresses).toEqual(["someone-else@example.com"])
  })
})

describe("resolveReplyTarget — default (no messageId)", () => {
  it("picks the newest message NOT sent by us — the actual root-cause fix (both real incidents were an ordinary reply, not a deliberate old-message pick)", async () => {
    // Thread: client message, then OUR reply is the literal newest.
    vi.mocked(gmailGet).mockResolvedValue({ messages: [clientMsg, ownMsg] })
    const target = await resolveReplyTarget({ threadId: THREAD_ID, asUser: ASUSER })
    expect(target.replyToAddresses).toEqual(["Dragos Popescu <dragos@payset.io>"])
  })

  it("falls back to the literal newest message when EVERY message in the thread is ours — and, since that message's own To is a real external recipient, correctly addresses them rather than defaulting back to us", async () => {
    const own2 = msg("m-own-2", THREAD_ID, { From: ASUSER, To: "dragos@payset.io", Subject: "Following up" })
    vi.mocked(gmailGet).mockResolvedValue({ messages: [ownMsg, own2] })
    const target = await resolveReplyTarget({ threadId: THREAD_ID, asUser: ASUSER })
    expect(target.replyToAddresses).toEqual(["dragos@payset.io"])
  })

  it("...but a genuinely internal-only fallback (every message's To is also one of our own addresses) has no real alternative, so addresses back to us", async () => {
    const internalOnly = msg("m-internal-2", THREAD_ID, { From: ASUSER, To: "antonio.durante@tonydurante.us", Subject: "Note to self" })
    vi.mocked(gmailGet).mockResolvedValue({ messages: [internalOnly] })
    const target = await resolveReplyTarget({ threadId: THREAD_ID, asUser: ASUSER })
    expect(target.replyToAddresses).toEqual([ASUSER])
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

  // Reply-All on our OWN sent message: the new primary recipient (derived
  // from To, not From) must not also be duplicated into Cc.
  it("Reply-All on our own sent message excludes the new primary recipient(s) from Cc, not the old From-based one", async () => {
    const ownMultiCc = msg("m-own-cc", THREAD_ID, {
      From: ASUSER,
      To: "dragos@payset.io, jane@example.com",
      Cc: "filip@payset.io",
      Subject: "Update",
    })
    vi.mocked(gmailGet).mockResolvedValue(ownMultiCc)
    const target = await resolveReplyTarget({ threadId: THREAD_ID, messageId: "m-own-cc", mode: "replyAll", asUser: ASUSER })
    expect(target.replyToAddresses.sort()).toEqual(["dragos@payset.io", "jane@example.com"])
    // Neither primary recipient reappears in cc — only the genuinely-extra filip@.
    expect(target.cc).toEqual(["filip@payset.io"])
  })

  // BLOCKER caught by the bug-hunter pass (dev job 208f39ad): the UI always
  // re-sends its current recipient list as toOverride, even when staff never
  // touched it — so "an override was sent" must NOT by itself disable the
  // normal auto-Cc, or Reply-All's Cc silently stops working on every
  // ordinary send, not just edited ones.
  it("an UNCHANGED toOverride (identical to what would have resolved naturally) still gets the normal auto-Cc", async () => {
    vi.mocked(gmailGet).mockResolvedValue(multiParty)
    const target = await resolveReplyTarget({
      threadId: THREAD_ID,
      messageId: "m-multi",
      mode: "replyAll",
      asUser: ASUSER,
      toOverride: ["dragos@payset.io"], // exactly what the server would resolve on its own
    })
    expect(target.cc.sort()).toEqual(["filip@payset.io", "jane@example.com"])
  })

  // The actual blocker: removing a recipient from the visible To chips must
  // not silently re-add them via the auto-computed Cc — that would make the
  // chip disappear on screen while the person still receives the email.
  it("a GENUINELY edited toOverride (a recipient actually removed) suppresses auto-Cc entirely, rather than silently re-adding the removed person via Cc", async () => {
    const ownMultiCc = msg("m-own-cc2", THREAD_ID, {
      From: ASUSER,
      To: "dragos@payset.io, jane@example.com",
      Cc: "filip@payset.io",
      Subject: "Update",
    })
    vi.mocked(gmailGet).mockResolvedValue(ownMultiCc)
    // Staff removed jane@example.com from the To chips before Reply-All.
    const target = await resolveReplyTarget({
      threadId: THREAD_ID,
      messageId: "m-own-cc2",
      mode: "replyAll",
      asUser: ASUSER,
      toOverride: ["dragos@payset.io"],
    })
    expect(target.replyToAddresses).toEqual(["dragos@payset.io"])
    // jane@ must NOT reappear in cc (that would defeat the removal), and
    // filip@ — a genuine Cc nobody touched — is also withheld rather than
    // guessed at, since there is no way today to show/edit Cc separately.
    expect(target.cc).toEqual([])
  })

  it("a genuinely edited toOverride on a plain (non-replyAll) reply has no Cc either way — nothing to suppress", async () => {
    vi.mocked(gmailGet).mockResolvedValue(multiParty)
    const target = await resolveReplyTarget({
      threadId: THREAD_ID,
      messageId: "m-multi",
      mode: "reply",
      asUser: ASUSER,
      toOverride: ["someone-else@example.com"],
    })
    expect(target.cc).toEqual([])
  })
})

describe("buildThreadQuotes", () => {
  it("returns every message strictly BEFORE the excluded (target) message, oldest-first, never anything after it", async () => {
    const third = msg("m-third", THREAD_ID, {
      From: "dragos@payset.io",
      To: ASUSER,
      Subject: "Follow-up",
      Date: "Mon, 1 Sep 2026 12:00:00 -0400",
    }, "3")
    // Deliberately out of order in the mocked response — function must sort.
    vi.mocked(gmailGet).mockResolvedValue({ messages: [third, ownMsg, clientMsg] })
    const quotes = await buildThreadQuotes(THREAD_ID, ASUSER, "m-own")
    expect(quotes.map((q) => q.from)).toEqual(["Dragos Popescu <dragos@payset.io>"])
  })

  it("strips each message's own nested quoted history before including it", async () => {
    const withNestedQuote = msg("m-nested", THREAD_ID, {
      From: "dragos@payset.io",
      To: ASUSER,
      Subject: "Re: thing",
      Date: "Mon, 1 Sep 2026 09:00:00 -0400",
    }, "0")
    // Body already carries a full quote of an earlier message — must not survive.
    withNestedQuote.payload = {
      ...withNestedQuote.payload,
      body: { data: Buffer.from("Fresh content here.\n\nOn Mon, wrote:\n> old stuff\n> more old stuff").toString("base64url") },
      mimeType: "text/plain",
    } as never
    vi.mocked(gmailGet).mockResolvedValue({ messages: [withNestedQuote, ownMsg] })
    const quotes = await buildThreadQuotes(THREAD_ID, ASUSER, "m-own")
    expect(quotes).toHaveLength(1)
    expect(quotes[0].body).toContain("Fresh content here.")
    expect(quotes[0].body).not.toContain("old stuff")
  })
})
