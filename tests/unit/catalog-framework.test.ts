/**
 * Catalog framework — Phase 1 unit tests.
 *
 * Mocks `@/lib/supabase-admin` with an in-memory fake of the four catalog
 * tables (`catalog_definitions`, `catalog_entries`, `catalog_decision_log`,
 * `catalog_pending_review`). Validates every helper in
 * `lib/catalog/framework.ts` plus the `lib/services/index.ts` accessor.
 *
 * Spec: sysdoc `ops-2026-05-09-catalog-framework-spec`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ─── In-memory store ─────────────────────────────────────────────────────

interface Row {
  [key: string]: unknown
}

interface Store {
  catalog_definitions: Row[]
  catalog_entries: Row[]
  catalog_decision_log: Row[]
  catalog_pending_review: Row[]
}

const store: Store = {
  catalog_definitions: [],
  catalog_entries: [],
  catalog_decision_log: [],
  catalog_pending_review: [],
}

let nextUuidCounter = 1
function nextUuid(prefix: string = "id"): string {
  return `${prefix}-${String(nextUuidCounter++).padStart(8, "0")}`
}

const NOW = "2026-05-09T12:00:00+00:00"

/**
 * Override for the next insert into `catalog_entries`. Lets us simulate the
 * unique-violation that the DB raises when (catalog_id, slug) collides.
 */
let nextEntryInsertError: { code?: string; message: string } | null = null

/**
 * Override for the next insert into `catalog_decision_log`. Lets us simulate
 * a log-write failure to verify the rollback path in `addEntry`.
 */
let nextLogInsertError: { code?: string; message: string } | null = null

function resetStore(): void {
  store.catalog_definitions = []
  store.catalog_entries = []
  store.catalog_decision_log = []
  store.catalog_pending_review = []
  nextUuidCounter = 1
  nextEntryInsertError = null
  nextLogInsertError = null
}

// ─── Fake supabase client ────────────────────────────────────────────────

type Filter =
  | { op: "eq"; col: string; val: unknown }
  | { op: "neq"; col: string; val: unknown }
  | { op: "contains"; col: string; val: unknown[] }

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((r) =>
    filters.every((f) => {
      const cell = r[f.col]
      if (f.op === "eq") return cell === f.val
      if (f.op === "neq") return cell !== f.val
      // contains: jsonb array @> array — every element of f.val must be in cell
      if (Array.isArray(cell)) {
        return f.val.every((v) => (cell as unknown[]).includes(v))
      }
      return false
    }),
  )
}

interface QueryBuilder extends PromiseLike<{ data: Row[] | Row | null; error: { code?: string; message: string } | null }> {
  select: (cols?: string) => QueryBuilder
  eq: (col: string, val: unknown) => QueryBuilder
  neq: (col: string, val: unknown) => QueryBuilder
  contains: (col: string, val: unknown[]) => QueryBuilder
  order: (col: string, opts?: { ascending?: boolean }) => QueryBuilder
  maybeSingle: () => QueryBuilder
  single: () => QueryBuilder
  insert: (row: Row | Row[]) => QueryBuilder
  update: (row: Row) => QueryBuilder
  delete: () => QueryBuilder
}

