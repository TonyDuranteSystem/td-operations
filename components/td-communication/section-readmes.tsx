'use client'

import type { ReactNode } from 'react'

/**
 * Shared, section-level "How this works — read me" for TD Communication.
 *
 * The same collapsed <details> pattern as the in-project / Design-Tools read-mes,
 * but surfaced at the TOP OF EACH TAB so staff (and Cris on /collab) can learn how
 * a section works WITHOUT opening a project. Native <details> — collapsed by
 * default, no extra JS. Content is keyed so the CRM dashboard and /collab render
 * the same copy for shared sections.
 */
export function SectionReadme({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="shrink-0 rounded-xl border border-zinc-200 bg-white text-sm text-zinc-700">
      <summary className="cursor-pointer select-none px-3 py-2 font-medium text-zinc-800">
        {title}
      </summary>
      <div className="space-y-2 border-t border-zinc-100 px-3 py-3 leading-relaxed text-[13px]">
        {children}
      </div>
    </details>
  )
}

interface ReadmeContent {
  title: string
  body: ReactNode
}

function P({ children }: { children: ReactNode }) {
  return <p>{children}</p>
}
function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc pl-5 space-y-1">
      {items.map((it, i) => <li key={i}>{it}</li>)}
    </ul>
  )
}

/** Read-me copy per section key (shared by the CRM tabs and /collab sections). */
export const SECTION_READMES: Record<string, ReadmeContent> = {
  projects: {
    title: 'How the Projects board works — read me',
    body: (
      <>
        <P>Every branding project is a card on a pipeline board, grouped by stage — <strong>New → In Progress → Ready for Review → Revision → Approved → Delivered</strong>. It&apos;s the same board Cris sees on his side.</P>
        <Bullets items={[
          <>Each card shows the client, the package, the deadline and an <strong>SLA dot</strong> (red = overdue, amber = due soon, green = on time).</>,
          <>Click a card to open its <strong>brief panel</strong> — the brand answers, uploaded materials, deliverables, project chat, private notes, and the status control.</>,
          <>The board moves automatically as work happens (a released concept advances the project), or you can set the status manually inside a project.</>,
        ]} />
      </>
    ),
  },
  deliverables: {
    title: 'How Deliverables work — read me',
    body: (
      <>
        <P>Where the creative files for each project live. Pick a project to manage its deliverables.</P>
        <Bullets items={[
          <>Files are organised by <strong>concept</strong> (A/B/C) and <strong>version</strong> (v1, v2…). Mark them draft vs final.</>,
          <><strong>Release to client</strong> makes a concept visible to the client (behind the disclaimer gate) and advances the project. Releasing a final marks it delivered.</>,
          <>Deleting is a soft-delete — staff keep an audit trail, the client stops seeing it.</>,
        ]} />
      </>
    ),
  },
  'design-tools': {
    title: 'How the Design Tools work — read me',
    body: (
      <>
        <P>Three in-browser accelerators that turn a project&apos;s brand brief into usable assets. You still design the logo in your own software — these handle everything around it.</P>
        <Bullets items={[
          <><strong>Palette</strong> — generate colour schemes + contrast (accessibility) checks and export them.</>,
          <><strong>Mockups</strong> — preview a logo on a card, letterhead, social post, website; export a PNG or save to Deliverables.</>,
          <><strong>Asset Kit</strong> — a zip of social sizes and favicons.</>,
          <>Everything runs in your browser. <strong>Nothing is sent to the client automatically</strong>, and saving never changes the project status.</>,
        ]} />
      </>
    ),
  },
  chat: {
    title: 'How Chat works — read me',
    body: (
      <>
        <P>The realtime message channel between TD staff and Cris. Messages appear instantly on both sides.</P>
        <Bullets items={[
          <>Attach files, reply/quote, edit, pin, and mark unread — like the client portal chat.</>,
          <>Each project also has its <strong>own chat</strong> inside the brief panel, separate from this general channel.</>,
        ]} />
      </>
    ),
  },
  landing: {
    title: 'How the Landing Page editor works — read me',
    body: (
      <>
        <P>The public &quot;TD Communication&quot; marketing page clients see. You edit the content; the layout is fixed.</P>
        <Bullets items={[
          <>Edit the hero, problem, and call-to-action copy in <strong>English and Italian</strong>, and manage the portfolio (upload images or pull from released deliverables).</>,
          <>Toggle between a <strong>&quot;Coming Soon&quot;</strong> teaser and the full landing with packages.</>,
          <>Changes are a <strong>draft</strong> until you <strong>Publish</strong> — the public page only shows published content.</>,
        ]} />
      </>
    ),
  },
  enrollments: {
    title: 'How Enrollments work — read me',
    body: (
      <>
        <P>The same projects as the board, shown as a flat list with delivery stats — a management view rather than a workflow view.</P>
        <Bullets items={[
          <>Filter by status; see <strong>SLA compliance %</strong> and how many are overdue.</>,
          <>Click any row to open the full project brief.</>,
        ]} />
      </>
    ),
  },
  revenue: {
    title: 'How Revenue & Payouts work — read me',
    body: (
      <>
        <P>The money layer. It works in <strong>two stages</strong>, so a partner is only ever paid after the client has paid TD.</P>
        <Bullets items={[
          <><strong>1 — Set what Cris earns</strong> on each project (a dollar amount you type). It becomes <strong>&quot;Earned&quot;</strong> the moment the client approves the concept.</>,
          <><strong>2 — It becomes &quot;Ready to withdraw&quot;</strong> only once the client has paid TD. Use <strong>Bill client</strong> to send a portal invoice, or <strong>Mark client paid</strong> for money collected off-platform.</>,
          <><strong>Payouts</strong> — Cris requests from his side; you <strong>Approve → Mark Paid</strong> (choose a method). Paying him automatically posts the cost to <strong>Finance → Expenses</strong>.</>,
          <>The cards up top show client revenue collected/outstanding and Cris&apos;s balance. <strong>Cris never sees client prices or your margin</strong> — only his own numbers.</>,
        ]} />
      </>
    ),
  },
  packages: {
    title: 'How Packages work — read me',
    body: (
      <>
        <P>The branding packages a client can buy — the source of truth for names, prices, delivery times, and revision limits.</P>
        <Bullets items={[
          <>Edit price, delivery days, revisions, description (EN/IT), and which package is highlighted.</>,
          <>The package <strong>id (slug) is fixed</strong> once created — changing a price is safe, changing identity is not.</>,
          <>These prices drive what a client is billed and what shows on the landing page.</>,
        ]} />
      </>
    ),
  },
  questions: {
    title: 'How Questions work — read me',
    body: (
      <>
        <P>The brand-audit questions a client answers in the intake wizard. Editing here changes the wizard — no code needed.</P>
        <Bullets items={[
          <>Add, edit, reorder, and group questions into steps; write them in <strong>English and Italian</strong>.</>,
          <>Toggle <strong>AI-assist</strong> per question so the client gets a ✨ &quot;Generate with AI&quot; helper on long-answer fields.</>,
        ]} />
      </>
    ),
  },
  settings: {
    title: 'How Settings work — read me',
    body: (
      <>
        <P>Master configuration for TD Communication.</P>
        <Bullets items={[
          <>Turn the service on/off, edit the <strong>legal disclaimer</strong> text shown before a concept reveal, and set the default delivery SLA.</>,
          <>The <strong>AI kill-switch</strong> disables all TD-Communication AI features instantly, with no deploy.</>,
        ]} />
      </>
    ),
  },
  earnings: {
    title: 'How your Earnings work — read me',
    body: (
      <>
        <P>Your earnings shown as a running balance. Money moves in two stages.</P>
        <Bullets items={[
          <><strong>Earned — waiting on client payment</strong>: the project is approved and your amount is set, but the client hasn&apos;t paid TD yet.</>,
          <><strong>Ready to withdraw</strong>: the client has paid — this is what you can request now.</>,
          <>Use <strong>Request a payout</strong> for any amount up to your available balance; TD approves it and marks it paid.</>,
        ]} />
      </>
    ),
  },
}
