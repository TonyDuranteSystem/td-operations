/**
 * Slice 10 — sla-eligibility unit tests
 *
 * Pure-logic helper for the /api/cron/workflow-sla-check cron. Time-travel
 * via explicit `now` argument — no Date mocking needed.
 *
 * Cases cover:
 *   - no SLA configured (snapshot missing sla field)
 *   - within warn → ok
 *   - past warn, not warned → warn (first detection)
 *   - past warn, already warned → warn_no_op (idempotency)
 *   - past escalate, not escalated → escalate (first detection)
 *   - past escalate, already escalated → escalate_no_op (idempotency)
 *   - past escalate, only warned (skipping warn write) → escalate (single click)
 *   - invalid date in created_at → ok with reason=invalid_dates (defensive)
 *   - sla with warn_hours only (no escalate)
 *   - sla with escalate_hours only (no warn)
 *   - auto_reassign and notify_email_to fields don't affect tier decision
 */

import { describe, it, expect } from "vitest"
import { decideSlaTier, type SlaConfig, type SlaCheckTask } from "@/lib/tasks/sla-eligibility"

function task(over: Partial<SlaCheckTask> = {}): SlaCheckTask {
  return {
    id: over.id ?? "task-1",
    created_at: over.created_at ?? "2026-05-17T00:00:00.000Z",
    task_meta: over.task_meta ?? null,
  }
}

const SLA_24_72: SlaConfig = { warn_hours: 24, escalate_hours: 72, escalate_to: "Antonio" }

// Helper to build a Date N hours after the task's created_at.
function hoursAfter(t: SlaCheckTask, hours: number): Date {
  const created = Date.parse(t.created_at)
  return new Date(created + hours * 60 * 60 * 1000)
}

describe("decideSlaTier — no SLA configured", () => {
  it("returns ok/no_sla when sla is null", () => {
    const t = task()
    const d = decideSlaTier(t, null, hoursAfter(t, 100))
    expect(d).toEqual({ tier: "ok", reason: "no_sla" })
  })

  it("returns ok/no_sla when sla is undefined", () => {
    const t = task()
    const d = decideSlaTier(t, undefined, hoursAfter(t, 100))
    expect(d).toEqual({ tier: "ok", reason: "no_sla" })
  })

  it("returns ok/no_sla when both warn_hours and escalate_hours are missing", () => {
    const t = task()
    const d = decideSlaTier(t, { escalate_to: "Antonio" }, hoursAfter(t, 100))
    expect(d).toEqual({ tier: "ok", reason: "no_sla" })
  })
})

describe("decideSlaTier — within warn", () => {
  it("returns ok/within_warn before warn_hours", () => {
    const t = task()
    const d = decideSlaTier(t, SLA_24_72, hoursAfter(t, 12))
    expect(d.tier).toBe("ok")
    if (d.tier === "ok") expect(d.reason).toBe("within_warn")
  })

  it("returns ok/within_warn at exactly warn_hours - epsilon", () => {
    const t = task()
    const d = decideSlaTier(t, SLA_24_72, hoursAfter(t, 23.9))
    expect(d.tier).toBe("ok")
  })
})

describe("decideSlaTier — warn tier (first detection)", () => {
  it("returns warn when just past warn_hours, no prior state", () => {
    const t = task()
    const d = decideSlaTier(t, SLA_24_72, hoursAfter(t, 25))
    expect(d.tier).toBe("warn")
    if (d.tier === "warn") {
      expect(d.warn_threshold).toBe(24)
      expect(d.hours_waiting).toBeCloseTo(25, 1)
    }
  })

  it("returns warn at exactly warn_hours boundary", () => {
    const t = task()
    const d = decideSlaTier(t, SLA_24_72, hoursAfter(t, 24))
    expect(d.tier).toBe("warn")
  })

  it("returns warn_no_op when task_meta.sla_state is already 'warn'", () => {
    const t = task({ task_meta: { sla_state: "warn" } })
    const d = decideSlaTier(t, SLA_24_72, hoursAfter(t, 48))
    expect(d.tier).toBe("warn_no_op")
  })

  it("returns warn_no_op when task_meta.sla_state is 'escalated' (escalate beats warn)", () => {
    // If somehow we're at warn-tier hours but state says escalated, treat as
    // no-op — don't downgrade. (Edge case: catalog SLA was tightened after
    // escalation; cron should leave the escalated state alone.)
    const t = task({ task_meta: { sla_state: "escalated" } })
    const d = decideSlaTier(t, SLA_24_72, hoursAfter(t, 36))
    expect(d.tier).toBe("warn_no_op")
  })
})

