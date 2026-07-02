import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { StaffFinancials } from './staff-financials'

export const dynamic = 'force-dynamic'

/**
 * /tools/pnl (staff) — the standalone P&L / Balance Sheet tool.
 *
 * Runs ISOLATED workspaces (blank OR forked from a client). A workspace has its
 * own storage (pnl_workspaces/_members/_transactions) and never touches a real
 * client's books until an explicit, audited "Save to client". Reuses the same
 * MMLLC engine as the portal (shared parity core), so numbers match. MMLLC only.
 */
export default async function PnlToolPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) redirect('/')

  const currentYear = new Date().getFullYear()

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">P&amp;L / Balance Sheet</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Run an isolated Profit &amp; Loss / Balance Sheet — from scratch or forked from a client.
          Upload statements, review, and download. Nothing touches a client&apos;s real books until you
          explicitly <span className="font-medium">Save to client</span>.
        </p>
      </div>

      {/* Built-in help — plain-English guide for the team. Native <details> so it
          stays collapsed by default and needs no client JS. */}
      <details className="rounded-xl border bg-white text-sm text-zinc-700">
        <summary className="cursor-pointer select-none px-4 py-3 font-medium text-zinc-800">
          How this tool works — read me
        </summary>
        <div className="space-y-5 border-t px-4 py-4 leading-relaxed">
          <section className="space-y-1">
            <h3 className="font-semibold text-zinc-900">What it is</h3>
            <p>
              An internal workspace to build a <strong>Profit &amp; Loss and Balance Sheet</strong> for a
              Multi-Member LLC — from scratch or from a copy of a real client&apos;s data. Everything you do
              stays in a <strong>private workspace</strong> and never changes a client&apos;s real records
              unless you deliberately press <strong>Save to client</strong>. You can keep several workspaces
              and reopen them anytime (e.g. run the same client two ways and compare).
            </p>
          </section>

          <section className="space-y-1">
            <h3 className="font-semibold text-zinc-900">Two ways to start</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>New blank workspace</strong> — start empty. Enter the company name, EIN, and members
                (people <em>or</em> companies) with their ownership %, then upload the bank statements. Use
                this for a brand-new company or a what-if.
              </li>
              <li>
                <strong>Fork a client</strong> — make a private copy of an existing client&apos;s real data
                (their transactions, members, and prior-year return). The client&apos;s real record is never
                touched. Use this to check a client&apos;s numbers, test changes, or compare scenarios.
              </li>
            </ul>
          </section>

          <section className="space-y-1">
            <h3 className="font-semibold text-zinc-900">What you can do in a workspace</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>Upload bank statements (CSV or PDF) — the system reads and categorizes them automatically.</li>
              <li>Review the P&amp;L and Balance Sheet; answer the categorization questions to clean up anything uncertain.</li>
              <li>Drill into any expense category to see the transactions behind it.</li>
              <li>Download the Excel (P&amp;L + Balance Sheet + per-member K-1 capital + detail sheets).</li>
              <li>Delete a workspace when you&apos;re done — it removes the copy and its uploaded files.</li>
            </ul>
          </section>

          <section className="space-y-1">
            <h3 className="font-semibold text-zinc-900">Save to client — the only action that changes real data</h3>
            <p>
              Everything else is isolated. <strong>Save to client</strong> is the one button that writes a
              workspace&apos;s transactions into a real client&apos;s books. Pick the target client:
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>If the client&apos;s year is <strong>empty</strong>, it simply adds the data.</li>
              <li>
                If the client <strong>already has data</strong> for that year you must choose:
                <ul className="list-disc pl-5 mt-1 space-y-1">
                  <li><strong>Merge</strong> — adds only new transactions; duplicates are skipped. Safe / additive.</li>
                  <li>
                    <strong>Replace</strong> — deletes the client&apos;s existing transactions for that year and
                    puts the workspace&apos;s in their place. A backup is taken automatically first, and every
                    save is logged.
                  </li>
                </ul>
              </li>
            </ul>
          </section>

          <section className="space-y-1">
            <h3 className="font-semibold text-amber-700">Good to know &amp; risks</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>Isolated by design:</strong> uploading, editing, answering, or deleting inside a workspace never affects the real client — <em>only</em> &quot;Save to client&quot; does.</li>
              <li><strong>Replace overwrites:</strong> it removes the client&apos;s existing year data (a backup is saved, but treat Replace as the heavy option — use Merge unless you truly mean to overwrite).</li>
              <li><strong>A fork is a snapshot copy:</strong> later changes the client makes don&apos;t flow into your workspace, and your edits don&apos;t reach them, until you Save.</li>
              <li><strong>MMLLC only:</strong> the tool is built for Multi-Member LLCs. It won&apos;t fork a single-member LLC or a C-Corp (a separate tool is planned for the land C-Corp).</li>
              <li><strong>Give statements a moment:</strong> large PDFs take longer to read; the numbers fill in as processing finishes.</li>
              <li><strong>Numbers match the client view:</strong> a fork uses the same engine as the client&apos;s official P&amp;L, so a fresh fork ties out to what the client sees.</li>
            </ul>
          </section>
        </div>
      </details>

      <StaffFinancials defaultYear={currentYear - 1} />
    </div>
  )
}
