/**
 * The CRM tables must follow the window when it shrinks (dev job be097205, Wave 1).
 *
 * Rule 1 (KEEP_WHOLE): an invoice number, date, amount or status chip is never broken across lines. A sign before a € or £ is a legal
 * line-break point in Chrome ("-€397.00" -> "-" / "€397.00"), so every amount cell that can show a sign carries it.
 * Rule 2 (pin): in the Finance and Invoice-aging tables the identifier column and the Actions column stay put while the middle scrolls.
 *
 * Part 1 tests the two helpers. Part 2 pins the screens by reading their source, in the same relational style as the other layout pins.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { KEEP_WHOLE, pinBodyCell, pinHeadCell } from "@/lib/ui/table-cells"

const read = (p: string) => readFileSync(p, "utf8")

describe("table cell helpers", () => {
  it("KEEP_WHOLE is the no-wrap class", () => {
    expect(KEEP_WHOLE).toBe("whitespace-nowrap")
  })

  it("a pinned body cell is sticky, opaque, on the right edge for 'end' and the left edge for 'start'", () => {
    const start = pinBodyCell("start")
    const end = pinBodyCell("end")
    for (const c of [start, end]) {
      expect(c).toContain("sticky")
      expect(c).toContain("bg-background") // opaque: the rows themselves are translucent
      expect(c).toContain("before:-z-10") // the row tint sits BEHIND the cell's content
      expect(c).toContain("group-hover:after:opacity-100") // the hover tint follows the row (the row carries `group`)
    }
    expect(start).toContain("left-0")
    expect(start).not.toContain("right-0")
    expect(end).toContain("right-0")
    expect(end).not.toContain("left-0")
  })

  it("only an overdue-style row gets the red tint, and an untinted cell has none", () => {
    expect(pinBodyCell("end", "danger")).toContain("before:bg-red-50/50")
    expect(pinBodyCell("end", "danger")).toContain("group-hover:before:opacity-0") // the hovered row drops its tint, so the pinned cell must too
    expect(pinBodyCell("end")).not.toContain("before:bg-red-50/50")
    expect(pinBodyCell("end", "none")).not.toContain("before:bg-red-50/50")
  })

  it("a pinned header cell mirrors the header row's own tint", () => {
    const h = pinHeadCell("start")
    expect(h).toContain("sticky")
    expect(h).toContain("bg-background")
    expect(h).toContain("before:bg-muted/50")
    expect(pinHeadCell("end")).toContain("right-0")
  })

  it("a pinned cell paints the surface its table sits on: the page by default, a white card when asked (Wave 2)", () => {
    expect(pinBodyCell("start")).toContain("bg-background")
    expect(pinBodyCell("start", "none", "page")).toContain("bg-background")
    const card = pinBodyCell("start", "none", "card")
    expect(card).toContain("bg-white")
    expect(card).not.toContain("bg-background") // in dark mode the two differ: a mismatch would show as a patch
    expect(pinHeadCell("end", "zinc-50", "card")).toContain("bg-white")
    expect(pinHeadCell("end", "zinc-50", "card")).not.toContain("bg-background")
  })

  it("a pinned header cell carries the tint of the header it sits in (none = just the surface)", () => {
    expect(pinHeadCell("start", "muted-40")).toContain("before:bg-muted/40")
    expect(pinHeadCell("start", "zinc-50")).toContain("before:bg-zinc-50")
    expect(pinHeadCell("start", "gray-50")).toContain("before:bg-gray-50")
    expect(pinHeadCell("start", "slate-50")).toContain("before:bg-slate-50")
    expect(pinHeadCell("start", "none", "card")).not.toContain("before:bg-")
    expect(pinHeadCell("start", "none", "card")).toContain("bg-white")
  })

  it("an opened (expanded) row's grey is mirrored by the 'zinc' tint", () => {
    expect(pinBodyCell("start", "zinc", "card")).toContain("before:bg-zinc-50")
    expect(pinBodyCell("start", "none", "card")).not.toContain("before:bg-zinc-50")
  })

  it("every class is written out in full (Tailwind finds classes by scanning text, so none may be built dynamically)", () => {
    const src = read("lib/ui/table-cells.ts")
    for (const cls of [
      "before:bg-red-50/50", "before:bg-muted/50", "before:bg-muted/40", "before:bg-zinc-50", "before:bg-gray-50", "before:bg-slate-50",
      "group-hover:after:opacity-100", "left-0", "right-0", "bg-background", "bg-white",
    ]) {
      expect(src).toContain(cls)
    }
    expect(src).not.toMatch(/`[^`]*\$\{[^}]*\}[^`]*(bg|left|right)-/)
  })
})

/**
 * Wave 2: nine more tables. Each one keeps its identifier column pinned (and its Actions column, where it has one), keeps dates, amounts and
 * chips whole, and pins with the SAME surface as the box around it (a white card in dark mode is not the page colour).
 */
