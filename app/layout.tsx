import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import { Toaster } from 'sonner'
import { SandboxBanner } from '@/components/sandbox-banner'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#18181b',
}

export const metadata: Metadata = {
  title: 'TD Operations',
  description: 'CRM Dashboard — Tony Durante LLC',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '32x32' },
      { url: '/portal-icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'TD Ops',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="it">
      <body className={inter.className}>
        <SandboxBanner />
        {children}
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  )
}
