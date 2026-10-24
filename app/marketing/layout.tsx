import type { Metadata, Viewport } from 'next'
import './marketing-dark.css'
import { getTheme } from '@/lib/marketing/theme-server'

/**
 * TD Marketing workspace (dev job 9aec66fa). Its own bare frame: none of the CRM's menus, header or notes.
 * Access is decided by middleware (lib/auth/role-door.ts: a marketing login reaches only this area) and again by the shared
 * guard in each page and API (lib/marketing/guard.ts).
 */
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' }
export const metadata: Metadata = { title: 'TD Marketing', description: 'Tony Durante LLC — marketing workspace' }

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  // the look (light / dark / follow the computer) is decided here, on the server, from the person's own cookie; marketing-dark.css re-colours the same classes
  return <div id="tdm-root" data-tdm-theme={getTheme()} className="min-h-screen bg-slate-50 text-slate-900">{children}</div>
}
