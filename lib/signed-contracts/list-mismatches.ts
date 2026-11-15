/**
 * Which people on the Contacts list get the amber flag: the ones with a signed contract whose amounts the Contact page's "Signed contracts"
 * card marks amber (dev job 02dbf9d3, Antonio 2026-11-15). Pure (no database), so every rule here is unit-tested.
 *
 * It does not re-decide anything. The lines come from the SAME `buildEntries` the card uses (newest file per offer, the same reading of the
 * saved amounts, the same company check), and a person owns a contract the SAME four ways the card lists it: the offer was made for them
 * (offers.contact_id), was sent to their email (any letter case), was made from a lead that became them, or is filed on a company they
 * are linked to. So the list and the Contact page cannot disagree about who is flagged.
 *
 * Only the two amber findings flag a person: "differs" and "the company has no amounts". Every grey "not compared" / "could not compare"
 * case flags nobody, exactly as it draws no amber on the card. Nothing here reads a passport or an address; the email is used only to
 * match and never leaves this function.
 */
import { buildEntries, type ContractRow, type OfferRow } from './entries'
import type { CompanyLookup } from './company-check'
import type { ContractMismatch } from './types'

/** The columns of an offer that say whose it is, on top of what the card's own lines read. */
export interface OfferWithOwners extends OfferRow {
  contact_id: string | null
  client_email: string | null
  lead_id: string | null
}

/** A person on the page: their id, email and the companies they are linked to. */
export interface MismatchPerson {
  id: string
  email: string | null
  accountIds: string[]
}

export function contractMismatchesByPerson(input: {
  people: MismatchPerson[]
  /** lead id → the person that lead became (leads.converted_to_contact_id) */
  leadPerson: Map<string, string>
  offers: OfferWithOwners[]
  contracts: ContractRow[]
  companies: CompanyLookup
  /** company id → its name, for the words of the finding */
  companyNames: Map<string, string>
}): Map<string, ContractMismatch[]> {
  const offerByToken = new Map(input.offers.map((o) => [o.token, o]))
  const entries = buildEntries({ offers: input.offers, contracts: input.contracts, agreements: [], corrections: [], companies: input.companies })

  // the amber lines, by offer: one finding per offer (its newest signing)
  const flagged = new Map<string, ContractMismatch>()
  for (const e of entries) {
    const check = e.companyCheck
    if (!check || (check.state !== 'differ' && check.state !== 'company_empty')) continue
    if (e.amounts?.kind !== 'jan-jun') continue
    const offer = offerByToken.get(e.offerToken)
    if (!offer) continue
    flagged.set(e.offerToken, {
      kind: check.state === 'differ' ? 'differs' : 'company_empty',
      company: (offer.account_id && input.companyNames.get(offer.account_id)) || 'The company',
      contract: e.chip,
      contractAmounts: `January ${e.amounts.january} · June ${e.amounts.june}`,
      crmAmounts: check.state === 'differ' ? `January ${check.january} · June ${check.june}` : null,
    })
  }

  const out = new Map<string, ContractMismatch[]>()
  if (flagged.size === 0) return out

  for (const person of input.people) {
    const email = person.email ? person.email.toLowerCase() : null
    const companies = new Set(person.accountIds)
    const mine: ContractMismatch[] = []
    for (const [token, finding] of Array.from(flagged)) {
      const offer = offerByToken.get(token)
      if (!offer) continue
      const isTheirs =
        offer.contact_id === person.id ||
        (email != null && offer.client_email != null && offer.client_email.toLowerCase() === email) ||
        (offer.lead_id != null && input.leadPerson.get(offer.lead_id) === person.id) ||
        (offer.account_id != null && companies.has(offer.account_id))
      if (isTheirs) mine.push(finding)
    }
    if (mine.length > 0) {
      mine.sort((a, b) => a.company.localeCompare(b.company) || a.contract.localeCompare(b.contract))
      out.set(person.id, mine)
    }
  }
  return out
}