function makeBuilder(table: keyof Store): QueryBuilder {
  const filters: Filter[] = []
  let orderCol: string | null = null
  let orderAsc = true
  let terminal: "list" | "maybeSingle" | "single" = "list"
  let pendingInsert: Row | null = null
  let pendingUpdate: Row | null = null
  let pendingDelete = false

  const exec = async (): Promise<{ data: Row[] | Row | null; error: { code?: string; message: string } | null }> => {
    // Mutations
    if (pendingInsert) {
      if (table === "catalog_entries" && nextEntryInsertError) {
        const err = nextEntryInsertError
        nextEntryInsertError = null
        return { data: null, error: err }
      }
      if (table === "catalog_decision_log" && nextLogInsertError) {
        const err = nextLogInsertError
        nextLogInsertError = null
        return { data: null, error: err }
      }
      const row: Row = {
        id: nextUuid(table === "catalog_entries" ? "entry" : table === "catalog_decision_log" ? "log" : "pending"),
        created_at: NOW,
        updated_at: NOW,
        ...pendingInsert,
      }
      // Enforce unique (catalog_id, slug) on catalog_entries
      if (table === "catalog_entries") {
        const dup = store.catalog_entries.find(
          (r) => r.catalog_id === row.catalog_id && r.slug === row.slug,
        )
        if (dup) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }
        }
      }
      store[table].push(row)
      return { data: JSON.parse(JSON.stringify(row)), error: null }
    }
    if (pendingDelete) {
      const matches = applyFilters(store[table], filters)
      const ids = new Set(matches.map((r) => r.id))
      store[table] = store[table].filter((r) => !ids.has(r.id))
      return { data: null, error: null }
    }
    if (pendingUpdate) {
      const matches = applyFilters(store[table], filters)
      for (const m of matches) {
        Object.assign(m, pendingUpdate, { updated_at: NOW })
      }
      const updated = matches[0] ?? null
      const cloneOne = (r: Row | null) => (r ? JSON.parse(JSON.stringify(r)) : null)
      if (terminal === "single" || terminal === "maybeSingle") {
        return { data: cloneOne(updated), error: updated ? null : { message: "no rows" } }
      }
      return { data: matches.map((r) => JSON.parse(JSON.stringify(r))), error: null }
    }
    // Read
    let rows = applyFilters(store[table], filters)
    if (orderCol) {
      const col = orderCol
      const asc = orderAsc
      rows = [...rows].sort((a, b) => {
        const av = a[col] as string | number
        const bv = b[col] as string | number
        if (av < bv) return asc ? -1 : 1
        if (av > bv) return asc ? 1 : -1
        return 0
      })
    }
    // Clone every row before returning so callers that capture a snapshot
    // ("before_state") don't see later mutations bleed in via shared refs.
    const clone = (r: Row): Row => JSON.parse(JSON.stringify(r))
    if (terminal === "maybeSingle") {
      if (rows.length === 0) return { data: null, error: null }
      if (rows.length > 1) return { data: null, error: { message: "Cannot coerce result to single object" } }
      return { data: clone(rows[0]), error: null }
    }
    if (terminal === "single") {
      if (rows.length === 1) return { data: clone(rows[0]), error: null }
      return { data: null, error: { message: rows.length === 0 ? "no rows" : "multiple rows" } }
    }
    return { data: rows.map(clone), error: null }
  }

  const builder: QueryBuilder = {
    select() {
      return builder
    },
    eq(col, val) {
      filters.push({ op: "eq", col, val })
      return builder
    },
    neq(col, val) {
      filters.push({ op: "neq", col, val })
      return builder
    },
    contains(col, val) {
      filters.push({ op: "contains", col, val })
      return builder
    },
    order(col, opts) {
      orderCol = col
      orderAsc = opts?.ascending !== false
      return builder
    },
    maybeSingle() {
      terminal = "maybeSingle"
      return builder
    },
    single() {
      terminal = "single"
      return builder
    },
    insert(row) {
      pendingInsert = Array.isArray(row) ? row[0] : row
      return builder
    },
    update(row) {
      pendingUpdate = row
      return builder
    },
    delete() {
      pendingDelete = true
      return builder
    },
    then(onFulfilled, onRejected) {
      return exec().then(onFulfilled, onRejected)
    },
  }

  return builder
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from(table: string) {
      return makeBuilder(table as keyof Store)
    },
  },
}))

// ─── Imports under test ──────────────────────────────────────────────────

import {
  type Actor,
  addEntry,
  addTranslation,
  deprecateEntry,
  getCatalog,
  getEntry,
  getEntryById,
  labelFor,
  listEntries,
  listPendingReview,
  renameEntry,
  type ResolveExternalResult,
  resolveExternalValue,
  resolvePendingReview,
  restoreEntry,
  slugFor,
  tagEntry,
} from "@/lib/catalog/framework"
import {
  _resetServicesCache,
  getAllSDTypes,
  getAllSellableServices,
  getAllServices,
  getLLCManagementBundle,
  getLLCManagementBundleTypes,
  getSDByType,
  getServiceBySlug,
  getServiceBySlugStatic,
  isStandaloneSD,
  labelForService,
  labelForServiceStatic,
  LLC_MANAGEMENT_BUNDLE_TYPES,
  SD_STATIC,
  type ServiceSlug,
  servicesAutoBundledWithManagement,
  SERVICES_STATIC,
  SERVICES_STATIC_SELLABLE,
  slugToDisplay,
} from "@/lib/services/index"

// ─── Fixtures ────────────────────────────────────────────────────────────

const ACTOR: Actor = { kind: "migration", userId: null }

type Unmatched = Extract<ResolveExternalResult, { matched: false }>

function assertUnmatched(r: ResolveExternalResult): Unmatched {
  if (r.matched) throw new Error(`expected unmatched, got entry ${r.entry.slug}`)
  return r as Unmatched
}

interface SeedEntry {
  slug: string
  display_name: string
  status: "active" | "deprecated" | "exception_only"
  tags: string[]
  display_name_translations?: Record<string, string>
}

/**
 * Mirror of the 18 production seeds for catalog_id='services'. Used both as
 * fixture data and as drift-detector for the hand-maintained ServiceSlug
 * union in `lib/services/index.ts`.
 */
