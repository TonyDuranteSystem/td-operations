import { LegalPage } from '@/components/legal/legal-page'
import { LEGAL_UPDATED, PRIVACY_SECTIONS, PRIVACY_TITLE } from '@/lib/legal/td-social-pages'

// Public page (middleware PUBLIC_PREFIXES): the App Store's privacy policy link for the TD Social app.
export const metadata = { title: 'Privacy Policy — TD Social', description: 'How the TD Social team app of Tony Durante LLC handles information.' }

export default function PrivacyPage() {
  return <LegalPage title={PRIVACY_TITLE} updated={LEGAL_UPDATED} sections={PRIVACY_SECTIONS} footerLink={{ href: '/support', label: 'TD Social support' }} />
}
