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

const ROOTS = ["lib", "app", "components"]
const SKIP_DIRS = new Set(["node_modules", ".next", "deprecated"])
const ALLOWLIST = new Set(["lib/td-address.ts"])
const STREET = "11125 Park Blvd"

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(full)) out.push(full)
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
          // Strip comments first — an EXAMPLE in a comment is not a delivery
          // path, whether the comment starts the line or trails a declaration.
          const code = line.split("//")[0].trim()
          if (!code.includes(STREET)) return
          if (code.startsWith("*") || code.startsWith("/*")) return
          offenders.push(`${rel}:${i + 1}  ${code.slice(0, 90)}`)
        })
      }
    }
    expect(offenders, `Hardcoded office address. Import from lib/td-address.\n\n${offenders.join("\n")}\n`).toEqual([])
  })
})
