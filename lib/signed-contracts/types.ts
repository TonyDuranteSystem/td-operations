/** What the Signed contracts card shows for one signing. Client-safe: no storage path, no personal data. */

export type AmountsView =
  | { kind: 'jan-jun'; january: string; june: string; yearly: string | null }
  /** a layout or value this screen cannot split into January and June: the saved text, as it is */
  | { kind: 'lines'; lines: string[] }

export interface SignedContractEntry {
  /** contracts.id — the signing record (also the key the open and edit routes use) */
  id: string
  offerToken: string
  contractType: string | null
  chip: string
  title: string
  signedAt: string | null
  version: string | null
  /** where the amounts are saved: on the contract itself, or on the annual agreement (renewals) */
  source: 'contract' | 'agreement'
  /** null = this kind of contract has no installment amounts */
  amounts: AmountsView | null
  /** this kind of contract can have its amounts corrected (whether THIS person may is decided separately) */
  amountsEditable: boolean
  /** starting text for the two edit boxes */
  editStart: { january: string; june: string } | null
  /** "$" or "€" when the offer says which; empty when unknown (never guessed) */
  symbol: string
  /** the signed PDF is recorded; false = the line shows but the button is greyed out */
  fileAvailable: boolean
  /** the last correction, shown under the line */
  correction: { byName: string; at: string; wasText: string } | null
  /** changes whenever the saved amounts change; sent back with an edit so two people cannot overwrite each other */
  updatedAt: string | null
}

export const AMOUNTS_CORRECTED_ACTION = 'signed_contract_amounts_corrected'
