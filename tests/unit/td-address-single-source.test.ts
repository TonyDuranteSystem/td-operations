/**
 * The office address must exist in exactly ONE place.
 *
 * It was hand-written in eleven source files, and a comment in one of them
 * claimed it lived in two others and named the wrong ones. If the office moves,
 * whoever trusts that comment updates a few sites and misses the rest — and a
 * client posts their ORIGINAL wet-ink W-7 and passport copies to an address
 * that no longer exists. Those do not come back.
 *
 * IF THIS FAILS: you hardcoded the address. Import it from lib/td-address
 * instead, choosing the export that matches your PURPOSE (where clients post to
 * us / TD's CAA identity on the W-7 / a stand-in for a client company with no
 * address on file). Tests are exempt — pinning the literal there is a
 * deliberate tripwire that fires if the value changes.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

// `scripts/migrations` is in scope because the address ALSO lives in seeded
// DATABASE content, which the code-only walk could not see: the ITIN Client
// Signing notice carried a hardcoded copy in a migration, and that copy had
// already drifted ("Suite" with no comma, "Florida" spelled out) while every
// code site was correct. The guard was green over a live duplicate. Only
// `migrations` is walked, not all of `scripts` — the sandbox seed files are
// generated dumps, so an address in one is an artifact nobody can fix by
// importing a constant.
const ROOTS = ["lib", "app", "components", "scripts/migrations"]
const SKIP_DIRS = new Set(["node_modules", ".next", "deprecated"])
const ALLOWLIST = new Set([
  "lib/td-address.ts",
  // Applied historical migration, deliberately left byte-identical: rewriting
  // an already-applied migration means "what production received" no longer
  // matches the file, with no trace. It carries a SUPERSEDED banner instead,
  // and the row it seeded is now the {td_mailing_address} token in both
  // databases. Anything NEWER than it is still guarded.
  "scripts/migrations/20260615-2100-itin-workspace-layouts.sql",
])
const STREET = "11125 Park Blvd"

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|sql)$/.test(full)) out.push(full)
  }
  return out
}

describe("office address single-source guard", () => {
  it("nothing hardcodes the office address outside lib/td-address", () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const rel = file.replace(/\\/g, "/")
        if (ALLOWLIST.has(rel)) continue
        readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          if (!line.includes(STREET)) return
          // A comment may only EXONERATE, never hide. The old rule split the
          // line on the comment marker and tested what was left — so a marker
          // appearing EARLIER on the line blanked the rest, and a genuinely
          // hardcoded address after it passed silently. A `--` inside a SQL
          // string literal does exactly that. A guard that lies is worse than
          // no guard.
          //
          // The address is an example only if a REAL comment opens before it.
          // A marker sitting inside a string literal is not a real comment, so
          // the quote count before it must be even.
          const code = line.trim()
          if (code.startsWith("*") || code.startsWith("/*")) return
          const marker = rel.endsWith(".sql") ? "--" : "//"
          const addrAt = line.indexOf(STREET)
          let commentAt = -1
          for (let at = line.indexOf(marker); at !== -1; at = line.indexOf(marker, at + 1)) {
            const before = line.slice(0, at)
            const quotes = (before.match(/(?<!\\)["'`]/g) ?? []).length
            if (quotes % 2 === 0) { commentAt = at; break } // outside any string
          }
          if (commentAt !== -1 && commentAt < addrAt) return
          offenders.push(`${rel}:${i + 1}  ${code.slice(0, 90)}`)
        })
      }
    }
    expect(offenders, `Hardcoded office address. Import from lib/td-address.\n\n${offenders.join("\n")}\n`).toEqual([])
  })
})
