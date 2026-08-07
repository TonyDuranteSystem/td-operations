-- 20260807-2000-portal-chat-leak-retag-cm.sql
-- DATA FIX (DML only — no DDL). Production containment for the portal-chat
-- cross-company leak (dev job 4bad3094-12dd-47ce-a892-649fe237a553).
--
-- WHAT HAPPENED: between 2026-05-26 and 2026-06-26, staff replies about
-- AI Venture Labs LLC (Michele Cotti's new NM company, account
-- 12dadc46-e431-4d11-9fe0-5c561d38737a) were mis-stamped with
-- account_id = Conversion Monsters LLC (6ec84fb7-ee7d-4be0-90ae-bc502d255f34),
-- exposing them to CM's other member (Marcello Faglia, not an AVL member).
-- Root cause: the staff inbox auto-selected the contact's first open company
-- as the send target for person-thread replies (app/(dashboard)/portal-chats/
-- page.tsx:300,1912,1467) and POST /api/portal/chat trusted the admin-supplied
-- account_id. Antonio approved this containment 2026-08-07 (decisions field of
-- dev job 4bad3094). Council-reviewed (full tier, 7 reviewers).
--
-- SCOPE (explicit id lists ONLY — never a date-range predicate):
--   A) 27 admin portal_messages rows -> account_id NULL (become personal to
--      Michele Cotti, contact_id 4e0e4026-1bf4-41e8-ba6c-e9db1e4ba2f8, kept).
--   B) 1 client portal_messages row (31b3d78d-1bce-4aa1-a5a8-bd63807e9941,
--      Michele's own reply in the same exchange) -> account_id NULL AND
--      sender_context 'company' -> NULL (council: never leave a
--      company-context row with no account).
--   C) 30 portal_notifications chat cards carrying 100-char previews of the
--      same content, served account-wide -> account_id NULL (contact_id kept)
--      AND read_at stamped (they were ALL unread; without stamping, Michele's
--      bell would flare with 30 stale cards across every company view).
-- NOT touched: genuine CM rows (May 6 member-info form, Aug 7 tax/payment
-- exchange — both outside the leak set); LUMA Beauty Global (verified genuine
-- business, off the list per Antonio); Easy English / THW single pleasantries
-- (Antonio: leave). Nothing is deleted anywhere.
--
-- BEFORE-STATE SNAPSHOT (read from production 2026-08-07, this session):
--   All 40+18 rows below: portal_messages.account_id =
--     '6ec84fb7-ee7d-4be0-90ae-bc502d255f34', contact_id =
--     '4e0e4026-1bf4-41e8-ba6c-e9db1e4ba2f8', deleted_at IS NULL,
--     read_at NOT NULL (all read), client_kept_unread false, no attachments.
--     sender_context: NULL on the 27 admin rows; 'company' on 31b3d78d-…9941.
--   All 30 portal_notifications rows: account_id = 6ec84fb7…, contact_id =
--     4e0e4026…, type='chat', read_at IS NULL, email already sent at the time.
--
-- ROLLBACK (mechanical inverse): re-run each UPDATE with
--   SET account_id = '6ec84fb7-ee7d-4be0-90ae-bc502d255f34' on the same id
--   list (guard: AND account_id IS NULL); restore sender_context='company' on
--   31b3d78d-…9941; restore read_at = NULL on the 30 notification ids.
--
-- IDEMPOTENCY: every UPDATE is guarded on the OLD value, so a re-run matches
-- 0 rows and is a provable no-op.

