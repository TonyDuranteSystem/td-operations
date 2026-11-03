/**
 * The owner's "Test Zoom" check (TD Marketing, dev job 9aec66fa, 3 Nov 2026). Zoom keys live only in the live app, so the test runs there: it makes ONE 15-minute test meeting for the person named, deletes it at once,
 * and asks Zoom whether the app may read that person's cloud recordings (needed to save recordings in the CRM storage). Nothing is stored. Everything goes through `ZoomApi`, so it is tested with a fake.
 */
import { makeZoomApi, zoomConfigured, type ZoomApi } from "@/lib/zoom"

export interface ZoomTestCheck { name: string; ok: boolean; detail: string }
export interface ZoomTestResult { ok: boolean; checks: ZoomTestCheck[] }

export const ZOOM_TEST_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Zoom's refusal in plain words (the app's own message is kept at the end, it holds no secret). */
export function explainZoomError(message: string): string {
  const m = message || "Zoom did not answer."
  if (/refused the login/i.test(m)) return `Zoom did not accept the app's keys. ${m}`
  if (/not set up/i.test(m)) return "The Zoom keys are not set in the live app."
  if (/\b1001\b|does not exist|not found|answered 404/i.test(m)) return `Zoom has no user with this email in our account. ${m}`
  if (/\b4711\b|scopes?|invalid access token/i.test(m)) return `The Zoom app is missing a permission (scope). ${m}`
  return m
}

export async function runZoomHostTest(hostEmail: string, makeApi: (host: string) => ZoomApi, now: Date = new Date()): Promise<ZoomTestResult> {
  const host = hostEmail.trim()
  const checks: ZoomTestCheck[] = []
  if (!ZOOM_TEST_EMAIL.test(host)) return { ok: false, checks: [{ name: "Zoom login email", ok: false, detail: "That is not an email address." }] }
  const api = makeApi(host)
  let id: string | null = null
  try {
    const m = await api.createMeeting({ topic: "TD test - delete me", startIso: new Date(now.getTime() + 24 * 3600_000).toISOString(), minutes: 15, timeZone: "UTC" })
    id = m.id
    checks.push({ name: `A meeting hosted by ${host}`, ok: true, detail: "Zoom let our app make a meeting for this person." })
  } catch (e) {
    checks.push({ name: `A meeting hosted by ${host}`, ok: false, detail: explainZoomError(e instanceof Error ? e.message : String(e)) })
  }
  if (id !== null) {
    try { await api.deleteMeeting(id); checks.push({ name: "The test meeting removed", ok: true, detail: "Nothing was left in Zoom." }) } catch (e) { checks.push({ name: "The test meeting removed", ok: false, detail: `The test meeting ${id} is still in Zoom: delete it by hand. ${explainZoomError(e instanceof Error ? e.message : String(e))}` }) }
  }
  if (api.checkRecordings) {
    try { await api.checkRecordings(); checks.push({ name: `Reading ${host}'s recordings`, ok: true, detail: "The app may read this person's cloud recordings." }) } catch (e) { checks.push({ name: `Reading ${host}'s recordings`, ok: false, detail: explainZoomError(e instanceof Error ? e.message : String(e)) }) }
  }
  return { ok: checks.every(c => c.ok), checks }
}

/** The live wiring: the app's own keys from the environment, one host per call. */
export function liveZoomHostTest(hostEmail: string): Promise<ZoomTestResult> {
  if (!zoomConfigured()) return Promise.resolve({ ok: false, checks: [{ name: "Zoom keys", ok: false, detail: "The Zoom keys are not set in this environment." }] })
  return runZoomHostTest(hostEmail, host => makeZoomApi({ ...process.env, ZOOM_HOST_USER: host }))
}
