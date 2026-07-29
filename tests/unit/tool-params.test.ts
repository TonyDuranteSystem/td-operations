import { describe, it, expect } from "vitest"
import { z } from "zod"
import { describeZodShape, formatToolParams, typeNameOf, shortDescription } from "@/lib/ai-agent/tool-params"
import { formatToolSearch } from "@/lib/ai-agent/tool-search"

/**
 * The assistant could FIND a tool but never see its settings, so anything behind an
 * unguessed setting was unreachable — Luca's "remove the Tony Durante LLC header"
 * had nowhere to land. These tests pin the settings actually reaching the assistant.
 */

describe("describeZodShape", () => {
  it("reads name, type, requiredness and the author's own description", () => {
    const params = describeZodShape({
      body: z.string().describe("The letter text."),
      letterhead: z
        .string()
        .optional()
        .describe('Sender line at the very top. Defaults to "Tony Durante LLC". Pass "" for a bare document.'),
    })
    expect(params).toHaveLength(2)
    const body = params.find((p) => p.name === "body")!
    expect(body).toMatchObject({ type: "string", required: true })
    const lh = params.find((p) => p.name === "letterhead")!
    expect(lh.required).toBe(false)
    expect(lh.type).toBe("string") // NOT "ZodOptional" — the wrapper tells the model nothing
    // THE WHOLE POINT: the sentence that tells it how to drop the header must survive.
    expect(lh.description).toContain('Pass "" for a bare document')
  })

  it("returns nothing for a tool that takes no settings", () => {
    expect(describeZodShape(undefined)).toEqual([])
    expect(describeZodShape({})).toEqual([])
  })

  it("marks a bare z.any() REQUIRED — isOptional() calls it optional and that is a lie", () => {
    // zod 4 implements isOptional() as safeParse(undefined).success, and z.any()
    // accepts undefined. offer_create's `services` and `cost_summary` are both bare
    // z.any() and both genuinely required; rendering them unstarred told the assistant
    // the two fields that make an offer an offer could be left out.
    const params = describeZodShape({
      services: z.any().describe("The services."),
      cost_summary: z.any().describe("The costs."),
      note: z.any().optional(),
    })
    expect(params.find((p) => p.name === "services")!.required).toBe(true)
    expect(params.find((p) => p.name === "cost_summary")!.required).toBe(true)
    expect(params.find((p) => p.name === "note")!.required).toBe(false)
  })

  it("treats a nullable-but-present field as REQUIRED (you must still supply null)", () => {
    const [p] = describeZodShape({ x: z.string().nullable() })
    expect(p.required).toBe(true)
  })

  it("treats .default() and .nullish() as omittable", () => {
    const params = describeZodShape({
      limit: z.number().default(10),
      note: z.string().nullish(),
    })
    expect(params.every((p) => p.required === false)).toBe(true)
  })
})

describe("typeNameOf", () => {
  it("names plain types", () => {
    expect(typeNameOf(z.string())).toBe("string")
    expect(typeNameOf(z.number())).toBe("number")
    expect(typeNameOf(z.boolean())).toBe("boolean")
  })

  it("unwraps optional/nullable chains to the underlying type", () => {
    expect(typeNameOf(z.string().optional().nullable())).toBe("string")
  })

  it("shows the element type of an array", () => {
    expect(typeNameOf(z.array(z.string()).optional())).toBe("string[]")
  })

  it("ENUMERATES enum choices — guessing the wrong spelling already broke this catalog once", () => {
    const t = typeNameOf(z.enum(["Inbound", "Outbound"]).optional())
    expect(t).toContain("Inbound")
    expect(t).toContain("Outbound")
  })
})

describe("shortDescription", () => {
  it("collapses whitespace and caps length", () => {
    expect(shortDescription("  a\n\n  b  ")).toBe("a b")
    const long = "x".repeat(500)
    const out = shortDescription(long)
    expect(out.length).toBeLessThanOrEqual(201) // 200-char cap + the ellipsis
    expect(out.endsWith("…")).toBe(true)
  })

  it("does NOT cut at the first sentence — the actionable clause is often the last", () => {
    // pdf_create's letterhead text verbatim: the instruction Luca needed is sentence 3.
    const real = 'Sender line at the very top. Defaults to "Tony Durante LLC". Pass "" or null for a bare document with no header.'
    expect(shortDescription(real)).toContain("bare document")
  })

  it("survives an undefined description", () => {
    expect(shortDescription(undefined)).toBe("")
  })
})

