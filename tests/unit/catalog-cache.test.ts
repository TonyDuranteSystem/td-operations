/**
 * Catalog cache — Slice 1.
 *
 * The cache is an in-memory Map keyed by (catalog_id, slug). Realtime
 * invalidation is opt-in via env (TD_DISABLE_CATALOG_REALTIME=1 in tests).
 *
 * These tests cover the helpers and the cache-hit path. Network/realtime
 * paths are out of scope — the realtime subscription is intentionally
 * disabled by the env var in test runs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

// Disable the realtime subscription before importing the module.
process.env.TD_DISABLE_CATALOG_REALTIME = "1"

// vi.mock() is hoisted — use vi.hoisted to define mock refs that the factory closure can use.
const mocks = vi.hoisted(() => {
  const maybeSingleMock = vi.fn()
  const orderMock = vi.fn()
  const eqMock: ReturnType<typeof vi.fn> = vi.fn(() => ({
    eq: eqMock,
    maybeSingle: maybeSingleMock,
    order: orderMock,
  }))
  const selectMock = vi.fn(() => ({ eq: eqMock }))
  const fromMock = vi.fn(() => ({ select: selectMock }))
  return { maybeSingleMock, orderMock, eqMock, selectMock, fromMock }
})

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: mocks.fromMock },
}))

import {
  _catalogCacheSize,
  _clearCatalogCache,
  _invalidateCatalogEntry,
  getCatalogEntry,
  listCatalogEntries,
} from "@/lib/tasks/catalog-cache"

const sampleRow = {
  id: "11111111-1111-1111-1111-111111111111",
  catalog_id: "task_workflows",
  slug: "itin_review",
  display_name: "Review ITIN forms",
  status: "active",
  tags: ["workflow"],
  metadata: { version: 1, label_admin: "Review ITIN forms" },
}

beforeEach(() => {
  _clearCatalogCache()
  mocks.maybeSingleMock.mockReset()
  mocks.orderMock.mockReset()
  mocks.fromMock.mockClear()
  mocks.selectMock.mockClear()
  mocks.eqMock.mockClear()
})

describe("catalog-cache — getCatalogEntry", () => {
  it("returns null when the DB has no matching row", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: null, error: null })
    const result = await getCatalogEntry("task_workflows", "missing")
    expect(result).toBeNull()
    expect(_catalogCacheSize()).toBe(0)
  })

  it("returns a normalized entry on cache miss + caches it", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: sampleRow, error: null })
    const result = await getCatalogEntry("task_workflows", "itin_review")
    expect(result).not.toBeNull()
    expect(result?.slug).toBe("itin_review")
    expect(result?.metadata).toEqual({ version: 1, label_admin: "Review ITIN forms" })
    expect(_catalogCacheSize()).toBe(1)
  })

  it("subsequent reads hit the cache (DB not called again)", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: sampleRow, error: null })
    await getCatalogEntry("task_workflows", "itin_review")

    // Second read: no further DB call expected.
    const result = await getCatalogEntry("task_workflows", "itin_review")
    expect(result?.slug).toBe("itin_review")
    expect(mocks.maybeSingleMock).toHaveBeenCalledTimes(1)
  })

  it("normalizes null tags / null metadata to defaults", async () => {
    const sparse = { ...sampleRow, tags: null, metadata: null }
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: sparse, error: null })
    const result = await getCatalogEntry("task_workflows", "itin_review")
    expect(result?.tags).toEqual([])
    expect(result?.metadata).toEqual({})
  })

  it("throws with context on DB error", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: null, error: { message: "boom" } })
    await expect(getCatalogEntry("task_workflows", "x")).rejects.toThrow(
      /getCatalogEntry\(task_workflows, x\): boom/,
    )
  })
})

describe("catalog-cache — invalidation", () => {
  it("_invalidateCatalogEntry drops a specific key", async () => {
    mocks.maybeSingleMock.mockResolvedValueOnce({ data: sampleRow, error: null })
    await getCatalogEntry("task_workflows", "itin_review")
    expect(_catalogCacheSize()).toBe(1)

    _invalidateCatalogEntry("task_workflows", "itin_review")
    expect(_catalogCacheSize()).toBe(0)
  })

  it("_clearCatalogCache wipes everything", async () => {
    mocks.maybeSingleMock
      .mockResolvedValueOnce({ data: sampleRow, error: null })
      .mockResolvedValueOnce({ data: { ...sampleRow, slug: "lease_review" }, error: null })
    await getCatalogEntry("task_workflows", "itin_review")
    await getCatalogEntry("task_workflows", "lease_review")
    expect(_catalogCacheSize()).toBe(2)

    _clearCatalogCache()
    expect(_catalogCacheSize()).toBe(0)
  })
})

describe("catalog-cache — listCatalogEntries", () => {
  it("returns rows normalized; bypasses the cache (no caching of list results)", async () => {
    mocks.orderMock.mockResolvedValueOnce({
      data: [sampleRow, { ...sampleRow, slug: "lease_review" }],
      error: null,
    })
    const rows = await listCatalogEntries("task_workflows")
    expect(rows).toHaveLength(2)
    expect(rows[0].slug).toBe("itin_review")
    expect(rows[1].slug).toBe("lease_review")
    // list does not populate the cache by design — verify size remained 0.
    expect(_catalogCacheSize()).toBe(0)
  })

  it("returns an empty array when the DB returns no rows", async () => {
    mocks.orderMock.mockResolvedValueOnce({ data: [], error: null })
    const rows = await listCatalogEntries("task_workflows")
    expect(rows).toEqual([])
  })

  it("throws with context on DB error", async () => {
    mocks.orderMock.mockResolvedValueOnce({ data: null, error: { message: "denied" } })
    await expect(listCatalogEntries("task_workflows")).rejects.toThrow(
      /listCatalogEntries\(task_workflows\): denied/,
    )
  })
})
