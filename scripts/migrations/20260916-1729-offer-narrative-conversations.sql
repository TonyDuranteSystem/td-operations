-- Persistence for the offer-narrative CONVERSATION (dev job — offer-narrative
-- chat redesign, 2026-09-16). "Generate with AI" and "Discuss with AI" merge
-- into one conversational panel with REAL memory across turns; a Vercel API
-- route is stateless between requests, so that memory has to live in the
-- database, not in server process memory.
--
-- Two tables, deliberately separate from `offers` itself: a conversation
-- exists for a draft that may never become a real offer row at all (the
-- staffer can cancel the dialog), so this can never gain a NOT NULL FK to
-- `offers`. Scoped instead to whichever of lead/account/contact identifies
-- the draft — the same identity CreateOfferDialogProps already requires
-- ("at least one of lead_id / account_id / contact_id").
--
-- SEQUENCING (concurrency safeguard): `seq` is a per-conversation monotonic
-- number assigned by the APPLICATION at persist time via max(seq)+1, with
-- UNIQUE(conversation_id, seq) as the race backstop — the exact idiom this
-- codebase already uses for invoice numbers (lib/portal/invoice-number.ts /
-- isUniqueViolation: "race safety lives in the partial unique index ... plus
-- caller-side retry-on-unique-violation", R098). Two browser tabs racing to
-- append a turn will have exactly one INSERT succeed for a given seq; the
-- loser reads a fresh max and retries (lib/offers/narrative-conversation.ts).
-- This is deliberately NOT inferred from `created_at` or insertion-completion
-- order, either of which can invert under a race.
--
-- Staff-only end to end (mirrors internal_thread_mention_dismissals' RLS
-- shape): a client never sees this table, and the conversation is read/written
-- exclusively via supabaseAdmin (service role) from the offer-narrative-chat
-- route, which is gated by canPerform(user, 'create_offer'). RLS is enabled
-- anyway as defense-in-depth against a future non-admin code path.

CREATE TABLE IF NOT EXISTS public.offer_narrative_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid REFERENCES public.leads(id) ON DELETE CASCADE,
  account_id  uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offer_narrative_conversations_subject_chk
    CHECK (lead_id IS NOT NULL OR account_id IS NOT NULL OR contact_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_offer_narrative_conversations_lead
  ON public.offer_narrative_conversations (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_offer_narrative_conversations_account
  ON public.offer_narrative_conversations (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_offer_narrative_conversations_contact
  ON public.offer_narrative_conversations (contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE public.offer_narrative_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS offer_narrative_conversations_staff ON public.offer_narrative_conversations;
CREATE POLICY offer_narrative_conversations_staff ON public.offer_narrative_conversations
  FOR ALL TO authenticated
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner'))
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner'));

CREATE TABLE IF NOT EXISTS public.offer_narrative_turns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.offer_narrative_conversations(id) ON DELETE CASCADE,
  seq             integer NOT NULL,
  role            text NOT NULL CHECK (role IN ('user', 'assistant')),
  -- Exactly the text sent to / received from the model this turn (the full
  -- prompt for role='user', the raw JSON completion for role='assistant') —
  -- so replaying prior turns as Anthropic message history is faithful, not a
  -- paraphrase. Grounding facts (current narrative state, formation state,
  -- entity type, email context) are folded into the 'user' content itself,
  -- same shape the single-shot refine prompt already used.
  content         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offer_narrative_turns_conversation_seq_uniq UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_offer_narrative_turns_conversation
  ON public.offer_narrative_turns (conversation_id, seq);

ALTER TABLE public.offer_narrative_turns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS offer_narrative_turns_staff ON public.offer_narrative_turns;
CREATE POLICY offer_narrative_turns_staff ON public.offer_narrative_turns
  FOR ALL TO authenticated
  USING (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner'))
  WITH CHECK (COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') NOT IN ('client', 'partner'));
