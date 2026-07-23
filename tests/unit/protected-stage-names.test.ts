/**
 * The list of pinned stage names must not fall behind the code.
 *
 * A stage name is normally a label, but in places the code matches one
 * literally to decide a client outcome — most sharply, whether a paying tax
 * client's wizard opens, which fails CLOSED on an exact match. So the Service
 * Catalog editor refuses to rename those stages.
 *
 * That refusal is only as good as the list behind it. This test scans the
 * codebase for stage-name comparisons and fails if it finds a literal nobody
 * declared, which is what stops the list rotting: add a new hardcoded stage name
 * and this tells you to declare it, instead of the editor cheerfully allowing a
 * rename that silently breaks it.
 */

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { PROTECTED_STAGE_NAMES, protectedStageReason } from "@/lib/services/protected-stage-names"

const ROOTS = ["lib", "app"]
const SKIP_DIRS = new Set(["node_modules", ".next", "deprecated"])

/**
 * The sales pipeline works in DEAL stages ("Closed Won", "Paid"), which are a
 * different vocabulary from a service delivery's steps and are not editable
 * from the Service Catalog. Scanning it only produces noise, and a noisy guard
 * is one people learn to ignore.
 */
const SKIP_PATHS = ["app/(dashboard)/pipeline/"]

/**
 * Patterns that mean "this code is comparing a delivery's stage to a fixed
 * name". Deliberately narrow — a broad scan picks up unrelated strings and
 * teaches people to ignore the failure.
 */
const PATTERNS = [
  /\.eq\(\s*["']stage["']\s*,\s*["']([^"']+)["']\s*\)/g,
  /\bstage_name\s*===\s*["']([^"']+)["']/g,
  /\bsd_stage\s*===\s*["']([^"']+)["']/g,
  /\bstage\s*===\s*["']([^"']+)["']/g,
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\./.test(full)) out.push(full)
  }
  return out
}

/** Every stage name the code compares against, with where it was found. */
function findHardcodedStageNames(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const rel = file.replace(/\\/g, "/")
      if (SKIP_PATHS.some(p => rel.includes(p))) continue
      const text = readFileSync(file, "utf8")
      for (const pattern of PATTERNS) {
        for (const m of text.matchAll(pattern)) {
          const name = m[1]
          // Values that are plainly not stage names: type names, statuses that
          // happen to share the shape, single lowercase tokens.
          if (name.length < 4) continue
          if (/^[a-z_]+$/.test(name)) continue
          const at = found.get(name) ?? []
          at.push(file.replace(/\\/g, "/"))
          found.set(name, at)
        }
      }
    }
  }
  return found
}

describe("pinned stage names stay in step with the code", () => {
  it("every stage name the code matches literally is declared", () => {
    const found = findHardcodedStageNames()
    const undeclared: string[] = []
    for (const [name, files] of found) {
      if (!protectedStageReason(name)) {
        undeclared.push(`"${name}" — matched in ${[...new Set(files)].join(", ")}`)
      }
    }

    expect(
      undeclared,
      `These stage names are matched literally in code but are not declared in ` +
        `lib/services/protected-stage-names.ts, so the Service Catalog editor would ` +
        `let an admin rename them and silently break whatever depends on them:\n\n` +
        `${undeclared.join("\n")}\n\n` +
        `Declare each one with a plain-English reason, or stop matching on the name.\n`,
    ).toEqual([])
  })

  it("finds the names we know are hardcoded — proving the scan actually works", () => {
    // If the scan silently matched nothing, the test above would pass vacuously.
    const found = findHardcodedStageNames()
    expect(found.size).toBeGreaterThan(3)
    expect([...found.keys()]).toContain("Data Collection")
  })

  it("a pinned name reports why, and an ordinary one does not", () => {
    expect(protectedStageReason("Wizard Available")).toMatch(/wizard opens/)
    expect(protectedStageReason("  wizard available  ")).toBeTruthy() // case/padding
    expect(protectedStageReason("CAA Review")).toBeNull()
    expect(protectedStageReason("Documents Received")).toBeNull()
  })

  it("every declared name carries a reason an admin can act on", () => {
    for (const p of PROTECTED_STAGE_NAMES) {
      expect(p.name.trim().length, `${p.name} has no name`).toBeGreaterThan(0)
      expect(p.because.length, `${p.name} has no reason`).toBeGreaterThan(15)
    }
  })
})
