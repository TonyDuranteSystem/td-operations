'use client'

import type { ReactNode } from 'react'

/**
 * Shared, section-level "How this works — read me" for TD Communication.
 *
 * The same collapsed <details> pattern as the in-project / Design-Tools read-mes,
 * but surfaced at the TOP OF EACH TAB so staff (and Cris on /collab) can learn how
 * a section works — and HOW TO USE IT — WITHOUT opening a project. Native <details>
 * — collapsed by default, no extra JS. Content is keyed so the CRM dashboard and
 * /collab render the same copy for shared sections. Every step below is written
 * against the section's actual controls.
 */
export function SectionReadme({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="shrink-0 rounded-xl border border-zinc-200 bg-white text-sm text-zinc-700">
      <summary className="cursor-pointer select-none px-3 py-2 font-medium text-zinc-800">
        {title}
      </summary>
      <div className="space-y-3 border-t border-zinc-100 px-3 py-3 leading-relaxed text-[13px]">
        {children}
      </div>
    </details>
  )
}

interface ReadmeContent {
  title: string
  body: ReactNode
}

function What({ children }: { children: ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="font-semibold text-zinc-900">What it is</h3>
      <p>{children}</p>
    </section>
  )
}
function HowTo({ steps }: { steps: ReactNode[] }) {
  return (
    <section className="space-y-1">
      <h3 className="font-semibold text-zinc-900">How to use it</h3>
      <ol className="list-decimal pl-5 space-y-1">
        {steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
    </section>
  )
}
function Note({ children }: { children: ReactNode }) {
  return <p className="text-zinc-500">💡 {children}</p>
}

/** Read-me copy per section key (shared by the CRM tabs and /collab sections). */
export const SECTION_READMES: Record<string, ReadmeContent> = {
  projects: {
    title: 'How the Projects board works — read me',
    body: (
      <>
        <What>
          The pipeline board — every branding project is a card, grouped into columns by stage
          (<strong>New → In Progress → Ready for Review → Revision → Approved → Delivered</strong>). Each
          column header shows how many projects are in it. It&apos;s the same board Cris sees.
        </What>
        <HowTo steps={[
          <>Read the board left-to-right to see where every project stands; the strip on top shows <strong>&quot;X on time · Y overdue&quot;</strong>.</>,
          <>Check each card&apos;s <strong>SLA dot</strong> — red = overdue, amber = due today/soon, green = on time — plus the client, package and deadline.</>,
          <><strong>Click a card</strong> to open its brief panel (slides in from the right).</>,
          <>Inside the panel you can: read the <strong>Brand Audit Answers</strong> + uploaded materials, generate the <strong>AI Brand Profile</strong>, manage <strong>Deliverables</strong>, chat in the project thread, add <strong>Private Notes</strong>, and change the <strong>Status</strong>.</>,
        ]} />
        <Note>The board advances by itself when you release a concept — you only set the status manually for exceptions.</Note>
      </>
    ),
  },
  deliverables: {
    title: 'How Deliverables work — read me',
    body: (
      <>
        <What>
          The creative files for each project, organised by <strong>concept</strong> (A/B/C) and{' '}
          <strong>version</strong> (v1, v2…). This is where a concept becomes visible to the client.
        </What>
        <HowTo steps={[
          <>Pick a project — its deliverables open in the brief panel.</>,
          <><strong>Upload</strong> a file, tag it to a concept, and mark it <strong>Draft</strong> or <strong>Final</strong>; versions auto-number within a concept.</>,
          <>Click <strong>Release to Client</strong> to reveal a concept to the client (behind the disclaimer gate) — this moves the project to <strong>Ready for Review</strong>.</>,
          <>Click <strong>Release Final</strong> when the work is done — this <strong>delivers</strong> the project.</>,
          <><strong>Download</strong> any file, or <strong>Delete</strong> it (a soft-delete — staff keep the record, the client stops seeing it).</>,
        ]} />
      </>
    ),
  },
  'design-tools': {
    title: 'How the Design Tools work — read me',
    body: (
      <>
        <What>
          Three in-browser accelerators that turn a project&apos;s brand brief into usable assets. You still
          design the logo in your own software — these handle everything around it.
        </What>
        <HowTo steps={[
          <>Pick a project (or use the standalone workspace) so the tools load its brand colours + AI Brand Profile.</>,
          <><strong>Palette</strong> — generate colour schemes, check <strong>WCAG contrast</strong> (accessibility), and export as CSS / SCSS / JSON / Tailwind / hex.</>,
          <><strong>Mockups</strong> — add a logo (upload, or pick one from Deliverables), preview it on a business card / letterhead / social post / website, then <strong>Export PNG</strong> or <strong>Save to Deliverables</strong>.</>,
          <><strong>Asset Kit</strong> — download a zip of the social sizes + favicons.</>,
        ]} />
        <Note>Everything runs in your browser. Nothing is sent to the client automatically, and saving an asset never changes the project status.</Note>
      </>
    ),
  },
  chat: {
    title: 'How Chat works — read me',
    body: (
      <>
        <What>The realtime message channel between TD staff and Cris — messages appear instantly on both sides.</What>
        <HowTo steps={[
          <>Type a message to reach Cris (or staff) directly.</>,
          <><strong>Attach files</strong> (drag &amp; drop), <strong>reply/quote</strong>, <strong>edit</strong> your own messages, <strong>pin</strong> important ones, or <strong>keep unread</strong>.</>,
          <>For talk about one specific project, use the chat <strong>inside that project&apos;s brief panel</strong> instead of this general channel.</>,
        ]} />
      </>
    ),
  },
  landing: {
    title: 'How the Landing Page editor works — read me',
    body: (
      <>
        <What>
          The public &quot;TD Communication&quot; marketing page clients see. You edit the content; the layout
          is fixed. Changes are a draft until you publish.
        </What>
        <HowTo steps={[
          <>Switch the <strong>English / Italian</strong> tab and edit the <strong>Hero</strong>, <strong>Problem statement</strong>, and <strong>Call to action</strong> copy.</>,
          <>Manage the <strong>Portfolio</strong> — upload images or use <strong>&quot;Add from delivered work&quot;</strong> to pull a released deliverable.</>,
          <>Toggle <strong>&quot;Show the full landing page&quot;</strong> — off shows a Coming-Soon teaser instead.</>,
          <>Edits autosave as a <strong>draft</strong>; click <strong>Publish</strong> to make them live, or <strong>Discard</strong> to revert to the last published version.</>,
        ]} />
      </>
    ),
  },
  enrollments: {
    title: 'How Enrollments work — read me',
    body: (
      <>
        <What>The same projects as the board, shown as a flat list with delivery stats — a management view rather than a workflow view.</What>
        <HowTo steps={[
          <>Use the <strong>Status</strong> filter to narrow the list.</>,
          <>Read the top chips — <strong>SLA compliance %</strong>, overdue count, and average delivery time.</>,
          <>Click any row to open that project&apos;s full brief.</>,
        ]} />
      </>
    ),
  },
  revenue: {
    title: 'How Revenue & Payouts work — read me',
    body: (
      <>
        <What>
          The money layer. It works in <strong>two stages</strong> so a partner is only ever paid after the
          client has paid TD. The cards on top summarise client revenue (collected / outstanding) and Cris&apos;s
          balance.
        </What>
        <HowTo steps={[
          <>In the <strong>Projects</strong> table, type what Cris earns in the <strong>&quot;Cris earns&quot;</strong> field (saves on Enter or when you click away). It becomes <strong>&quot;Earned&quot;</strong> once the client approves the concept.</>,
          <>Click <strong>Bill client</strong> to send a portal invoice, or <strong>Mark client paid</strong> for money collected off-platform. When the client has paid, the project flips to <strong>&quot;Ready&quot;</strong>.</>,
          <>In <strong>Payout requests</strong>, when Cris asks to withdraw: <strong>Approve</strong> → <strong>Mark Paid</strong> (choose a method), or <strong>Reject</strong>.</>,
        ]} />
        <Note>Marking a payout paid automatically posts the cost to <strong>Finance → Expenses</strong>. Cris never sees client prices or your margin — only his own numbers.</Note>
      </>
    ),
  },
  packages: {
    title: 'How Packages work — read me',
    body: (
      <>
        <What>The branding packages a client can buy — the source of truth for names, prices, delivery times, and revision limits.</What>
        <HowTo steps={[
          <>Click <strong>Add package</strong>, or edit an existing row.</>,
          <>Set the <strong>Name</strong> (EN/IT), <strong>Price</strong>, <strong>Delivery days</strong>, <strong>Max revisions</strong>, <strong>Payment timing</strong> (Upfront / On approval), <strong>Sort order</strong>, and optional upsell.</>,
          <>Use <strong>Status</strong> (active/inactive) to show or hide it, then <strong>Save</strong>.</>,
        ]} />
        <Note>The <strong>Slug</strong> (a package&apos;s id) is fixed once created — change prices freely, but its identity is locked so existing projects stay linked.</Note>
      </>
    ),
  },
  questions: {
    title: 'How Questions work — read me',
    body: (
      <>
        <What>The brand-audit questions a client answers in the intake wizard. Editing here changes the wizard — no code needed.</What>
        <HowTo steps={[
          <>Click <strong>Add question</strong>, or edit an existing one.</>,
          <>Set the <strong>Type</strong> (text / textarea / select / number / file), <strong>Audience</strong>, <strong>Step</strong>, and whether it&apos;s <strong>Required</strong>. For a <em>select</em>, add choices with <strong>Add option</strong> (EN/IT).</>,
          <>Toggle <strong>AI-assist</strong> on a long-answer question so the client gets a ✨ <strong>&quot;Generate with AI&quot;</strong> helper.</>,
          <>Reorder with <strong>Sort order</strong>; set <strong>Inactive</strong> to hide a question. Save.</>,
        ]} />
      </>
    ),
  },
  settings: {
    title: 'How Settings work — read me',
    body: (
      <>
        <What>Master configuration for TD Communication.</What>
        <HowTo steps={[
          <>Toggle the <strong>Client portal tab</strong> on/off and set the <strong>Default SLA days</strong>.</>,
          <>Edit the <strong>Disclaimer text</strong> (English + Italian) shown to a client before a concept reveal.</>,
          <>Use the <strong>AI features</strong> toggle as a kill-switch to disable all TD-Communication AI instantly — no deploy needed.</>,
        ]} />
      </>
    ),
  },
  earnings: {
    title: 'How your Earnings work — read me',
    body: (
      <>
        <What>Your earnings shown as a running balance. Money moves in two stages.</What>
        <HowTo steps={[
          <>Read your balance: <strong>Earned — waiting on client payment</strong> means the project is approved but the client hasn&apos;t paid TD yet; <strong>Ready to withdraw</strong> means they have, and you can request it now.</>,
          <>In <strong>Request a payout</strong>, enter an amount up to your available balance, add an optional note, and submit.</>,
          <>Track each request in your <strong>payout history</strong> as it moves requested → approved → paid.</>,
        ]} />
      </>
    ),
  },
}
