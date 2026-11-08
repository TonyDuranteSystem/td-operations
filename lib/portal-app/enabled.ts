/**
 * Client iPhone app — the runtime switches (server; dev job 056a70d0, Step 2).
 *
 * `client_app_enabled` is the first thing every client-app route checks. OFF means the route answers "not switched on" and has NOT
 * read anything about the person, so this code can be merged (and goes live on production the moment it merges) long before the app
 * exists. Only a stored `true` turns it on; a missing row, any other value or a failed read is OFF (fails CLOSED), the opposite of a
 * switch that removes something people already have. It lives in app_settings so it can be flipped without a deploy; there is no
 * screen for it, Claude sets it on Antonio's word.
 *
 * `client_app_pay_enabled` decides whether the app shows the Pay button. It is the OPPOSITE kind of switch: Pay is ON unless a stored
 * value says `false` (the true/false value, or the text "false" in case it was typed by hand: Antonio's kill switch in case Apple
 * objects to card payment inside the app), so a failed read must not hide Pay from every client.
 */
import { getAppSetting } from "@/lib/settings"

export const CLIENT_APP_NOT_ENABLED = { error: "The app is not switched on yet.", code: "APP_NOT_ENABLED" } as const

export async function isClientAppEnabled(): Promise<boolean> {
  try {
    return (await getAppSetting<unknown>("client_app_enabled", false)) === true
  } catch {
    return false
  }
}

export async function isClientAppPayEnabled(): Promise<boolean> {
  try {
    const v = await getAppSetting<unknown>("client_app_pay_enabled", true)
    return !(v === false || (typeof v === "string" && v.trim().toLowerCase() === "false"))
  } catch {
    return true
  }
}
