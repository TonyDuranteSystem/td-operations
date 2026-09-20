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
  // NO banking_submissions entry — both banking-form pages (the bare
  // email-gated page and the [code] page) moved fully server-side
  // (service key) 2026-09-20: /api/banking-form/[token]/data (fetch,
  // view-tracking, final submit) and /api/banking-form/[token]/gate (the
  // pre-code email gate, which used to fetch the FULL row before checking
  // anything). Anon GRANT revoke is the next step, same as ss4/itin.
  // NO closure_submissions entry — both closure-form pages (the bare
  // email-gated page and the [code] page) moved fully server-side (service
  // key) 2026-09-20: /api/closure-form/[token]/data (fetch, view-tracking,
  // final submit) and /api/closure-form/[token]/gate (the pre-code email
  // gate, which used to fetch the FULL row — including the real access_code
  // and owner_email — before any email was even checked).
  contracts: ["INSERT", "UPDATE"],
  form_8832_applications: ["SELECT", "UPDATE"],
  // NO formation_submissions entry — both formation-form pages moved fully
  // server-side (service key) 2026-09-20, same shape as tax_return_submissions:
  // /api/formation-form/[token]/data + /api/formation-form/[token]/gate.
  // NO itin_submissions entry — the ITIN wizard and its pre-code email gate no
  // longer read or write this table with the anon key. Both moved fully
  // server-side (service key) this session: /api/itin-form/[token]/data
  // (fetch, view-tracking, final submit) and /api/itin-form/[token]/gate
  // (the email-gate landing page, which used to fetch the FULL row —
  // including the real access_code — before any email was even checked).
  // This closes the ITIN half of the anon-SELECT/UPDATE exposure found and
  // fixed 2026-09-19 (dev job 527b2377); the anon GRANT itself is the next
  // step, once this test confirms zero remaining call sites.
  //
  // SELECT dropped 2026-07-24: the lease signing pages no longer read the row with
  // the anon key — they call the server route /api/lease/[token]/fetch, which
  // verifies the code and returns a whitelist (lib/lease/public-view). anon SELECT
  // is revoked to id-only by 20260724-1900-lease-close-public-read.sql. UPDATE
  // REMAINS because the signing WRITE is still browser-side; moving it server-side
  // and revoking this is the tracked step 2 (mirrors the OA).
  lease_agreements: ["UPDATE"],
  member_info_requests: ["SELECT"],
  // NO oa_agreements / oa_signatures entry — the browser no longer writes EITHER
  // OA table with the anon key. The canonical `[token]/[code]` page moved signing
  // fully server-side (/api/operating-agreement/[token]/sign, service key), and
  // as of 2026-08-11 the LEGACY bare-token page is a pure redirect — its old
  // browser-side anon write (html2pdf screenshot + status/pdf update) is gone.
  // That closes the last anon-write hole and unblocks revoking the anon UPDATE
  // grant on oa_agreements (migration 20260811-2100). The signed-oa BUCKET stays
  // anon-reachable (the canonical page still downloads signature images from it).
  offers: ["SELECT", "UPDATE"],
  // NO onboarding_submissions entry — both onboarding-form pages moved fully
  // server-side (service key) 2026-09-20, same shape as formation_submissions
  // above: /api/onboarding-form/[token]/data + /api/onboarding-form/[token]/gate.
  signature_requests: ["SELECT", "UPDATE"],
  // NO ss4_applications entry — the SS-4 signing page no longer reads or
  // writes this table with the anon key (fetch, view-tracking, and the
  // signature write all moved to /api/ss4/[token]/data, service key). Same
  // 2026-09-19 fix as itin_submissions above. The PDF and upload-signed
  // routes already used the service key before this change and are
  // untouched. Anon GRANT revoke is the next step.
  // NO tax_quote_submissions entry — the bare tax-quote page moved fully
  // server-side (service key) 2026-09-20: /api/tax-quote/[token]/data
  // (fetch, view-tracking, final submit). This table has no access_code
  // column at all — the token itself was always the only secret — so this
  // route does not use verifyTokenAccess, unlike every other converted form.
  // NO tax_return_submissions entry — both tax-form pages moved fully
  // server-side (service key) 2026-09-20, same shape and same reason as
  // banking_submissions above: /api/tax-form/[token]/data +
  // /api/tax-form/[token]/gate.
}

/**
 * Storage buckets the browser reaches with the anon key. Tracked because
 * locking a table while its bucket stays open is half a fix — the signed PDFs
 * and uploads live here.
 */
// signed-contracts / signed-leases were REMOVED 2026-08-01 (dev_task 97177e49): the
// client download now goes through a token-checked server route that signs the exact
// recorded path (/api/offer/[token]/contract-pdf, /api/lease/[token]/signed-pdf), so
// the browser no longer reaches those buckets with the anon storage client. The
// signed-PDF UPLOADS still POST to object/<bucket> via raw fetch (INSERT), which this
// detector intentionally does not count (it only tracks `.storage.from(...)`).
const ANON_REACHABLE_BUCKETS = [
  "banking-uploads",
  "closure-uploads",
  "formation-uploads",
  "onboarding-uploads",
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
  }, 20000) // full-repo AST scan (500+ files) — the default 5s budget is marginal under full-suite parallel load, not a correctness issue

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
  }, 20000) // full-repo AST scan again — see timeout note above

  it("the storage buckets reachable with the anon key match the recorded list", () => {
    const found = new Set<string>()
    for (const { file, source } of files) {
      for (const b of findAnonTableUsage(source, file).buckets) found.add(b.bucket)
    }
    expect(
      Array.from(found).sort(),
      "Anon-reachable storage buckets changed. These hold signed PDFs and client uploads — locking a table while its bucket stays open is half a fix.",
    ).toEqual([...ANON_REACHABLE_BUCKETS].sort())
  }, 20000) // full-repo AST scan again — see timeout note above
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
