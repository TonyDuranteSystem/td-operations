import { PAYMENT_ITEM_TYPES, type PaymentItemType } from "@/lib/finance/payment-item-vocabulary"

/**
 * A line item as entered by a caller — quantity/unit_price are the source of
 * truth; any `amount` the caller sends is ignored and recomputed here. This
 * mirrors what the New Invoice form already does client-side (it derives
 * `amount = quantity * unit_price` on every keystroke), so the server simply
 * stops trusting a number the client already treats as derived.
 */
export interface InvoiceLineItemInput {
  description: string
  quantity: number
  unit_price: number
  sort_order?: number
  /** Preserved through a recompute, never set by a human — see payment-item-vocabulary.ts. */
  item_type?: PaymentItemType
}

export interface InvoiceLineItemComputed {
  description: string
  quantity: number
  unit_price: number
  amount: number
  sort_order: number
  item_type: PaymentItemType
}

export interface InvoiceTotals {
  items: InvoiceLineItemComputed[]
  subtotal: number
  /** The discount actually applied — floored at 0, never the raw caller value. Persist this, not the input. */
  discount: number
  /** subtotal - discount, floored at 0 — a discount can zero an invoice, never invert it. */
  total: number
}

/** Round to the nearest cent, correcting for binary floating-point representation error. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * The one place invoice subtotal/total is computed from line items. Both
 * createInvoice and the Draft line-item editor call this so a rounding or
 * floor fix lands once, not per copy (dev job ef5da377).
 */
export function computeInvoiceItemTotals(
  items: InvoiceLineItemInput[],
  discount: number,
): InvoiceTotals {
  const computed: InvoiceLineItemComputed[] = items.map((item, i) => ({
    description: item.description,
    quantity: item.quantity,
    unit_price: item.unit_price,
    amount: round2(item.quantity * item.unit_price),
    sort_order: item.sort_order ?? i,
    item_type: item.item_type && (PAYMENT_ITEM_TYPES as readonly string[]).includes(item.item_type)
      ? item.item_type
      : "service",
  }))
  const subtotal = round2(computed.reduce((sum, item) => sum + item.amount, 0))
  // Floored at 0 same as the total below: a negative discount would otherwise
  // ADD to the subtotal instead of reducing it, inflating the total past its
  // own line-item sum — and, for a payment-plan part, silently defeat the
  // "no discount on a plan part" guard, which only rejects discount > 0
  // (bug-hunter pass, dev job ef5da377). createInvoice's caller-side schema
  // already rejects a negative discount before it reaches here; this is the
  // matching floor for updateInvoiceItems, which has no schema of its own.
  const safeDiscount = Math.max(0, discount || 0)
  const total = Math.max(0, round2(subtotal - safeDiscount))
  return { items: computed, subtotal, discount: safeDiscount, total }
}
