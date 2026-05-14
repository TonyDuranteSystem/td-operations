import { describe, expect, it, vi, beforeEach } from "vitest"

// Catalog rows the mocked supabaseAdmin returns. Each test sets this before
// calling getWelcomeMessage, then the .in('slug', ...) filter is applied here.
let CATALOG_ROWS: Array<{
  slug: string
  display_name: string
  display_name_translations: Record<string, string> | null
  description: string | null
  description_translations: Record<string, string> | null
  status: string
  metadata: Record<string, unknown> | null
}> = []
let CATALOG_ERROR: { message: string } | null = null

vi.mock("@/lib/supabase-admin", () => {
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table !== "catalog_entries") throw new Error(`unexpected table: ${table}`)
        let slugs: string[] = []
        const chain: Record<string, unknown> = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          neq: vi.fn().mockReturnThis(),
          in: vi.fn((_col: string, vals: string[]) => {
            slugs = vals
            return chain
          }),
        }
        chain.then = (resolve: (v: { data: typeof CATALOG_ROWS; error: typeof CATALOG_ERROR }) => void) => {
          if (CATALOG_ERROR) return resolve({ data: [], error: CATALOG_ERROR })
          const filtered = CATALOG_ROWS.filter((r) => slugs.includes(r.slug) && r.status !== "deprecated")
          resolve({ data: filtered, error: null })
        }
        return chain
      },
    },
  }
})

import { getWelcomeMessage, renderTemplate } from "@/lib/portal/welcome-message"

beforeEach(() => {
  CATALOG_ROWS = []
  CATALOG_ERROR = null
})

describe("renderTemplate", () => {
  it("substitutes known placeholders", () => {
    const out = renderTemplate("Hi {{firstName}}, welcome to {{companyName}}!", {
      firstName: "Valerio",
      companyName: "Acme LLC",
    })
    expect(out).toBe("Hi Valerio, welcome to Acme LLC!")
  })

  it("leaves unknown placeholders in place so missing data is visible during QA", () => {
    const out = renderTemplate("Hi {{firstName}}, your {{missingThing}} is ready", {
      firstName: "Valerio",
    })
    expect(out).toBe("Hi Valerio, your {{missingThing}} is ready")
  })

  it("treats undefined/empty values as unknown (renders the placeholder)", () => {
    const out = renderTemplate("Hi {{firstName}}!", { firstName: undefined })
    expect(out).toBe("Hi {{firstName}}!")
    const out2 = renderTemplate("Hi {{firstName}}!", { firstName: "" })
    expect(out2).toBe("Hi {{firstName}}!")
  })

  it("ignores braces with whitespace inside (only exact {{key}} form is substituted)", () => {
    const out = renderTemplate("Hi {{ firstName }}!", { firstName: "X" })
    expect(out).toBe("Hi {{ firstName }}!")
  })
})

describe("getWelcomeMessage", () => {
  it("picks the highest-priority template across bundled pipelines", async () => {
    CATALOG_ROWS = [
      {
        slug: "tax_return",
        display_name: "Tax welcome EN",
        display_name_translations: { it: "Tax welcome IT" },
        description: "Tax body EN",
        description_translations: { it: "Tax body IT" },
        status: "active",
        metadata: { priority: 70 },
      },
      {
        slug: "ein",
        display_name: "EIN welcome EN",
        display_name_translations: { it: "EIN welcome IT" },
        description: "EIN body EN",
        description_translations: { it: "EIN body IT" },
        status: "active",
        metadata: { priority: 50 },
      },
      {
        slug: "company_formation",
        display_name: "Formation welcome EN",
        display_name_translations: { it: "Formation welcome IT" },
        description: "Formation body EN",
        description_translations: { it: "Formation body IT" },
        status: "active",
        metadata: { priority: 90 },
      },
    ]
    const result = await getWelcomeMessage({
      contractType: "formation",
      pipelines: ["Company Formation", "EIN", "Tax Return"],
      language: "en",
    })
    expect(result).not.toBeNull()
    expect(result!.slug).toBe("company_formation")
    expect(result!.priority).toBe(90)
    expect(result!.title).toBe("Formation welcome EN")
  })

  it("returns Italian text when language='it' and IT translation exists", async () => {
    CATALOG_ROWS = [
      {
        slug: "itin",
        display_name: "EN title",
        display_name_translations: { it: "IT title" },
        description: "EN body",
        description_translations: { it: "IT body" },
        status: "active",
        metadata: { priority: 80, wizard_path: "/portal/wizard" },
      },
    ]
    const result = await getWelcomeMessage({
      contractType: "tax_return",
      pipelines: ["ITIN"],
      language: "Italian",
    })
    expect(result).not.toBeNull()
    expect(result!.language).toBe("it")
    expect(result!.title).toBe("IT title")
    expect(result!.body).toBe("IT body")
    expect(result!.wizardPath).toBe("/portal/wizard")
  })

  it("falls back to English when IT translation is missing", async () => {
    CATALOG_ROWS = [
      {
        slug: "itin",
        display_name: "EN title",
        display_name_translations: {}, // no IT
        description: "EN body",
        description_translations: null,
        status: "active",
        metadata: { priority: 80 },
      },
    ]
    const result = await getWelcomeMessage({
      contractType: "tax_return",
      pipelines: ["ITIN"],
      language: "it",
    })
    expect(result).not.toBeNull()
    expect(result!.language).toBe("it") // language preference preserved
    expect(result!.title).toBe("EN title") // but fell back to EN content
    expect(result!.body).toBe("EN body")
  })

  it("falls back to contractType slug when pipelines is empty (onboarding case)", async () => {
    CATALOG_ROWS = [
      {
        slug: "client_onboarding",
        display_name: "Onboarding welcome",
        display_name_translations: null,
        description: "Body",
        description_translations: null,
        status: "active",
        metadata: { priority: 100 },
      },
    ]
    const result = await getWelcomeMessage({
      contractType: "onboarding",
      pipelines: [], // no pipelines — SD created later by wizard
      language: "en",
    })
    expect(result).not.toBeNull()
    expect(result!.slug).toBe("client_onboarding")
  })

  it("returns null when no templates match (caller falls back to legacy copy)", async () => {
    CATALOG_ROWS = []
    const result = await getWelcomeMessage({
      contractType: "renewal", // not mapped
      pipelines: ["State Annual Report"], // intentionally has no welcome
      language: "en",
    })
    expect(result).toBeNull()
  })

  it("returns null on catalog read error (logs, doesn't throw)", async () => {
    CATALOG_ERROR = { message: "boom" }
    const result = await getWelcomeMessage({
      contractType: "formation",
      pipelines: ["Company Formation"],
      language: "en",
    })
    expect(result).toBeNull()
  })
})