const SERVICES_SEED: SeedEntry[] = [
  { slug: "llc_formation", display_name: "LLC Formation", status: "active", tags: ["service", "sellable", "entry_to_management"], display_name_translations: { it: "Costituzione LLC" } },
  { slug: "onboarding", display_name: "Onboarding", status: "active", tags: ["service", "sellable", "entry_to_management"], display_name_translations: { it: "Onboarding LLC esistente" } },
  { slug: "tax_return", display_name: "Tax Return", status: "active", tags: ["service", "sd", "sellable", "auto_bundled_with_management"], display_name_translations: { it: "Dichiarazione Fiscale" } },
  { slug: "itin", display_name: "ITIN Application", status: "active", tags: ["service", "sd", "sellable"], display_name_translations: { it: "Richiesta ITIN" } },
  { slug: "ein", display_name: "EIN Application", status: "active", tags: ["service", "sd", "sellable"], display_name_translations: { it: "Richiesta EIN" } },
  { slug: "banking", display_name: "Banking", status: "active", tags: ["service", "sd", "sellable"], display_name_translations: { it: "Apertura conto bancario" } },
  { slug: "cmra", display_name: "CMRA Mailing Address", status: "active", tags: ["service", "sd", "sellable", "auto_bundled_with_management"], display_name_translations: { it: "Indirizzo postale (CMRA)" } },
  { slug: "shipping", display_name: "Shipping Service", status: "active", tags: ["service", "sellable"] },
  { slug: "notary", display_name: "Public Notary", status: "active", tags: ["service", "sellable"] },
  { slug: "closure", display_name: "Company Closure", status: "active", tags: ["service", "sd", "sellable"] },
  { slug: "consulting", display_name: "Consulting Call", status: "active", tags: ["service", "sellable"] },
  { slug: "state_annual_report", display_name: "State Annual Report", status: "active", tags: ["sd", "auto_bundled_with_management"], display_name_translations: { it: "Rapporto annuale statale" } },
  { slug: "state_ra_renewal", display_name: "State RA Renewal", status: "active", tags: ["sd", "auto_bundled_with_management"], display_name_translations: { it: "Rinnovo Registered Agent" } },
  { slug: "client_onboarding", display_name: "Client Onboarding", status: "active", tags: ["sd"] },
  { slug: "company_formation", display_name: "Company Formation", status: "active", tags: ["sd"] },
  { slug: "annual_renewal_sd", display_name: "Annual Renewal (Legacy SD)", status: "deprecated", tags: ["billing_cycle_artifact", "deprecated"] },
  { slug: "custom", display_name: "Custom", status: "exception_only", tags: ["exception"] },
  { slug: "pending_review", display_name: "Pending Review", status: "exception_only", tags: ["exception"] },
]

function seedServicesCatalog(): void {
  store.catalog_definitions.push({
    id: "services",
    display_name: "Services & SD Types",
    display_name_translations: {},
    description: "Services, SD types, and the LLC Management bundle.",
    admin_can_add_rows: true,
    tags_schema: null,
    created_at: NOW,
    updated_at: NOW,
  })

  for (const s of SERVICES_SEED) {
    store.catalog_entries.push({
      id: nextUuid("entry"),
      catalog_id: "services",
      slug: s.slug,
      display_name: s.display_name,
      display_name_translations: s.display_name_translations ?? {},
      description: null,
      description_translations: {},
      status: s.status,
      tags: s.tags,
      capabilities: {},
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
      created_by: null,
      updated_by: null,
    })
  }
}

function findEntryBySlug(slug: string): Row {
  const e = store.catalog_entries.find((r) => r.slug === slug)
  if (!e) throw new Error(`Test fixture missing slug: ${slug}`)
  return e
}

beforeEach(() => {
  resetStore()
  seedServicesCatalog()
  _resetServicesCache()
})

afterEach(() => {
  resetStore()
})

// ─── getCatalog ───────────────────────────────────────────────────────────

describe("getCatalog", () => {
  it("returns the definition row when present", async () => {
    const def = await getCatalog("services")
    expect(def).not.toBeNull()
    expect(def?.id).toBe("services")
    expect(def?.display_name).toBe("Services & SD Types")
    expect(def?.admin_can_add_rows).toBe(true)
  })

  it("returns null for an unknown catalog", async () => {
    const def = await getCatalog("does_not_exist")
    expect(def).toBeNull()
  })
})

// ─── listEntries ──────────────────────────────────────────────────────────

describe("listEntries", () => {
  it("excludes deprecated by default", async () => {
    const rows = await listEntries("services")
    expect(rows.length).toBe(17)
    expect(rows.find((r) => r.slug === "annual_renewal_sd")).toBeUndefined()
  })

  it("includes deprecated when includeDeprecated=true", async () => {
    const rows = await listEntries("services", { includeDeprecated: true })
    expect(rows.length).toBe(18)
    expect(rows.find((r) => r.slug === "annual_renewal_sd")).toBeDefined()
  })

  it("filters by status", async () => {
    const exceptions = await listEntries("services", { status: "exception_only" })
    expect(exceptions.map((r) => r.slug).sort()).toEqual(["custom", "pending_review"])
  })

  it("filters by tags (jsonb @>)", async () => {
    const services = await listEntries("services", { tags: ["service"] })
    expect(services.length).toBe(11)
    expect(services.every((r) => r.tags.includes("service"))).toBe(true)
  })

  it("combines status and tags filters", async () => {
    const sdActive = await listEntries("services", { status: "active", tags: ["sd"] })
    expect(sdActive.every((r) => r.status === "active" && r.tags.includes("sd"))).toBe(true)
    expect(sdActive.find((r) => r.slug === "annual_renewal_sd")).toBeUndefined()
  })
})

