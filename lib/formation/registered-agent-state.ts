/**
 * The registered-agent state rule (dev job ff2b73d7).
 *
 * A company's registered agent must be in the company's own state. The SS-4's Line 6 is copied from the registered agent's county and
 * state, so a wrong-state agent silently puts the wrong state on a form that goes to the IRS (Tanto per: a New Mexico company, the
 * Wyoming agent linked by hand, "Sheridan County, Wyoming" faxed to the IRS).
 *
 * PURE and client-safe (no database, no server imports) — the picker in the browser and every server gate use the SAME rule. The two
 * places the state is stored spell it differently ("New Mexico" on the company, "NM" on the agent's address, a mix on older companies),
 * so everything is compared as a two-letter code and a spelling difference never blocks anything.
 */

/** State code -> name. Also the table `formatCountyAndState` (lib/addresses.ts) prints Line 6 with. */
export const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
}

const NAME_TO_CODE: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  const codes = Object.keys(STATE_NAMES)
  for (let i = 0; i < codes.length; i++) out[STATE_NAMES[codes[i]].toUpperCase()] = codes[i]
  out['WASHINGTON DC'] = 'DC'
  out['WASHINGTON D C'] = 'DC'
  return out
})()

/** "New Mexico" / "NM" / "nm" / "N.M." -> "NM". null when it is blank or not a state we know (never a guess). */
export function stateCode(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[.]/g, '').replace(/\s+/g, ' ').trim().toUpperCase()
  if (!cleaned) return null
  if (STATE_NAMES[cleaned]) return cleaned
  return NAME_TO_CODE[cleaned] ?? null
}

/** "NM" -> "New Mexico" (the plain-English name used in every message). Falls back to the text itself. */
export function stateLabel(value: string | null | undefined): string {
  const code = stateCode(value)
  if (code) return STATE_NAMES[code]
  return typeof value === 'string' && value.trim() ? value.trim() : 'an unknown state'
}

/**
 * The state printed on SS-4 Line 6: "Sheridan County, Wyoming" -> "WY". Reads what follows the LAST comma (or the last " - " of the one
 * older row that was typed "Bernalillo - New Mexico"). null when the line is blank or its state cannot be read.
 */
export function line6State(line6: string | null | undefined): string | null {
  if (typeof line6 !== 'string') return null
  const text = line6.trim()
  if (!text) return null
  const comma = text.lastIndexOf(',')
  if (comma > -1) return stateCode(text.slice(comma + 1))
  const dash = text.lastIndexOf(' - ')
  if (dash > -1) return stateCode(text.slice(dash + 3))
  return null
}

export type RaStateProblem = 'company_state_unknown' | 'agent_state_unknown' | 'mismatch'

export interface RaStateCheck {
  ok: boolean
  problem?: RaStateProblem
  companyState: string | null
  agentState: string | null
  /** Plain-English sentence for staff (shown as it is, in the picker, the SS-4 panel and the fax panel). Present when ok is false. */
  message?: string
}

function whose(companyName: string | null | undefined): string {
  return companyName && companyName.trim() ? companyName.trim() : 'this company'
}

/** The registered agent's state must be the company's state. */
export function checkAgentInCompanyState(input: {
  companyState: string | null | undefined
  agentState: string | null | undefined
  companyName?: string | null
}): RaStateCheck {
  const companyState = stateCode(input.companyState)
  const agentState = stateCode(input.agentState)
  const who = whose(input.companyName)
  if (!companyState) {
    return {
      ok: false, problem: 'company_state_unknown', companyState, agentState,
      message: `The state ${who} is formed in is not set, so its registered agent cannot be checked. Set the company's state first.`,
    }
  }
  if (!agentState) {
    return {
      ok: false, problem: 'agent_state_unknown', companyState, agentState,
      message: `The registered agent linked to ${who} has no state on its address entry, so it cannot be checked. Fix that entry in the Addresses registry first.`,
    }
  }
  if (companyState !== agentState) {
    return {
      ok: false, problem: 'mismatch', companyState, agentState,
      message:
        `The registered agent for ${who} is in ${STATE_NAMES[agentState]}, but the company is formed in ${STATE_NAMES[companyState]}. ` +
        `A company's registered agent must be in its own state. Pick a ${STATE_NAMES[companyState]} registered agent on the company.`,
    }
  }
  return { ok: true, companyState, agentState }
}

/** The state printed on the SS-4's Line 6 must be the company's state (what the IRS actually reads). */
export function checkLine6InCompanyState(input: {
  companyState: string | null | undefined
  line6: string | null | undefined
  companyName?: string | null
}): RaStateCheck {
  const companyState = stateCode(input.companyState)
  const printedState = line6State(input.line6)
  const who = whose(input.companyName)
  if (!companyState) {
    return {
      ok: false, problem: 'company_state_unknown', companyState, agentState: printedState,
      message: `The state ${who} is formed in is not set, so Line 6 of its SS-4 cannot be checked. Set the company's state first.`,
    }
  }
  if (!printedState) {
    return {
      ok: false, problem: 'agent_state_unknown', companyState, agentState: printedState,
      message: `The state on Line 6 of this SS-4 ("${(input.line6 ?? '').trim() || 'blank'}") cannot be read. It must end with the state, like "Bernalillo County, New Mexico".`,
    }
  }
  if (printedState !== companyState) {
    return {
      ok: false, problem: 'mismatch', companyState, agentState: printedState,
      message:
        `Line 6 of this SS-4 says ${STATE_NAMES[printedState]}, but ${who} is formed in ${STATE_NAMES[companyState]}. ` +
        `Line 6 follows the registered agent, which must be in the company's own state.`,
    }
  }
  return { ok: true, companyState, agentState: printedState }
}
