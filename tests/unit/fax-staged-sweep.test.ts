import { describe, it, expect } from "vitest"
import { staleStagedPaths } from "@/lib/fax/staged-sweep"

const U1 = "123e4567-e89b-12d3-a456-426614174000", U2 = "223e4567-e89b-12d3-a456-426614174000"
const now = new Date("2026-10-20T12:00:00Z")

describe("staleStagedPaths — expiry of staged fax uploads", () => {
  it("deletes what is older than 24 hours, keeps what is newer", () => {
    const out = staleStagedPaths([
      { name: `${U1}.pdf`, created_at: "2026-10-19T11:00:00Z" },
      { name: `${U2}.pdf`, created_at: "2026-10-20T11:00:00Z" },
    ], now)
    expect(out).toEqual([`fax-upload/${U1}.pdf`])
  })
  it("an object with no readable time counts as an orphan; one of another shape is never touched", () => {
    expect(staleStagedPaths([{ name: `${U1}.pdf` }], now)).toEqual([`fax-upload/${U1}.pdf`])
    expect(staleStagedPaths([{ name: "notes.txt", created_at: "2020-01-01T00:00:00Z" }, { name: "../x.pdf", created_at: "2020-01-01T00:00:00Z" }], now)).toEqual([])
  })
})
