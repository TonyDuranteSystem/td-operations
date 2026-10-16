import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: { from: vi.fn() } }))

import {
  BUILTIN_WAIT_KINDS,
  RESERVED_WAIT_SLUGS,
  UNSET,
  WAIT_BEHAVIOURS,
  assembleWaitKinds,
  catalogWaitKind,
  defaultWaitKinds,
  firstKindWith,
  phraseOf,
  waitKindOf,
} from "@/lib/open-services/types"
import {
  danglingWarning,
  isUsableKindSlug,
  parseCatalogWaitKinds,
  resolveWho,
  slugFromName,
  waitingOnOptions,
  waitingOnSaveProblem,
  type CatalogKindRow,
} from "@/lib/open-services/wait-kinds"
import { stepSettingsProblems } from "@/lib/services/step-settings"
import { waitingOnChoiceProblems } from "@/lib/services/stages"

/**
 * "Waiting on" kinds (dev job 40235e3c): the built-in kinds + the catalog list. Pure rules only — names below are invented
 * test names; the two seeded slugs (outside, date) are the real stored values they must keep matching.
 */

const row = (slug: string, over: Partial<CatalogKindRow> = {}): CatalogKindRow => ({
  slug,
  display_name: slug,
  status: "active",
  metadata: { behaviour: "other" },
  ...over,
})

describe("the built-in and default kinds", () => {
  it("the defaults are the five slugs that were stored before the list became data", () => {
    expect(defaultWaitKinds().map(k => k.slug)).toEqual(["us", "client", "outside", "date", "none"])
  })

  it("the built-ins carry the behaviours the engine keys off, and the reserved names cover them", () => {
    expect(BUILTIN_WAIT_KINDS.us.behaviour).toBe("ours")
    expect(BUILTIN_WAIT_KINDS.client.behaviour).toBe("client")
    expect(BUILTIN_WAIT_KINDS.none.behaviour).toBe("none")
    for (const s of ["us", "client", "none", UNSET]) expect(RESERVED_WAIT_SLUGS).toContain(s)
    expect(new Set(WAIT_BEHAVIOURS).size).toBe(5)
  })

  it("order: us, the client, someone else (before dates, then by name), nobody", () => {
    const kinds = assembleWaitKinds([
      catalogWaitKind("date", "A date", "date"),
      catalogWaitKind("the_irs", "The IRS", "other"),
      catalogWaitKind("a_bank", "A bank", "other"),
      catalogWaitKind("the_day", "Court day", "date"),
    ])
    expect(kinds.map(k => k.slug)).toEqual(["us", "client", "a_bank", "the_irs", "date", "the_day", "none"])
  })

  it("a catalog kind speaks in plain words: 'Waiting on the IRS', 'Waiting on an outside office', a name that is not an article phrase stays as is", () => {
    expect(phraseOf("The IRS")).toBe("the IRS")
    expect(phraseOf("An outside office")).toBe("an outside office")
    expect(phraseOf("A date")).toBe("a date")
    expect(phraseOf("Banco Sella")).toBe("Banco Sella")
    expect(phraseOf("Theodora")).toBe("Theodora")
    const k = catalogWaitKind("the_irs", "The IRS", "other")
    expect(k).toMatchObject({ chip: "The IRS", group: "Waiting on the IRS", phrase: "the IRS", tip: "Waiting on the IRS", builtin: false, retired: false })
  })
})

