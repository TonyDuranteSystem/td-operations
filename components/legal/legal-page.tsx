import type { LegalSection } from '@/lib/legal/td-social-pages'

/**
 * A plain public reading page (Privacy Policy, Support) for the TD Social app. Server component, no client code, no login:
 * App Store reviewers and anyone with the link must be able to read it. Layout only; the wording is in lib/legal/td-social-pages.ts.
 */
export function LegalPage({ title, updated, sections, footerLink }: {
  title: string
  updated?: string
  sections: LegalSection[]
  footerLink?: { href: string; label: string }
}) {
  return (
    <main className="min-h-screen bg-white text-zinc-900">
      <div className="mx-auto max-w-2xl px-5 py-10 sm:py-14">
        <p className="text-sm font-semibold tracking-wide text-[#BE1E2D]">Tony Durante LLC</p>
        <h1 className="mt-1 text-2xl font-bold leading-tight sm:text-3xl">{title}</h1>
        {updated && <p className="mt-2 text-sm text-zinc-500">Last updated: {updated}</p>}
        <div className="mt-8 space-y-7">
          {sections.map(s => (
            <section key={s.heading}>
              <h2 className="text-lg font-semibold">{s.heading}</h2>
              {s.paragraphs?.map(p => <p key={p} className="mt-2 leading-relaxed text-zinc-700">{p}</p>)}
              {s.bullets && (
                <ul className="mt-2 list-disc space-y-1.5 pl-5 text-zinc-700">
                  {s.bullets.map(b => <li key={b} className="leading-relaxed">{b}</li>)}
                </ul>
              )}
              {s.after?.map(p => <p key={p} className="mt-3 leading-relaxed text-zinc-700">{p}</p>)}
            </section>
          ))}
        </div>
        {footerLink && (
          <p className="mt-10 border-t border-zinc-200 pt-5 text-sm">
            <a href={footerLink.href} className="font-medium text-[#BE1E2D] underline underline-offset-2">{footerLink.label}</a>
          </p>
        )}
      </div>
    </main>
  )
}
