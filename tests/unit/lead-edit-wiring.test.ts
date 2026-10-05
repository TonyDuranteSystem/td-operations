/**
 * Wiring guard for the guarded Leads edits (dev job f3f3e237 step 2 / d26b8a7e remainder).
 *
 * The routes and the five screens that call them must stay in step: if a screen stops sending
 * what it edited from, the server falls back to "no expected value" and the silent overwrite
 * quietly comes back. These checks pin that, and the one trap that would cause false refusals:
 * the value a person edits FROM must be captured when editing STARTS (not read live from props
 * that refresh while they type) and moved forward after their own successful save.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const root = join(__dirname, "..", "..")
const read = (p: string) => readFileSync(join(root, p), "utf8")

const routes = {
  field: read("app/api/crm/admin-actions/update-lead-field/route.ts"),
  notes: read("app/api/crm/admin-actions/update-lead-notes/route.ts"),
  status: read("app/api/crm/admin-actions/update-lead-status/route.ts"),
}

describe("lead edit routes", () => {
  it("all three write through the guarded helper, never a bare update", () => {
    for (const [name, src] of Object.entries(routes)) {
      expect(src, `${name} route`).toContain("updateLeadColumnGuarded(")
      expect(src, `${name} route`).not.toMatch(/\.from\("leads"\)\s*\.update\(/)
    }
  })

  it("each narrows the result with the explicit guard (the project's TypeScript is not strict)", () => {
    for (const [name, src] of Object.entries(routes)) {
      expect(src, `${name} route`).toContain("if (isGuardedFailure(guarded)) {")
    }
  })

  it("each reads its own expected-value key from the request body", () => {
    expect(routes.field).toContain('hasExpectedValue(body, "expected_value")')
    expect(routes.notes).toContain('hasExpectedValue(body, "expected_notes")')
    expect(routes.status).toContain('hasExpectedValue(body, "expected_status")')
  })

  it("a conflict answers 409 with the server's own message, a missing lead 404", () => {
    for (const [name, src] of Object.entries(routes)) {
      expect(src, `${name} route`).toMatch(/guarded\.reason === "conflict"[\s\S]*status: 409/)
      expect(src, `${name} route`).toMatch(/guarded\.reason === "not_found"[\s\S]*status: 404/)
    }
  })
})

describe("screens that edit a lead", () => {
  const editable = read("app/(dashboard)/leads/[id]/components/editable-field.tsx")
  const notes = read("app/(dashboard)/leads/[id]/components/lead-notes-editor.tsx")
  const callNotes = read("app/(dashboard)/leads/[id]/components/call-notes-editor.tsx")
  const kanban = read("app/(dashboard)/leads/components/leads-kanban.tsx")
  const rowActions = read("components/leads/lead-row-actions.tsx")

  it("every save sends what the person was editing from", () => {
    expect(editable).toContain("expected_value: editBase.current")
    expect(editable).toContain("expected_value: value ?? ''") // the clear (remove) action
    expect(notes).toContain("expected_notes: editBase.current")
    expect(callNotes).toContain("expected_value: editBase.current")
    expect(kanban).toContain("expected_status: source.droppableId")
    expect(rowActions).toContain("expected_status: lead.status")
  })

  it("captures the starting value when editing STARTS, not while typing", () => {
    expect(editable).toMatch(/editBase\.current = value \?\? ''; setEditing\(true\)/)
    expect(notes).toMatch(/editBase\.current = notes; setEditing\(true\)/)
    expect(callNotes).toMatch(/editBase\.current = callNotes \?\? ''; setEditing\(true\)/)
  })

  it("moves the starting value forward after the person's own successful save", () => {
    expect(editable).toContain("editBase.current = editValue.trim()")
    expect(notes).toContain("editBase.current = value")
    expect(callNotes).toContain("editBase.current = value.trim()")
  })

  it("on a refusal, keeps what was typed and refreshes to show the latest", () => {
    for (const [name, src] of Object.entries({ editable, notes, callNotes, kanban, rowActions })) {
      expect(src, name).toMatch(/res\.status === 409\) router\.refresh\(\)/)
    }
  })
})