describe("parseCatalogWaitKinds", () => {
  it("keeps active rows, keeps deprecated rows as retired (so steps that use them keep their meaning), ignores draft rows", () => {
    const { kinds, problems } = parseCatalogWaitKinds([
      row("outside", { display_name: "An outside office" }),
      row("old_bank", { display_name: "Old bank", status: "deprecated" }),
      row("maybe", { status: "draft" }),
      row("odd", { status: "exception_only" }),
    ])
    expect(problems).toEqual([])
    expect(kinds.map(k => [k.slug, k.retired])).toEqual([["outside", false], ["old_bank", true]])
  })

  it("a row with no behaviour (added through the generic catalog tool) is 'someone else'; 'date' must be said", () => {
    const { kinds } = parseCatalogWaitKinds([row("the_bank", { metadata: {} }), row("court_day", { metadata: { behaviour: "date" } }), row("nometa", { metadata: null })])
    expect(kinds.find(k => k.slug === "the_bank")!.behaviour).toBe("other")
    expect(kinds.find(k => k.slug === "court_day")!.behaviour).toBe("date")
    expect(kinds.find(k => k.slug === "nometa")!.behaviour).toBe("other")
  })

  it("skips and REPORTS a row that cannot be used: reserved or badly written slug, or a behaviour a list kind cannot have", () => {
    const { kinds, problems } = parseCatalogWaitKinds([
      row("us"), row("unset"), row("Bad Slug"), row("__proto__"), row("ok_kind"),
      row("pretend", { metadata: { behaviour: "ours" } }),
      row("pretend2", { metadata: { behaviour: "client" } }),
      row("junk", { metadata: { behaviour: "banana" } }),
    ])
    expect(kinds.map(k => k.slug)).toEqual(["ok_kind"])
    expect(problems).toHaveLength(7)
    expect(problems.join(" ")).toContain("pretend")
  })

  it("a blank name falls back to the slug", () => {
    expect(parseCatalogWaitKinds([row("x_kind", { display_name: "   " })]).kinds[0].name).toBe("x_kind")
  })
})

describe("slugs", () => {
  it("a name becomes a safe lower-case slug; accents fold; nothing usable gives an empty slug", () => {
    expect(slugFromName("The IRS")).toBe("the_irs")
    expect(slugFromName("Società  Sella!")).toBe("societa_sella")
    expect(slugFromName("  --  ")).toBe("")
    expect(slugFromName("x".repeat(100))).toHaveLength(40)
  })

  it("reserved and badly shaped slugs are not usable", () => {
    for (const s of ["us", "client", "none", "unset", "", "1abc", "A", "a b", "a,b", "a~b", "é"]) expect(isUsableKindSlug(s)).toBe(false)
    for (const s of ["the_irs", "outside", "date", "a"]) expect(isUsableKindSlug(s)).toBe(true)
  })
})

describe("resolveWho", () => {
  const kinds = assembleWaitKinds([catalogWaitKind("outside", "An outside office", "other"), catalogWaitKind("old", "Old", "other", true)])
  it("a known kind resolves to its slug, retired ones included", () => {
    expect(resolveWho(kinds, "outside", false)).toEqual({ who: "outside", dangling: null })
    expect(resolveWho(kinds, "old", false)).toEqual({ who: "old", dangling: null })
    expect(resolveWho(kinds, "client", false)).toEqual({ who: "client", dangling: null })
  })

  it("no setting is 'unset'; a setting whose kind no longer exists is 'unset' AND reported, never silent", () => {
    expect(resolveWho(kinds, null, false)).toEqual({ who: UNSET, dangling: null })
    expect(resolveWho(kinds, "  ", false)).toEqual({ who: UNSET, dangling: null })
    expect(resolveWho(kinds, "gone", false)).toEqual({ who: UNSET, dangling: "gone" })
  })

  it("the done step wins and resolves to the kind with the behaviour 'none', not to a typed slug", () => {
    expect(resolveWho(kinds, "outside", true)).toEqual({ who: "none", dangling: null })
    expect(resolveWho(kinds, "gone", true)).toEqual({ who: "none", dangling: null })
    expect(firstKindWith(kinds, "none")?.slug).toBe("none")
  })

  it("the warning names the count and up to three distinct kinds", () => {
    const w = danglingWarning(5, ["a", "a", "b", "c", "d"], "job")
    expect(w).toContain("5 open job(s)")
    expect(w).toContain('"a", "b", "c"')
    expect(w).not.toContain('"d"')
  })
})

