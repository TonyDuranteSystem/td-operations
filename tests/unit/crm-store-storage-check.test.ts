import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import { evaluateStorageCheck, guessFileOwner, nameTokens, normalizeForMatch, findingKey, type CheckSnapshot } from "@/lib/crm-store/storage-check"

const base = (o: Partial<CheckSnapshot> = {}): CheckSnapshot => ({
  accountId: "a1", companyName: "Reset Formula LLC", ownerId: "own1", rootName: "Reset Formula LLC", rootCollision: false,
  people: [
    { contactId: "stella", name: "Stefano Stella", hasStorage: true, ownerId: "o-stella", roles: ["authorized_representative"] },
    { contactId: "magg", name: "Francesco Maggiorino-Ortuso", hasStorage: true, ownerId: "o-magg", roles: ["owner"] },
  ],
  members: [], files: [], leftNotes: [], dismissed: new Set(), ...o,
})

describe("normalizeForMatch / nameTokens", () => {
  it("removes accents and punctuation", () => {
    expect(normalizeForMatch("Pèrez_Núñez-Ortuso.pdf")).toBe("perez nunez ortuso pdf")
  })
  it("keeps only words of 4+ letters", () => {
    expect(nameTokens("Jo Li Maggiorino-Ortuso")).toEqual(["maggiorino", "ortuso"])
  })
})

describe("guessFileOwner", () => {
  const others = [{ contactId: "magg", name: "Francesco Maggiorino-Ortuso" }]
  it("finds the other person when the file names only them (the Reset Formula passport)", () => {
    expect(guessFileOwner("passport_owner_a9d1e51e_Maggiorino_Passport.pdf", "Stefano Stella", others)).toBe("magg")
  })
  it("says nothing when the file also names the owner", () => {
    expect(guessFileOwner("Stella_and_Maggiorino_OA.pdf", "Stefano Stella", others)).toBeNull()
  })
  it("says nothing when the file names nobody", () => {
    expect(guessFileOwner("bank_statement.pdf", "Stefano Stella", others)).toBeNull()
  })
  it("says nothing when two people match", () => {
    expect(guessFileOwner("Maggiorino Rossi passport.pdf", "Stefano Stella", [...others, { contactId: "r", name: "Maria Rossi" }])).toBeNull()
  })
})

describe("evaluateStorageCheck", () => {
  it("nothing to show when the company is not in the new storage", () => {
    expect(evaluateStorageCheck(base({ ownerId: null, people: [{ contactId: "x", name: "X Person", hasStorage: false, ownerId: null, roles: [] }] }))).toEqual([])
  })
  it("a person without a storage gets the create option, pre-ticked", () => {
    const f = evaluateStorageCheck(base({ people: [{ contactId: "magg", name: "Francesco Maggiorino-Ortuso", hasStorage: false, ownerId: null, roles: ["owner"] }] }))
    expect(f).toHaveLength(1)
    expect(f[0].kind).toBe("person_without_storage")
    expect(f[0].actions[0]).toMatchObject({ id: "create_person_storage", defaultOn: true })
  })
  it("a representative who is not listed gets no 'create storage' nag, but their files are still compared (the Reset Formula passport)", () => {
    const snap = base({
      people: [
        { contactId: "stella", name: "Stefano Stella", hasStorage: true, ownerId: "o-stella", roles: ["authorized_representative"], listed: false },
        { contactId: "magg", name: "Francesco Maggiorino-Ortuso", hasStorage: true, ownerId: "o-magg", roles: ["owner"], listed: true },
      ],
      files: [{ fileId: "f1", name: "passport_owner_x_Maggiorino_Passport.pdf", ownerContactId: "stella" }],
    })
    const f = evaluateStorageCheck(snap)
    expect(f.map((x) => x.kind)).toEqual(["misfiled_document"])
    expect(f[0].data.toContactId).toBe("magg")
    expect(f[0].openFileId).toBe("f1")
    const noStore = evaluateStorageCheck(base({ people: [{ contactId: "rep", name: "Rita Rep", hasStorage: false, ownerId: null, roles: ["authorized_representative"], listed: false }] }))
    expect(noStore).toEqual([])
  })
  it("a folder with an old company name offers the rename", () => {
    const f = evaluateStorageCheck(base({ rootName: "Old Name LLC" }))
    expect(f.map((x) => x.kind)).toEqual(["folder_name_differs"])
    expect(f[0].actions[0].defaultOn).toBe(true)
    expect(f[0].blocked).toBeNull()
  })
  it("a rename that would clash with another folder is blocked and not pre-ticked", () => {
    const f = evaluateStorageCheck(base({ rootName: "Old Name LLC", rootCollision: true }))
    expect(f[0].blocked).toMatch(/already has that name/)
    expect(f[0].actions[0].defaultOn).toBe(false)
  })
  it("a person member without a person record is reported; a company member is not", () => {
    const f = evaluateStorageCheck(base({ members: [
      { memberId: "m1", name: "Jane Roe", type: "individual", contactId: null, linked: false },
      { memberId: "m2", name: "Kira Strategy LLC", type: "company", contactId: null, linked: false },
    ] }))
    expect(f.map((x) => x.key)).toEqual([findingKey("member_without_link", "m1")])
    expect(f[0].actions).toEqual([])
  })
  it("a member that has a person but no company link is reported", () => {
    const f = evaluateStorageCheck(base({ members: [{ memberId: "m1", name: "Jane Roe", type: "individual", contactId: "c1", linked: false }] }))
    expect(f[0].kind).toBe("member_without_link")
  })
  it("a misfiled document is suggested but never pre-ticked", () => {
    const f = evaluateStorageCheck(base({ files: [{ fileId: "f1", name: "passport_owner_x_Maggiorino_Passport.pdf", ownerContactId: "stella" }] }))
    expect(f).toHaveLength(1)
    expect(f[0].kind).toBe("misfiled_document")
    expect(f[0].actions[0].defaultOn).toBe(false)
    expect(f[0].data.toContactId).toBe("magg")
    expect(f[0].openFileId).toBe("f1")
  })
  it("a person who was removed shows once, with 'mark as seen'", () => {
    const f = evaluateStorageCheck(base({ leftNotes: [{ id: "n1", contactId: "stella", name: "Stefano Stella", createdAt: "2026-10-15" }] }))
    expect(f[0].kind).toBe("person_left")
    expect(f[0].detail).toMatch(/nothing was moved/i)
  })
  it("a finding staff called 'not an issue' stays away", () => {
    const k = findingKey("folder_name_differs", "own1")
    expect(evaluateStorageCheck(base({ rootName: "Old Name LLC", dismissed: new Set([k]) }))).toEqual([])
  })
  it("a clean company has no findings", () => {
    expect(evaluateStorageCheck(base())).toEqual([])
  })
})
