'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { HARBOR } from '@/lib/renewal-links'
import type { SectionResult, WrapUpCompanyFacts, WrapUpFacts, WrapUpJob, WrapUpMoneyItem, WrapUpPersonFacts } from '@/lib/closure/wrapup-facts'
import { closingEmailRecipients } from '@/lib/closure/wrapup-email'

interface ClosureWrapupPanelProps {
  serviceDeliveryId: string
}

/**
 * The Company Closure "Wrap-up" step (slice 1: READ-ONLY). Shows what the CRM knows so the person doing the chores sees the whole
 * picture in one place: registered agent, money, tax return, renewals, other services, who gets the closing email, the lease and
 * suite, owners, and any company this one is a member of. It changes nothing; closing from here arrives in a later slice.
 *
 * Fail closed: a section that could not be read says so in red. It never reads as "nothing found" (the status dialog's
 * "preview unavailable, change will still apply" is the antipattern). Server errors are shown verbatim (R099).
 * "Open Finance" is a plain new-tab link (a floating window would open under a modal backdrop — UX review, 2026-10-15).
 */
export function ClosureWrapupPanel({ serviceDeliveryId }: ClosureWrapupPanelProps) {
  const [facts, setFacts] = useState<WrapUpFacts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/flows/${serviceDeliveryId}/wrapup-facts`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not read the Wrap-up facts.')
      setFacts(data.facts as WrapUpFacts)
      setError(null)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not read the Wrap-up facts.')
    } finally {
      setLoading(false)
    }
  }, [serviceDeliveryId])

  useEffect(() => {
    load()
  }, [load])

  // Coming back from another tab (Finance, Harbor) re-reads the facts, so what is shown is never stale after a payment.
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onFocus)
    return () => document.removeEventListener('visibilitychange', onFocus)
  }, [load])

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">Wrap-up</div>
          <h3 className="text-sm font-semibold text-zinc-900">What the CRM knows before this company is closed</h3>
          <p className="mt-0.5 text-xs text-zinc-500">Read-only view. Nothing here changes the company. Closing from this screen comes in a later version.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          {facts && <span>Checked {new Date(facts.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Refresh
          </button>
        </div>
      </div>

      {error && !facts && (
        <p className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      {error && facts && <p className="mb-2 text-xs text-red-600">Could not refresh: {error}. Showing the last read.</p>}
      {!facts && loading && (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {facts?.variant === 'company' && <CompanyView facts={facts} />}
      {facts?.variant === 'person' && <PersonView facts={facts} />}
    </div>
  )
}

// ───────────────────────────── shared bits ─────────────────────────────

function Section({ title, tag, children }: { title: string; tag?: { text: string; tone: 'amber' | 'green' | 'grey' | 'red' }; children: React.ReactNode }) {
  const tone = { amber: 'bg-amber-50 text-amber-700 border-amber-200', green: 'bg-emerald-50 text-emerald-700 border-emerald-100', grey: 'bg-zinc-50 text-zinc-500 border-zinc-200', red: 'bg-red-50 text-red-700 border-red-100' }
  return (
    <section className="border-t border-zinc-100 py-3 first:border-t-0 first:pt-0">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-zinc-900">{title}</h4>
        {tag && <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone[tag.tone]}`}>{tag.text}</span>}
      </div>
      <div className="space-y-1.5 text-sm text-zinc-700">{children}</div>
    </section>
  )
}

function Failed({ error }: { error: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-700">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error} Closing stays off until this can be checked.
    </p>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-zinc-500">{children}</p>
}

function Warn({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">{children}</p>
}

function NewTabLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50"
    >
      {children}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  )
}