describe("waitingOnSaveProblem: a NEW choice must be built in or active; one the step already has is never refused", () => {
  const kinds = assembleWaitKinds([catalogWaitKind("outside", "An outside office", "other"), catalogWaitKind("old", "Old bank", "other", true)])
  it("empty and unchanged values are fine, even when the kind was retired or removed", () => {
    expect(waitingOnSaveProblem(kinds, null, "outside")).toBeNull()
    expect(waitingOnSaveProblem(kinds, "", "outside")).toBeNull()
    expect(waitingOnSaveProblem(kinds, "old", "old")).toBeNull()
    expect(waitingOnSaveProblem(kinds, "gone", "gone")).toBeNull()
  })

  it("a changed value must be a built-in or an active kind; a retired or unknown one is refused in plain words", () => {
    expect(waitingOnSaveProblem(kinds, "us", "outside")).toBeNull()
    expect(waitingOnSaveProblem(kinds, "outside", null)).toBeNull()
    expect(waitingOnSaveProblem(kinds, "old", null)).toContain("retired")
    expect(waitingOnSaveProblem(kinds, "staff", null)).toContain("not in the waiting-on list")
  })
})

describe("waitingOnOptions (the dropdown)", () => {
  const kinds = assembleWaitKinds([catalogWaitKind("outside", "An outside office", "other"), catalogWaitKind("old", "Old bank", "other", true)])
  it("offers every non-retired kind, in order", () => {
    expect(waitingOnOptions(kinds, null).map(o => o.value)).toEqual(["us", "client", "outside", "none"])
  })
  it("keeps showing the step's CURRENT value when it is retired or gone, so the dropdown never lies and a save keeps it", () => {
    expect(waitingOnOptions(kinds, "old").at(-1)).toEqual({ value: "old", label: "Old bank (retired)" })
    expect(waitingOnOptions(kinds, "gone").at(-1)).toEqual({ value: "gone", label: "gone (no longer in the list)" })
    expect(waitingOnOptions(kinds, "outside")).toHaveLength(4)
  })
})

describe("stepSettingsProblems keeps the client rule through the built-in client kind", () => {
  it("an 'action required' step must wait on the client, whatever kinds exist", () => {
    const p = stepSettingsProblems("ITIN", [{ stage_name: "Client Signing", waiting_on: "outside" }])
    expect(p[0]).toContain("must be waiting on the client")
    expect(stepSettingsProblems("ITIN", [{ stage_name: "Client Signing", waiting_on: "client" }])).toEqual([])
  })
})

describe("the lookup helpers", () => {
  it("waitKindOf finds by slug and returns null for unset, unknown, and prototype names", () => {
    const kinds = defaultWaitKinds()
    expect(waitKindOf(kinds, "client")?.slug).toBe("client")
    expect(waitKindOf(kinds, "unset")).toBeNull()
    expect(waitKindOf(kinds, "__proto__")).toBeNull()
    expect(waitKindOf(kinds, "constructor")).toBeNull()
    expect(waitKindOf(kinds, null)).toBeNull()
  })
})

describe("waitingOnChoiceProblems (the save path)", () => {
  const kinds = assembleWaitKinds([catalogWaitKind("outside", "An outside office", "other"), catalogWaitKind("old", "Old bank", "other", true)])

  it("reads nothing and refuses nothing when no choice changed (kinds are not even loaded)", async () => {
    // `kinds` omitted on purpose: if the function tried to load them it would hit the mocked database and throw
    await expect(waitingOnChoiceProblems([{ name: "A", value: "old", stored: "old" }, { name: "B", value: null, stored: "outside" }, { name: "C", value: undefined, stored: null }])).resolves.toEqual([])
  })

  it("a retired kind on a SIBLING step never blocks an unrelated edit", async () => {
    const steps = [
      { name: "Mailed", value: "old", stored: "old" },
      { name: "Name Collection", value: "client", stored: "client" },
    ]
    await expect(waitingOnChoiceProblems(steps, kinds)).resolves.toEqual([])
  })

  it("a changed choice to a retired or unknown kind is refused, one plain sentence per step", async () => {
    const out = await waitingOnChoiceProblems(
      [{ name: "A", value: "old", stored: "us" }, { name: "B", value: "staff", stored: null }, { name: "C", value: "outside", stored: "us" }],
      kinds,
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toContain('"A"')
    expect(out[0]).toContain("retired")
    expect(out[1]).toContain('"B"')
    expect(out[1]).toContain("not in the waiting-on list")
  })
})
