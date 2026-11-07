import { describe, it, expect } from "vitest"
import { pickChatContact } from "@/lib/flows/chat-contact"

// Company Closure Part C (dev job a6bbea09): a staff message in a job's chat on a company with several members goes to the buyer.
describe("pickChatContact", () => {
  const A = "contact-a" // the buyer
  const B = "contact-b"
  const C = "contact-c"

  it("addresses the job's own contact (the buyer) on a multi-member company, whatever order the links come in", () => {
    const links = [{ contact_id: B, is_primary: true }, { contact_id: A, is_primary: false }, { contact_id: C }]
    expect(pickChatContact({ jobContactId: A, links })).toBe(A)
    expect(pickChatContact({ jobContactId: A, links: [...links].reverse() })).toBe(A)
  })

  it("falls back to the primary member when the job's contact is not linked to the company", () => {
    const links = [{ contact_id: B, is_primary: false }, { contact_id: C, is_primary: true }]
    expect(pickChatContact({ jobContactId: A, links })).toBe(C)
  })

  it("falls back to the first linked member when nobody is primary", () => {
    expect(pickChatContact({ jobContactId: null, links: [{ contact_id: B }, { contact_id: C }] })).toBe(B)
  })

  it("never addresses a member who left while another is still linked", () => {
    const links = [{ contact_id: A, ended_at: "2026-10-01T00:00:00Z" }, { contact_id: B }]
    expect(pickChatContact({ jobContactId: A, links })).toBe(B)
  })

  it("uses the job's own contact when every member has left or none is linked (contact-scoped job)", () => {
    expect(pickChatContact({ jobContactId: A, links: [] })).toBe(A)
    expect(pickChatContact({ jobContactId: A, links: [{ contact_id: B, ended_at: "2026-10-01T00:00:00Z" }] })).toBe(A)
  })

  it("returns nobody when there is no job contact and no link, and ignores empty contact ids", () => {
    expect(pickChatContact({ jobContactId: undefined, links: [] })).toBeNull()
    expect(pickChatContact({ jobContactId: null, links: [{ contact_id: null }] })).toBeNull()
  })

  it("last resort: a link whose person left is still better than nobody", () => {
    expect(pickChatContact({ jobContactId: null, links: [{ contact_id: B, ended_at: "2026-10-01T00:00:00Z" }] })).toBe(B)
  })
})
