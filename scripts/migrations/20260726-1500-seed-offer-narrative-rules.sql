-- Seed the editable "Offer Narrative — Business Rules" knowledge article so the
-- offer-narrative generator has a real, editable source on every environment.
-- Without this the generator silently uses the built-in fallback floor and any
-- admin edits have no effect (the whole point of moving the rules out of code).
--
-- Idempotent: inserts only if no article already carries the lookup tag, so
-- re-running never duplicates and never clobbers an article an admin has since
-- edited. The generator reads the article tagged 'offer_narrative_rules'.
INSERT INTO knowledge_articles (title, category, content, tags)
SELECT
  'Offer Narrative — Business Rules',
  'Business Rules',
  $$SERVICES TONY DURANTE DOES NOT OFFER — never mention, imply, promise, or ask about:
- Bookkeeping of any kind (monthly/quarterly bookkeeping, setting up accounting systems, recording transactions, "audit-ready books")
- Ongoing financial reporting / management accounts
- Personal tax return preparation
- Tax planning or tax advisory
- Legal representation or legal advice
- Trademark or intellectual-property registration
- Website development or marketing
Never ask the client to summarize their transactions, bank activity, or income for bookkeeping purposes. (Note: preparing the company's U.S. tax return, below, is a distinct, in-scope service — not bookkeeping or financial reporting.)

U.S. TAX FILING BY COMPANY TYPE (Tony Durante's clients are typically non-U.S. residents with no U.S.-source income, and therefore generally owe no U.S. income tax — never state an individual client's tax liability as a promise):
- Single-Member LLC (foreign-owned): the U.S. filing is an INFORMATION return — a pro-forma Form 1120 plus Form 5472. No bookkeeping / full set of accounting books is required; it reports the company's details and any related-party transactions. Never describe it as income-tax preparation, bookkeeping, or "year-end tax prep".
- Multi-Member LLC: the U.S. filing is a partnership return (Form 1065), for which a Profit & Loss statement (and a Balance Sheet where required) are prepared from the company's bank statements.
- Corporation (C-Corp): the corporate return (Form 1120). Keep wording general unless the specific filing is known. (S-corporations are generally unavailable to non-U.S.-resident owners — do not offer or describe an S-corp/1120-S filing.)
The tax return is prepared and filed through Tony Durante's accountant.

CLIENT PORTAL (available to managed clients — emphasize it only for offers that include ongoing management):
- Secure document vault: Articles of Organization, Operating Agreement, EIN letter, Lease
- Deadline calendar: annual report, registered-agent renewal, tax filing
- Online document signing
- Upload bank statements and view filed returns
- Business tools: create invoices and a mini-CRM for the client's OWN customers
- Portal Chat — the REQUIRED day-to-day support channel, with voice dictation; it replaces WhatsApp/Telegram
- Installable mobile and desktop app with push notifications

STANDARD MANAGEMENT SERVICES (only when the offer includes ongoing management): registered agent; annual report and state-compliance filing; U.S. business-address mail handling and forwarding; Operating Agreement preparation, review and updates.$$,
  ARRAY['offer_narrative_rules']::text[]
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_articles WHERE tags @> ARRAY['offer_narrative_rules']::text[]
);
