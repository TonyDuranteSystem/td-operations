import { localeFromLanguage } from '@/lib/locale'

/**
 * Gender-aware greeting helper.
 * Uses contacts.gender (M/F) + language to produce the correct salutation.
 *
 * Italian: Caro {firstName} (M), Cara {firstName} (F), Gentile {firstName} (unknown)
 * English: Dear Mr. {lastName} (M), Dear Ms. {lastName} (F), Dear {firstName} (unknown)
 */
export function getGreeting(
  opts: {
    firstName: string
    lastName?: string | null
    gender?: string | null   // 'M' | 'F' | null
    language?: string | null // 'it' | 'en' | 'Italian' | 'English' | null
  }
): string {
  const { firstName, lastName, gender } = opts
  const lang = localeFromLanguage(opts.language)

  if (lang === 'it') {
    if (gender === 'F') return `Cara ${firstName}`
    if (gender === 'M') return `Caro ${firstName}`
    return `Gentile ${firstName}`
  }

  // English (default)
  if (gender === 'F' && lastName) return `Dear Ms. ${lastName}`
  if (gender === 'M' && lastName) return `Dear Mr. ${lastName}`
  return `Dear ${firstName}`
}
