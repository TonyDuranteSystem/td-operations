/**
 * S3 (workspace-only plan, dev job 0a07e0cd): lines in the portal's "Action Items" box for services that are waiting on the client.
 *
 * Source of truth = the step's own setting. A step shows a line only when it is the client's turn (`waiting_on = 'client'`) AND it was
 * switched on for the box (`client_task_in_list`, an opt-in: a step with a wrong "whose turn" tag stays silent), and it uses the step's
 * own client wording (`client_label` / `client_label_it`). The line disappears by itself when the step moves on.
 *
 * ⛔ New services only: nothing is listed until the go-live switch is set, and then only services created at or after it
 * (`service_start_notices_go_live`, see lib/operations/service-start-notice.ts). Services that were already open are never touched.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { getServiceStartGoLive, createdAfterGoLive } from '@/lib/operations/service-start-notice'
import { actionStageConfigFor, resolveActionLink } from '@/lib/portal/action-stage-registry'
import { ALL_FLOW_TYPES } from '@/lib/flows/resolve-flows'
import type { ActionItem } from '@/lib/portal/queries'

export interface ClientTurnSd {
  id: string
  account_id?: string | null
  service_type: string
  service_name: string | null
  stage: string | null
  stage_entered_at: string | null
  created_at: string
}

export interface ClientTurnStage {
  service_type: string
  stage_name: string
  client_label: string | null
  client_label_it: string | null
}

const DAY_MS = 86_400_000

/**
 * Where the line opens. The page where the client can actually DO the step wins:
 *   1. the step's own action link when the action registry has one (the Operating Agreement step opens Generate Documents);
 *   2. the Sign Documents page for the signing step (the client signs there; the service page only shows the journey);
 *   3. the service's page, but only for a service type that has one — anything else would 404, so it opens the home page.
 * Pure.
 */
export function clientTurnHref(sd: Pick<ClientTurnSd, 'id' | 'account_id' | 'service_type' | 'stage'>): string {
  const cfg = actionStageConfigFor(sd.service_type, sd.stage)
  if (cfg) return resolveActionLink(cfg.link, { sdId: sd.id, accountId: sd.account_id ?? null })
  if (sd.service_type === 'Company Change Name' && sd.stage === 'Client signs the name-change form') return '/portal/sign'
  return (ALL_FLOW_TYPES as readonly string[]).includes(sd.service_type) ? `/portal/flows/${sd.id}` : '/portal'
}

/** Pure: the box lines for a set of active services. */
export function buildClientTurnItems(args: {
  sds: ClientTurnSd[]
  stages: ClientTurnStage[]
  goLive: Date | null
  now?: Date
}): ActionItem[] {
  if (!args.goLive) return []
  const now = (args.now ?? new Date()).getTime()
  const byKey = new Map<string, ClientTurnStage>()
  for (const s of args.stages) {
    if (s.client_label?.trim()) byKey.set(`${s.service_type}\u0000${s.stage_name}`, s)
  }
  const items: ActionItem[] = []
  for (const sd of args.sds) {
    if (!createdAfterGoLive(args.goLive, sd.created_at)) continue
    const stage = sd.stage ? byKey.get(`${sd.service_type}\u0000${sd.stage}`) : undefined
    if (!stage) continue
    const since = sd.stage_entered_at || sd.created_at
    const ageDays = Math.floor((now - new Date(since).getTime()) / DAY_MS)
    const label = stage.client_label!.trim()
    const labelIt = stage.client_label_it?.trim() || label
    const name = sd.service_name || sd.service_type
    items.push({
      type: 'service',
      title: label,
      titleIt: labelIt,
      description: name,
      descriptionIt: name,
      href: clientTurnHref(sd),
      priority: ageDays > 7 ? 'red' : ageDays > 3 ? 'orange' : 'blue',
      createdAt: since,
    })
  }
  return items
}

/**
 * The lines for one client view: the selected company's services and the person's own (contact-scoped) services.
 * Never throws — the box must still render without them.
 */
export async function getClientTurnItems(opts: { accountId?: string | null; contactId?: string | null }): Promise<ActionItem[]> {
  try {
    const goLive = await getServiceStartGoLive()
    if (!goLive) return []

    const cols = 'id, account_id, service_type, service_name, stage, stage_entered_at, created_at'
    const sinceIso = goLive.toISOString()
    const [acct, person] = await Promise.all([
      opts.accountId
        ? supabaseAdmin.from('service_deliveries').select(cols).eq('status', 'active').eq('account_id', opts.accountId).gte('created_at', sinceIso)
        : Promise.resolve({ data: [] as ClientTurnSd[] }),
      opts.contactId
        ? supabaseAdmin.from('service_deliveries').select(cols).eq('status', 'active').eq('contact_id', opts.contactId).is('account_id', null).gte('created_at', sinceIso)
        : Promise.resolve({ data: [] as ClientTurnSd[] }),
    ])
    // supabase-js returns errors instead of throwing — say so, or a missing column (migration not yet on this database) hides the lines silently.
    const readError = acct.error?.message ?? person.error?.message
    if (readError) {
      await reportReadFailure(readError)
      return []
    }
    const seen = new Set<string>()
    const sds: ClientTurnSd[] = []
    for (const sd of [...(acct.data ?? []), ...(person.data ?? [])] as ClientTurnSd[]) {
      if (seen.has(sd.id)) continue
      seen.add(sd.id)
      sds.push(sd)
    }
    if (sds.length === 0) return []

    const types = Array.from(new Set(sds.map((s) => s.service_type)))
    const { data: stages, error: stagesError } = await supabaseAdmin
      .from('pipeline_stages')
      .select('service_type, stage_name, client_label, client_label_it')
      .eq('waiting_on', 'client')
      .eq('client_task_in_list', true)
      .in('service_type', types)
    if (stagesError) {
      await reportReadFailure(stagesError.message)
      return []
    }
    return buildClientTurnItems({ sds, stages: (stages ?? []) as ClientTurnStage[], goLive })
  } catch (err) {
    await reportReadFailure(err instanceof Error ? err.message : String(err))
    return []
  }
}

/** The box still renders without these lines, but a failure must leave a trace (one fixed message, so repeats merge into one row). */
async function reportReadFailure(reason: string): Promise<void> {
  console.error(`[client-turn-items] could not read the client's service steps: ${reason}`)
  try {
    const { reportSystemError } = await import('@/lib/system-errors')
    await reportSystemError({
      source: 'server',
      route: 'lib/portal/client-turn-items.ts:getClientTurnItems',
      message: `The portal Action Items box could not read the services waiting on the client (the box still shows its other lines): ${reason}`,
      context: {},
    })
  } catch {
    /* never fail the page over the report */
  }
}