// ─── getEntry / getEntryById ─────────────────────────────────────────────

describe("getEntry / getEntryById", () => {
  it("getEntry returns the row by slug", async () => {
    const e = await getEntry("services", "tax_return")
    expect(e).not.toBeNull()
    expect(e?.display_name).toBe("Tax Return")
  })

  it("getEntry returns null for unknown slug", async () => {
    const e = await getEntry("services", "nonexistent")
    expect(e).toBeNull()
  })

  it("getEntryById returns the row by uuid", async () => {
    const seeded = findEntryBySlug("ein")
    const e = await getEntryById(seeded.id as string)
    expect(e?.slug).toBe("ein")
  })
})

// ─── labelFor / slugFor ──────────────────────────────────────────────────

describe("labelFor / slugFor", () => {
  it("labelFor returns Italian when present", async () => {
    const e = await getEntry("services", "tax_return")
    expect(e).not.toBeNull()
    expect(labelFor(e!, "it")).toBe("Dichiarazione Fiscale")
  })

  it("labelFor falls back to English when translation absent", async () => {
    const e = await getEntry("services", "consulting")
    expect(e).not.toBeNull()
    expect(labelFor(e!, "it")).toBe("Consulting Call")
  })

  it("labelFor defaults to English (no lang arg)", async () => {
    const e = await getEntry("services", "tax_return")
    expect(labelFor(e!)).toBe("Tax Return")
  })

  it("slugFor returns the slug", async () => {
    const e = await getEntry("services", "ein")
    expect(slugFor(e!)).toBe("ein")
  })
})

// ─── addEntry ────────────────────────────────────────────────────────────

describe("addEntry", () => {
  it("inserts a new entry and writes a decision-log row", async () => {
    const created = await addEntry(
      "services",
      { slug: "wire_setup", display_name: "Wire Setup", tags: ["service", "sellable"] },
      "Antonio confirmed wire-setup is now a paid service",
      ACTOR,
    )
    expect(created.slug).toBe("wire_setup")
    expect(created.status).toBe("active")
    expect(store.catalog_entries.find((r) => r.slug === "wire_setup")).toBeDefined()

    const log = store.catalog_decision_log.filter((r) => r.catalog_entry_id === created.id)
    expect(log.length).toBe(1)
    expect(log[0].action).toBe("added")
    expect(log[0].reason).toBe("Antonio confirmed wire-setup is now a paid service")
    expect(log[0].actor_kind).toBe("migration")
    expect(log[0].before_state).toBeNull()
  })

  it("rejects empty reason", async () => {
    await expect(
      addEntry("services", { slug: "no_reason", display_name: "X" }, "", ACTOR),
    ).rejects.toThrow(/reason/)
  })

  it("idempotency: same slug twice raises a clear error and does not duplicate", async () => {
    // Simulate the 23505 the DB raises on the unique (catalog_id, slug) index.
    nextEntryInsertError = { code: "23505", message: "duplicate key" }
    await expect(
      addEntry(
        "services",
        { slug: "tax_return", display_name: "Tax Return Duplicate" },
        "duplicate insert attempt",
        ACTOR,
      ),
    ).rejects.toThrow(/already exists/)

    const dups = store.catalog_entries.filter((r) => r.slug === "tax_return")
    expect(dups.length).toBe(1)
  })

  it("rolls back the inserted row when decision-log insert fails", async () => {
    nextLogInsertError = { message: "log table down" }
    await expect(
      addEntry(
        "services",
        { slug: "rollback_me", display_name: "Rollback Me" },
        "test rollback",
        ACTOR,
      ),
    ).rejects.toThrow(/log table down/)

    expect(store.catalog_entries.find((r) => r.slug === "rollback_me")).toBeUndefined()
  })
})

// ─── renameEntry ─────────────────────────────────────────────────────────

describe("renameEntry", () => {
  it("updates display_name and writes a decision log with before/after", async () => {
    const ein = findEntryBySlug("ein")
    const result = await renameEntry(
      ein.id as string,
      "EIN Application (renamed)",
      "clarify naming for new admins",
      ACTOR,
    )
    expect(result.display_name).toBe("EIN Application (renamed)")

    const log = store.catalog_decision_log.find((r) => r.catalog_entry_id === ein.id)
    expect(log?.action).toBe("renamed")
    expect((log?.before_state as Record<string, unknown>)?.display_name).toBe("EIN Application")
    expect((log?.after_state as Record<string, unknown>)?.display_name).toBe(
      "EIN Application (renamed)",
    )
  })

  it("rejects empty reason", async () => {
    const ein = findEntryBySlug("ein")
    await expect(renameEntry(ein.id as string, "Foo", "", ACTOR)).rejects.toThrow(/reason/)
  })

  it("throws when entry not found", async () => {
    await expect(
      renameEntry("entry-99999999", "X", "test", ACTOR),
    ).rejects.toThrow(/not found/)
  })
})

