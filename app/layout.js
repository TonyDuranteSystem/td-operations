import './globals.css'

export const metadata = {
  title: 'TD Operations — Tony Durante LLC',
  description: 'CRM Dashboard for Tony Durante LLC operations',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
