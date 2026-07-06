/**
 * TD Communication — Client Landing renderer (Phase 16).
 *
 * Pure, prop-driven presentational component. Used by BOTH the public
 * /site/[slug] page (published snapshot) AND the editor's live preview (draft).
 * No hooks → server- and client-safe. All text is rendered as TEXT (React escapes
 * it); every href/image URL is already sanitized upstream in client-landing.ts.
 */

import { FONT_STACKS } from '@/lib/td-communication/client-landing'
import type {
  ClandTheme,
  ClandSection,
  ClandHeroSection,
  ClandAboutSection,
  ClandServicesSection,
  ClandGallerySection,
  ClandContactSection,
  ClandCustomTextSection,
} from '@/lib/td-communication/types'

function Hero({ s, theme }: { s: ClandHeroSection; theme: ClandTheme }) {
  return (
    <section style={{ background: theme.primary, color: theme.text, padding: '64px 24px', textAlign: 'center' }}>
      {theme.logo_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={theme.logo_url}
          alt=""
          style={{ maxHeight: 96, maxWidth: 240, objectFit: 'contain', margin: '0 auto 24px', display: 'block' }}
        />
      ) : null}
      {s.headline ? <h1 style={{ fontSize: 40, fontWeight: 800, margin: '0 0 12px', lineHeight: 1.1 }}>{s.headline}</h1> : null}
      {s.subheadline ? <p style={{ fontSize: 18, opacity: 0.9, maxWidth: 640, margin: '0 auto 24px' }}>{s.subheadline}</p> : null}
      {s.cta_label && s.cta_href ? (
        <a
          href={s.cta_href}
          style={{
            display: 'inline-block',
            background: theme.accent,
            color: '#ffffff',
            padding: '12px 28px',
            borderRadius: 8,
            fontWeight: 700,
            textDecoration: 'none',
          }}
        >
          {s.cta_label}
        </a>
      ) : null}
    </section>
  )
}

function TextBlock({ heading, body, theme }: { heading: string; body: string; theme: ClandTheme }) {
  return (
    <section style={{ padding: '48px 24px', maxWidth: 800, margin: '0 auto' }}>
      {heading ? <h2 style={{ fontSize: 28, fontWeight: 700, color: theme.primary, margin: '0 0 16px' }}>{heading}</h2> : null}
      {body ? <p style={{ fontSize: 17, lineHeight: 1.7, color: theme.text, whiteSpace: 'pre-wrap' }}>{body}</p> : null}
    </section>
  )
}

function Services({ s, theme }: { s: ClandServicesSection; theme: ClandTheme }) {
  if (s.items.length === 0 && !s.heading) return null
  return (
    <section style={{ padding: '48px 24px', maxWidth: 1000, margin: '0 auto' }}>
      {s.heading ? <h2 style={{ fontSize: 28, fontWeight: 700, color: theme.primary, margin: '0 0 24px', textAlign: 'center' }}>{s.heading}</h2> : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 20 }}>
        {s.items.map((it, i) => (
          <div key={i} style={{ border: `1px solid ${theme.secondary}22`, borderRadius: 10, padding: 20 }}>
            {it.title ? <h3 style={{ fontSize: 18, fontWeight: 700, color: theme.secondary, margin: '0 0 8px' }}>{it.title}</h3> : null}
            {it.description ? <p style={{ fontSize: 15, lineHeight: 1.6, color: theme.text, margin: 0 }}>{it.description}</p> : null}
          </div>
        ))}
      </div>
    </section>
  )
}

function Gallery({ s, theme }: { s: ClandGallerySection; theme: ClandTheme }) {
  if (s.images.length === 0) return null
  return (
    <section style={{ padding: '48px 24px', maxWidth: 1000, margin: '0 auto' }}>
      {s.heading ? <h2 style={{ fontSize: 28, fontWeight: 700, color: theme.primary, margin: '0 0 24px', textAlign: 'center' }}>{s.heading}</h2> : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
        {s.images.map((img, i) => (
          <figure key={i} style={{ margin: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.image_url} alt={img.caption || ''} style={{ width: '100%', height: 200, objectFit: 'contain', background: '#f8f8f8', borderRadius: 8 }} />
            {img.caption ? <figcaption style={{ fontSize: 13, color: theme.text, opacity: 0.7, marginTop: 6, textAlign: 'center' }}>{img.caption}</figcaption> : null}
          </figure>
        ))}
      </div>
    </section>
  )
}

function Contact({ s, theme }: { s: ClandContactSection; theme: ClandTheme }) {
  return (
    <section style={{ padding: '48px 24px', background: `${theme.secondary}11`, textAlign: 'center' }}>
      {s.heading ? <h2 style={{ fontSize: 28, fontWeight: 700, color: theme.primary, margin: '0 0 16px' }}>{s.heading}</h2> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
        {s.email ? <a href={`mailto:${s.email}`} style={{ color: theme.accent, fontSize: 16, textDecoration: 'none' }}>{s.email}</a> : null}
        {s.phone ? <a href={`tel:${s.phone}`} style={{ color: theme.accent, fontSize: 16, textDecoration: 'none' }}>{s.phone}</a> : null}
        {s.links.length > 0 ? (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 }}>
            {s.links.map((l, i) => (
              <a key={i} href={l.href} target="_blank" rel="noopener noreferrer nofollow" style={{ color: theme.secondary, fontSize: 15 }}>
                {l.label || l.href}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function SectionView({ section, theme }: { section: ClandSection; theme: ClandTheme }) {
  switch (section.type) {
    case 'hero':
      return <Hero s={section as ClandHeroSection} theme={theme} />
    case 'about':
      return <TextBlock heading={(section as ClandAboutSection).heading} body={(section as ClandAboutSection).body} theme={theme} />
    case 'services':
      return <Services s={section as ClandServicesSection} theme={theme} />
    case 'gallery':
      return <Gallery s={section as ClandGallerySection} theme={theme} />
    case 'contact':
      return <Contact s={section as ClandContactSection} theme={theme} />
    case 'custom_text':
      return <TextBlock heading={(section as ClandCustomTextSection).heading} body={(section as ClandCustomTextSection).body} theme={theme} />
    default:
      return null
  }
}

export function ClientLandingRenderer({
  title,
  theme,
  sections,
}: {
  title?: string
  theme: ClandTheme
  sections: ClandSection[]
}) {
  const visible = sections.filter((s) => s.enabled)
  return (
    <div style={{ fontFamily: FONT_STACKS[theme.font_key], color: theme.text, background: '#ffffff', minHeight: '100%' }}>
      {visible.length === 0 ? (
        <div style={{ padding: '80px 24px', textAlign: 'center', color: '#9ca3af' }}>
          {title ? <h1 style={{ fontSize: 28, fontWeight: 700, color: theme.primary }}>{title}</h1> : null}
          <p>This page is being built.</p>
        </div>
      ) : (
        visible.map((s) => <SectionView key={s.id} section={s} theme={theme} />)
      )}
    </div>
  )
}