// ─── deprecateEntry / restoreEntry ───────────────────────────────────────

describe("deprecateEntry / restoreEntry", () => {
  it("deprecateEntry sets status=deprecated and logs", async () => {
    const closure = findEntryBySlug("closure")
    const result = await deprecateEntry(closure.id as string, "closure no longer offered", ACTOR)
    expect(result.status).toBe("deprecated")

    const log = store.catalog_decision_log.find((r) => r.catalog_entry_id === closure.id)
    expect(log?.action).toBe("deprecated")
    expect(log?.reason).toBe("closure no longer offered")
  })

  it("restoreEntry sets status=active and logs", async () => {
    const legacy = findEntryBySlug("annual_renewal_sd")
    const result = await restoreEntry(
      legacy.id as string,
      "we are reviving the legacy renewal SD",
      ACTOR,
    )
    expect(result.status).toBe("active")

    const log = store.catalog_decision_log.find((r) => r.catalog_entry_id === legacy.id)
    expect(log?.action).toBe("restored")
  })
})

// ─── tagEntry ────────────────────────────────────────────────────────────

describe("tagEntry", () => {
  it("replaces tags and logs before/after", async () => {
    const consulting = findEntryBySlug("consulting")
    const result = await tagEntry(
      consulting.id as string,
      ["service", "sellable", "phone_only"],
      "consulting is now phone-only",
      ACTOR,
    )
    expect(result.tags).toEqual(["service", "sellable", "phone_only"])

    const log = store.catalog_decision_log.find((r) => r.catalog_entry_id === consulting.id)
    expect(log?.action).toBe("tagged")
    expect((log?.before_state as Record<string, unknown>)?.tags).toEqual(["service", "sellable"])
    expect((log?.after_state as Record<string, unknown>)?.tags).toEqual([
      "service",
      "sellable",
      "phone_only",
    ])
  })
})

// ─── addTranslation ──────────────────────────────────────────────────────

describe("addTranslation", () => {
  it("adds a new translation and logs translation_added", async () => {
    const consulting = findEntryBySlug("consulting")
    const result = await addTranslation(
      consulting.id as string,
      "it",
      "Consulenza telefonica",
      "Consulenza pagata one-shot",
      "translate consulting card",
      ACTOR,
    )
    expect(result.display_name_translations.it).toBe("Consulenza telefonica")
    expect(result.description_translations.it).toBe("Consulenza pagata one-shot")

    const log = store.catalog_decision_log.find(
      (r) => r.catalog_entry_id === consulting.id,
    )
    expect(log?.action).toBe("translation_added")
  })

  it("logs translation_changed when the language already had a translation", async () => {
    const taxReturn = findEntryBySlug("tax_return")
    const result = await addTranslation(
      taxReturn.id as string,
      "it",
      "Dichiarazione dei Redditi",
      undefined,
      "match the formal Italian term",
      ACTOR,
    )
    expect(result.display_name_translations.it).toBe("Dichiarazione dei Redditi")

    const log = store.catalog_decision_log.find((r) => r.catalog_entry_id === taxReturn.id)
    expect(log?.action).toBe("translation_changed")
  })
})

// ─── resolveExternalValue ────────────────────────────────────────────────

describe("resolveExternalValue", () => {
  it("matches by exact slug", async () => {
    const result = await resolveExternalValue(
      "services",
      "tax_return",
      "stripe_webhook",
      { test: true },
    )
    expect(result.matched).toBe(true)
    if (result.matched) expect(result.entry.slug).toBe("tax_return")
  })

  it("matches by exact display_name", async () => {
    const result = await resolveExternalValue(
      "services",
      "Tax Return",
      "stripe_webhook",
      {},
    )
    expect(result.matched).toBe(true)
    if (result.matched) expect(result.entry.slug).toBe("tax_return")
  })

  it("matches by translation value", async () => {
    const result = await resolveExternalValue(
      "services",
      "Dichiarazione Fiscale",
      "whop_webhook",
      {},
    )
    expect(result.matched).toBe(true)
    if (result.matched) expect(result.entry.slug).toBe("tax_return")
  })

  it("inserts a pending_review row when no match found", async () => {
    const result = await resolveExternalValue(
      "services",
      "Mystery Plan v3",
      "whop_webhook",
      { plan_id: "plan_123" },
    )
    expect(result.matched).toBe(false)
    const unmatched = assertUnmatched(result)
    expect(unmatched.pendingReview.submitted_value).toBe("Mystery Plan v3")
    expect(unmatched.pendingReview.source).toBe("whop_webhook")
    expect(unmatched.pendingReview.status).toBe("pending")
    expect((unmatched.pendingReview.source_metadata as Record<string, unknown>).plan_id).toBe(
      "plan_123",
    )
    expect(store.catalog_pending_review.length).toBe(1)
  })

  it("dedups pending_review on retry of the same unknown value", async () => {
    const a = assertUnmatched(
      await resolveExternalValue("services", "Mystery Plan v3", "whop_webhook", { attempt: 1 }),
    )
    const b = assertUnmatched(
      await resolveExternalValue("services", "Mystery Plan v3", "whop_webhook", { attempt: 2 }),
    )
    expect(store.catalog_pending_review.length).toBe(1)
    expect(b.pendingReview.id).toBe(a.pendingReview.id)
  })
})

