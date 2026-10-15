/**
 * Company Closure "Wrap-up" step — the follow-up to-dos left behind when a company is closed
 * (lib/services/closure-cascade.ts), and the pieces that must stay in step with it.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildClosureFollowUpCards,
  CLOSURE_CHORES,
  WRAP_UP_STAGE_NAME,
} from "@/lib/services/closure-cascade"
import { protectedStageReason } from "@/lib/services/protected-stage-names"

const ROOT = join(__dirname, "..", "..")
const titles = (cards: { task_title: string }[]) => cards.map(c => c.task_title)

describe("buildClosureFollowUpCards", () => {
  it("gives every chore its follow-up when the job has no to-dos (a job that skipped Wrap-up, or to-dos not readable)", () => {
    const t = titles(buildClosureFollowUpCards([]))
    expect(t).toEqual([
      "[CLOSURE] Remove RA on Harbor Compliance",
      "[CLOSURE] Cancel CMRA mailing address / lease if active",
      "[CLOSURE] Stop the yearly renewals (RA + annual report)",
      "[CLOSURE] Cancel QB recurring invoices",
      "[CLOSURE] Email client -- closure complete",
    ])
  })

  it("does not repeat a chore that is recorded Done (stored title carries the service-name prefix)", () => {
    const t = titles(
      buildClosureFollowUpCards([
        { task_title: "[Company Closure - Acme LLC] Cancel Registered Agent on Harbor Compliance", status: "Done" },
      ]),
    )
    expect(t).not.toContain("[CLOSURE] Remove RA on Harbor Compliance")
    expect(t).toContain("[CLOSURE] Cancel CMRA mailing address / lease if active")
    expect(t).toContain("[CLOSURE] Stop the yearly renewals (RA + annual report)")
  })

  it("a chore left open or in progress comes back — the sweep that marks every open to-do Done must not swallow it", () => {
    for (const status of ["To Do", "In Progress", "Waiting", "Cancelled", null]) {
      const t = titles(
        buildClosureFollowUpCards([{ task_title: "[Company Closure - Acme LLC] Cancel CMRA/lease if active", status }]),
      )
      expect(t, `status ${status}`).toContain("[CLOSURE] Cancel CMRA mailing address / lease if active")
    }
  })

  it("matches ignoring case and padding, and ignores unrelated to-dos", () => {
    const t = titles(
      buildClosureFollowUpCards([
        { task_title: "  [X] CANCEL REGISTERED AGENT ON HARBOR COMPLIANCE ", status: "Done" },
        { task_title: "[X] Fill out EIN closure form", status: "Done" },
        { task_title: null, status: "Done" },
      ]),
    )
    expect(t).not.toContain("[CLOSURE] Remove RA on Harbor Compliance")
    expect(t).toHaveLength(4)
  })

  it("all three chores done → only the two long-standing follow-ups remain", () => {
    const done = CLOSURE_CHORES.map(c => ({ task_title: `[Company Closure - Acme LLC] ${c.stepTitle}`, status: "Done" }))
    expect(titles(buildClosureFollowUpCards(done))).toEqual([
      "[CLOSURE] Cancel QB recurring invoices",
      "[CLOSURE] Email client -- closure complete",
    ])
  })

  it("every card is complete (title, description, priority, category)", () => {
    for (const c of buildClosureFollowUpCards([])) {
      expect(c.task_title.startsWith("[CLOSURE] ")).toBe(true)
      expect(c.description.length).toBeGreaterThan(10)
      expect(["High", "Normal"]).toContain(c.priority)
      expect(c.category.length).toBeGreaterThan(0)
    }
  })
})

describe("kept in step with the rest", () => {
  const migration = readFileSync(join(ROOT, "scripts/migrations/20261015-1200-closure-wrapup-step.sql"), "utf8")

  it("the chore titles in code are exactly the Wrap-up to-do titles the migration creates", () => {
    for (const c of CLOSURE_CHORES) {
      expect(migration, c.stepTitle).toContain(`"title": "${c.stepTitle}"`)
    }
  })

  it("the migration names the step the code names, and puts it before the finishing step", () => {
    expect(migration).toContain(`'${WRAP_UP_STAGE_NAME}'`)
    expect(migration).toContain("5:Wrap-up,6:Closing")
  })

  it("Wrap-up is a pinned step name (the workflow buttons match it by name)", () => {
    expect(protectedStageReason(WRAP_UP_STAGE_NAME)).toBeTruthy()
  })

  it("the closing clean-up reads the job's own to-dos BEFORE the sweep that marks them Done", () => {
    const src = readFileSync(join(ROOT, "lib/service-delivery.ts"), "utf8")
    const section = src.slice(src.indexOf("// 14. Company Closure"), src.indexOf("// 15. Action log"))
    const readAt = section.indexOf(`select("task_title, status")`)
    const sweepAt = section.indexOf("updateTasksBulk")
    const cardsAt = section.indexOf("buildClosureFollowUpCards(jobTasks)")
    expect(readAt).toBeGreaterThan(-1)
    expect(sweepAt).toBeGreaterThan(readAt)
    expect(cardsAt).toBeGreaterThan(sweepAt)
  })

  it("the migration only touches Company Closure (Company Formation has its own step called Closing)", () => {
    const statements = migration.match(/UPDATE public\.pipeline_stages[\s\S]*?;/g) ?? []
    expect(statements.length).toBeGreaterThan(0)
    for (const s of statements) expect(s).toContain("service_type = 'Company Closure'")
  })
})