describe("formatToolParams", () => {
  it("marks required settings with a star and includes the description", () => {
    const out = formatToolParams([
      { name: "body", type: "string", required: true, description: "The text." },
      { name: "letterhead", type: "string", required: false, description: 'Pass "" for a bare document.' },
    ])
    expect(out).toContain("body* (string)")
    expect(out).toContain("letterhead (string)")
    expect(out).not.toContain("letterhead*")
    expect(out).toContain('Pass "" for a bare document.')
  })

  it("is empty for a tool with no settings, so callers can append unconditionally", () => {
    expect(formatToolParams([])).toBe("")
  })

  it("NEVER drops a required setting to the cap — it shows required ones first", () => {
    // The cap used to slice in declaration order, so a required field declared 13th
    // vanished behind "…and N more" and the assistant was told a mandatory setting did
    // not exist. offer_create declares 35+ params with entity_type at #25, and that
    // field decides SMLLC vs MMLLC — i.e. which agreements get generated.
    const params = [
      ...Array.from({ length: 20 }, (_, i) => ({
        name: `opt${i}`,
        type: "string",
        required: false,
        description: "",
      })),
      { name: "entity_type", type: "string", required: true, description: "SMLLC or MMLLC." },
    ]
    const out = formatToolParams(params)
    expect(out).toContain("entity_type*")
    expect(out).toContain("…and 9 more")
  })

  it("keeps the author's ordering among settings of equal requiredness", () => {
    const out = formatToolParams([
      { name: "bbb", type: "string", required: true, description: "" },
      { name: "aaa", type: "string", required: true, description: "" },
    ])
    expect(out.indexOf("bbb")).toBeLessThan(out.indexOf("aaa"))
  })

  it("caps a huge parameter list and says how many were dropped", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      name: `p${i}`,
      type: "string",
      required: false,
      description: "",
    }))
    const out = formatToolParams(many)
    expect(out).toContain("…and 8 more")
    expect(out.split("\n")).toHaveLength(13) // 12 shown + the "more" line
  })
})

describe("formatToolSearch with settings — the end-to-end fix", () => {
  const catalog = [
    {
      name: "pdf_create",
      description: "Generate a PDF letter and return a download link.",
      params: describeZodShape({
        body: z.string().describe("Letter text."),
        letterhead: z.string().optional().describe('Defaults to "Tony Durante LLC". Pass "" for a bare document.'),
      }),
    },
  ]

  it("shows the letterhead setting when the assistant searches for a PDF tool", () => {
    const out = formatToolSearch(catalog, "pdf")
    expect(out).toContain("pdf_create")
    // Before this change the output stopped at the description and the assistant
    // never learned the header could be switched off.
    expect(out).toContain("letterhead")
    expect(out).toContain('Pass "" for a bare document')
    expect(out).toContain("* = required")
  })

  it("FINDS THE TOOL BY ITS SETTING — Luca's actual words, which name no tool", () => {
    // "letterhead" and "header" appear in no tool NAME and no tool DESCRIPTION in the
    // real catalog; they live only inside pdf_create's parameter text. Ranking on name
    // + description alone scored this query zero on every tool, so the settings block
    // was only ever reached by someone who already thought to search "pdf".
    expect(formatToolSearch(catalog, "remove the Tony Durante LLC header")).toContain("pdf_create")
    expect(formatToolSearch(catalog, "letterhead")).toContain("pdf_create")
  })

  it("ranks a setting match BELOW a name or description match", () => {
    const two = [
      { name: "invoice_create", description: "Create an invoice.", params: [] },
      {
        name: "unrelated_tool",
        description: "Does something else.",
        params: [{ name: "invoice", type: "string", required: false, description: "An invoice ref." }],
      },
    ]
    const out = formatToolSearch(two, "invoice")
    expect(out.indexOf("invoice_create")).toBeLessThan(out.indexOf("unrelated_tool"))
  })

  it("still ranks and still reports a miss plainly when nothing matches", () => {
    const out = formatToolSearch(catalog, "zzzznotathing")
    expect(out).toMatch(/No tools match/)
    expect(out).not.toContain("* = required")
  })

  it("omits the legend for tools that carry no settings", () => {
    const out = formatToolSearch([{ name: "ping", description: "Health check." }], "ping")
    expect(out).toContain("ping")
    expect(out).not.toContain("* = required")
  })
})
