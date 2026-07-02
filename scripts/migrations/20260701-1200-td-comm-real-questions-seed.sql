-- ─────────────────────────────────────────────────────────────────────────
-- TD Communication — real brand-audit questions (unified SUPERNOVA + SIRIUS brief)
-- ─────────────────────────────────────────────────────────────────────────
-- Replaces the 15 Phase-8 placeholder rows with the 30 real questions Cris
-- delivered, across 4 steps, audience 'both' (client_type still differentiates
-- the enrollment; the question set is unified). The client wizard renders these
-- via buildTdCommWizardConfig (lib/td-communication/question-to-field.ts). IT
-- copy is a professional translation of Cris's EN brief and is operator-editable
-- from the CRM Questions admin — no code deploy needed to reword.
--
-- No FK references these rows (form_data stores keys, not FKs), so the
-- delete/replace is safe. Idempotent: UPSERT on the unique `key`.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Retire any question whose key is not part of the real 30 (the old placeholders).
DELETE FROM public.td_comm_questions
WHERE key NOT IN (
  -- Step 1 — Business & Strategy
  'business_description','added_value','target_client','mission','vision',
  'core_values','brand_message','strengths','brand_usage','competitors',
  -- Step 2 — Brand Personality
  'brand_famous_person','admired_company','people_say','unsaid_message',
  'company_personality','client_feedback',
  -- Step 3 — Visual & Design
  'brand_name','color_personality','color_preference','design_elements',
  'symbol_object','geometric_shapes','admired_logo','brand_place',
  -- Step 4 — Final Details
  'one_word','never_communicate','brand_soundtrack','era_movement',
  'additional_notes','upload_materials'
);

-- 2. Upsert the 30 real questions.
INSERT INTO public.td_comm_questions
  (key, label_en, label_it, type, required, step, audience, options, active, sort_order)
