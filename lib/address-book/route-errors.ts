/** Address book: turns anything thrown inside a route into the plain-words answer the page shows (R099). An AddressBookError keeps its own words and status; anything else is logged and answered generically. */
import type { NextResponse } from "next/server"
import { fail } from "@/lib/address-book/access"
import { isAddressBookError } from "@/lib/address-book/errors"

export function respondError(e: unknown, where: string): NextResponse {
  if (isAddressBookError(e)) return fail(e.status, e.message, e.extra)
  console.error(`[address-book] ${where}:`, e instanceof Error ? e.message : e)
  return fail(500, "Something went wrong on our side. Please try again.")
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v)
