CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  pagespeed_api_key TEXT,
  hunter_api_key TEXT,
  groq_api_key TEXT,
  sendgrid_api_key TEXT,
  sendgrid_from TEXT,
  sendgrid_name TEXT,
  sendgrid_template_id TEXT,
  mailgun_api_key TEXT,
  mailgun_domain TEXT,
  mailgun_from TEXT,
  email_provider TEXT NOT NULL DEFAULT 'gmail' CHECK (email_provider IN ('gmail','sendgrid','mailgun')),
  gmail_accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
  gmail_access_token TEXT,
  gmail_refresh_token TEXT,
  gmail_token_expiry BIGINT,
  send_delay INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  domain_key TEXT,
  mobile_performance INTEGER,
  desktop_performance INTEGER,
  mobile_seo INTEGER,
  desktop_seo INTEGER,
  mobile_best_practices INTEGER,
  desktop_best_practices INTEGER,
  mobile_accessibility INTEGER,
  desktop_accessibility INTEGER,
  contact_email TEXT,
  email_source TEXT,
  email_status TEXT NOT NULL DEFAULT 'Not Checked',
  flagged BOOLEAN NOT NULL DEFAULT false,
  deep_findings JSONB NOT NULL DEFAULT '[]'::jsonb,
  deep_priority TEXT NOT NULL DEFAULT 'NONE',
  deep_scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
  name TEXT,
  email TEXT,
  domain TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  outreach_stage TEXT NOT NULL DEFAULT 'lead',
  notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_emailed TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  template_id UUID REFERENCES templates(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  UNIQUE (campaign_id, contact_id)
);

CREATE TABLE IF NOT EXISTS email_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  store_name TEXT,
  to_email TEXT,
  provider TEXT,
  provider_message_id TEXT,
  opened TEXT NOT NULL DEFAULT 'No',
  replied TEXT NOT NULL DEFAULT 'No',
  clicked TEXT NOT NULL DEFAULT 'No',
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tracker (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_name TEXT,
  website TEXT,
  email TEXT,
  mobile_score INTEGER,
  subject_used TEXT,
  reply TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_user_url_unique ON stores(user_id, url);
CREATE INDEX IF NOT EXISTS idx_stores_user_id ON stores(user_id);
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sendgrid_api_key TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sendgrid_from TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sendgrid_name TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS sendgrid_template_id TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS mailgun_api_key TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS mailgun_domain TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS mailgun_from TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS gmail_access_token TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS gmail_refresh_token TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS gmail_token_expiry BIGINT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS send_delay INTEGER NOT NULL DEFAULT 3;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS domain_key TEXT;
UPDATE stores SET domain_key = lower(regexp_replace(substring(url from '^https?://([^/:?#]+)'), '^www\.', '')) WHERE domain_key IS NULL;
CREATE INDEX IF NOT EXISTS idx_stores_user_domain ON stores(user_id, domain_key);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS deep_findings JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS deep_priority TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS deep_scanned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_templates_user_id ON templates(user_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_user_id ON campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_user_id ON email_logs(user_id);
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS store_name TEXT;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS to_email TEXT;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS opened TEXT NOT NULL DEFAULT 'No';
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS replied TEXT NOT NULL DEFAULT 'No';
ALTER TABLE email_logs ADD COLUMN IF NOT EXISTS clicked TEXT NOT NULL DEFAULT 'No';
CREATE INDEX IF NOT EXISTS idx_email_logs_provider_message_id
  ON email_logs ((lower(replace(replace(provider_message_id, '<', ''), '>', ''))))
  WHERE provider_message_id IS NOT NULL;
ALTER TABLE contacts ALTER COLUMN email DROP NOT NULL;
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'contacts' AND column_name = 'notes') = 'text' THEN
    ALTER TABLE contacts ALTER COLUMN notes DROP DEFAULT;
    ALTER TABLE contacts ALTER COLUMN notes TYPE JSONB USING CASE WHEN notes IS NULL OR btrim(notes) = '' THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('text', notes, 'ts', COALESCE(created_at, NOW()))) END;
  END IF;
END $$;
ALTER TABLE contacts ALTER COLUMN notes SET DEFAULT '[]'::jsonb;
ALTER TABLE contacts ALTER COLUMN notes SET NOT NULL;
CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gmail_oauth_states_expiry ON gmail_oauth_states(expires_at);
CREATE TABLE IF NOT EXISTS email_provider_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  email_log_id UUID NOT NULL REFERENCES email_logs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX IF NOT EXISTS idx_email_provider_events_log ON email_provider_events(email_log_id);
CREATE INDEX IF NOT EXISTS idx_tracker_user_id ON tracker(user_id);
