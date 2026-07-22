/**
 * THE ANON GRANT CONTRACT — the guard that would have stopped the 2026-07-21 break.
 *
 * A migration revoked UPDATE on ss4_applications and form_8832_applications from
 * `anon` because a text search for `supabasePublic.from(` found no writes. Both
 * signing pages alias the client first (`const supabase = supabasePublic`), so
 * the search was blind, the grant was pulled, and clients saw "Signed" while the
 * signature was never recorded.
 *
 * This test derives, from the real TypeScript AST, exactly which privileges the
 * BROWSER needs from the `anon` role — and fails if that set drifts from the
 * contract recorded below.
 *
 * ── IF THIS TEST FAILS ────────────────────────────────────────────────────────
 * You changed what the browser does with the anon key. Before you touch any
 * GRANT/REVOKE:
 *   • privilege ADDED   → the database must grant it, or that page breaks
 *                         (silently — these pages do not check for errors).
 *   • privilege REMOVED → only then is it safe to revoke.
 * Update REQUIRED_ANON_PRIVILEGES in the same change, deliberately.
 *
 * ⛔ NEVER revoke an `anon` privilege on the strength of a grep. Run this.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"
import {
  findAnonTableUsage,
  summariseAnonUsage,
  privilegeFor,
  type AnonOp,
} from "@/lib/security/anon-usage"

const ROOT = process.cwd()

/**
 * What the browser genuinely requires. Derived from the code, not guessed.
 * `contracts` is the only table the browser INSERTs into (offer signing).
 * `member_info_requests` is read-only from the browser — its writes go through
 * a service-key route.
 */
const REQUIRED_ANON_PRIVILEGES: Record<string, string[]> = {
  annual_agreements: ["SELECT", "UPDATE"],
  banking_submissions: ["SELECT", "UPDATE"],
  closure_submissions: ["SELECT", "UPDATE"],
  contracts: ["INSERT", "UPDATE"],
  form_8832_applications: ["SELECT", "UPDATE"],
  formation_submissions: ["SELECT", "UPDATE"],
  itin_submissions: ["SELECT", "UPDATE"],
  lease_agreements: ["SELECT", "UPDATE"],
  member_info_requests: ["SELECT"],
  // The OA pages no longer READ with the anon key: both go through
  // /api/operating-agreement/[token]/fetch, which verifies the access code
  // server-side and returns a whitelist (lib/oa/public-view.ts). SELECT is
  // revoked by 20260722-0100-oa-close-public-read.sql.
  // UPDATE remains ONLY because the signing writes are still browser-side —
  // moving them server-side and revoking this is the tracked follow-up. Until
  // then an attacker who guesses a token can still corrupt an agreement.
  oa_agreements: ["UPDATE"],
  oa_signatures: ["UPDATE"],
  offers: ["SELECT", "UPDATE"],
  onboarding_submissions: ["SELECT", "UPDATE"],
  signature_requests: ["SELECT", "UPDATE"],
  ss4_applications: ["SELECT", "UPDATE"],
  tax_quote_submissions: ["SELECT", "UPDATE"],
  tax_return_submissions: ["SELECT", "UPDATE"],
}

/**
 * Storage buckets the browser reaches with the anon key. Tracked because
 * locking a table while its bucket stays open is half a fix — the signed PDFs
 * and uploads live here.
 */
const ANON_REACHABLE_BUCKETS = [
  "banking-uploads",
  "closure-uploads",
  "formation-uploads",
  "onboarding-uploads",
  "signed-contracts",
  "signed-leases",
  "signed-oa",
  "tax-form-uploads",
]

function sourceFiles(): Array<{ file: string; source: string }> {
  const out = execSync(
    `find app components lib -name "*.ts" -o -name "*.tsx"`,
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  )
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(f => ({ file: f, source: readFileSync(join(ROOT, f), "utf8") }))
}

