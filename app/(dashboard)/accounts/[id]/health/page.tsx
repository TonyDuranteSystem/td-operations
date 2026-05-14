import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, Stethoscope, AlertOctagon, AlertTriangle, Info, CheckCircle2 } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { auditClientHealth, type Finding, type Severity } from "@/lib/operations/client-health-audit"

export const dynamic = "force-dynamic"

const SEVERITY_STYLES: Record<Severity, { badge: string; icon: typeof AlertOctagon; label: string }> = {
  error: { badge: "bg-red-100 text-red-700 border-red-200", icon: AlertOctagon, label: "Error" },
  warning: { badge: "bg-amber-100 text-amber-700 border-amber-200", icon: AlertTriangle, label: "Warning" },
  info: { badge: "bg-blue-100 text-blue-700 border-blue-200", icon: Info, label: "Info" },
}

const SEVERITY_ORDER: Severity[] = ["error", "warning", "info"]

function groupByRule(findings: Finding[]): Record<string, Finding[]> {
  const out: Record<string, Finding[]> = {}
  for (const f of findings) {
    const key = `${f.rule_id} · ${f.rule_title}`
    if (!out[key]) out[key] = []
    out[key].push(f)
  }
  return out
}

export default async function AccountHealthPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const admin = user ? isDashboardUser(user) : false
  if (!admin) notFound()

  let result
  try {
    result = await auditClientHealth(params.id)
  } catch (e) {
    notFound()
    // unreachable but quiets type narrowing
    throw e
  }

  const grouped = groupByRule(result.findings)
  const orderedGroups = Object.entries(grouped).sort(([a], [b]) => {
    // Sort by max severity in the group, then by rule id.
    const sevOf = (entries: Finding[]) => Math.min(...entries.map(f => SEVERITY_ORDER.indexOf(f.severity)))
    const av = sevOf(grouped[a])
    const bv = sevOf(grouped[b])
    if (av !== bv) return av - bv
    return a.localeCompare(b)
  })

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href={`/accounts/${params.id}`}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to account
        </Link>
      </div>

      <header className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Stethoscope className="h-5 w-5 text-zinc-500" />
          <h1 className="text-2xl font-semibold">Client Health Audit</h1>
        </div>
        <p className="text-muted-foreground">
          {result.company_name ?? result.account_id}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Generated {new Date(result.generated_at).toLocaleString()}
        </p>
      </header>

      {/* Summary */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <SummaryCard label="Errors" value={result.summary.error} tone="error" />
        <SummaryCard label="Warnings" value={result.summary.warning} tone="warning" />
        <SummaryCard label="Info" value={result.summary.info} tone="info" />
        <SummaryCard label="Total findings" value={result.summary.total} tone="neutral" />
      </div>

      {result.findings.length === 0 ? (
        <div className="border rounded-lg p-8 flex flex-col items-center justify-center text-center bg-emerald-50/50">
          <CheckCircle2 className="h-10 w-10 text-emerald-600 mb-2" />
          <p className="text-lg font-medium">All 10 rules passed.</p>
          <p className="text-sm text-muted-foreground">No findings for this account.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {orderedGroups.map(([key, items]) => (
            <section key={key} className="border rounded-lg overflow-hidden">
              <header className="bg-zinc-50 px-4 py-2 border-b">
                <h2 className="text-sm font-semibold">{key}</h2>
              </header>
              <ul className="divide-y">
                {items.map((f, i) => {
                  const style = SEVERITY_STYLES[f.severity]
                  const Icon = style.icon
                  return (
                    <li key={`${f.rule_id}-${i}`} className="p-4 flex gap-3">
                      <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${style.badge}`}>
                        <Icon className="h-3 w-3" />
                        {style.label}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm">{f.description}</p>
                        <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
                          {f.current_value && (
                            <div>
                              Current: <code className="bg-zinc-100 px-1 rounded">{f.current_value}</code>
                            </div>
                          )}
                          {f.expected_value && (
                            <div>
                              Expected: <code className="bg-zinc-100 px-1 rounded">{f.expected_value}</code>
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: "error" | "warning" | "info" | "neutral" }) {
  const tones: Record<typeof tone, string> = {
    error: "bg-red-50 text-red-700 border-red-200",
    warning: "bg-amber-50 text-amber-700 border-amber-200",
    info: "bg-blue-50 text-blue-700 border-blue-200",
    neutral: "bg-zinc-50 text-zinc-700 border-zinc-200",
  }
  return (
    <div className={`border rounded-lg p-3 ${tones[tone]}`}>
      <div className="text-xs uppercase tracking-wide">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  )
}
