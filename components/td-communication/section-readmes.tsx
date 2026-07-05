'use client'

import type { ReactNode } from 'react'

/**
 * Shared, section-level "How this works — read me" for TD Communication.
 *
 * The same collapsed <details> pattern + structure as the original Design-Tools
 * read-me (What it is / How to use it / Good to know), but surfaced at the TOP OF
 * EACH TAB so staff (and Cris on /collab) can learn a section — and how to use it —
 * WITHOUT opening a project. Native <details>, collapsed by default. Keyed so the
 * CRM dashboard and /collab render the same copy for shared sections.
 *
 * NOTE: there is deliberately NO 'design-tools' key here — the Design Tools tab
 * already renders the richer original read-me inside DesignToolsSection, so adding
 * one here would double it up.
 */
export function SectionReadme({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="shrink-0 rounded-xl border border-zinc-200 bg-white text-sm text-zinc-700">
      <summary className="cursor-pointer select-none px-3 py-2 font-medium text-zinc-800">
        {title}
      </summary>
      <div className="space-y-4 border-t border-zinc-100 px-3 py-3 leading-relaxed text-[13px]">
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
function GoodToKnow({ items }: { items: ReactNode[] }) {
  return (
    <section className="space-y-1">
      <h3 className="font-semibold text-amber-700">Good to know</h3>
      <ul className="list-disc pl-5 space-y-1">
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </section>
  )
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
          column header shows how many projects are in it, and the strip on top summarises{' '}
          <strong>&quot;X on time · Y overdue&quot;</strong>. It&apos;s the same board Cris sees.
        </What>
        <HowTo steps={[
          <>Read the board left-to-right to see where every project stands; check each card&apos;s <strong>SLA dot</strong> (red = overdue, amber = due today/soon, green = on time) plus its client, package and deadline.</>,
          <><strong>Click a card</strong> to open its brief panel — it slides in from the right and is where everything about a project happens.</>,
          <>In the panel: read the <strong>Brand Audit Answers</strong> + uploaded materials, generate the <strong>AI Brand Profile</strong>, manage <strong>Deliverables</strong>, use the <strong>Design Tools</strong>, chat in the project thread, and add <strong>Private Notes</strong>.</>,
          <>Move a project by <strong>releasing a deliverable</strong> (preferred) or, for exceptions, using the <strong>Status</strong> dropdown in the panel.</>,
        ]} />
        <GoodToKnow items={[
          <>The board <strong>advances by itself</strong> when you release a concept — you only touch the Status dropdown for exceptions.</>,
          <><strong>Cancelled</strong> projects are hidden from the board.</>,
          <>The cards themselves are read-only — <strong>all actions live inside the brief panel</strong> you open by clicking a card.</>,
        ]} />
      </>
    ),
  },
  deliverables: {
    title: 'How Deliverables work — read me',
    body: (
      <>
        <What>
          The creative files for each project, organised by <strong>concept</strong> (A/B/C) and{' '}
          <strong>version</strong> (v1, v2…). This is where a concept becomes visible to the client and
          where a project gets delivered.
        </What>
        <HowTo steps={[
          <>Pick a project — its deliverables open inside the brief panel.</>,
          <><strong>Upload</strong> a file, tag it to a concept, and mark it <strong>Draft</strong> or <strong>Final</strong>; versions auto-number within a concept.</>,
          <>Click <strong>Release to Client</strong> to reveal a concept to the client — this moves the project to <strong>Ready for Review</strong>.</>,
          <>Click <strong>Release Final</strong> when the work is done — this <strong>delivers</strong> the project.</>,
          <><strong>Download</strong> any file, or <strong>Delete</strong> one you no longer need.</>,
        ]} />
        <GoodToKnow items={[
          <><strong>Release to Client is the client-facing moment</strong> — the client accepts a legal disclaimer before they can see the concept in their portal.</>,
          <><strong>Delete is a soft-delete</strong> — staff keep the file and the audit trail; the client simply stops seeing it.</>,
          <><strong>Design-tool outputs</strong> (mockups, asset kits) show in their own block and are <strong>download/delete only</strong> — they are never released to the client.</>,
        ]} />
      </>
    ),
  },
  chat: {
    title: 'How Chat works — read me',
    body: (
      <>
        <What>
          The realtime message channel between TD staff and Cris — messages appear instantly on both sides,
          with the same features as the client portal chat.
        </What>
        <HowTo steps={[
          <>Type a message to reach Cris (or staff) directly.</>,
          <><strong>Attach files</strong> (drag &amp; drop), <strong>reply/quote</strong>, <strong>edit</strong> your own messages, <strong>pin</strong> important ones, or <strong>keep unread</strong>.</>,
          <>For talk about one specific project, use the chat <strong>inside that project&apos;s brief panel</strong> instead of this general channel.</>,
        ]} />
        <GoodToKnow items={[
          <>This is a <strong>staff ↔ Cris</strong> channel — the client is not in it.</>,
          <>Every project also has its <strong>own separate chat</strong> in its brief panel.</>,
          <>A deleted message disappears for Cris, but staff still see a <strong>tombstone</strong> so nothing is lost from the record.</>,
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
          <>Click <strong>Publish</strong> to make your changes live, or <strong>Discard</strong> to revert to the last published version.</>,
        ]} />
        <GoodToKnow items={[
          <>The public page shows <strong>only what you Publish</strong> — your draft stays private until then.</>,
          <><strong>&quot;Add from delivered work&quot;</strong> only offers images from concepts already released to a client.</>,
          <>The Coming-Soon toggle lets you go live with the page <strong>before the packages are ready</strong>.</>,
        ]} />
      </>
    ),
  },
  portfolio: {
    title: 'How the Portfolio works — read me',
    body: (
      <>
        <What>
          A curated <strong>public showcase</strong> of finished branding work, shown at{' '}
          <strong>/portfolio</strong> (a page anyone can open — no login). Each entry has an{' '}
          <strong>&quot;after&quot;</strong> image (the result) and an optional <strong>&quot;before&quot;</strong>,
          plus a title, description, tags and a client-consent note. You choose what goes public.
        </What>
        <HowTo steps={[
          <>Click <strong>New entry</strong>. Pick the finished <strong>&quot;after&quot;</strong> image — from a project&apos;s <strong>released</strong> work or a manual upload — and optionally a <strong>&quot;before&quot;</strong>.</>,
          <>Fill in the <strong>title, client name, description</strong> (English + Italian), a <strong>category</strong> and <strong>tags</strong>; optionally link the source <strong>project</strong>.</>,
          <>Entries start <strong>unpublished</strong>. When you&apos;re happy, click <strong>Publish</strong> to put it on the public page; use <strong>Feature</strong> to pin the best work first.</>,
          <>Check the <strong>consent badge</strong> — green when the client opted in, grey when you&apos;ve recorded written permission. Use <strong>Mark written permission</strong> if you have it on file.</>,
        ]} />
        <GoodToKnow items={[
          <>The public page shows <strong>only published entries</strong>, and the whole page has a master <strong>on/off switch</strong> in Settings (off by default).</>,
          <>Consent is <strong>your call</strong> — the badge is there to inform you, it never blocks publishing — <em>but</em> if a client <strong>withdraws</strong>, their entry is <strong>automatically hidden</strong>.</>,
          <>Only <strong>released</strong> work can be pulled in — a client&apos;s raw uploaded files are never offered for the public page.</>,
          <>This is separate from the <strong>Landing Page</strong> portfolio strip (that one lives inside the logged-in client portal).</>,
        ]} />
      </>
    ),
  },
  enrollments: {
    title: 'How Enrollments work — read me',
    body: (
      <>
        <What>
          The same projects as the board, shown as a flat list with delivery stats — a management/reporting
          view rather than a workflow view.
        </What>
        <HowTo steps={[
          <>Use the <strong>Status</strong> filter to narrow the list.</>,
          <>Read the top chips — <strong>SLA compliance %</strong>, overdue count, and average delivery time.</>,
          <>Click any row to open that project&apos;s full brief.</>,
        ]} />
        <GoodToKnow items={[
          <>It&apos;s the <strong>same projects</strong> as the board — a list view, not a second system.</>,
          <><strong>SLA compliance %</strong> counts only delivered projects that had a deadline.</>,
          <>Clicking a row opens the <strong>same brief panel</strong> as the board.</>,
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
          client has paid TD. The cards on top summarise client revenue (collected / outstanding) and
          Cris&apos;s balance (earned-waiting / ready / in-request / paid-out).
        </What>
        <HowTo steps={[
          <>In the <strong>Projects</strong> table, type what Cris earns in the <strong>&quot;Cris earns&quot;</strong> field (saves on Enter or when you click away). It becomes <strong>&quot;Earned&quot;</strong> once the client approves the concept.</>,
          <>Click <strong>Bill client</strong> to send a portal invoice, or <strong>Mark client paid</strong> for money collected off-platform. When the client has paid, the project flips to <strong>&quot;Ready&quot;</strong>.</>,
          <>In <strong>Payout requests</strong>, when Cris asks to withdraw: <strong>Approve</strong> → <strong>Mark Paid</strong> (choose a method), or <strong>Reject</strong>.</>,
        ]} />
        <GoodToKnow items={[
          <><strong>Two stages on purpose:</strong> a partner is never paid before the client has paid TD.</>,
          <>A <strong>Bill client</strong> invoice only counts as paid on a <strong>real payment</strong> — an invoice covered by account credit does not flip Cris to &quot;Ready&quot;.</>,
          <>Marking a payout paid <strong>automatically posts the cost to Finance → Expenses</strong>.</>,
          <>If a paid invoice is later refunded after Cris was paid, the balance can read negative — it&apos;s surfaced to you, never acted on automatically.</>,
          <><strong>Cris never sees client prices or your margin</strong> — only his own numbers.</>,
        ]} />
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
        <GoodToKnow items={[
          <>The <strong>Slug</strong> (a package&apos;s id) is fixed once created — change prices freely, but its identity is locked so existing projects stay linked.</>,
          <>Setting a package <strong>Inactive</strong> hides it from clients but leaves existing projects intact.</>,
          <>These prices drive both <strong>client billing</strong> and what shows on the <strong>landing page</strong>.</>,
        ]} />
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
          <>Reorder with <strong>Sort order</strong>; set <strong>Inactive</strong> to hide a question, then Save.</>,
        ]} />
        <GoodToKnow items={[
          <>Changes take effect in the client wizard <strong>immediately</strong> — no deploy.</>,
          <>Questions are <strong>bilingual</strong> (EN/IT); the Italian text is shown to Italian clients.</>,
          <><strong>AI-assist</strong> only applies to long-answer (textarea) questions.</>,
          <>Setting a question <strong>Inactive</strong> hides it without deleting past answers.</>,
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
          <>Use the <strong>AI features</strong> toggle as a kill-switch to disable all TD-Communication AI instantly.</>,
        ]} />
        <GoodToKnow items={[
          <>The <strong>AI features</strong> toggle is an instant kill-switch — no deploy needed.</>,
          <>The disclaimer is <strong>shown to the client and logged</strong> before every concept reveal, so keep it accurate.</>,
          <>Set <strong>both</strong> languages — the Italian disclaimer never falls back to English.</>,
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
          <>Read your balance: <strong>Earned — waiting on client payment</strong> means the project is approved but the client hasn&apos;t paid TD yet; <strong>Ready to withdraw</strong> means they have.</>,
          <>In <strong>Request a payout</strong>, enter an amount up to your available balance, add an optional note, and submit.</>,
          <>Track each request in your <strong>payout history</strong> as it moves requested → approved → paid.</>,
        ]} />
        <GoodToKnow items={[
          <>You only ever see <strong>your own numbers</strong> — never the client&apos;s price or what TD charged.</>,
          <>An amount is <strong>only withdrawable after the client has paid TD</strong>.</>,
          <>Each payout request goes to TD for <strong>approval</strong> before it&apos;s paid.</>,
        ]} />
      </>
    ),
  },
}
