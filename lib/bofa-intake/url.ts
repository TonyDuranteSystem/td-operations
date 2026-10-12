import { APP_BASE_URL } from "@/lib/config"

/** The client-facing one-time link. Never a hardcoded domain (R012). */
export function bofaLinkUrl(token: string): string {
  return `${APP_BASE_URL}/bank-application/${token}`
}
