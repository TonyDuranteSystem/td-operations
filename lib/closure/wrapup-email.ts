/**
 * Who the closing email would go to. CLIENT-SAFE on purpose: no value imports, so the Wrap-up panel (a browser component) can use it
 * without pulling the server-only database client in through wrapup-facts.ts.
 */

import type { WrapUpPerson } from '@/lib/closure/wrapup-facts'

/** The emails the closing message would go to: one per distinct address, in the person's language. */
export function closingEmailRecipients(people: WrapUpPerson[]): { name: string; email: string; language: 'it' | 'en' }[] {
  const seen = new Set<string>()
  const out: { name: string; email: string; language: 'it' | 'en' }[] = []
  for (const p of people) {
    const email = p.email?.toLowerCase()
    if (!email || seen.has(email)) continue
    seen.add(email)
    out.push({ name: p.name, email: p.email as string, language: p.emailLanguage })
  }
  return out
}