// ─── listPendingReview ───────────────────────────────────────────────────

describe("listPendingReview", () => {
  it("returns only pending rows by default", async () => {
    const a = assertUnmatched(
      await resolveExternalValue("services", "Mystery A", "whop_webhook", {}),
    )
    assertUnmatched(await resolveExternalValue("services", "Mystery B", "stripe_webhook", {}))

    // Resolve one — should fall out of the default list.
    const taxReturn = findEntryBySlug("tax_return")
    await resolvePendingReview(
      a.pendingReview.id,
      "approved_aliased",
      taxReturn.id as string,
      "alias mystery A to tax_return",
      ACTOR,
    )

    const pending = await listPendingReview()
    expect(pending.length).toBe(1)
    expect(pending[0].submitted_value).toBe("Mystery B")
    expect(pending[0].status).toBe("pending")
  })

  it("filters by catalog_id", async () => {
    assertUnmatched(await resolveExternalValue("services", "Mystery C", "whop_webhook", {}))
    const rows = await listPendingReview({ catalogId: "services" })
    expect(rows.length).toBe(1)
    const empty = await listPendingReview({ catalogId: "does_not_exist" })
    expect(empty.length).toBe(0)
  })

  it("status='all' returns every row regardless of resolution", async () => {
    const a = assertUnmatched(
      await resolveExternalValue("services", "Mystery D", "whop_webhook", {}),
    )
    await resolvePendingReview(
      a.pendingReview.id,
      "rejected",
      null,
      "spam",
      ACTOR,
    )
    const all = await listPendingReview({ status: "all" })
    expect(all.length).toBe(1)
    expect(all[0].status).toBe("rejected")
  })
})

// ─── resolvePendingReview ────────────────────────────────────────────────

describe("resolvePendingReview", () => {
  it("approved_aliased: marks status, links resolved_to_entry_id, stamps reason in source_metadata", async () => {
    const before = assertUnmatched(
      await resolveExternalValue("services", "Tax Return Premium", "stripe_webhook", {
        plan: "p1",
      }),
    )
    const taxReturn = findEntryBySlug("tax_return")
    const resolved = await resolvePendingReview(
      before.pendingReview.id,
      "approved_aliased",
      taxReturn.id as string,
      "Stripe label drift — alias to tax_return",
      { kind: "ui", userId: null },
    )
    expect(resolved.status).toBe("approved_aliased")
    expect(resolved.resolved_to_entry_id).toBe(taxReturn.id)
    expect(resolved.resolved_at).toBeTruthy()
    const meta = resolved.source_metadata as Record<string, unknown>
    expect((meta.resolution as Record<string, unknown>).reason).toBe(
      "Stripe label drift — alias to tax_return",
    )
    expect((meta.resolution as Record<string, unknown>).actor_kind).toBe("ui")
    // Original metadata preserved
    expect(meta.plan).toBe("p1")
  })

  it("rejected: status flips to rejected, resolved_to_entry_id stays null", async () => {
    const before = assertUnmatched(
      await resolveExternalValue("services", "Spam Plan", "whop_webhook", {}),
    )
    const resolved = await resolvePendingReview(
      before.pendingReview.id,
      "rejected",
      null,
      "spam — webhook noise",
      ACTOR,
    )
    expect(resolved.status).toBe("rejected")
    expect(resolved.resolved_to_entry_id).toBeNull()
  })

  it("rejects empty reason", async () => {
    const before = assertUnmatched(
      await resolveExternalValue("services", "Mystery E", "whop_webhook", {}),
    )
    await expect(
      resolvePendingReview(before.pendingReview.id, "rejected", null, "", ACTOR),
    ).rejects.toThrow(/reason/)
  })

  it("rejects approved_* without a resolved_to_entry_id", async () => {
    const before = assertUnmatched(
      await resolveExternalValue("services", "Mystery F", "whop_webhook", {}),
    )
    await expect(
      resolvePendingReview(before.pendingReview.id, "approved_aliased", null, "test", ACTOR),
    ).rejects.toThrow(/resolvedToEntryId is required/)
  })

  it("rejects 'rejected' with a non-null resolved_to_entry_id", async () => {
    const before = assertUnmatched(
      await resolveExternalValue("services", "Mystery G", "whop_webhook", {}),
    )
    const taxReturn = findEntryBySlug("tax_return")
    await expect(
      resolvePendingReview(
        before.pendingReview.id,
        "rejected",
        taxReturn.id as string,
        "test",
        ACTOR,
      ),
    ).rejects.toThrow(/must be null when status='rejected'/)
  })

  it("rejects target entry from a different catalog", async () => {
    // Seed a second catalog + entry, then try to alias a 'services' pending row to it.
    store.catalog_definitions.push({
      id: "other",
      display_name: "Other",
      display_name_translations: {},
      description: null,
      admin_can_add_rows: true,
      tags_schema: null,
      created_at: NOW,
      updated_at: NOW,
    })
    const otherEntry: Row = {
      id: nextUuid("entry"),
      catalog_id: "other",
      slug: "x",
      display_name: "X",
      display_name_translations: {},
      description: null,
      description_translations: {},
      status: "active",
      tags: [],
      capabilities: {},
      metadata: {},
      created_at: NOW,
      updated_at: NOW,
      created_by: null,
      updated_by: null,
    }
    store.catalog_entries.push(otherEntry)

    const before = assertUnmatched(
      await resolveExternalValue("services", "Mystery H", "whop_webhook", {}),
    )
    await expect(
      resolvePendingReview(
        before.pendingReview.id,
        "approved_aliased",
        otherEntry.id as string,
        "test",
        ACTOR,
      ),
    ).rejects.toThrow(/belongs to catalog 'other'/)
  })

  it("rejects double-resolution of the same row", async () => {
    const before = assertUnmatched(
      await resolveExternalValue("services", "Mystery I", "whop_webhook", {}),
    )
    await resolvePendingReview(before.pendingReview.id, "rejected", null, "first", ACTOR)
    await expect(
      resolvePendingReview(before.pendingReview.id, "rejected", null, "again", ACTOR),
    ).rejects.toThrow(/already resolved/)
  })

  it("throws when pending row not found", async () => {
    await expect(
      resolvePendingReview("pending-99999999", "rejected", null, "test", ACTOR),
    ).rejects.toThrow(/not found/)
  })
})

