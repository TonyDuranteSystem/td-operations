/**
 * chain-transitions resolver — Slice 5.
 *
 * After every successful workflow action, the dispatcher consults this
 * resolver to figure out what the catalog says about what happens next.
 * The resolver returns either:
 *   - { spawn_workflow: '<slug>', advance_sd_stage: null } — spawn-only
 *   - { spawn_workflow: null, advance_sd_stage: '<stage>' } — advance-only
 *   - { spawn_workflow: '<slug>', advance_sd_stage: '<stage>' } — both
 *   - null — nothing to do (fail-quiet — the dispatcher treats null as "no
 *           catalog wiring for this transition, leave it to the handler's
 *           explicit spawn_task / side_effects")
 *
 * Tests mock supabaseAdmin + getEntryByServiceType so we don't hit the DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const maybeSingleMock = vi.fn()
  const eqMock: ReturnType<typeof vi.fn> = vi.fn(() => ({
    eq: eqMock,
    maybeSingle: maybeSingleMock,
  }))
  const selectMock = vi.fn(() => ({ eq: eqMock }))
  const fromMock = vi.fn(() => ({ select: selectMock }))
  const getEntryByServiceTypeMock = vi.fn()
  return { maybeSingleMock, eqMock, selectMock, fromMock, getEntryByServiceTypeMock }
})

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: mocks.fromMock },
}))
vi.mock("@/lib/services", () => ({
  getEntryByServiceType: mocks.getEntryByServiceTypeMock,
}))

import { resolveCatalogTransition, getWorkflowCatalogRow } from "@/lib/tasks/chain-transitions"
import type { TaskRow } from "@/lib/tasks/types"

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-1",
    task_title: "t",
    assigned_to: "Luca",
    status: "To Do",
    priority: "Normal",
    due_date: null,
    category: null,
    description: null,
    created_by: null,
    completed_date: null,
    notified: false,
    account_id: null,
    deal_id: null,
    service_id: null,
    notes: null,
    airtable_id: null,
    zoho_task_id: null,
    hubspot_id: null,
    created_at: "2026-05-16T00:00:00Z",
    updated_at: "2026-05-16T00:00:00Z",
    stage_order: null,
    delivery_id: "delivery-1",
    contact_id: "contact-1",
    attachments: [],
    workflow_slug: "itin_review",
    workflow_snapshot: {},
    task_meta: {},
    ...overrides,
  } as TaskRow
}

function makeServiceRow(transitions: Record<string, unknown>) {
  return {
    id: "service-row-id",
    catalog_id: "services",
    slug: "itin",
    display_name: "ITIN Application",
    status: "active",
    tags: [],
    metadata: {
      workflow_chain: { transitions },
    },
  }
}

beforeEach(() => {
  mocks.maybeSingleMock.mockReset()
  mocks.fromMock.mockClear()
  mocks.selectMock.mockClear()
  mocks.eqMock.mockClear()
  mocks.getEntryByServiceTypeMock.mockReset()
})

describe("resolveCatalogTransition — null cases", () => {
  it("returns null when task has no delivery_id", async () => {
    const result = await resolveCatalogTransition({
      task: makeTask({ delivery_id: null }),
      workflowSlug: "itin_review",
      transitionKey: "approve_send",
    })
    expect(result).toBeNull()
  })

  it("returns null when SD lookup returns nothing", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: null, error: null })
    const result = await resolveCatalogTransition({
      task: makeTask(),
      workflowSlug: "itin_review",
      transitionKey: "approve_send",
    })
    expect(result).toBeNull()
  })

  it("returns null when service_type maps to no catalog row", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: { service_type: "ITIN" }, error: null })
    mocks.getEntryByServiceTypeMock.mockResolvedValueOnce(null)
    const result = await resolveCatalogTransition({
      task: makeTask(),
      workflowSlug: "itin_review",
      transitionKey: "approve_send",
    })
    expect(result).toBeNull()
  })

  it("returns null when catalog row has no workflow_chain", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: { service_type: "ITIN" }, error: null })
    mocks.getEntryByServiceTypeMock.mockResolvedValueOnce({
      id: "x",
      catalog_id: "services",
      slug: "itin",
      display_name: "x",
      status: "active",
      tags: [],
      metadata: {},
    })
    const result = await resolveCatalogTransition({
      task: makeTask(),
      workflowSlug: "itin_review",
      transitionKey: "approve_send",
    })
    expect(result).toBeNull()
  })

  it("returns null when transition key has no entry in transitions[workflowSlug]", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: { service_type: "ITIN" }, error: null })
    mocks.getEntryByServiceTypeMock.mockResolvedValueOnce(
      makeServiceRow({
        itin_review: { approve_send: { spawn_workflow: "itin_await_client_mailing" } },
      }),
    )
    const result = await resolveCatalogTransition({
      task: makeTask(),
      workflowSlug: "itin_review",
      transitionKey: "never_defined",
    })
    expect(result).toBeNull()
  })

  it("returns null when neither spawn_workflow nor advance_sd_stage is set on the matched transition", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: { service_type: "ITIN" }, error: null })
    mocks.getEntryByServiceTypeMock.mockResolvedValueOnce(
      makeServiceRow({
        itin_review: { approve_send: { notes: "empty" } },
      }),
    )
    const result = await resolveCatalogTransition({
      task: makeTask(),
      workflowSlug: "itin_review",
      transitionKey: "approve_send",
    })
    expect(result).toBeNull()
  })
})

describe("resolveCatalogTransition — match cases", () => {
  it("returns spawn_workflow only when only spawn is configured", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: { service_type: "ITIN" }, error: null })
    mocks.getEntryByServiceTypeMock.mockResolvedValueOnce(
      makeServiceRow({
        itin_review: { approve_send: { spawn_workflow: "itin_await_client_mailing" } },
      }),
    )
    const result = await resolveCatalogTransition({
      task: makeTask(),
      workflowSlug: "itin_review",
      transitionKey: "approve_send",
    })
    expect(result).toEqual({ spawn_workflow: "itin_await_client_mailing", advance_sd_stage: null })
  })

  it("returns advance_sd_stage only when only stage is configured", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: { service_type: "ITIN" }, error: null })
    mocks.getEntryByServiceTypeMock.mockResolvedValueOnce(
      makeServiceRow({
        itin_number_received: { send_to_client: { advance_sd_stage: "ITIN Approved" } },
      }),
    )
    const result = await resolveCatalogTransition({
      task: makeTask(),
      workflowSlug: "itin_number_received",
      transitionKey: "send_to_client",
    })
    expect(result).toEqual({ spawn_workflow: null, advance_sd_stage: "ITIN Approved" })
  })

  it("returns both when transition configures both (Slice 5 itin_caa_certify_and_mail.mailed_to_irs)", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: { service_type: "ITIN" }, error: null })
    mocks.getEntryByServiceTypeMock.mockResolvedValueOnce(
      makeServiceRow({
        itin_caa_certify_and_mail: {
          mailed_to_irs: {
            spawn_workflow: "itin_irs_processing",
            advance_sd_stage: "Submitted to IRS",
          },
        },
      }),
    )
    const result = await resolveCatalogTransition({
      task: makeTask(),
      workflowSlug: "itin_caa_certify_and_mail",
      transitionKey: "mailed_to_irs",
    })
    expect(result).toEqual({
      spawn_workflow: "itin_irs_processing",
      advance_sd_stage: "Submitted to IRS",
    })
  })
})

describe("getWorkflowCatalogRow", () => {
  it("returns null when slug isn't in the catalog", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: null, error: null })
    const result = await getWorkflowCatalogRow("missing")
    expect(result).toBeNull()
  })

  it("returns metadata + injected slug when present", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({
      data: { metadata: { version: 1, label_admin: "Test Workflow" } },
      error: null,
    })
    const result = await getWorkflowCatalogRow("itin_review")
    expect(result).toEqual({ version: 1, label_admin: "Test Workflow", slug: "itin_review" })
  })

  it("returns null when metadata is null", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: { metadata: null }, error: null })
    const result = await getWorkflowCatalogRow("itin_review")
    expect(result).toBeNull()
  })
})
