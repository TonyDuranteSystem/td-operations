/**
 * TD Marketing — the time zone of a lead (server-side helpers; dev job 9aec66fa, Addendum K, build step B1). A lead has no country saved, so the zone is worked out from the phone number: the country
 * code gives the country, and a country with ONE time zone (or whose zones all keep the same hours) gives the zone. A country with several different zones (the US, Canada, Spain with the Canary
 * Islands, Australia…) is never guessed: the page asks. A zone a person set by hand always wins and is kept in the lead's history. The country and zone lists come from maintained libraries, not from
 * a table typed here. No database.
 */
import { parsePhoneNumberFromString, getCountries, getCountryCallingCode, type CountryCode } from "libphonenumber-js/min"
import { getCountry } from "countries-and-timezones"
import { isValidZone, offsetMinutes } from "@/lib/marketing/zones"

export type ZoneGuess =
  | { kind: "zone"; zone: string; country: string; callingCode: string }
  | { kind: "ask"; country: string | null; callingCode: string; zones: string[] }
  | { kind: "none" }

/** Do all these zones keep the same clock all year (the same offset in January and in July)? Then any of them gives the right time. */
function sameClock(zones: readonly string[], year: number): boolean {
  const key = (z: string) => `${offsetMinutes(new Date(Date.UTC(year, 0, 15, 12)), z)}/${offsetMinutes(new Date(Date.UTC(year, 6, 15, 12)), z)}`
  return new Set(zones.map(key)).size <= 1
}

let byCode: Map<string, string[]> | null = null
function countriesOfCode(code: string): string[] {
  if (!byCode) {
    byCode = new Map()
    for (const c of getCountries()) { const k = getCountryCallingCode(c); byCode.set(k, [...(byCode.get(k) ?? []), c]) }
  }
  return byCode.get(code) ?? []
}

const zonesOf = (country: string): string[] => (getCountry(country)?.timezones ?? []).filter(isValidZone)

/** What a phone number says about the zone. Needs the international form ("+39 …"): a number without a country code says nothing. */
export function guessZoneFromPhone(phone: string | null | undefined, now: Date = new Date()): ZoneGuess {
  const raw = (phone ?? "").trim()
  if (!raw.startsWith("+")) return { kind: "none" }
  const p = parsePhoneNumberFromString(raw)
  if (!p) return { kind: "none" }
  const code = String(p.countryCallingCode)
  const year = now.getUTCFullYear()
  // the country the number belongs to, or every country that shares its country code (+1, +7, +44…)
  const candidates = p.country ? [p.country as CountryCode] : (countriesOfCode(code) as CountryCode[])
  const zones = Array.from(new Set(candidates.flatMap(c => zonesOf(c))))
  if (zones.length === 0) return { kind: "none" }
  if (!sameClock(zones, year)) return { kind: "ask", country: p.country ?? null, callingCode: code, zones }
  return { kind: "zone", zone: zones[0], country: p.country ?? candidates[0], callingCode: code }
}

export interface ZoneEvent { kind: string; created_at: string; actor: string; data: Record<string, unknown> }
export interface LeadZone {
  /** the zone to read the lead's time in, or null while it is not known (the page asks) */
  zone: string | null
  /** where it came from: a person set it, the phone number gave it, or nobody knows yet */
  source: "set" | "phone" | "none"
  /** who set it (their login) when a person did */
  by: string | null
  callingCode: string | null
  /** for an unknown zone: the zones the number could be in, to offer first */
  options: string[]
}

/** The zone of a lead: the newest "zone set" entry of its history wins; otherwise the phone number; otherwise unknown. */
export function leadZoneOf(i: { phone: string | null | undefined; events: readonly ZoneEvent[]; now?: Date }): LeadZone {
  let latest: ZoneEvent | null = null
  for (const e of i.events) {
    if (e.kind !== "zone_set" || !isValidZone(e.data?.zone)) continue
    if (!latest || e.created_at >= latest.created_at) latest = e
  }
  const guess = guessZoneFromPhone(i.phone, i.now)
  const callingCode = guess.kind === "none" ? null : guess.callingCode
  if (latest) return { zone: latest.data.zone as string, source: "set", by: latest.actor, callingCode, options: [] }
  if (guess.kind === "zone") return { zone: guess.zone, source: "phone", by: null, callingCode, options: [] }
  return { zone: null, source: "none", by: null, callingCode, options: guess.kind === "ask" ? guess.zones : [] }
}