describe("decideSlaTier — escalate tier", () => {
  it("returns escalate when past escalate_hours, no prior state", () => {
    const t = task()
    const d = decideSlaTier(t, SLA_24_72, hoursAfter(t, 80))
    expect(d.tier).toBe("escalate")
    if (d.tier === "escalate") {
      expect(d.escalate_threshold).toBe(72)
      expect(d.escalate_to).toBe("Antonio")
      expect(d.hours_waiting).toBeCloseTo(80, 1)
    }
  })

  it("returns escalate when past escalate_hours even if previously warned (single jump)", () => {
    // Task was 'warn' a few hours ago; now past escalate. Cron should escalate
    // it (not return no_op) — the state needs to advance warn → escalated.
    const t = task({ task_meta: { sla_state: "warn", sla_warned_at: "2026-05-18T00:00:00Z" } })
    const d = decideSlaTier(t, SLA_24_72, hoursAfter(t, 100))
    expect(d.tier).toBe("escalate")
  })

  it("returns escalate_no_op when task_meta.sla_state is already 'escalated'", () => {
    const t = task({ task_meta: { sla_state: "escalated" } })
    const d = decideSlaTier(t, SLA_24_72, hoursAfter(t, 200))
    expect(d.tier).toBe("escalate_no_op")
  })

  it("returns escalate at exactly escalate_hours boundary", () => {
    const t = task()
    const d = decideSlaTier(t, SLA_24_72, hoursAfter(t, 72))
    expect(d.tier).toBe("escalate")
  })

  it("passes escalate_to from sla config", () => {
    const t = task()
    const d = decideSlaTier(t, { ...SLA_24_72, escalate_to: "Luca" }, hoursAfter(t, 100))
    if (d.tier === "escalate") expect(d.escalate_to).toBe("Luca")
  })
})

describe("decideSlaTier — partial SLA configs", () => {
  it("warn-only sla: returns warn past warn_hours, never escalates", () => {
    const t = task()
    const sla: SlaConfig = { warn_hours: 24, escalate_to: "Antonio" }
    const d1 = decideSlaTier(t, sla, hoursAfter(t, 50))
    expect(d1.tier).toBe("warn")
    const d2 = decideSlaTier(t, sla, hoursAfter(t, 5000))
    expect(d2.tier).toBe("warn") // would be warn_no_op after first write; helper returns warn
  })

  it("escalate-only sla: returns escalate past escalate_hours, never warns", () => {
    const t = task()
    const sla: SlaConfig = { escalate_hours: 72, escalate_to: "Antonio" }
    const d1 = decideSlaTier(t, sla, hoursAfter(t, 50))
    expect(d1.tier).toBe("ok")
    if (d1.tier === "ok") expect(d1.reason).toBe("within_warn")
    const d2 = decideSlaTier(t, sla, hoursAfter(t, 100))
    expect(d2.tier).toBe("escalate")
  })
})

describe("decideSlaTier — defensive", () => {
  it("returns ok/invalid_dates when created_at is unparseable", () => {
    const t = task({ created_at: "not-a-date" })
    const d = decideSlaTier(t, SLA_24_72, new Date())
    expect(d.tier).toBe("ok")
    if (d.tier === "ok") expect(d.reason).toBe("invalid_dates")
  })

  it("ignores non-string sla_state in task_meta", () => {
    const t = task({ task_meta: { sla_state: 123 } as unknown as Record<string, unknown> })
    const d = decideSlaTier(t, SLA_24_72, hoursAfter(t, 30))
    expect(d.tier).toBe("warn") // treated as no prior state
  })
})

describe("decideSlaTier — auto_reassign + notify_email_to fields", () => {
  it("auto_reassign=false does NOT affect tier decision (behavior is for the cron)", () => {
    const t = task()
    const d = decideSlaTier(t, { ...SLA_24_72, auto_reassign: false }, hoursAfter(t, 100))
    expect(d.tier).toBe("escalate")
  })

  it("notify_email_to='' does NOT affect tier decision (behavior is for the cron)", () => {
    const t = task()
    const d = decideSlaTier(
      t,
      { ...SLA_24_72, notify_email_to: "" },
      hoursAfter(t, 100),
    )
    expect(d.tier).toBe("escalate")
  })
})
