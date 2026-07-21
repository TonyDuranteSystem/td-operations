/**
 * What kind of line an invoice/payment item is.
 *
 * Backed by the database CHECK `payment_items_item_type_check`, and registered
 * in CONSTRAINT_CONTRACTS so the two can never drift apart silently. Before
 * this existed the values lived only as inline string literals in three
 * writers, and nothing verified them against the column.
 *
 * `fee` exists so a surcharge line can be excluded from the base amount —
 * `base = sum(item_type <> 'fee')`. Do not add a value here without the
 * matching migration; the gate will fail the push, which is the point.
 */
export const PAYMENT_ITEM_TYPES = ["service", "fee"] as const
export type PaymentItemType = (typeof PAYMENT_ITEM_TYPES)[number]
