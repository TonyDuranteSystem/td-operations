# Address book — standalone, reads the CRM, saves everyone else
_Last verified against code: 2026-11-14 — Claude (dev job `055f2400`, SANDBOX, step 1 "Foundation" only; **NOT in production, no screen yet**). Antonio, 14 Nov 2026: "the address book gathers the information from the CRM and we use it to save other contacts that wouldn't have a place in the CRM"; "don't touch Contacts"; "I have to create what I want without hardcode, it must be flexible"; the Personal book is only his. Mockup: https://claude.ai/artifact/F3xcZSu1YUFf54Qw6ZUiUE. Built and proved in the sandbox: the three tables + the catalog, the encryption, the "only Antonio" rule, the locks. NOT built: every screen, the phone pages, card reading, save from email/WhatsApp, the copy to the iPhone's Contacts (steps 2-5 of the plan in the dev job)._

## What it is
One address book that shows everyone we already have in the CRM (read only: the Contacts people and the Partners) and lets staff save the OTHER people who have no place in the CRM (suppliers, lawyers, a banker met at an event). It has two books on the phone: **Company** (CRM people + people saved here, visible to the team) and **Personal** (only Antonio). The Contacts page and the contacts table are NOT touched and nothing saved here ever becomes a CRM contact.

## Business rules (Antonio, 14 Nov 2026)
- **Standalone.** Reads contacts (507 on 14 Nov) and partners (13) read only. Never writes to them, never adds a foreign key to them (86 tables already point at contacts; the WhatsApp matcher, name suggestions and the AI search read every contact).
- **No hard-coded types.** Types and each type's extra boxes are created by Antonio in the address book (catalog `address_book_types`; none seeded). Box kinds: text, date, number, yes/no, no rules between boxes. Hiding a type = status `deprecated`; its people keep working.
- **CRM people get their type by suggestion + his confirmation**, kept in `address_book_crm_labels`, never on the Contacts data.
- **Personal book = ONE login** (the primary owner, `lib/auth.ts` `PRIMARY_OWNER_EMAIL`). Not the other owners (`NEXT_PUBLIC_EXTRA_OWNER_EMAILS`), not admins, not the team, not the AI tools.
- **A copy to the iPhone's own Contacts** is wanted (Personal on by default, Company off). It needs a NEW TD Social build + Apple review: the app has no Contacts permission today. Not built.
- Defaults I chose and flagged to him: the Company book (with the people saved there) is visible to the whole team; Personal on phone and computer for him alone.

## How it's built
- **Tables** (migration `scripts/migrations/20261114-2100-address-book-foundation.sql`, UNDO next to it; all RLS on, `REVOKE ALL … FROM anon, authenticated`, service client only):
  - `address_book_entries` — the Company book's own people. Plain columns (name, company, job title, website, phones, emails, address, notes), `phone_keys` (digits only) and `emails` (lower case) written by code for "already saved" lookups, `extra` jsonb = the type's boxes, `type_entry_id` → catalog row, `source` (typed | email | whatsapp | card | other), `archived_at` soft delete.
  - `address_book_personal` — one **encrypted** payload per person (`payload_enc`, AES-256-GCM), `owner_user_id`. No readable column holds a name or number. **Also revoked from the `ai_readonly` role** (Slack worker, Hermes `crm_query`) and listed in `BLOCKED_TABLES` (`lib/mcp/tools/hermes-read.ts`).
  - `address_book_crm_labels` — `(subject_kind contact|partner, subject_id)` unique → confirmed type. `subject_id` has NO foreign key on purpose; a label whose person is gone or merged must be ignored by code.
- **Catalog:** `address_book_types` (definition inserted by the migration, no entries). Entry `metadata` = `{"boxes":[{"key","label","kind"}],"color","sort_order"}`. A unique index on the lower-cased name keeps two types from sharing a name.
- **Key files:** `lib/address-book/crypto.ts` (encrypt/decrypt, key from env `ADDRESS_BOOK_PERSONAL_KEY` ≥ 32 characters, owner id bound in as AAD so a payload cannot be moved to another owner), `lib/address-book/types.ts` (box schema, `parseTypeMeta`, `cleanExtra`, `phoneKey`, `normalizeEmail`, `lookupKeys`, `personInputSchema`), `lib/address-book/personal-access.ts` (`canUsePersonalBook` / `personalOwnerId`). Tests: `tests/unit/address-book-*.test.ts` and the two extra `address_book_personal` rows in `tests/unit/crm-query-readonly.test.ts`.
- **Env:** `ADDRESS_BOOK_PERSONAL_KEY` is NOT set anywhere yet (needed before the Personal book can store or open anything; the book is switched off while it is missing or short). Set it per environment (sandbox, production) when step 3 (phone) starts; never reuse another secret.
- **No store, no routes, no screens yet.** `lib/database.types.ts` does not know the new tables (regenerate through the CI artifact, see the memory note) — the store added in step 2 must cast or use the regenerated types.

## Gotchas, invariants & past bugs
- **"Only you" is enforced in layers, and the honest limit is stated:** RLS + no client grants; `ai_readonly` revoked; encrypted payload; every query scoped to `owner_user_id`. Any admin SQL tool (including a Claude session) can still read the ciphertext, not the names. A database admin with the server key could decrypt.
- The generic MCP `execute_sql` runs as the service role and has no per-table block for reads, so the encryption, not a block list, is what protects the Personal book from it.
- `address_book_crm_labels.subject_id` is a plain uuid. A merged contact keeps its label on the old id: ignore labels whose contact has `merged_into` set.
- Two types may not share a name (case and spaces ignored, hidden ones included); the accent-insensitive check lives in code (step 2).
- Personal rows hold their type inside the encrypted payload, so the Personal list is decrypted in code and filtered there (a person's book is small).

## How to verify current state
- Tables, locks and the AI role: `SELECT c.relname, c.relrowsecurity, has_table_privilege('ai_readonly', ('public.'||c.relname)::regclass, 'SELECT') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'address_book_%'` → RLS true for all three, `ai_readonly` false only for `address_book_personal`.
- Catalog: `SELECT id FROM catalog_definitions WHERE id='address_book_types'` (and `SELECT count(*) FROM catalog_entries WHERE catalog_id='address_book_types'` = 0 until he creates types).
- Code: `npx vitest run tests/unit/address-book-*.test.ts tests/unit/crm-query-readonly.test.ts`.
