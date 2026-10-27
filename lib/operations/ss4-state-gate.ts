/**
 * The SS-4 state gate (dev job ff2b73d7) — the server side of lib/formation/registered-agent-state.ts.
 *
 * Used where an SS-4 is about to go out of staff's hands: sent to the client to sign, re-sent for signature, faxed to the IRS. It checks
 * the two things that must hold, from the live records:
 *   1. the registered agent linked to the company is in the company's own state;
 *   2. the state printed on the SS-4's Line 6 (what the client signs and the IRS reads) is the company's state.
 *
 * It FAILS CLOSED: a record that cannot be read is a refusal ("nothing was sent"), never a pass — these gates guard an irreversible
 * fax. There is no override: a company's registered agent has to be in its own state, so the way out is to fix the agent.
 *
 * `allowStaleLine6` is for re-sending a SIGNED SS-4 for signature. A signed SS-4 is locked from the in-place refresh, so when the
 * agent is now right but the saved Line 6 still carries the old state, the gate hands back the corrected Line 6 (`line6Fix`) for the
 * caller to write in the same update that re-opens the SS-4 — the client then signs the corrected form.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { formatCountyAndState } from '@/lib/addresses'
import { checkAgentInCompanyState, checkLine6InCompanyState, stateCode } from '@/lib/formation/registered-agent-state'

export type Ss4GateContext = 'send' | 'resend' | 'fax'

export interface Ss4StateGateResult {
  ok: boolean
  /** Which rule refused: the registered agent's state, the state printed on Line 6, or a record that could not be read. */
  kind?: 'agent' | 'line6' | 'read_error'
  /** Plain-English sentence for staff — what is wrong AND what to do next. Present when ok is false. */
  message?: string
  /** allowStaleLine6 only: the Line 6 text to write when the saved one carries the wrong state (agent now right). */
  line6Fix?: string | null
}

const NEXT_STEP: Record<Ss4GateContext, { agent: string; line6: string }> = {
  send: {
    agent: 'Then use "Regenerate from account data" to refresh the SS-4, and send it.',
    line6: 'Use "Regenerate from account data" so Line 6 follows the registered agent, then send it.',
  },
  resend: {
    agent: 'Then re-send the SS-4 for signature.',
    line6: 'Link the registered agent (with its county) on the company, then re-send the SS-4 for signature.',
  },
  fax: {
    agent: 'Nothing was faxed. Fix the registered agent, then use "Re-send for Signature" so the client signs the corrected SS-4.',
    line6: 'Nothing was faxed. Use "Re-send for Signature" — it corrects Line 6 from the registered agent, and the client signs the corrected SS-4.',
  },
}

const READ_ERROR = 'Could not check the registered agent and the SS-4 against the company. Nothing was sent. Please try again.'

/**
 * Linking a registered agent to a company (the picker's save): refused when the agent is not in the company's state. Returns the plain
 * sentence to show, or null when the link may go ahead. A company whose own state is not set yet cannot be compared, so it is allowed
 * here — the SS-4 gates refuse it later until the state is set. A read that fails is a refusal.
 */
export async function registeredAgentStateProblem(accountId: string, addressId: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const accRes = await db.from('accounts').select('company_name, state_of_formation').eq('id', accountId).maybeSingle()
  if (accRes.error || !accRes.data) return 'Could not check the registered agent against the company. Nothing was saved. Please try again.'
  const addrRes = await db.from('addresses').select('state').eq('id', addressId).maybeSingle()
  if (addrRes.error || !addrRes.data) return 'Could not check the registered agent against the company. Nothing was saved. Please try again.'

  const c = checkAgentInCompanyState({
    companyState: accRes.data.state_of_formation as string | null,
    agentState: addrRes.data.state as string | null,
    companyName: accRes.data.company_name as string | null,
  })
  if (c.ok || c.problem === 'company_state_unknown') return null
  return c.message ?? null
}

export async function checkSs4StateGate(
  accountId: string,
  opts: {
    context: Ss4GateContext
    allowStaleLine6?: boolean
    /** A Line 6 about to be saved in the same call (the MCP ss4_update tool) — checked instead of the stored one. */
    line6Override?: string | null
  },
): Promise<Ss4StateGateResult> {
  const { context } = opts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  const accRes = await db.from('accounts').select('company_name, state_of_formation, registered_agent_id').eq('id', accountId).maybeSingle()
  if (accRes.error || !accRes.data) return { ok: false, kind: 'read_error', message: READ_ERROR }
  const ssRes = await db.from('ss4_applications').select('county_and_state').eq('account_id', accountId).maybeSingle()
  if (ssRes.error) return { ok: false, kind: 'read_error', message: READ_ERROR }

  const account = accRes.data as { company_name: string | null; state_of_formation: string | null; registered_agent_id: string | null }
  const storedLine6 = (ssRes.data?.county_and_state as string | null | undefined) ?? null
  const line6 = opts.line6Override && opts.line6Override.trim() ? opts.line6Override : storedLine6

  let agent: { state: string | null; county: string | null } | null = null
  if (account.registered_agent_id) {
    const agentRes = await db.from('addresses').select('state, county').eq('id', account.registered_agent_id).maybeSingle()
    if (agentRes.error || !agentRes.data) return { ok: false, kind: 'read_error', message: READ_ERROR }
    agent = agentRes.data as { state: string | null; county: string | null }
  }

  // 1. The registered agent itself.
  if (agent) {
    const c = checkAgentInCompanyState({ companyState: account.state_of_formation, agentState: agent.state, companyName: account.company_name })
    if (!c.ok) return { ok: false, kind: 'agent', message: `${c.message} ${NEXT_STEP[context].agent}` }
  }

  // 2. What is printed on Line 6. (A blank Line 6 is not this gate's job: the send and signing steps already refuse a blank one.)
  if (line6 && line6.trim()) {
    const c = checkLine6InCompanyState({ companyState: account.state_of_formation, line6, companyName: account.company_name })
    if (!c.ok) {
      const fixable = !!opts.allowStaleLine6 && !!agent && !!agent.county && !!agent.state && !!stateCode(account.state_of_formation)
      if (fixable) return { ok: true, line6Fix: formatCountyAndState(agent!.county as string, agent!.state as string) }
      return { ok: false, kind: 'line6', message: `${c.message} ${NEXT_STEP[context].line6}` }
    }
  }

  return { ok: true, line6Fix: null }
}
