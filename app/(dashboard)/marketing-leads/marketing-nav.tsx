"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

const TABS: Array<{ href: string; label: string; soon?: boolean }> = [
  { href: "/marketing-leads", label: "Overview" },
  { href: "/marketing-leads/leads", label: "All leads" },
  { href: "/marketing-leads/teams", label: "Teams" },
  { href: "/marketing-leads/audit", label: "Audit log" },
  { href: "/marketing-leads/settings", label: "Settings" },
  { href: "#money", label: "Money", soon: true },
  { href: "#calls", label: "Calls", soon: true },
  { href: "#conversations", label: "Conversations", soon: true },
]

/** The sub-menu of Antonio's Marketing section in the CRM. Screens that are not built yet are shown greyed, never as a link that goes nowhere. */
export function MarketingNav() {
  const path = usePathname() ?? ""
  const on = (href: string) => (href === "/marketing-leads" ? path === href : path === href || path.startsWith(`${href}/`))
  return (
    <nav aria-label="Marketing" className="flex flex-wrap gap-1 border-b px-6 pt-4">
      {TABS.map(t => t.soon ? (
        <span key={t.href} className="cursor-default rounded-t-lg px-3 py-2 text-sm text-slate-400" title="Not built yet">{t.label} <span className="text-[10px] uppercase">soon</span></span>
      ) : (
        <Link key={t.href} href={t.href} aria-current={on(t.href) ? "page" : undefined}
          className={`rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium ${on(t.href) ? "border-teal-700 text-teal-800" : "border-transparent text-slate-600 hover:text-slate-900"}`}>{t.label}</Link>
      ))}
    </nav>
  )
}