describe("anon grant contract", () => {
  const files = sourceFiles()

  it("scans a plausible number of files (guards against a broken file list)", () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it("every .from() on an anon client resolves to a known operation", () => {
    const unresolved: string[] = []
    for (const { file, source } of files) {
      for (const u of findAnonTableUsage(source, file).unknownOps) {
        unresolved.push(`${file}:${u.line} → ${u.table}`)
      }
    }
    expect(
      unresolved,
      `Unreadable anon call site(s). A site this tool cannot classify must NOT be treated as "no usage" — that is exactly how the 2026-07-21 break happened. Teach lib/security/anon-usage.ts to read it:\n${unresolved.join("\n")}`,
    ).toEqual([])
  })

  it("the privileges the browser needs match the recorded contract", () => {
    const summary = summariseAnonUsage(files)
    const actual: Record<string, string[]> = {}
    for (const [table, ops] of Array.from(summary)) {
      actual[table] = Array.from(new Set(Array.from(ops.keys()).map(o => privilegeFor(o as AnonOp)))).sort()
    }

    const tables = Array.from(new Set([...Object.keys(actual), ...Object.keys(REQUIRED_ANON_PRIVILEGES)])).sort()
    const drift: string[] = []
    for (const t of tables) {
      const have = (actual[t] ?? []).join(",")
      const want = (REQUIRED_ANON_PRIVILEGES[t] ?? []).sort().join(",")
      if (have !== want) {
        const sites = summary.get(t)
        const where = sites
          ? Array.from(sites.entries()).map(([op, locs]) => `      ${op}: ${locs.join(", ")}`).join("\n")
          : "      (no call sites)"
        drift.push(`  ${t}\n    code needs: [${have || "none"}]\n    contract  : [${want || "none"}]\n${where}`)
      }
    }

    expect(
      drift,
      `The browser's anon privilege needs changed.\n\n${drift.join("\n\n")}\n\nBefore changing any GRANT/REVOKE: a privilege ADDED must exist in the database or that page breaks SILENTLY (these pages do not check errors). Only a privilege REMOVED here is safe to revoke. Then update REQUIRED_ANON_PRIVILEGES deliberately.`,
    ).toEqual([])
  })

  it("the storage buckets reachable with the anon key match the recorded list", () => {
    const found = new Set<string>()
    for (const { file, source } of files) {
      for (const b of findAnonTableUsage(source, file).buckets) found.add(b.bucket)
    }
    expect(
      Array.from(found).sort(),
      "Anon-reachable storage buckets changed. These hold signed PDFs and client uploads — locking a table while its bucket stays open is half a fix.",
    ).toEqual([...ANON_REACHABLE_BUCKETS].sort())
  })
})

describe("the detector sees through the pattern that caused the incident", () => {
  it("finds writes made through an aliased client", () => {
    const src = `
      import { supabasePublic } from "@/lib/supabase/public-client"
      export default function Page() {
        const load = async () => {
          const supabase = supabasePublic
          const { data } = await supabase.from("ss4_applications").select("*").eq("token", t).single()
          await supabase.from("ss4_applications").update({ status: "signed" }).eq("id", data.id)
        }
      }`
    const r = findAnonTableUsage(src, "page.tsx")
    expect(r.usages.filter(u => u.op === "update").map(u => u.table)).toEqual(["ss4_applications"])
    expect(r.usages.some(u => u.via === "alias")).toBe(true)
  })

  it("a plain text search for the direct chain would MISS that write (the original bug)", () => {
    const src = `const supabase = supabasePublic\nawait supabase.from("ss4_applications").update({ x: 1 })`
    expect(src.includes("supabasePublic.from(")).toBe(false) // the old check found nothing
    const r = findAnonTableUsage(
      `import { supabasePublic } from "@/lib/supabase/public-client"\n${src}`,
      "page.tsx",
    )
    expect(r.usages.some(u => u.op === "update")).toBe(true) // the new check finds it
  })

  it("finds writes through a hand-rolled anon client", () => {
    const src = `
      import { createClient } from "@supabase/supabase-js"
      const SB = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
      await SB.from("offers").update({ status: "signed" }).eq("token", t)`
    const r = findAnonTableUsage(src, "page.tsx")
    expect(r.usages).toEqual([
      expect.objectContaining({ table: "offers", op: "update", via: "inline-anon-client" }),
    ])
  })

  it("does NOT count the service-key client as anon", () => {
    const src = `
      import { supabaseAdmin } from "@/lib/supabase-admin"
      await supabaseAdmin.from("ss4_applications").update({ status: "signed" })`
    expect(findAnonTableUsage(src, "route.ts").usages).toEqual([])
  })

  it("classifies .storage.from() as a bucket, never as a table", () => {
    const src = `
      import { supabasePublic } from "@/lib/supabase/public-client"
      await supabasePublic.storage.from("signed-contracts").download(p)`
    const r = findAnonTableUsage(src, "page.tsx")
    expect(r.usages).toEqual([])
    expect(r.buckets.map(b => b.bucket)).toEqual(["signed-contracts"])
  })

  it("sees a write split across multiple lines", () => {
    const src = `
      import { supabasePublic } from "@/lib/supabase/public-client"
      await supabasePublic
        .from("tax_return_submissions")
        .update({
          status: "completed",
        })
        .eq("token", token)`
    expect(findAnonTableUsage(src, "page.tsx").usages).toEqual([
      expect.objectContaining({ table: "tax_return_submissions", op: "update" }),
    ])
  })
})
