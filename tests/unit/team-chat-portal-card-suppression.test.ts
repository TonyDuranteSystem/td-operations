import { describe, it, expect } from "vitest"
import { teamChatCardForFrozenDraft } from "@/lib/team/confirm-card"

/**
 * TEAM CHAT MUST NOT RENDER A PORTAL CARD.
 *
 * Why this is worth its own file. Team Chat's Confirm card is not like the
 * ephemeral panel cards in the Inbox and Portal Chats — it is written INTO a
 * chat message, so it is permanent and visible to the whole channel, and it
 * stays clickable long after the conversation has moved on.
 *
 * A portal row physically cannot hold a recipient address or a subject (the
 * database's per-kind CHECK forbids it), so a portal draft rendered through the
 * email card path produces a permanent channel message that reads:
 *
 *     Confirm email to null
 *
 * pointing at a real, confirmable frozen send. And Team Chat has neither the
 * client picker nor the language dropdown a portal send requires, so even a
 * correctly-labelled portal card would be unusable there. Suppression is the
 * only right answer.
 *
 * The guard is one `kind !== 'email'` line inside a long side-effecting
 * function, and `strict: false` in tsconfig means the nullable types would NOT
 * have failed the build without it. Exactly the kind of control that quietly
 * disappears in a refactor — hence pinned here.
 */

const emailDraft = {
  id: "prep-1",
  kind: "email",
  to_address: "chiara@example.com",
  subject: "Re: your password reset",
  body: "Ciao Chiara, ti rimandiamo il link adesso.",
  attachments: [] as Array<{ name?: string }>,
}

describe("teamChatCardForFrozenDraft", () => {
  it("SUPPRESSES a portal draft — no card at all", () => {
    expect(
      teamChatCardForFrozenDraft({ id: "prep-2", kind: "portal", to_address: null, subject: null, body: "…" }),
    ).toBeNull()
  })

  it("suppresses anything that is not explicitly an email (null / missing / unknown kind)", () => {
    // A row whose kind never arrived must fail CLOSED. Falling through to the
    // email card would title itself "Confirm email to null".
    expect(teamChatCardForFrozenDraft({ id: "p", kind: null, to_address: null, subject: null })).toBeNull()
    expect(teamChatCardForFrozenDraft({ id: "p", to_address: null, subject: null })).toBeNull()
    expect(teamChatCardForFrozenDraft({ id: "p", kind: "sms", to_address: null, subject: null })).toBeNull()
  })

  it("attaches nothing when the turn froze nothing", () => {
    expect(teamChatCardForFrozenDraft(null)).toBeNull()
  })

  it("still builds the EMAIL card — the working case is not weakened", () => {
    const card = teamChatCardForFrozenDraft(emailDraft)
    expect(card).toEqual({
      kind: "email_confirm",
      title: "Confirm email to chiara@example.com",
      subtitle: "Re: your password reset",
      entity_type: "worker_prepared_send",
      entity_id: "prep-1",
      body: "Ciao Chiara, ti rimandiamo il link adesso.",
    })
  })

  it("carries the FILES themselves so the card can render them — a filename in a subtitle is not something a human can check", () => {
    // CONTRACT CHANGED: the names used to be joined into the subtitle. With a file
    // now able to come from a conversation (and later from a client's records),
    // one company's "EIN Letter.pdf" reads exactly like another's — so the card
    // renders each file, openable, with where it came from.
    const card = teamChatCardForFrozenDraft({
      ...emailDraft,
      attachments: [
        { name: "affidavit.pdf", size: 400, content_type: "application/pdf", origin: "posted in this thread by Luca" },
        { name: "ein.pdf" },
      ],
    })
    expect(card?.subtitle).toBe("Re: your password reset")
    expect(card?.files).toEqual([
      { name: "affidavit.pdf", size: 400, content_type: "application/pdf", origin: "posted in this thread by Luca" },
      { name: "ein.pdf", size: undefined, content_type: undefined, origin: undefined },
    ])
  })

  it("keeps a NAMELESS attachment in position rather than dropping it — the card must never show fewer files than the email carries", () => {
    const card = teamChatCardForFrozenDraft({ ...emailDraft, attachments: [{ size: 10 }, { name: "ein.pdf" }] })
    expect(card?.files?.length).toBe(2)
    expect(card?.files?.[0].name).toBe("file")
  })

  it("carries NO url — this card is a permanent channel row, so it must not hold a standing link to a client document", () => {
    const card = teamChatCardForFrozenDraft({ ...emailDraft, attachments: [{ name: "affidavit.pdf" }] })
    expect(JSON.stringify(card)).not.toMatch(/https?:\/\//)
    // The renderer addresses the file by the frozen row's id + its position.
    expect(card?.entity_id).toBe("prep-1")
  })

  it("carries the exact body — Confirm approves a MESSAGE, not just an address", () => {
    // A card that showed only the recipient would let a staff member approve
    // wording they never read.
    expect(teamChatCardForFrozenDraft(emailDraft)?.body).toBe(emailDraft.body)
    // A non-string body must not leak "[object Object]" into the channel.
    expect(teamChatCardForFrozenDraft({ ...emailDraft, body: { oops: true } })?.body).toBe("")
  })
})
