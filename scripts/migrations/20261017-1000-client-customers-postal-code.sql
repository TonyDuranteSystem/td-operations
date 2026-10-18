-- Client invoicing: a customer can now have a postal code (ZIP / CAP). Empty for every existing customer; nothing is guessed.
ALTER TABLE client_customers ADD COLUMN IF NOT EXISTS postal_code text;
