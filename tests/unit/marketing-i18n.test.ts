import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { makeT, localeFor } from "@/lib/marketing/i18n"
import { IT } from "@/lib/marketing/i18n-it"
import { DEFAULT_TEMPLATES } from "@/lib/marketing/templates"
import { MARKETING_SETTING_DEFS } from "@/lib/marketing/settings-schema"
import { modulesFor } from "@/lib/marketing/workspace"
import { LEAD_SHOW_OPTIONS } from "@/lib/marketing/lead-view"
import { MARKETING_PERMISSIONS } from "@/lib/marketing/permissions"
import { PERMISSION_LABELS, ROLE_LABELS } from "@/lib/marketing/permission-labels"
import { ACCESS_GROUPS, accessWarnings } from "@/lib/marketing/access"
import { saleStatusLabel } from "@/lib/marketing/sales"
import { columnsFor } from "@/lib/marketing/board"

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}
const root = process.cwd()
const files = [...walk(join(root, "app/marketing")), ...walk(join(root, "components/marketing")), ...walk(join(root, "lib/marketing"))].filter(f => !f.endsWith("i18n-it.ts") && !f.endsWith("lib/marketing/i18n.ts"))

/** Every `t("…")`, `t('…')` or `t(`…`)` with a plain string in the screens and in the lib helpers they call. */
function used(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  const re = /\bt\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g
  for (const f of files) {
    const src = readFileSync(f, "utf8")
    for (const m of src.matchAll(re)) out.push({ file: f.replace(root + "/", ""), text: (m[1] ?? m[2]).replace(/\\(['"\\])/g, "$1") })
  }
  return out
}

describe("Italian for the TD Marketing workspace", () => {
  it("every text the screens pass to t() has an Italian version (nothing is left half-translated)", () => {
    const missing = used().filter(u => !(u.text in IT)).map(u => `${u.file}: ${u.text}`)
    expect(missing, `add these to lib/marketing/i18n-it.ts:\n${missing.join("\n")}`).toEqual([])
  })
  it("an Italian text keeps the same {slots} as its English", () => {
    const slots = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",")
    const bad = Object.entries(IT).filter(([en, it]) => slots(en) !== slots(it)).map(([en]) => en)
    expect(bad).toEqual([])
  })
  it("no Italian entry is empty", () => {
    expect(Object.entries(IT).filter(([, it]) => !it.trim()).map(([en]) => en)).toEqual([])
  })
  it("t() translates, fills the slots, and falls back to the English text for anything unknown", () => {
    const it = makeT("it"), en = makeT("en")
    expect(it("Call list")).toBe("Lista chiamate")
    expect(en("Call list")).toBe("Call list")
    expect(it("{n} to call", { n: 4 })).toBe("4 da chiamare")
    expect(en("{n} to call", { n: 4 })).toBe("4 to call")
    expect(it("A text nobody translated")).toBe("A text nobody translated")
    expect(it("{n} to call")).toBe("{n} da chiamare")
  })
  it("the words that come from lists (stages, reasons, menu, filters) are translated too — they reach t() by a variable", () => {
    const labels = [
      ...MARKETING_SETTING_DEFS.pipeline_stages.fallback.map(x => x.label), ...MARKETING_SETTING_DEFS.not_in_target_reasons.fallback.map(x => x.label),
      ...modulesFor(Array.from(MARKETING_PERMISSIONS as readonly string[])).map(m => m.label), ...LEAD_SHOW_OPTIONS.map(o => o.label),
      "Good", "Not in target", "Call back", "Pipeline", "Cards", "List",
      ...columnsFor("setter").map(c => c.label), ...columnsFor("seller").map(c => c.label),
      ...Object.values(PERMISSION_LABELS), ...Object.values(ROLE_LABELS), "Team owner", "Custom access", "No role",
      ...ACCESS_GROUPS.flatMap(g => [g.group, ...g.items.map(i => i.label)]),
      ...accessWarnings(["payment_links.create", "leads.pick", "team.activity", "leads.worklist", "leads.mark"]).flatMap(w => [w.text, w.fixLabel ?? ""]).filter(Boolean),
      ...["link_created", "paid", "partly_refunded", "refunded", "expired", "failed"].map(st => saleStatusLabel({ status: st, paid_out_at: null, seller_cents: 1 } as never)),
      saleStatusLabel({ status: "paid", paid_out_at: "2026-10-01", seller_cents: 1 } as never), saleStatusLabel({ status: "paid", paid_out_at: null, seller_cents: null } as never),
    ]
    expect(labels.filter(l => !(l in IT))).toEqual([])
  })
  it("dates use the language's own locale", () => {
    expect(localeFor("it")).toBe("it-IT")
    expect(localeFor("en")).toBe("en-GB")
  })
  it("the message templates exist in Italian too", () => {
    for (const t of DEFAULT_TEMPLATES) { expect(t.text.it.length).toBeGreaterThan(20); expect(t.label.it).not.toBe(t.label.en) }
  })
})