function money(amount: number | null, currency: string): string {
  if (amount === null) return '—'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

function dateLabel(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
}

function pending<T>(r: SectionResult<T>, render: (data: T) => React.ReactNode): React.ReactNode {
  return r.ok === false ? <Failed error={r.error} /> : render(r.data)
}

// ───────────────────────────── company view ─────────────────────────────

function CompanyView({ facts }: { facts: WrapUpCompanyFacts }) {
  const h = facts.header
  return (
    <div>
      <p className="mb-3 text-xs text-zinc-500">
        <span className="font-medium text-zinc-700">{h.companyName}</span>
        {h.state ? ` · ${h.state}` : ''}
        {h.entityType ? ` · ${h.entityType}` : ''}
        {h.accountStatus ? ` · ${h.accountStatus}` : ''}
      </p>

      <Section title="What would hold the closing today" tag={facts.holds.length ? { text: `${facts.holds.length} to settle`, tone: 'amber' } : { text: 'Nothing found', tone: 'green' }}>
        {facts.holds.length ? (
          <ul className="list-disc space-y-1 pl-5">
            {facts.holds.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ) : (
          <Hint>Nothing in the CRM would hold the closing. The registered agent and the final tax return still need an answer.</Hint>
        )}
      </Section>

      <Section title="Registered agent">
        <p>
          <span className="text-zinc-500">Provider in the CRM:</span> {facts.registeredAgent.provider ?? '(empty)'}
        </p>
        {facts.registeredAgent.missing && <Warn>The CRM has no registered agent for this company (35 active companies have none). Check the Articles or ask the client.</Warn>}
        <Hint>{facts.registeredAgent.isHarbor ? 'Harbor is cancelled by hand: open the site, cancel, then keep the receipt for the file.' : 'Not Harbor, so there is no site to open here.'}</Hint>
        {facts.registeredAgent.isHarbor && <NewTabLink href={HARBOR.url}>Open {HARBOR.label}</NewTabLink>}
      </Section>

      <Section title="Money" tag={moneyTag(facts)}>
        <div className="flex flex-wrap items-center gap-2">
          <NewTabLink href={`/finance?tab=clients&client=${facts.accountId}`}>Open Finance for this company</NewTabLink>
          <Hint>Opens in a new tab. When you come back this list refreshes.</Hint>
        </div>
        {pending(facts.money, (m) => (
          <>
            {m.items.length === 0 ? <Hint>No open invoices or uninvoiced installments. Paid invoices are never touched.</Hint> : <MoneyTable items={m.items} />}
            {m.credit.map((c) => (
              <Warn key={c.currency}>
                {money(c.amount, c.currency)} of unspent client credit. Closing would leave it stranded.
              </Warn>
            ))}
            <Hint>Counts Pending, Overdue, Delinquent, part-paid, draft and never-invoiced items. A part-paid invoice can only be settled in Finance.</Hint>
          </>
        ))}
      </Section>

      <Section title="Final tax return" tag={taxTag(facts)}>
        {pending(facts.tax, (t) => (
          <>
            {t.records.length === 0 ? <Hint>No tax return record on this company.</Hint> : (
              <ul className="space-y-0.5">
                {t.records.map((r, i) => (
                  <li key={`${r.year}-${i}`}>
                    <span className="text-zinc-500">Tax return record:</span> {r.year ?? '—'} · {r.status ?? '—'}
                    {r.paid === true ? ' · paid' : r.paid === false ? ' · unpaid' : ''}
                  </li>
                ))}
              </ul>
            )}
            {t.openJobs.length > 0 ? (
              <>
                {t.openJobs.map((j) => (
                  <p key={j.id}>
                    <span className="text-zinc-500">Open Tax Return job:</span> {j.label}
                  </p>
                ))}
                <Warn>The company stays Active until the return is filed (step “TR Filed”). The client keeps their portal in the meantime.</Warn>
              </>
            ) : (
              <Hint>No Tax Return job is open. Where the final return stands is recorded when the company is closed.</Hint>
            )}
          </>
        ))}
      </Section>

      <Section title="Yearly renewals">
        {pending(facts.renewals, (r) =>
          r.dates.length === 0 && r.jobs.length === 0 ? (
            <Hint>No renewal dates and no open renewal jobs.</Hint>
          ) : (
            <>
              {r.dates.map((d) => (
                <p key={d.key}>
                  {d.label}: <span className="font-medium">{dateLabel(d.date)}</span>
                  <span className="text-zinc-500">{d.hasOpenJob ? ' · job open' : ' · no job open yet'}</span>
                </p>
              ))}
              {r.jobs.map((j) => (
                <JobLine key={j.id} job={j} />
              ))}
              <Hint>Stopping a renewal clears its date, even when no job is open yet.</Hint>
            </>
          ),
        )}
      </Section>

      <Section title="Other open services">
        {pending(facts.jobs, (jobs) => {
          // Renewal jobs have their own section, and an open Tax Return is shown (and holds the closing) under "Final tax return".
          const others = jobs.filter((j) => !j.isRenewal && !j.isTaxReturn)
          return others.length === 0 ? (
            <Hint>No other open services on this company.</Hint>
          ) : (
            <>
              {others.map((j) => (
                <JobLine key={j.id} job={j} />
              ))}
              <Hint>Includes blocked and on-hold jobs. A job already past its first step needs an explicit choice when the company is closed.</Hint>
            </>
          )
        })}
      </Section>

      <Section title="Client email">
        {pending(facts.people, (people) => {
          const recipients = closingEmailRecipients(people)
          const noEmail = people.filter((p) => !p.email)
          return people.length === 0 ? (
            <Hint>No people are linked to this company.</Hint>
          ) : (
            <>
              {recipients.map((r) => (
                <p key={r.email}>
                  {r.name} <span className="text-zinc-500">({r.language === 'it' ? 'Italian' : 'English'}):</span> {r.email}
                </p>
              ))}
              {noEmail.length > 0 && <Warn>{noEmail.map((p) => p.name).join(', ')} {noEmail.length === 1 ? 'has' : 'have'} no email on file and cannot be reached by the closing message.</Warn>}
              <Hint>The closing email is off unless someone ticks it when closing. No portal button, because the company’s portal is closed.</Hint>
            </>
          )
        })}
      </Section>

      <Section title="For your information" tag={{ text: 'No choice needed', tone: 'grey' }}>
        {pending(facts.lease, (l) => (
          <div>
            <p className="font-medium text-zinc-800">Mailing address, suite and lease</p>
            {!l.suite && l.draftCount === 0 && !l.inForce ? (
              <Hint>No suite and no lease.</Hint>
            ) : (
              <>
                {l.suite && <p><span className="text-zinc-500">Suite:</span> {l.suite}</p>}
                {l.inForce ? (
                  <Hint>
                    A lease is in force{l.inForceHasNoEndDate ? ' with no end date' : l.inForceUntil ? ` until ${dateLabel(l.inForceUntil)}` : ''}. The suite stays reserved until it ends, then returns to the pool by itself. Only the owner can end a signed lease early (Documents).
                  </Hint>
                ) : l.suiteFreedAtClose ? (
                  <Hint>No lease is in force, so closing returns the suite to the pool right away.</Hint>
                ) : null}
                {l.draftNamesSuite && <Warn>A draft lease also names this suite. A draft is not “in force”, so closing frees the suite while the draft still names it. Delete the draft in Documents first.</Warn>}
              </>
            )}
          </div>
        ))}
        {pending(facts.people, (people) => (
          <div>
            <p className="font-medium text-zinc-800">People and portal access</p>
            {people.length === 0 ? (
              <Hint>No people are linked to this company.</Hint>
            ) : (
              <ul className="space-y-0.5">
                {people.map((p) => (
                  <li key={p.contactId}>
                    {p.name}:{' '}
                    {p.keepsLogin ? (
                      <span className="text-zinc-600">keeps their login (also owns {p.otherCompanies.join(', ')})</span>
                    ) : (
                      <span className="text-zinc-600">no other active company, so a personal area only</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {pending(facts.memberOf, (m) => (
          <div>
            <p className="font-medium text-zinc-800">Part of another company</p>
            {m.length === 0 ? (
              <Hint>This company is not recorded as a member of another company in the CRM.</Hint>
            ) : (
              <>
                {m.map((x) => (
                  <p key={x.companyName}>
                    Owns {x.ownershipPct !== null ? `${x.ownershipPct}% of ` : 'a stake in '}
                    {x.companyName}
                    {x.status ? ` (${x.status})` : ''}
                  </p>
                ))}
                <Warn>Update that company’s member list and Operating Agreement separately. Nothing changes there automatically.</Warn>
              </>
            )}
          </div>
        ))}
        <div>
          <p className="font-medium text-zinc-800">Company files</p>
          <Hint>Stay exactly where they are.</Hint>
        </div>
      </Section>
    </div>
  )
}

function moneyTag(f: WrapUpCompanyFacts): { text: string; tone: 'amber' | 'green' | 'grey' | 'red' } {
  if (!f.money.ok) return { text: 'Could not check', tone: 'red' }
  const n = f.money.data.items.length
  if (n > 0) return { text: `${n} to settle`, tone: 'red' }
  return f.money.data.credit.length ? { text: 'Credit unspent', tone: 'amber' } : { text: 'Nothing owed', tone: 'grey' }
}

function taxTag(f: WrapUpCompanyFacts): { text: string; tone: 'amber' | 'green' | 'grey' | 'red' } {
  if (!f.tax.ok) return { text: 'Could not check', tone: 'red' }
  return f.tax.data.holdsClosing ? { text: 'Holds the closing', tone: 'amber' } : { text: 'Nothing open', tone: 'grey' }
}

function MoneyTable({ items }: { items: WrapUpMoneyItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <tbody>
          {items.map((i) => (
            <tr key={i.id} className="border-t border-zinc-100 align-top">
              <td className="py-1.5 pr-2">
                <div className="text-sm text-zinc-800">{i.invoiceNumber ? `${i.invoiceNumber} · ` : ''}{i.label}</div>
                <div className="text-zinc-500">
                  {i.statusText}
                  {i.paid > 0 ? ` · ${money(i.paid, i.currency)} paid` : ' · nothing paid'}
                  {!i.canVoid && i.kind === 'partial' ? ' · cannot be voided here' : ''}
                </div>
              </td>
              <td className="whitespace-nowrap py-1.5 text-right text-sm font-medium text-zinc-800">{money(i.due ?? i.total, i.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function JobLine({ job }: { job: WrapUpJob }) {
  return (
    <p>
      {job.serviceType}
      <span className="text-zinc-500">{job.stage ? ` · step “${job.stage}”` : ''}</span>
      {job.flag === 'blocked' && <span className="ml-1.5 rounded-full bg-red-50 px-1.5 py-0.5 text-[11px] font-semibold text-red-700">blocked</span>}
      {job.flag === 'on_hold' && <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">on hold</span>}
      {job.pastFirstStep && <span className="text-zinc-500"> · already past its first step</span>}
    </p>
  )
}

// ───────────────────────────── person-only view ─────────────────────────────

function PersonView({ facts }: { facts: WrapUpPersonFacts }) {
  return (
    <div>
      <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <b>No company record is closed or changed here.</b> This closure is not linked to a company in the CRM, on purpose: it comes from a contract that also forms a new company, and
        {facts.personCompanies.length > 0 ? ' the person’s companies in the CRM are not the one being closed. ' : ' there is no company to link. '}
        Never link this job to one of them.
      </div>
      {facts.readFailed && <Failed error="Some of the facts about this person could not be read." />}
      <Section title="The closure">
        <p>
          <span className="text-zinc-500">Company named on the closure form:</span> {facts.closureCompanyName ?? 'no form submitted yet'}
          {facts.closureCompanyState ? ` · ${facts.closureCompanyState}` : ''}
        </p>
        <p>
          <span className="text-zinc-500">Returns filed, as the client wrote it:</span> {facts.returnsFiledText ?? '—'}
        </p>
        <Hint>The registered agent, the state and IRS filings and the final return are handled outside the CRM. Recording them comes in a later version.</Hint>
      </Section>
      <Section title="The person">
        <p>
          {facts.person ? `${facts.person.name}${facts.person.languageLabel ? ` (${facts.person.languageLabel})` : ''}${facts.person.email ? ` · ${facts.person.email}` : ' · no email on file'}` : 'No person is linked to this job.'}
        </p>
      </Section>
      <Section title="Their companies in the CRM" tag={{ text: 'Not the company being closed', tone: 'grey' }}>
        {facts.personCompanies.length === 0 ? (
          <Hint>None.</Hint>
        ) : (
          <ul className="space-y-0.5">
            {facts.personCompanies.map((c) => (
              <li key={c.name}>
                {c.name}
                <span className="text-zinc-500">{c.status ? ` · ${c.status}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