// ─── lib/services/index.ts accessors ─────────────────────────────────────

describe("lib/services/index", () => {
  it("getAllServices returns the 11 active rows tagged 'service'", async () => {
    const services = await getAllServices()
    expect(services.length).toBe(11)
    expect(services.every((s) => s.status === "active" && s.tags.includes("service"))).toBe(true)
  })

  it("getAllSDTypes returns the 10 rows tagged 'sd' (annual_renewal_sd is tagged deprecated, not sd)", async () => {
    const sds = await getAllSDTypes()
    expect(sds.length).toBe(10)
    expect(sds.every((s) => s.tags.includes("sd"))).toBe(true)
    expect(sds.find((s) => s.slug === "annual_renewal_sd")).toBeUndefined()
  })

  it("getLLCManagementBundle returns the 4 auto-bundled SDs", async () => {
    const bundle = await getLLCManagementBundle()
    expect(bundle.map((b) => b.slug).sort()).toEqual(
      ["cmra", "state_annual_report", "state_ra_renewal", "tax_return"].sort(),
    )
  })

  it("servicesAutoBundledWithManagement is an alias of getLLCManagementBundle", async () => {
    const a = await servicesAutoBundledWithManagement()
    const b = await getLLCManagementBundle()
    expect(a.map((x) => x.slug).sort()).toEqual(b.map((x) => x.slug).sort())
  })

  it("LLC_MANAGEMENT_BUNDLE_TYPES set matches catalog auto_bundled_with_management entries", async () => {
    const fromCatalog = (await getLLCManagementBundle()).map((e) => e.display_name).sort()
    const fromConst = [...LLC_MANAGEMENT_BUNDLE_TYPES].sort()
    expect(fromConst).toEqual(fromCatalog)
  })

  it("LLC_MANAGEMENT_BUNDLE_TYPES preserves the historical write order for bundled_pipelines", () => {
    expect(LLC_MANAGEMENT_BUNDLE_TYPES).toEqual([
      "CMRA Mailing Address",
      "State RA Renewal",
      "State Annual Report",
      "Tax Return",
    ])
  })

  it("getLLCManagementBundleTypes returns the 4 display names from the catalog", async () => {
    const types = await getLLCManagementBundleTypes()
    expect(types.sort()).toEqual(
      ["CMRA Mailing Address", "State Annual Report", "State RA Renewal", "Tax Return"].sort(),
    )
  })

  it("getAllSellableServices returns the 11 sellable rows", async () => {
    const sellable = await getAllSellableServices()
    expect(sellable.length).toBe(11)
    expect(sellable.every((s) => s.tags.includes("sellable"))).toBe(true)
  })

  it("getServiceBySlug returns the row for a known slug", async () => {
    const e = await getServiceBySlug("ein")
    expect(e?.display_name).toBe("EIN Application")
  })

  it("getSDByType matches by display_name (the value stored in service_deliveries.service_type)", async () => {
    const e = await getSDByType("Tax Return")
    expect(e?.slug).toBe("tax_return")
  })

  it("isStandaloneSD returns true for SDs that are also sellable", async () => {
    expect(await isStandaloneSD("Tax Return")).toBe(true)
    expect(await isStandaloneSD("Banking")).toBe(true)
  })

  it("isStandaloneSD returns false for SDs that are not sellable on their own", async () => {
    expect(await isStandaloneSD("Company Formation")).toBe(false)
    expect(await isStandaloneSD("Client Onboarding")).toBe(false)
  })

  it("labelForService returns Italian when present, English when absent", async () => {
    expect(await labelForService("tax_return", "it")).toBe("Dichiarazione Fiscale")
    expect(await labelForService("consulting", "it")).toBe("Consulting Call")
    expect(await labelForService("tax_return")).toBe("Tax Return")
  })

  it("slugToDisplay maps every seeded slug to its English display name", async () => {
    const map = await slugToDisplay()
    expect(map.tax_return).toBe("Tax Return")
    expect(map.cmra).toBe("CMRA Mailing Address")
    expect(Object.keys(map).length).toBe(SERVICES_SEED.length)
  })

  // ── Build-time drift detector: ServiceSlug union vs DB seed ──
  it("ServiceSlug union covers exactly the 11 seeded rows tagged 'service'", () => {
    // Hand-mirrored from `lib/services/index.ts::ServiceSlug`. If this list
    // diverges from the type union, TS will fail on the `satisfies` below.
    const SERVICE_SLUGS_FROM_TYPE = [
      "llc_formation",
      "onboarding",
      "tax_return",
      "itin",
      "ein",
      "banking",
      "cmra",
      "shipping",
      "notary",
      "closure",
      "consulting",
    ] as const satisfies readonly ServiceSlug[]

    const fromSeed = SERVICES_SEED.filter((s) => s.tags.includes("service")).map((s) => s.slug)
    expect(SERVICE_SLUGS_FROM_TYPE.slice().sort()).toEqual(fromSeed.slice().sort())
  })

  it("seed contains exactly 18 entries (matches DB)", () => {
    expect(SERVICES_SEED.length).toBe(18)
  })
})

