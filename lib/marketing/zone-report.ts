/**
 * TD Marketing: a person's time zone follows where they connect (pure; dev job 9aec66fa; Antonio, 31 Oct 2026: "if I'm traveling or Rocco is traveling, the time must change accordingly").
 * Each person's browser reports its own zone when a Marketing screen opens (and when the tab comes back); the server keeps the newest one as that person's zone. This file decides which
 * report is believed. No database and no network here.
 */
import { isValidZone } from "@/lib/marketing/zones"

/** Zones a browser shows when it hides the real one (privacy modes) or does not know it: never believed, the stored zone stays. */
const NOT_A_PLACE = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Etc/Unknown", "Etc/Universal", "Etc/Zulu"])

/** Is this reported zone a real place we may store? */
export function isUsableDeviceZone(zone: unknown): zone is string {
  return typeof zone === "string" && isValidZone(zone.trim()) && !NOT_A_PLACE.has(zone.trim())
}

/** The zone to store for a person, or null when nothing should change (not a real place, or the same as what is stored). */
export function zoneToStore(reported: unknown, stored: string): string | null {
  if (!isUsableDeviceZone(reported)) return null
  const z = reported.trim()
  return z === stored ? null : z
}
