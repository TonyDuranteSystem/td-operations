import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * The Booking-link rules AS PRODUCTION BUILDS THEM (R115). On 2026-11-08 Next 14's production compiler (SWC, minifier on) silently changed a regex that every unit test
 * and the sandbox read fine, because those run the source as written. The Booking engine reads text that comes from outside (a visitor-edited address, a dirty language
 * value, the Calendly tag) with regexes, so this compiles the pure files with Next's own compiler, minified, for the targets that matter, and runs the COMPILED code.
 */
async function compile(file: string, target: "es2017" | "es5", requires: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const source = readFileSync(path.join(process.cwd(), file), "utf8")
  const { transform } = await import("next/dist/build/swc")
  const out = await transform(source, {
    filename: path.basename(file),
    jsc: { parser: { syntax: "typescript" }, target, minify: { compress: true, mangle: true } },
    module: { type: "commonjs" },
    minify: true,
    sourceMaps: false,
  })
  const mod = { exports: {} as Record<string, unknown> }
  new Function("module", "exports", "require", out.code)(mod, mod.exports, (id: string) => {
    if (id in requires) return requires[id]
    throw new Error(`unexpected import in ${file}: ${id}`)
  })
  return mod.exports
}

describe("booking rules, compiled the way production compiles them", () => {
  for (const target of ["es2017", "es5"] as const) {
    it(`target ${target}: language, kind names, link ids, tag, match, destination, errors`, async () => {
      const lang = (await compile("lib/booking-links/language.ts", target)).normalizeLeadLanguage as (v: unknown) => string | null
      for (const v of ["Italiano", "it", "Italian / Englis"]) expect(lang(v)).toBe("Italian")
      for (const v of ["en", "English", "Inglese"]) expect(lang(v)).toBe("English")
      for (const v of ["", "Español", "entry", "itinerary", null]) expect(lang(v)).toBeNull()

      const kinds = await compile("lib/booking/kinds.ts", target)
      expect((kinds.kindNameKey as (n: string) => string)("  Clïent  Å ")).toBe("client a")
      expect((kinds.kindNameTaken as (n: string, l: string[]) => boolean)("Cliënt", ["Client"])).toBe(true)

      const idMod = await compile("lib/booking-links/id.ts", target, { "node:crypto": await import("node:crypto") })
      const isId = idMod.isStrictLinkId as (v: unknown) => boolean
      const made = (idMod.newLinkId as () => string)()
      expect(made).toHaveLength(22)
      expect(isId(made)).toBe(true)
      expect(isId("A".repeat(21) + "!")).toBe(false)
      expect(isId("llc formation near me")).toBe(false)

      const tag = (await compile("lib/booking-links/tag.ts", target, { "@/lib/booking-links/id": idMod })).extractLinkTag as (p: unknown) => { linkId: string | null; oldInvitee: string | null }
      const t = tag({ payload: { uri: "u", old_invitee: "o", tracking: { utm_term: made } } })
      expect(t.linkId).toBe(made)
      expect(t.oldInvitee).toBe("o")
      expect(tag({ payload: { tracking: { utm_term: "not an id" } } }).linkId).toBeNull()

      const match = await compile("lib/booking-links/match.ts", target)
      const decide = match.decideLinkMatch as (i: unknown) => { action: string }
      const row = { status: "open", once: true, revoked_at: null, expires_at: null, claimed_invitee_uri: null, claimed_email: null, effects_done_at: null, person_emails: ["m@x.com"] }
      const base = { inviteeUri: "i1", oldInvitee: null, now: new Date("2026-11-13T12:00:00Z") }
      expect(decide({ ...base, row, bookerEmail: " M@X.COM " }).action).toBe("claim")
      expect(decide({ ...base, row, bookerEmail: "other@y.com" }).action).toBe("mismatch")

      const dest = (await compile("lib/booking-links/destination.ts", target)).buildDestination as (u: string, p: unknown) => string | null
      expect(dest("https://calendly.com/d/abc/x", { linkId: made, name: "A B", email: "a@b.com" })).toContain(`utm_term=${made}`)
      expect(dest("https://calendly.com.evil.com/x", { linkId: made })).toBeNull()
      expect(dest("http://calendly.com/x", { linkId: made })).toBeNull()

      const miss = await compile("lib/booking-links/missing-table.ts", target)
      expect((miss.isMissingTable as (e: unknown) => boolean)({ message: 'relation "booking_links" does not exist' })).toBe(true)
      expect((miss.isMissingTable as (e: unknown) => boolean)({ message: "Could not find the table 'public.booking_links' in the schema cache" })).toBe(true)
      expect((miss.isMissingTable as (e: unknown) => boolean)({ code: "23505" })).toBe(false)
    })
  }
})