// ─── SERVICES_STATIC drift detector ──────────────────────────────────────

describe("SERVICES_STATIC", () => {
  it("contains exactly the 18 seed entries by slug", () => {
    expect(SERVICES_STATIC.map((e) => e.slug).sort()).toEqual(
      SERVICES_SEED.map((s) => s.slug).sort(),
    )
  })

  it("matches each seed row's display_name, status, tags, and translations", () => {
    for (const seed of SERVICES_SEED) {
      const stat = SERVICES_STATIC.find((e) => e.slug === seed.slug)
      expect(stat, `static entry missing for slug=${seed.slug}`).toBeDefined()
      if (!stat) continue
      expect(stat.display_name).toBe(seed.display_name)
      expect(stat.status).toBe(seed.status)
      expect([...stat.tags].sort()).toEqual([...seed.tags].sort())
      expect(stat.display_name_translations).toEqual(seed.display_name_translations ?? {})
    }
  })

  it("SERVICES_STATIC_SELLABLE matches getAllServices() (11 active rows tagged 'service')", async () => {
    const dynamic = await getAllServices()
    expect(SERVICES_STATIC_SELLABLE.map((e) => e.slug).sort()).toEqual(
      dynamic.map((e) => e.slug).sort(),
    )
    expect(SERVICES_STATIC_SELLABLE.length).toBe(11)
  })

  it("SD_STATIC matches active 'sd'-tagged rows (10 rows; annual_renewal_sd is deprecated)", async () => {
    const dynamic = await getAllSDTypes()
    const dynamicActive = dynamic.filter((e) => e.status === "active")
    expect(SD_STATIC.map((e) => e.slug).sort()).toEqual(
      dynamicActive.map((e) => e.slug).sort(),
    )
    expect(SD_STATIC.length).toBe(10)
  })

  it("getServiceBySlugStatic returns the same slug as getServiceBySlug for known slugs", async () => {
    const dyn = await getServiceBySlug("tax_return")
    const stat = getServiceBySlugStatic("tax_return")
    expect(stat?.slug).toBe(dyn?.slug)
    expect(stat?.display_name).toBe(dyn?.display_name)
  })

  it("getServiceBySlugStatic returns null for unknown slug", () => {
    expect(getServiceBySlugStatic("nonexistent")).toBeNull()
  })

  it("labelForServiceStatic returns Italian when present, English otherwise", () => {
    expect(labelForServiceStatic("tax_return", "it")).toBe("Dichiarazione Fiscale")
    expect(labelForServiceStatic("consulting", "it")).toBe("Consulting Call")
    expect(labelForServiceStatic("tax_return")).toBe("Tax Return")
    expect(labelForServiceStatic("unknown_slug")).toBe("unknown_slug")
  })
})