const WAVE2: Array<{ file: string; surface: "page" | "card"; end: boolean }> = [
  { file: "app/(dashboard)/bofa-intake/page.tsx", surface: "page", end: true },
  { file: "app/(dashboard)/marketing-leads/money/page.tsx", surface: "card", end: true },
  { file: "app/(dashboard)/cases/page.tsx", surface: "card", end: false },
  { file: "app/(dashboard)/catalog/catalog-client.tsx", surface: "card", end: true },
  { file: "app/(dashboard)/team-management/page.tsx", surface: "card", end: true },
  { file: "app/(dashboard)/referrals/referrals-dashboard.tsx", surface: "card", end: false },
  { file: "app/(dashboard)/workflows/workflows-list-client.tsx", surface: "card", end: false },
  { file: "app/(dashboard)/tools/fax/history/history-table.tsx", surface: "card", end: true },
  { file: "app/(dashboard)/marketing-leads/audit/page.tsx", surface: "card", end: false },
]

describe("Wave 2 tables follow the window", () => {
  for (const { file, surface, end } of WAVE2) {
    const src = read(file)
    const pins = Array.from(src.matchAll(/pin(Head|Body)Cell\(([^)]*)\)/g), (m) => ({ kind: m[1], args: m[2] }))

    describe(file, () => {
      it("uses the shared rules", () => {
        expect(src).toMatch(/from ["']@\/lib\/ui\/table-cells["']/)
        expect((src.match(/KEEP_WHOLE/g) ?? []).length).toBeGreaterThanOrEqual(4) // import + at least 3 cells keep their text whole
      })

      it("pins its identifier column in the header and in the rows", () => {
        expect(pins.some((p) => p.kind === "Head" && /["']start["']/.test(p.args))).toBe(true)
        expect(pins.some((p) => p.kind === "Body" && /["']start["']/.test(p.args))).toBe(true)
      })

      it(end ? "pins its Actions column too" : "has no Actions column to pin", () => {
        const hasEnd = pins.some((p) => /["']end["']/.test(p.args))
        expect(hasEnd).toBe(end)
        if (end) {
          expect(pins.some((p) => p.kind === "Head" && /["']end["']/.test(p.args))).toBe(true)
          expect(pins.some((p) => p.kind === "Body" && /["']end["']/.test(p.args))).toBe(true)
        }
      })

      it(`pins on the ${surface} surface, never the other one`, () => {
        for (const p of pins) {
          if (surface === "card") expect(p.args).toMatch(/["']card["']/)
          else expect(p.args).not.toMatch(/["']card["']/)
        }
      })

      it("rows carry `group` so the hover tint follows the row", () => {
        expect(src).toMatch(/<tr[\s\S]{0,160}?\bgroup\b/)
      })
    })
  }

  it("Team management keeps a name whole (a hyphenated name used to split at the hyphen)", () => {
    const src = read("app/(dashboard)/team-management/page.tsx")
    expect(src).toMatch(/px-4 py-3 \$\{KEEP_WHOLE\} \$\{pinBodyCell\('start', 'none', 'card'\)\}/)
  })

  it("Fax history gives its Status column room, so the long outcome text cannot stack letter by letter", () => {
    const src = read("app/(dashboard)/tools/fax/history/history-table.tsx")
    expect(src).toContain("min-w-[13rem]")
  })
})

/** The nearest `className` on the line of `expr` or the 3 lines above it (the opening tag of the cell that holds the amount). */
function ownerTagLines(source: string, expr: string): string[] {
  const lines = source.split("\n")
  const found: string[] = []
  lines.forEach((ln, i) => {
    if (!ln.includes(expr)) return
    for (let k = i; k >= Math.max(0, i - 3); k--) {
      if (lines[k].includes("className")) { found.push(lines[k]); return }
    }
    found.push(`(no className near line ${i + 1})`)
  })
  return found
}

/** An amount may not wrap if its cell has the no-wrap class, or is a flex item that cannot shrink. */
const HOLDS = /KEEP_WHOLE|whitespace-nowrap|shrink-0/

describe("every amount that can carry a sign before a € keeps its sign and number together", () => {
  const AMOUNTS: Array<[string, string[]]> = [
    ["app/(dashboard)/finance/all-invoices-tab.tsx", ["formatCurrency(Number(inv.total ?? 0), inv.currency || 'USD')"]],
    ["app/(dashboard)/owner/transactions-tab.tsx", ["fmtRow(modal.tx.amount", "fmtRow(tx.amount", "fmtRow(p.amount"]],
    ["app/(dashboard)/owner/pnl-tab.tsx", ["{fmt(value)}", "{fmt(prior)}", "{fmtPct(variancePct"]],
    ["app/(dashboard)/owner/dashboard-tab.tsx", ["(b.net_profit)", "(a.balance)"]],
    ["app/(dashboard)/owner/cashflow-tab.tsx", ["(a.balance)"]],
    ["app/(dashboard)/owner/balance-sheet-tab.tsx", ["{money(f.amount, f.currency)}"]],
    ["app/(dashboard)/owner/connect-bank-panel.tsx", ["fmt(acc.balances.current"]],
    ["components/payments/invoice-detail-dialog.tsx", ["formatCurrency(item.unit_price", "formatCurrency(item.amount"]],
    ["components/payments/payment-board.tsx", ["formatCurrency(Math.abs(Number(p.total ?? p.amount))"]],
    ["components/shared/invoice-dialog.tsx", ["{currencySymbol}{Math.abs(total).toFixed(2)}"]],
  ]

  for (const [file, exprs] of AMOUNTS) {
    const source = read(file)
    for (const expr of exprs) {
      it(`${file} — ${expr}`, () => {
        const tags = ownerTagLines(source, expr)
        expect(tags.length).toBeGreaterThan(0) // the amount is still rendered here (if it moved, update this pin)
        for (const tag of tags) expect(tag).toMatch(HOLDS)
      })
    }
  }
})

describe("Finance All Invoices table", () => {
  const src = read("app/(dashboard)/finance/all-invoices-tab.tsx")

  it("the header sits above pinned body cells (z-10) and the rows carry `group` for the hover tint", () => {
    expect(src).toContain('<thead className="bg-muted/50 sticky top-0 z-10">')
    expect(src).toMatch(/className=\{`group hover:bg-muted\/30 transition-colors/)
  })

  it("the invoice number and the Actions column are pinned in the header and in every row", () => {
    expect(src).toContain("pinHeadCell('start')")
    expect(src).toContain("pinHeadCell('end')")
    expect(src).toContain("pinBodyCell('start', isOverdue ? 'danger' : 'none')")
    expect(src).toContain("pinBodyCell('end', isOverdue ? 'danger' : 'none')")
  })

  it("the Actions icons use the shared tooltip, not a hidden label inside the cell (that label stuck out past the table and gave the scroll area a blank strip)", () => {
    const button = src.slice(src.indexOf("function ActionButton"), src.indexOf("// ── Invoice Actions ──"))
    expect(button).toContain("<FastTooltip")
    expect(button).toContain("aria-label={label}") // the label text used to be in the page; the button must keep its accessible name
    expect(button).not.toContain("absolute bottom-full")
    expect(src).not.toContain("opacity-0 group-hover:opacity-100")
  })

  it("invoice number, status, issue date and due date cells keep their text whole", () => {
    const table = src.slice(src.indexOf("{/* Table (md+) */}"))
    const cells = table.split("\n").filter((l) => /<td className=\{`px-4 py-3/.test(l) || /<th className=\{`/.test(l))
    expect(cells.length).toBeGreaterThanOrEqual(10)
    for (const l of cells) expect(l).toContain("KEEP_WHOLE")
  })
})

describe("Invoice aging table", () => {
  const src = read("app/(dashboard)/invoice-aging/invoice-aging-table.tsx")

  it("the client column is pinned (cut with … and a hover title) and every other cell keeps its text whole", () => {
    expect(src).toContain("pinHeadCell('start')")
    expect(src).toContain("pinBodyCell('start')")
    expect(src).toContain('title={row.company_name}')
    const body = src.slice(src.indexOf("{filtered.map(row => ("))
    const others = body.split("\n").filter((l) => /<td className=\{`px-4 py-3/.test(l))
    expect(others.length).toBe(6)
    for (const l of others) expect(l).toContain("KEEP_WHOLE")
  })

  it("the row tint is repeated on the pinned cell, because a pinned cell must be opaque", () => {
    expect(src).toMatch(/pinBodyCell\('start'\), agingColor\(row\.days_overdue, row\.status\), 'group-hover:bg-background'/)
    expect(src).toMatch(/className=\{`group border-b hover:bg-muted\/30 \$\{agingColor/)
  })
})
