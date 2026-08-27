/**
 * Which contract type a bundled multi-service offer counts as, for gating the
 * Entity Type / State of Formation / Multiple Options sections in the Create
 * Offer dialog. 'formation' and 'onboarding' each unlock sections none of the
 * other contract types need, so they must win whenever present in the
 * selection — NOT just when they happen to be the first service the staffer
 * checked.
 *
 * Bug report (dev job 3c1bb5fa, 2026-08-26): the dialog used a plain
 * first-match loop over the selection in click order. On a bundled offer
 * (Company Formation + ITIN Application), checking ITIN before Company
 * Formation silently hid Entity Type, State of Formation, AND Multiple
 * Options — all three — with no indication anything was missing. Reproduced
 * live: `{"hasEntityType":false,"hasMultipleOptions":false,"hasStateOfFormation":false}`.
 */
export function deriveContractType(selectedContractTypes: Array<string | null | undefined>): string {
  const types = selectedContractTypes.filter((t): t is string => !!t)
  if (types.includes('formation')) return 'formation'
  if (types.includes('onboarding')) return 'onboarding'
  return types[0] ?? 'formation'
}
