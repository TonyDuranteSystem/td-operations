import { describe, it, expect } from "vitest"
import { survivingWizardRowId, dropSupersededDrafts } from "@/lib/portal/wizard-progress-write"

// Company Closure Part C (dev job a6bbea09): two saves racing created two drafts of one wizard, 0.34 s apart.
describe("survivingWizardRowId", () => {
  it("keeps the oldest draft, so both racing requests agree on the same survivor", () => {
    const rows = [
      { id: "b", created_at: "2026-11-06T23:07:05.811Z" },
      { id: "a", created_at: "2026-11-06T23:07:05.468Z" },
    ]
    expect(survivingWizardRowId(rows)).toBe("a")
    expect(survivingWizardRowId([...rows].reverse())).toBe("a")
  })

  it("breaks a tie on the id, so two rows with the same timestamp still have exactly one survivor", () => {
    const t = "2026-11-06T23:07:05.468Z"
    expect(survivingWizardRowId([{ id: "z", created_at: t }, { id: "m", created_at: t }])).toBe("m")
  })

  it("returns null when there is no draft, and tolerates a missing timestamp", () => {
    expect(survivingWizardRowId([])).toBeNull()
    expect(survivingWizardRowId([{ id: "x", created_at: null }, { id: "y", created_at: "2026-11-06T00:00:00Z" }])).toBe("x")
  })
})

describe("dropSupersededDrafts", () => {
  const e = (status: string, wizard_type: string, updated_at: string) => ({ status, wizard_type, updated_at })

  it("hides the leftover draft once a wizard of the same kind was sent after it", () => {
    const rows = [e("submitted", "closure", "2026-11-06T23:08:03Z"), e("in_progress", "closure", "2026-11-06T23:07:05Z")]
    expect(dropSupersededDrafts(rows)).toEqual([rows[0]])
  })

  it("keeps a draft that is newer than the sent wizard (the client opened it again)", () => {
    const rows = [e("submitted", "tax", "2026-01-01T00:00:00Z"), e("in_progress", "tax", "2026-06-01T00:00:00Z")]
    expect(dropSupersededDrafts(rows)).toEqual(rows)
  })

  it("never touches another kind of wizard", () => {
    const rows = [e("submitted", "closure", "2026-11-06T23:08:03Z"), e("in_progress", "onboarding", "2026-11-06T23:07:05Z")]
    expect(dropSupersededDrafts(rows)).toEqual(rows)
  })

  it("leaves a list with no sent wizard exactly as it is", () => {
    const rows = [e("in_progress", "closure", "2026-11-06T23:07:05Z"), e("in_progress", "closure", "2026-11-06T23:00:00Z")]
    expect(dropSupersededDrafts(rows)).toEqual(rows)
  })
})
