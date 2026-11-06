// The two public pages the App Store asks for, for the TD Social phone app (dev job 2072bc3e): the Privacy Policy and the Support page.
// Plain data, so the wording lives in one place and a test can pin that no draft marker is left in it. Served at /privacy and /support
// (public in middleware.ts). Wording written from what the app really does (docs/systems/social-app.md); Antonio reviews it before it goes live.

export const LEGAL_UPDATED = '6 November 2026'
export const LEGAL_CONTACT_EMAIL = 'support@tonydurante.us'

export interface LegalSection {
  heading: string
  paragraphs?: string[]
  bullets?: string[]
  /** paragraphs shown AFTER the bullets */
  after?: string[]
}

export const PRIVACY_TITLE = 'Privacy Policy for the TD Social app'

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    heading: '1. Who we are',
    paragraphs: [
      'Tony Durante LLC ("we", "us") provides tax and business consulting services. TD Social is our private team app. It is for our team members and partners only. Clients do not use it.',
    ],
  },
  {
    heading: '2. What we collect',
    paragraphs: ['We collect the following.'],
    bullets: [
      'Account details: your name, work email address and role, which an administrator enters when your account is created.',
      'Content you send and receive in the app: chat messages, photos, files and voice messages, and the client, WhatsApp and email conversations your role lets you open.',
      'Phone details for alerts: the alert address Apple gives your phone, the name you gave your phone, the app version and the time the app was last used.',
      'Your settings: which alerts you switched off, and when you last opened a mailbox (to count new email).',
      'Error information: if the app or its pages fail, we receive technical details about the error and how fast pages load, through an error-monitoring service.',
    ],
    after: [
      'We do not collect your location, contacts, health data or payment details in this app. We do not use advertising or tracking tools.',
    ],
  },
  {
    heading: '3. How we use it',
    paragraphs: [
      'To let you sign in and use the app, to deliver messages and alerts, to keep our business records, to keep the service secure and to fix errors.',
    ],
  },
  {
    heading: '4. Who we share it with',
    paragraphs: [
      'We do not sell your information. We use service providers to run the app. They handle data only to provide their service to us:',
    ],
    bullets: [
      'Vercel: hosting.',
      'Supabase: database, sign-in and file storage.',
      'Apple: push alerts to your phone.',
      'Google: access to the company email.',
      'Sentry: error monitoring.',
      'OpenAI: turning a voice message into text, only when you tap "Show text" on it.',
    ],
  },
  {
    heading: '5. Messages from other people',
    paragraphs: [
      'Messages from clients and other people reach you through the channels our business uses (the client portal, WhatsApp and email). Their content is handled under our client privacy practices.',
    ],
  },
  {
    heading: '6. Alerts',
    paragraphs: [
      'Alerts for client messages and email show who wrote and not what they wrote. Alerts for direct messages between team members may show the message text on the lock screen. You can switch alerts off for each tab in the app or in your iPhone settings.',
    ],
  },
  {
    heading: '7. How long we keep it',
    paragraphs: [
      'Business messages and records are kept as long as we need them for our services and legal duties. Your phone\'s alert address is removed when you sign out. When someone leaves the team, an administrator switches off their login.',
    ],
  },
  {
    heading: '8. Security',
    paragraphs: [
      'We use encrypted connections, role-based access (each person sees only what their role allows) and, where it is switched on, two-step sign-in.',
    ],
  },
  {
    heading: '9. Your choices and rights',
    paragraphs: [
      `You can ask us to see, correct or delete the personal information we hold about you by writing to ${LEGAL_CONTACT_EMAIL}. We may keep information we are required to keep by law.`,
    ],
  },
  {
    heading: '10. Children',
    paragraphs: ['The app is not for children.'],
  },
  {
    heading: '11. Changes',
    paragraphs: ['If we change this policy we will update the date at the top of this page.'],
  },
  {
    heading: '12. Contact',
    paragraphs: [`Tony Durante LLC, ${LEGAL_CONTACT_EMAIL}`],
  },
]

export const SUPPORT_TITLE = 'TD Social support'

export const SUPPORT_SECTIONS: LegalSection[] = [
  {
    heading: 'About the app',
    paragraphs: ['TD Social is the private team app of Tony Durante LLC. It is for our team members and partners.'],
  },
  {
    heading: 'Need help?',
    paragraphs: [
      `Write to ${LEGAL_CONTACT_EMAIL}. Please tell us your name, your phone model and what happened.`,
      'Your account is created by our administrator. If you need access, or want your access switched off, ask us at the same address.',
    ],
  },
]