-- ============ A) 27 admin messages -> personal scope ============
WITH moved AS (
  UPDATE portal_messages
     SET account_id = NULL
   WHERE account_id = '6ec84fb7-ee7d-4be0-90ae-bc502d255f34'
     AND id IN (
    '24a610e8-ab8b-4741-9317-dd740a1b8ade',
    '9a8eba6b-ec8c-4532-969c-4ca620da02be',
    '9f9c3af0-b677-41b9-84ce-c15bb6c41ad7',
    '5b354c1d-79cd-4072-9105-c8f108ef0313',
    '1244afbb-45ed-4a9c-8fbf-669de4fd47b3',
    '9b65de21-c76a-4c29-bb21-0373f8b443c4',
    '385965dc-ab28-4f4b-8e4a-403262e1e47e',
    '1b5a662c-40a6-4740-898e-20a84c81b445',
    '60f40dbf-c8a8-47bc-b83e-cd485ef376b2',
    '5c947c60-45c8-47df-9ff1-d8b3700ae878',
    'bd4a6026-cd4e-4a5d-b6ca-cb5ad2625aa1',
    '048fced1-cb98-4175-bb3a-8f075a64b3be',
    'f9a190cb-5998-4d31-af75-de1659a37967',
    'f9b609cf-b556-41d1-837d-aae812ccf2b9',
    '90dfde29-8199-40b2-9c04-c96c0998efeb',
    '273a3162-a0af-41d3-a516-f366e4c904e5',
    '2317bdc0-a1f5-41be-a4de-dd4f1ade9e50',
    '9418cbc9-e6b3-4585-b4a2-c67cf9a1b9ed',
    '879535d2-7146-4026-a470-2f3898603bad',
    '1462f2ab-0768-442f-90af-eb8c7338d8b0',
    '9b15c1ef-6075-4507-ad08-4f32c31b3a1d',
    '527e6206-5185-43af-bc7a-61e90f1131a7',
    '34902b7f-3638-49a0-911c-e3ee78f22ec2',
    '5fed8d01-bb0f-48d6-b8d7-6065c288eee6',
    'b6c1d36f-35fa-485d-a9c6-47d0d3176c17',
    '3a616133-83c7-41e7-ac39-0ff1739dff55',
    'bc9350e3-a8a1-4511-9286-52b8f5b744dd'
  )
  RETURNING id
)
SELECT count(*) AS admin_messages_moved FROM moved;  -- expect 27

-- ============ B) Michele's 1 client message in the same exchange ============
WITH moved AS (
  UPDATE portal_messages
     SET account_id = NULL,
         sender_context = NULL
   WHERE account_id = '6ec84fb7-ee7d-4be0-90ae-bc502d255f34'
     AND id = '31b3d78d-1bce-4aa1-a5a8-bd63807e9941'
  RETURNING id
)
SELECT count(*) AS client_message_moved FROM moved;  -- expect 1

-- ============ C) 30 notification cards -> personal scope, marked read ============
WITH moved AS (
  UPDATE portal_notifications
     SET account_id = NULL,
         read_at = now()
   WHERE account_id = '6ec84fb7-ee7d-4be0-90ae-bc502d255f34'
     AND id IN (
    '08b3fb63-4af1-4eb5-bad2-3c7b1fd98f38',
    '75e80963-ddcb-4dec-908e-f15f14a19ca3',
    '3935302a-7d60-434d-9069-e9a11eac30fb',
    '650dfec1-13fa-4ed8-b366-bf6205394556',
    '11a526b4-234b-4d62-a95f-e20d9bee450e',
    '3d15bbb8-a239-4b18-b95e-faafef3757be',
    'e4671b18-7bc0-432e-b9d1-9d5d4ced75a4',
    'da80fb09-6a5b-4875-ac4f-35cca98611ca',
    '3f2a6bfa-5bca-4fd2-9567-7301359a4c45',
    '3d61c7a2-d99f-4426-80de-6b98a3ec4d34',
    '9bcc33ae-5350-48f0-9f1b-f36ce519db27',
    'ec906e6d-c2f4-48b1-8f2d-6c503bbdf703',
    '769c4adc-9fe0-4fa1-a773-2b476fa48eb5',
    '5f1a33bf-7d3b-46c9-8c62-f1686fa15ac6',
    '04fa5210-6c1e-4bdd-acbb-0763fc6f5d71',
    'ffb426ac-8a90-48c0-8beb-1552568d4441',
    '0d2075b0-d4a5-48e9-85ba-4e30ebf3b28e',
    'a5e390e6-4d94-4954-a829-a4d3903a213a',
    'f6eb19ef-86f7-426b-a58f-3459fdbcd291',
    '52744d23-f143-424d-b707-1ddf6e7a3d31',
    'deb57f56-734a-4e75-8815-42d252a54584',
    '78cd52b2-6ead-431c-a22c-fc78bf1007fa',
    'da27fa8f-83f2-4221-b658-01ec2b953042',
    '5ddf0d49-8c9c-4354-bd9f-8de387dfb21b',
    'dda381cc-5efc-484e-a941-7cebcb9286ca',
    '44868d1e-04d6-4202-bc0f-9cef5fd9c5ce',
    'b026ab38-3279-4e30-8e72-5f1dbf846336',
    'a032fac9-9547-4843-89a6-7059bde4849b',
    'a9af54c7-00a3-432a-a2fa-6ebb8fcb70c4',
    '325bf4bb-eaa5-4f1d-ab90-97f1d1a2cceb'
  )
  RETURNING id
)
SELECT count(*) AS notifications_moved FROM moved;  -- expect 30
