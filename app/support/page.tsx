import { LegalPage } from '@/components/legal/legal-page'
import { SUPPORT_SECTIONS, SUPPORT_TITLE } from '@/lib/legal/td-social-pages'

// Public page (middleware PUBLIC_PREFIXES): the App Store's support link for the TD Social app.
export const metadata = { title: 'Support — TD Social', description: 'Help with the TD Social team app of Tony Durante LLC.' }

export default function SupportPage() {
  return <LegalPage title={SUPPORT_TITLE} sections={SUPPORT_SECTIONS} footerLink={{ href: '/privacy', label: 'Privacy Policy for TD Social' }} />
}
