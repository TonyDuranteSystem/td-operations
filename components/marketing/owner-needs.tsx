import Link from 'next/link'
import type { NeedsItem } from '@/lib/marketing/master-view'
import { GiveBox, TeamBox } from '@/components/marketing/owner-home-actions'

const TONE = { bad: 'bg-red-50 text-red-700', warn: 'bg-amber-50 text-amber-800' } as const
const TAG: Record<NeedsItem['key'], string> = { untouched: 'Slow', unassigned: 'Assign', late_callbacks: 'Late', existing_client: 'Check' }
const open = (id: string) => `/marketing/board?open=${id}`

/**
 * "Needs you" on Antonio's Home (TD Marketing, dev job 9aec66fa, Addendum H): every line has the button that fixes it, next to the lead it is about. A lead nobody picked is given to a person of the team; a lead
 * with no team is given to a team; a late call back or an existing client opens the lead in a window. English: his own screen.
 */
export function OwnerNeeds({ needs, people, teams, currentTeamId }: { needs: NeedsItem[]; people: Array<{ id: string; name: string }>; teams: Array<{ id: string; name: string }>; currentTeamId?: string }) {
  return (
    <section className="rounded-xl border bg-white p-5" aria-label="Needs you" data-testid="home-needs">
      <h2 className="text-sm font-semibold text-slate-600">Needs you</h2>
      {needs.length === 0 ? <p className="mt-3 text-sm text-slate-500">Nothing needs you right now.</p> : (
        <ul className="mt-3 divide-y text-sm">
          {needs.map((n, i) => (
            <li key={i} className="py-3 first:pt-0 last:pb-0" data-testid="need-row" data-need={n.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span>{n.text}</span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${TONE[n.tone]}`}>{TAG[n.key]}</span>
              </div>
              {n.leadId && <p className="mt-1.5"><Link href={open(n.leadId)} className="rounded-lg border px-2 py-1 text-xs hover:bg-slate-50" data-testid="need-open">Open lead</Link></p>}
              {n.leads && n.leads.length > 0 && (
                <ul className="mt-2 space-y-2">
                  {n.leads.map(l => (
                    <li key={l.id} className="flex flex-wrap items-center justify-between gap-2" data-testid="need-lead">
                      <span className="min-w-0 truncate font-medium">{l.name}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        {n.key !== 'unassigned' && <Link href={open(l.id)} className="rounded-lg border px-2 py-1 text-xs hover:bg-slate-50" data-testid="need-open">Open lead</Link>}
                        {n.key === 'untouched' && <GiveBox leadId={l.id} people={people} />}
                        {n.key === 'unassigned' && <TeamBox leadId={l.id} teams={teams} defaultTeamId={currentTeamId} />}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
