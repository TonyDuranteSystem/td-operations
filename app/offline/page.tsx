/**
 * Offline fallback for the installed PWA (dashboard + portal service workers
 * serve this when a navigation fails with no network).
 *
 * Deliberately self-contained: server component, inline styles, no client JS —
 * it is served from the service-worker cache where framework chunks and
 * stylesheets may not be available, so it must render as plain HTML.
 * Public route (middleware PUBLIC_PREFIXES) so the SW can cache it at install.
 */
export const metadata = { title: 'Offline — TD Operations' }

export default function OfflinePage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        padding: '24px',
        textAlign: 'center',
        background: '#fafafa',
        color: '#18181b',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div style={{ fontSize: '40px' }} aria-hidden>
        📡
      </div>
      <h1 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>You&apos;re offline</h1>
      <p style={{ fontSize: '14px', color: '#52525b', margin: 0, maxWidth: '320px' }}>
        TD Operations needs a connection to show live data. Check your network and try again.
      </p>
      <a
        href="/"
        style={{
          marginTop: '8px',
          padding: '10px 20px',
          borderRadius: '8px',
          background: '#18181b',
          color: '#ffffff',
          fontSize: '14px',
          fontWeight: 500,
          textDecoration: 'none',
        }}
      >
        Retry
      </a>
    </div>
  )
}
