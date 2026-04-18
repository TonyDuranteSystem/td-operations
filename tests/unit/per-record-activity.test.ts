/**
 * P3.8 — lib/per-record-activity/queries.ts unit tests
 *
 * Covers the pure summarizeActivity helper. The actual DB-hitting queries
 * are exercised through browser QA on the Backend tab against real Supabase
 * data (per R079).
 */

import { describe, expect, it } from "vitest"
import { summarizeActivity, type BackendActivity } from "@/lib/per-record-activity/queries"

const empty: BackendActivity = { actions: [], jobs: [], webhooks: [], checkpoints: [] }

describe("summarizeActivity", () => {
  it("returns zeros for an empty activity", () => {
    expect(summarizeActivity(empty)).toEqual({
      actions: 0, jobs: 0, webhooks: 0, checkpoints: 0, total: 0,
    })
  })

  it("sums counts across sources", () => {
    const a: BackendActivity = {
      actions: [
        { id: "a1", actor: "dashboard:antonio", action_type: "update", table_name: "accounts", summary: "x", details: null, created_at: "2026-04-18T12:00:00Z" },
        { id: "a2", actor: null, action_type: "delete", table_name: "documents", summary: "y", details: null, created_at: "2026-04-18T11:00:00Z" },
      ],
      jobs: [
        { id: "j1", job_type: "activate-service", status: "completed", priority: 1, attempts: 1, error: null, created_at: "2026-04-18T10:00:00Z", started_at: null, completed_at: null },
      ],
      webhooks: [
        { id: "w1", source: "stripe", event_type: "checkout.session.completed", external_id: "cs_123", review_status: null, created_at: "2026-04-18T09:00:00Z" },
        { id: "w2", source: "whop", event_type: "payment.succeeded", external_id: null, review_status: "reviewed", created_at: "2026-04-18T08:00:00Z" },
        { id: "w3", source: "calendly", event_type: "invitee.created", external_id: null, review_status: null, created_at: "2026-04-18T07:00:00Z" },
      ],
      checkpoints: [
        { id: "c1", summary: "test", next_steps: null, session_type: "ops", created_at: "2026-04-18T06:00:00Z" },
      ],
    }
    const counts = summarizeActivity(a)
    expect(counts).toEqual({ actions: 2, jobs: 1, webhooks: 3, checkpoints: 1, total: 7 })
  })
})
