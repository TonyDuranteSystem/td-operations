import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { SIGNED_KEY_PREFIXES, NOT_SIGNED_KEY_PREFIXES } from "@/lib/crm-store/signed-prefixes"

const ROOT = join(__dirname, "..", "..")

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".next") continue
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n)) out.push(p)
  }
  return out
}

/** every caller-key prefix passed to the three "save a document" helpers, with the helper's name */
function producers(): Array<{ helper: string; prefix: string; file: string }> {
  const found: Array<{ helper: string; prefix: string; file: string }> = []
  for (const f of [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app"))]) {
    const src = readFileSync(f, "utf8")
    const re = /\b(saveSignedPdfForAccount|saveDocumentForAccount|saveDocumentForContact)\(\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      // the call's object literal: up to the first closing "})" after the call start
      const end = src.indexOf("})", m.index)
      const body = src.slice(m.index, end === -1 ? m.index + 1200 : end)
      const k = /callerKey:\s*`([a-z0-9-]+:)/.exec(body)
      if (k) found.push({ helper: m[1], prefix: k[1], file: f.replace(ROOT, "") })
    }
  }
  return found
}

describe("signed caller-key prefixes", () => {
  const all = producers()
  const listed = new Set<string>([...SIGNED_KEY_PREFIXES, ...Object.keys(NOT_SIGNED_KEY_PREFIXES)])

  it("finds the known producers (the scan itself works)", () => {
    const prefixes = new Set(all.map((p) => p.prefix))
    for (const p of ["lease-signed:", "ss4-signed-company:", "8832-signed:", "signature-signed:", "oa-handsigned-scan:", "esign-signed:", "oa-signed:", "offer-signed:"]) {
      expect(prefixes.has(p), p).toBe(true)
    }
  })

  it("every prefix given to saveSignedPdfForAccount is either a signed prefix or explicitly listed as not signed", () => {
    const unknown = all.filter((p) => p.helper === "saveSignedPdfForAccount" && !listed.has(p.prefix))
    expect(unknown.map((p) => `${p.prefix} (${p.file})`)).toEqual([])
  })

  it("any key that looks signed / scanned is classified", () => {
    const unknown = all.filter((p) => /sign|scan/i.test(p.prefix) && !listed.has(p.prefix))
    expect(unknown.map((p) => `${p.prefix} (${p.file})`)).toEqual([])
  })

  it("the constants never overlap", () => {
    for (const k of Object.keys(NOT_SIGNED_KEY_PREFIXES)) expect(SIGNED_KEY_PREFIXES as readonly string[]).not.toContain(k)
  })

  it("the migrations write exactly the signed prefixes of the constant (and nothing else)", () => {
    const base = readFileSync(join(ROOT, "scripts/migrations/20261025-1200-storage-safe-save.sql"), "utf8")
    const add = readFileSync(join(ROOT, "scripts/migrations/20261025-1500-storage-signed-prefixes.sql"), "utf8")
    const first = /store_signed_key_prefixes', '(\[[^']*\])'/.exec(base)
    expect(first).not.toBeNull()
    const second = /ARRAY\[([^\]]*)\]/.exec(add)
    expect(second).not.toBeNull()
    const fromBase: string[] = JSON.parse(first![1])
    const fromAdd = [...second![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    expect([...new Set([...fromBase, ...fromAdd])].sort()).toEqual([...SIGNED_KEY_PREFIXES].sort())
  })
})
