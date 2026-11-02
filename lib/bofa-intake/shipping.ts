/**
 * Bank application intake — the SHIPPING address printed on every application (Antonio 2026-11-02: "a pre-filled field for
 * the shipping address, with Seminole already pre-filled").
 *
 * It is our Seminole office, the same for every applicant (it is where the bank posts the debit cards and letters). The
 * client sees it on the form, read-only; the SERVER writes it into the saved answers at submit time — nothing the browser
 * sends can change it, and an application started before this existed still gets it. The words come from TD_OFFICE
 * (lib/td-address.ts), the same source as the Shipping Address card clients see in the portal, so there is one place to
 * change if the office ever moves. Pure + client-safe (the form page and the server both use it).
 */

import { TD_OFFICE } from "@/lib/td-address"

/** The saved-answer keys for the shipping block. Not part of BOFA_TEXT_FIELDS: the client never types or sends them. */
export const BOFA_SHIPPING_FIELDS: { key: string; label: string }[] = [
  { key: "shipping_name", label: "Shipping address: name" },
  { key: "shipping_street", label: "Shipping address: street" },
  { key: "shipping_city", label: "Shipping address: city" },
  { key: "shipping_region", label: "Shipping address: state" },
  { key: "shipping_zip", label: "Shipping address: zip code" },
  { key: "shipping_country", label: "Shipping address: country" },
]

export const BOFA_SHIPPING_KEYS: string[] = BOFA_SHIPPING_FIELDS.map((f) => f.key)

/** The locked shipping address, as saved answers. */
export function shippingAddressFields(): Record<string, string> {
  return {
    shipping_name: TD_OFFICE.company,
    shipping_street: TD_OFFICE.street,
    shipping_city: TD_OFFICE.city,
    shipping_region: TD_OFFICE.state,
    shipping_zip: TD_OFFICE.zip,
    shipping_country: TD_OFFICE.country,
  }
}

/** The answers with the shipping block stamped on (always OUR address: anything the browser sent under these keys is replaced). */
export function withShippingAddress(data: Record<string, string>): Record<string, string> {
  return { ...data, ...shippingAddressFields() }
}

/** The address as printed lines, for the form, the email and the PDF. */
export function shippingAddressLines(): string[] {
  return [TD_OFFICE.company, TD_OFFICE.street, `${TD_OFFICE.city}, ${TD_OFFICE.state} ${TD_OFFICE.zip}`, TD_OFFICE.country]
}