VALUES
  -- ── Step 1 — Business & Strategy ──────────────────────────────────────────
  ('business_description', 'Tell us about your business. What do you do?',
    'Parlaci della tua attività. Di cosa ti occupi?', 'textarea', true, 1, 'both', '[]'::jsonb, true, 0),
  ('added_value', 'What is the added value that makes the difference?',
    'Qual è il valore aggiunto che fa la differenza?', 'textarea', true, 1, 'both', '[]'::jsonb, true, 1),
  ('target_client', 'Who is your target client?',
    'Chi è il tuo cliente ideale?', 'textarea', true, 1, 'both', '[]'::jsonb, true, 2),
  ('mission', 'Tell us your MISSION',
    'Raccontaci la tua MISSION', 'textarea', false, 1, 'both', '[]'::jsonb, true, 3),
  ('vision', 'Tell us your VISION',
    'Raccontaci la tua VISION', 'textarea', false, 1, 'both', '[]'::jsonb, true, 4),
  ('core_values', 'List the 5 most important values of your business',
    'Elenca i 5 valori più importanti della tua attività', 'textarea', true, 1, 'both', '[]'::jsonb, true, 5),
  ('brand_message', 'What message do you want to communicate through your brand?',
    'Quale messaggio vuoi comunicare attraverso il tuo brand?', 'textarea', true, 1, 'both', '[]'::jsonb, true, 6),
  ('strengths', 'What are the strengths of your business?',
    'Quali sono i punti di forza della tua attività?', 'textarea', true, 1, 'both', '[]'::jsonb, true, 7),
  ('brand_usage', 'Where will this brand be used?',
    'Dove verrà utilizzato questo brand?', 'textarea', true, 1, 'both', '[]'::jsonb, true, 8),
  ('competitors', 'Who are your 3 main competitors and how do you differ from them?',
    'Chi sono i tuoi 3 principali concorrenti e in cosa ti differenzi da loro?', 'textarea', true, 1, 'both', '[]'::jsonb, true, 9),

  -- ── Step 2 — Brand Personality ────────────────────────────────────────────
  ('brand_famous_person', 'If your brand were a famous person, who would it be and why?',
    'Se il tuo brand fosse un personaggio famoso, chi sarebbe e perché?', 'textarea', true, 2, 'both', '[]'::jsonb, true, 0),
  ('admired_company', 'Is there a company you admire for how it communicates itself? Why?',
    'C''è un''azienda che ammiri per come comunica? Perché?', 'textarea', true, 2, 'both', '[]'::jsonb, true, 1),
  ('people_say', 'What would you want people to say about you when you''re not there?',
    'Cosa vorresti che le persone dicessero di te quando non ci sei?', 'textarea', true, 2, 'both', '[]'::jsonb, true, 2),
  ('unsaid_message', 'Is there something you''ve always wanted to communicate but never found the way?',
    'C''è qualcosa che hai sempre voluto comunicare ma non hai mai trovato il modo?', 'textarea', false, 2, 'both', '[]'::jsonb, true, 3),
  ('company_personality', 'What personality does your company have?',
    'Che personalità ha la tua azienda?', 'textarea', true, 2, 'both', '[]'::jsonb, true, 4),
  ('client_feedback', 'What do clients say about the way you work?',
    'Cosa dicono i clienti del modo in cui lavori?', 'textarea', true, 2, 'both', '[]'::jsonb, true, 5),

  -- ── Step 3 — Visual & Design ──────────────────────────────────────────────
  ('brand_name', 'What name would you like to use in your brand?',
    'Quale nome vorresti usare per il tuo brand?', 'text', true, 3, 'both', '[]'::jsonb, true, 0),
  ('color_personality', 'If your company were a color, which would it be?',
    'Se la tua azienda fosse un colore, quale sarebbe?', 'select', true, 3, 'both',
    '[
      {"value":"red","label_en":"Red","label_it":"Rosso","description_en":"Passionate, energetic, bold","description_it":"Passionale, energico, audace"},
      {"value":"pink","label_en":"Pink","label_it":"Rosa","description_en":"Sensitive, caring, creative","description_it":"Sensibile, premuroso, creativo"},
      {"value":"orange","label_en":"Orange","label_it":"Arancione","description_en":"Dynamic, friendly, enthusiastic","description_it":"Dinamico, amichevole, entusiasta"},
      {"value":"yellow","label_en":"Yellow","label_it":"Giallo","description_en":"Optimistic, warm, youthful","description_it":"Ottimista, caloroso, giovane"},
      {"value":"green","label_en":"Green","label_it":"Verde","description_en":"Generous, natural, balanced","description_it":"Generoso, naturale, equilibrato"},
      {"value":"blue","label_en":"Blue","label_it":"Blu","description_en":"Calm, reliable, trustworthy","description_it":"Calmo, affidabile, che ispira fiducia"},
      {"value":"purple","label_en":"Purple","label_it":"Viola","description_en":"Mystery, luxury, imagination","description_it":"Mistero, lusso, immaginazione"},
      {"value":"brown","label_en":"Brown","label_it":"Marrone","description_en":"Practical, grounded, dependable","description_it":"Pratico, concreto, affidabile"},
      {"value":"grey","label_en":"Grey","label_it":"Grigio","description_en":"Reserved, neutral, professional","description_it":"Riservato, neutro, professionale"},
      {"value":"black","label_en":"Black","label_it":"Nero","description_en":"Power, authority, elegance","description_it":"Potere, autorità, eleganza"}
    ]'::jsonb, true, 1),
  ('color_preference', 'What color would you like in the logo? Is there one to exclude?',
    'Che colore vorresti nel logo? Ce n''è uno da escludere?', 'textarea', true, 3, 'both', '[]'::jsonb, true, 2),
  ('design_elements', 'Is there any design element you''d like in the logo?',
    'C''è qualche elemento grafico che vorresti nel logo?', 'textarea', true, 3, 'both', '[]'::jsonb, true, 3),
  ('symbol_object', 'If you were an object or symbol that represents you, what would you be and why?',
    'Se fossi un oggetto o un simbolo che ti rappresenta, cosa saresti e perché?', 'textarea', false, 3, 'both', '[]'::jsonb, true, 4),
  ('geometric_shapes', 'Which geometric shapes represent you in character?',
    'Quali forme geometriche rappresentano il tuo carattere?', 'select', true, 3, 'both',
    '[
      {"value":"rounded","label_en":"Rounded","label_it":"Arrotondate","description_en":"Soft and calm","description_it":"Morbide e calme"},
      {"value":"sharp","label_en":"Sharp","label_it":"Spigolose","description_en":"Strong and decisive","description_it":"Forti e decise"}
    ]'::jsonb, true, 5),
  ('admired_logo', 'Is there a design or logo style you particularly like?',
    'C''è uno stile di design o di logo che ti piace particolarmente?', 'textarea', true, 3, 'both', '[]'::jsonb, true, 6),
  ('brand_place', 'If your brand were a physical place, where would it be and what would it look like?',
    'Se il tuo brand fosse un luogo fisico, dove sarebbe e che aspetto avrebbe?', 'textarea', true, 3, 'both', '[]'::jsonb, true, 7),

  -- ── Step 4 — Final Details ────────────────────────────────────────────────
  ('one_word', 'Is there a single word you''d want people to immediately associate with your brand?',
    'C''è una sola parola che vorresti le persone associassero immediatamente al tuo brand?', 'text', true, 4, 'both', '[]'::jsonb, true, 0),
  ('never_communicate', 'What would you NEVER want your brand to communicate?',
    'Cosa non vorresti MAI che il tuo brand comunicasse?', 'textarea', true, 4, 'both', '[]'::jsonb, true, 1),
  ('brand_soundtrack', 'If your brand had a soundtrack, what would it be?',
    'Se il tuo brand avesse una colonna sonora, quale sarebbe?', 'textarea', false, 4, 'both', '[]'::jsonb, true, 2),
  ('era_movement', 'Is there a historical era or artistic movement you feel close to your brand?',
    'C''è un''epoca storica o un movimento artistico che senti vicino al tuo brand?', 'textarea', false, 4, 'both', '[]'::jsonb, true, 3),
  ('additional_notes', 'NOTES: add any other information you think might help',
    'NOTE: aggiungi qualsiasi altra informazione che ritieni utile', 'textarea', false, 4, 'both', '[]'::jsonb, true, 4),
  ('upload_materials', 'Upload any existing brand materials, inspiration images, or reference files',
    'Carica eventuali materiali di brand esistenti, immagini di ispirazione o file di riferimento', 'file', false, 4, 'both', '[]'::jsonb, true, 5)

ON CONFLICT (key) DO UPDATE SET
  label_en   = EXCLUDED.label_en,
  label_it   = EXCLUDED.label_it,
  type       = EXCLUDED.type,
  required   = EXCLUDED.required,
  step       = EXCLUDED.step,
  audience   = EXCLUDED.audience,
  options    = EXCLUDED.options,
  active     = true,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();
