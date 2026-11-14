/**
 * The list of lines on the card, kept in the page (not in the card itself) so a correction survives a tab switch:
 * the Overview tab — and the card in it — is thrown away when another tab is opened. Pure, client-safe.
 */
import type { SignedContractEntry } from './types'

/** The same list with the corrected line in place of the old one; every other line is left as it is. */
export function replaceEntry(entries: SignedContractEntry[], next: SignedContractEntry): SignedContractEntry[] {
  return entries.map((e) => (e.id === next.id ? next : e))
}
