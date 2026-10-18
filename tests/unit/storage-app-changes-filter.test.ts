import { describe, it, expect } from "vitest"
import { filterChanges, parseCursor, formatCursor, type OwnerFacts, type Row } from "@/lib/storage-app/changes"

const row = (o: Partial<Row>): Row => ({ seq: 1, txid: "10", item_kind: "file", item_id: "f1", op: "upsert", owner_id: "o-co", parent_id: "p", old_owner_id: null, old_parent_id: null, name: "A.pdf", resync: false, ...o })
const owners = new Map<string, OwnerFacts>([
  ["o-co", { kind: "company", private_user_id: null, study_only: false }],
  ["o-study", { kind: "person", private_user_id: null, study_only: true }],
  ["o-mine", { kind: "private", private_user_id: "me", study_only: false }],
  ["o-theirs", { kind: "private", private_user_id: "someone-else", study_only: false }],
  ["o-owners", { kind: "private", private_user_id: "primary-owner", study_only: false }],
])
const team = { id: "me", ownerOnly: false }
const ownerLogin = { id: "second-owner", ownerOnly: true }

describe("which changes a login is told about", () => {
  it("a live company's change is delivered with its name", () => {
    expect(filterChanges([row({})], owners, team, null)).toMatchObject([{ id: "f1", op: "upsert", name: "A.pdf" }])
  })
  it("a hidden study copy gets no upsert, but a delete still goes out (no name) so Finder can drop it", () => {
    const rows = [row({ owner_id: "o-study", item_id: "a" }), row({ owner_id: "o-study", item_id: "b", op: "delete" })]
    expect(filterChanges(rows, owners, team, null)).toEqual([expect.objectContaining({ id: "b", op: "delete", name: null })])
  })
  it("another person's My files is never mentioned — not even a delete", () => {
    const rows = [row({ owner_id: "o-theirs", item_id: "a" }), row({ owner_id: "o-theirs", item_id: "b", op: "delete" })]
    expect(filterChanges(rows, owners, team, null)).toEqual([])
  })
  it("your own My files comes through; the owners' shared My files only to an owner login", () => {
    expect(filterChanges([row({ owner_id: "o-mine" })], owners, team, null)).toHaveLength(1)
    expect(filterChanges([row({ owner_id: "o-owners" })], owners, team, null)).toHaveLength(0)
    expect(filterChanges([row({ owner_id: "o-owners" })], owners, ownerLogin, "primary-owner")).toHaveLength(1)
  })
  it("an unknown storage gets no upsert (fails closed) but its delete is delivered", () => {
    expect(filterChanges([row({ owner_id: "gone", op: "upsert" })], owners, team, null)).toEqual([])
    expect(filterChanges([row({ owner_id: "gone", op: "delete" })], owners, team, null)).toHaveLength(1)
  })
  it("carries a move (old parent / old owner) through", () => {
    const c = filterChanges([row({ old_parent_id: "old-p", old_owner_id: "o-co" })], owners, team, null)
    expect(c[0]).toMatchObject({ oldParentId: "old-p", oldOwnerId: "o-co" })
  })
})

describe("moves between places a login can and cannot see", () => {
  it("a file moved from a visible company INTO someone else's My files disappears from the old place (no ghost), and the private ids are not mentioned", () => {
    const moved = row({ owner_id: "o-theirs", parent_id: "secret-folder", old_owner_id: "o-co", old_parent_id: "old-folder", name: "Secret.pdf" })
    const out = filterChanges([moved], owners, team, null)
    expect(out).toEqual([{ kind: "file", id: "f1", op: "delete", ownerId: "o-co", parentId: "old-folder", oldOwnerId: null, oldParentId: null, name: null }])
    expect(JSON.stringify(out)).not.toContain("secret-folder")
    expect(JSON.stringify(out)).not.toContain("Secret.pdf")
  })
  it("a file moved from a visible company into a hidden study copy also disappears from the old place", () => {
    const out = filterChanges([row({ owner_id: "o-study", old_owner_id: "o-co", old_parent_id: "old-folder" })], owners, team, null)
    expect(out).toEqual([expect.objectContaining({ op: "delete", ownerId: "o-co", parentId: "old-folder", name: null })])
  })
  it("a file moved OUT of someone else's My files into a visible company arrives as an upsert WITHOUT the private ids", () => {
    const out = filterChanges([row({ owner_id: "o-co", old_owner_id: "o-theirs", old_parent_id: "their-folder" })], owners, team, null)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ op: "upsert", oldOwnerId: null, oldParentId: null, name: "A.pdf" })
  })
  it("a move between two visible places keeps the old place (Finder treats it as a move)", () => {
    const m = new Map(owners); m.set("o-co2", { kind: "company", private_user_id: null, study_only: false })
    const out = filterChanges([row({ owner_id: "o-co2", old_owner_id: "o-co", old_parent_id: "old" })], m, team, null)
    expect(out[0]).toMatchObject({ op: "upsert", oldOwnerId: "o-co", oldParentId: "old" })
  })
  it("a move into a hidden place from somewhere this login could not see says nothing at all", () => {
    expect(filterChanges([row({ owner_id: "o-study", old_owner_id: "o-theirs", old_parent_id: "x" })], owners, team, null)).toEqual([])
  })
})

describe("cursor", () => {
  it("round-trips and rejects anything that is not txid.seq", () => {
    expect(parseCursor("123.45")).toEqual({ txid: "123", seq: 45 })
    expect(formatCursor({ txid: "123", seq: 45 })).toBe("123.45")
    for (const bad of ["", "abc", "12", "12.", ".5", "1.2.3", "1;drop", null, undefined, 5]) expect(parseCursor(bad as unknown)).toBeNull()
  })
})
