BEGIN;
CREATE TABLE pos.whatsapp_contacts (
  customer_id uuid PRIMARY KEY REFERENCES pos.customers(id),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  verified_at timestamptz,
  updated_by uuid NOT NULL REFERENCES pos.profiles(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pos.communication_consents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES pos.customers(id),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  purpose text NOT NULL DEFAULT 'credit_reminder' CHECK (purpose = 'credit_reminder'),
  granted boolean NOT NULL,
  source text NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 100),
  evidence text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 1 AND 1000),
  captured_by uuid NOT NULL REFERENCES pos.profiles(id),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX consent_latest_idx ON pos.communication_consents(customer_id, id DESC);
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON pos.communication_consents FOR EACH ROW EXECUTE FUNCTION pos.prevent_financial_mutation();

CREATE TABLE pos.credit_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES pos.credit_accounts(id),
  period date NOT NULL CHECK (extract(day FROM period) = 1),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','retry_wait','dispatching','accepted','delivered','read','skipped','failed','unknown')),
  reason text,
  amount_snapshot numeric(18,2) CHECK (amount_snapshot > 0),
  phone_snapshot text CHECK (phone_snapshot ~ '^\+[1-9][0-9]{7,14}$'),
  consent_id bigint REFERENCES pos.communication_consents(id),
  prepared_at timestamptz,
  provider text NOT NULL DEFAULT 'mock' CHECK (provider = 'mock'),
  provider_message_id text UNIQUE,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(account_id, period),
  CHECK (status NOT IN ('dispatching','accepted','delivered','read','unknown') OR
    (amount_snapshot IS NOT NULL AND phone_snapshot IS NOT NULL AND consent_id IS NOT NULL AND prepared_at IS NOT NULL)),
  CHECK (status NOT IN ('accepted','delivered','read') OR provider_message_id IS NOT NULL)
);
CREATE INDEX reminder_pending_idx ON pos.credit_reminders(next_attempt_at, id) WHERE status IN ('queued','retry_wait');
CREATE TABLE pos.reminder_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id uuid NOT NULL REFERENCES pos.credit_reminders(id),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  dispatch_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('accepted','rejected_retryable','rejected_final','unknown','cancelled')),
  provider_code text CHECK (length(provider_code) <= 100),
  provider_message_id text,
  UNIQUE(reminder_id, attempt_number),
  CHECK ((finished_at IS NULL AND outcome IS NULL) OR (finished_at IS NOT NULL AND outcome IS NOT NULL)),
  CHECK (outcome IS DISTINCT FROM 'accepted' OR provider_message_id IS NOT NULL)
);

CREATE TABLE pos.reminder_delivery_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reminder_id uuid NOT NULL REFERENCES pos.credit_reminders(id),
  provider text NOT NULL CHECK (provider = 'mock'),
  event_key text NOT NULL CHECK (length(btrim(event_key)) BETWEEN 1 AND 200),
  delivery_status text NOT NULL CHECK (delivery_status IN ('delivered','read','failed')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(provider, event_key)
);
CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON pos.reminder_delivery_events FOR EACH ROW EXECUTE FUNCTION pos.prevent_financial_mutation();

-- No network/HTTP extensions, no Graph API tokens, no automatic live transport.
CREATE FUNCTION pos.set_whatsapp_contact(p_actor uuid, p_customer uuid, p_phone text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_account uuid; v_previous text;
BEGIN
  PERFORM pos.require_staff(p_actor);
  IF p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{7,14}$' THEN RAISE EXCEPTION 'INVALID_WHATSAPP_NUMBER'; END IF;
  SELECT id INTO v_account FROM pos.credit_accounts WHERE customer_id = p_customer FOR UPDATE;
  SELECT phone_e164 INTO v_previous FROM pos.whatsapp_contacts WHERE customer_id = p_customer FOR UPDATE;
  INSERT INTO pos.whatsapp_contacts(customer_id, phone_e164, updated_by) VALUES(p_customer, p_phone, p_actor)
  ON CONFLICT(customer_id) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164,
    verified_at = CASE WHEN pos.whatsapp_contacts.phone_e164 = EXCLUDED.phone_e164 THEN pos.whatsapp_contacts.verified_at ELSE NULL END,
    updated_by = p_actor, updated_at = clock_timestamp();
  IF v_previous IS NOT NULL AND v_previous <> p_phone THEN
    INSERT INTO pos.communication_consents(customer_id,phone_e164,granted,source,evidence,captured_by)
      VALUES(p_customer,p_phone,false,'contact_changed','Cambio de número: se requiere un nuevo consentimiento.',p_actor);
  END IF;
  INSERT INTO pos.audit_events(actor_id, action, entity_id) VALUES(p_actor, 'customer.whatsapp_contact_updated', p_customer);
END $$;

CREATE FUNCTION pos.record_communication_consent(p_actor uuid, p_customer uuid, p_phone text, p_granted boolean, p_source text, p_evidence text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_account uuid; v_id bigint;
BEGIN
  PERFORM pos.require_staff(p_actor);
  IF p_granted IS NULL THEN RAISE EXCEPTION 'INVALID_CONSENT'; END IF;
  SELECT id INTO v_account FROM pos.credit_accounts WHERE customer_id = p_customer FOR UPDATE;
  PERFORM 1 FROM pos.whatsapp_contacts WHERE customer_id = p_customer AND phone_e164 = p_phone FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTACT_MISMATCH'; END IF;
  INSERT INTO pos.communication_consents(customer_id, phone_e164, granted, source, evidence, captured_by)
    VALUES(p_customer, p_phone, p_granted, p_source, p_evidence, p_actor) RETURNING id INTO v_id;
  INSERT INTO pos.audit_events(actor_id, action, entity_id, details) VALUES(p_actor, 'customer.communication_consent', p_customer, jsonb_build_object('consent_id', v_id, 'granted', p_granted));
  RETURN v_id;
END $$;

-- Technical verification only after a trusted ownership-verification workflow.
-- Not executable by pos_app; a cashier cannot assert number ownership.
CREATE FUNCTION pos.verify_whatsapp_contact(p_customer uuid, p_phone text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
BEGIN
  PERFORM 1 FROM pos.credit_accounts WHERE customer_id = p_customer FOR UPDATE;
  UPDATE pos.whatsapp_contacts SET verified_at = clock_timestamp() WHERE customer_id = p_customer AND phone_e164 = p_phone;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTACT_MISMATCH'; END IF;
END $$;

CREATE FUNCTION pos.enqueue_credit_reminders(p_at timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_date date := (p_at AT TIME ZONE 'America/Bogota')::date; v_count integer;
BEGIN
  IF p_at IS NULL OR extract(day FROM v_date) <> 28 THEN RETURN 0; END IF;
  INSERT INTO pos.credit_reminders(account_id, period, created_at, next_attempt_at)
    SELECT id, date_trunc('month', v_date::timestamp)::date, p_at, p_at FROM pos.credit_account_balances WHERE outstanding > 0
    ON CONFLICT(account_id, period) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

-- One candidate per call; bounded Worker loop. An account lock orders receipts,
-- consent changes and final preflight; SKIP LOCKED lets separate workers cooperate.
CREATE FUNCTION pos.claim_credit_reminder(p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_job pos.credit_reminders; v_account pos.credit_accounts; v_contact pos.whatsapp_contacts;
  v_consent pos.communication_consents; v_amount numeric; v_token uuid; v_date date := (p_at AT TIME ZONE 'America/Bogota')::date;
  v_time time := (p_at AT TIME ZONE 'America/Bogota')::time; v_reason text;
BEGIN
  PERFORM pos.require_read_committed();
  IF p_at IS NULL OR extract(day FROM v_date) <> 28 OR v_time < time '09:00' OR v_time >= time '18:00' THEN RETURN NULL; END IF;
  SELECT a.* INTO v_account FROM pos.credit_accounts a WHERE EXISTS (
    SELECT FROM pos.credit_reminders r WHERE r.account_id = a.id AND r.period = date_trunc('month', v_date::timestamp)::date
      AND r.status IN ('queued','retry_wait') AND r.next_attempt_at <= p_at AND r.attempt_count < 3)
    ORDER BY a.id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO v_job FROM pos.credit_reminders WHERE account_id = v_account.id
    AND period = date_trunc('month', v_date::timestamp)::date AND status IN ('queued','retry_wait') FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT outstanding INTO v_amount FROM pos.credit_account_balances WHERE id = v_account.id;
  SELECT * INTO v_contact FROM pos.whatsapp_contacts WHERE customer_id = v_account.customer_id FOR SHARE;
  -- Latest event across the customer, not just the old phone: a revoked/new
  -- contact must not resurrect consent granted to an earlier number.
  SELECT * INTO v_consent FROM pos.communication_consents WHERE customer_id = v_account.customer_id ORDER BY id DESC LIMIT 1;
  IF v_amount <= 0 THEN v_reason := 'no_debt';
  ELSIF v_contact.verified_at IS NULL THEN v_reason := 'unverified_contact';
  ELSIF v_consent.id IS NULL OR NOT v_consent.granted OR v_consent.phone_e164 <> v_contact.phone_e164 THEN v_reason := 'no_consent'; END IF;
  IF v_reason IS NOT NULL THEN
    UPDATE pos.credit_reminders SET status = 'skipped', reason = v_reason WHERE id = v_job.id;
    RETURN jsonb_build_object('reminder_id', v_job.id, 'status', 'skipped', 'reason', v_reason);
  END IF;
  UPDATE pos.credit_reminders SET status = 'dispatching', reason = NULL, amount_snapshot = v_amount,
    phone_snapshot = v_contact.phone_e164, consent_id = v_consent.id, prepared_at = p_at,
    attempt_count = attempt_count + 1 WHERE id = v_job.id;
  INSERT INTO pos.reminder_attempts(reminder_id, attempt_number, started_at)
    VALUES(v_job.id, v_job.attempt_count + 1, p_at) RETURNING dispatch_token INTO v_token;
  RETURN jsonb_build_object('reminder_id', v_job.id, 'dispatch_token', v_token, 'status', 'dispatching',
    'account_id', v_account.id, 'customer_id', v_account.customer_id, 'amount', v_amount::text,
    'phone_e164', v_contact.phone_e164, 'as_of', p_at, 'provider', 'mock');
END $$;

-- Call immediately before transport, including after a queued dispatch has been
-- reserved. Does not hold a database transaction open over external HTTP.
CREATE FUNCTION pos.preflight_credit_reminder(p_token uuid, p_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_attempt pos.reminder_attempts; v_job pos.credit_reminders; v_account pos.credit_accounts;
  v_contact pos.whatsapp_contacts; v_consent pos.communication_consents; v_amount numeric; v_reason text;
BEGIN
  PERFORM pos.require_read_committed();
  SELECT * INTO v_attempt FROM pos.reminder_attempts WHERE dispatch_token = p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'UNKNOWN_DISPATCH_TOKEN'; END IF;
  SELECT a.* INTO v_account FROM pos.credit_accounts a JOIN pos.credit_reminders r ON r.account_id = a.id WHERE r.id = v_attempt.reminder_id FOR UPDATE OF a;
  SELECT * INTO v_attempt FROM pos.reminder_attempts WHERE dispatch_token = p_token FOR UPDATE;
  SELECT * INTO v_job FROM pos.credit_reminders WHERE id = v_attempt.reminder_id FOR UPDATE;
  IF v_attempt.finished_at IS NOT NULL OR v_job.status <> 'dispatching' THEN RETURN NULL; END IF;
  SELECT outstanding INTO v_amount FROM pos.credit_account_balances WHERE id = v_account.id;
  SELECT * INTO v_contact FROM pos.whatsapp_contacts WHERE customer_id = v_account.customer_id FOR SHARE;
  SELECT * INTO v_consent FROM pos.communication_consents WHERE customer_id = v_account.customer_id ORDER BY id DESC LIMIT 1;
  IF p_at IS NULL OR p_at < v_attempt.started_at THEN RAISE EXCEPTION 'INVALID_DELIVERY_TIME'; END IF;
  IF (p_at AT TIME ZONE 'America/Bogota')::date <> v_job.period + 27
    OR (p_at AT TIME ZONE 'America/Bogota')::time < time '09:00'
    OR (p_at AT TIME ZONE 'America/Bogota')::time >= time '18:00' THEN v_reason := 'outside_window';
  ELSIF v_amount <= 0 THEN v_reason := 'no_debt';
  ELSIF v_contact.verified_at IS NULL THEN v_reason := 'unverified_contact';
  ELSIF v_consent.id IS NULL OR NOT v_consent.granted OR v_consent.phone_e164 <> v_contact.phone_e164 THEN v_reason := 'no_consent'; END IF;
  IF v_reason IS NOT NULL THEN
    UPDATE pos.reminder_attempts SET outcome = 'cancelled', finished_at = p_at, provider_code = v_reason WHERE id = v_attempt.id;
    UPDATE pos.credit_reminders SET status = 'skipped', reason = v_reason WHERE id = v_job.id;
    RETURN jsonb_build_object('status', 'skipped', 'reason', v_reason);
  END IF;
  UPDATE pos.credit_reminders SET amount_snapshot = v_amount, phone_snapshot = v_contact.phone_e164, consent_id = v_consent.id, prepared_at = p_at WHERE id = v_job.id;
  RETURN jsonb_build_object('status', 'dispatching', 'reminder_id', v_job.id, 'dispatch_token', p_token,
    'amount', v_amount::text, 'phone_e164', v_contact.phone_e164, 'as_of', p_at, 'provider', 'mock');
END $$;

CREATE FUNCTION pos.finish_credit_reminder(p_token uuid, p_outcome text, p_message_id text, p_provider_code text, p_at timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_attempt pos.reminder_attempts; v_job pos.credit_reminders; v_status text;
BEGIN
  IF p_at IS NULL OR p_outcome NOT IN ('accepted','rejected_retryable','rejected_final','unknown') OR p_outcome IS NULL THEN RAISE EXCEPTION 'INVALID_DELIVERY_OUTCOME'; END IF;
  SELECT * INTO v_attempt FROM pos.reminder_attempts WHERE dispatch_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'UNKNOWN_DISPATCH_TOKEN'; END IF;
  IF p_at < v_attempt.started_at THEN RAISE EXCEPTION 'INVALID_DELIVERY_TIME'; END IF;
  IF v_attempt.finished_at IS NOT NULL THEN
    IF v_attempt.outcome IS DISTINCT FROM p_outcome OR v_attempt.provider_message_id IS DISTINCT FROM p_message_id THEN RAISE EXCEPTION 'DELIVERY_RESULT_CONFLICT'; END IF;
    RETURN (SELECT status FROM pos.credit_reminders WHERE id = v_attempt.reminder_id);
  END IF;
  SELECT * INTO v_job FROM pos.credit_reminders WHERE id = v_attempt.reminder_id FOR UPDATE;
  IF v_job.status <> 'dispatching' THEN RAISE EXCEPTION 'INVALID_REMINDER_STATE'; END IF;
  IF p_outcome = 'accepted' THEN
    IF nullif(btrim(p_message_id), '') IS NULL THEN RAISE EXCEPTION 'PROVIDER_MESSAGE_ID_REQUIRED'; END IF;
    v_status := 'accepted';
  ELSIF p_outcome = 'unknown' THEN v_status := 'unknown';
  ELSIF p_outcome = 'rejected_retryable' AND v_job.attempt_count < 3 THEN v_status := 'retry_wait';
  ELSE v_status := 'failed'; END IF;
  UPDATE pos.reminder_attempts SET finished_at = p_at, outcome = p_outcome, provider_code = p_provider_code, provider_message_id = p_message_id WHERE id = v_attempt.id;
  UPDATE pos.credit_reminders SET status = v_status, provider_message_id = CASE WHEN v_status = 'accepted' THEN p_message_id END,
    next_attempt_at = p_at + CASE WHEN attempt_count = 1 THEN interval '5 minutes' ELSE interval '15 minutes' END WHERE id = v_job.id;
  RETURN v_status;
END $$;
-- Simulated delivery events only. Real transport needs a separate reviewed change
-- and webhook signature verification in the future Worker.
CREATE FUNCTION pos.record_reminder_delivery(p_provider text, p_event_key text, p_message_id text, p_status text, p_occurred_at timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_job pos.credit_reminders; v_old pos.reminder_delivery_events;
BEGIN
  IF p_provider IS NULL OR p_provider <> 'mock' OR p_status IS NULL OR p_status NOT IN ('delivered','read','failed')
    OR p_occurred_at IS NULL OR p_event_key IS NULL OR length(btrim(p_event_key)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_DELIVERY_EVENT'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('webhook:' || p_provider || ':' || p_event_key, 0));
  SELECT * INTO v_job FROM pos.credit_reminders WHERE provider = p_provider AND provider_message_id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'UNKNOWN_PROVIDER_MESSAGE'; END IF;
  IF p_occurred_at < v_job.prepared_at THEN RAISE EXCEPTION 'INVALID_DELIVERY_TIME'; END IF;
  SELECT * INTO v_old FROM pos.reminder_delivery_events WHERE provider = p_provider AND event_key = p_event_key;
  IF FOUND THEN
    IF v_old.reminder_id <> v_job.id OR v_old.delivery_status <> p_status OR v_old.occurred_at <> p_occurred_at THEN RAISE EXCEPTION 'DELIVERY_EVENT_CONFLICT'; END IF;
    RETURN v_job.status;
  END IF;
  INSERT INTO pos.reminder_delivery_events(reminder_id,provider,event_key,delivery_status,occurred_at) VALUES(v_job.id,p_provider,p_event_key,p_status,p_occurred_at);
  IF v_job.status <> 'read' AND (p_status = 'read' OR (p_status = 'delivered' AND v_job.status IN ('accepted','failed')) OR (p_status = 'failed' AND v_job.status = 'accepted')) THEN
    UPDATE pos.credit_reminders SET status = p_status, reason = CASE WHEN p_status = 'failed' THEN 'delivery_failed_no_resend' END WHERE id = v_job.id;
    RETURN p_status;
  END IF;
  RETURN v_job.status;
END $$;

CREATE FUNCTION pos.get_credit_history(p_actor uuid, p_customer uuid, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_account uuid; v_result jsonb; v_receipts jsonb; v_limits jsonb; v_reminders jsonb; v_purchases jsonb;
BEGIN
  PERFORM pos.require_staff(p_actor);
  IF p_offset IS NULL OR p_limit IS NULL OR p_offset < 0 OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_FILTER'; END IF;
  SELECT id INTO v_account FROM pos.credit_accounts WHERE customer_id = p_customer;
  IF v_account IS NULL THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]') INTO v_purchases FROM (
    SELECT c.id AS charge_id, c.sale_id, c.authorization_id, c.purchased_on, c.due_on, c.principal::text, c.outstanding::text, c.status,
      s.total::text AS sale_total, s.created_by, p.display_name AS responsible
    FROM pos.credit_charge_balances c JOIN pos.sales s ON s.id = c.sale_id JOIN pos.profiles p ON p.id = s.created_by
    WHERE c.account_id = v_account ORDER BY c.purchased_on DESC, c.created_at DESC, c.id LIMIT p_limit OFFSET p_offset
  ) q;
  SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]') INTO v_receipts FROM (
    SELECT h.source_id, h.kind, h.amount::text, m.name AS method, h.actor_id, p.display_name AS responsible, h.occurred_at,
      coalesce((SELECT jsonb_agg(jsonb_build_object('charge_id', x.charge_id, 'amount', x.amount::text)) FROM pos.credit_allocations x WHERE x.receipt_id = h.source_id), '[]') AS allocations
    FROM pos.credit_receipt_history h JOIN pos.payment_methods m ON m.id = h.method_id JOIN pos.profiles p ON p.id = h.actor_id
    WHERE h.account_id = v_account ORDER BY h.occurred_at DESC, h.source_id LIMIT p_limit OFFSET p_offset
  ) q;
  SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]') INTO v_limits FROM (
    SELECT l.id, l.previous_limit::text, l.new_limit::text, l.reason, l.authorized_by, p.display_name AS responsible, l.authorized_at
    FROM pos.credit_limit_authorizations l JOIN pos.profiles p ON p.id = l.authorized_by
    WHERE l.account_id = v_account ORDER BY l.id DESC LIMIT p_limit OFFSET p_offset
  ) q;
  SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]') INTO v_reminders FROM (
    SELECT r.id, r.period, r.status, r.reason, r.amount_snapshot::text, r.provider, r.prepared_at,
      CASE WHEN r.phone_snapshot IS NOT NULL THEN '***' || right(r.phone_snapshot, 4) END AS masked_phone,
      coalesce((SELECT jsonb_agg(jsonb_build_object('attempt', a.attempt_number, 'started_at', a.started_at, 'finished_at', a.finished_at, 'outcome', a.outcome, 'provider_code', a.provider_code) ORDER BY a.attempt_number)
        FROM pos.reminder_attempts a WHERE a.reminder_id = r.id), '[]') AS attempts,
      coalesce((SELECT jsonb_agg(jsonb_build_object('status', e.delivery_status, 'occurred_at', e.occurred_at) ORDER BY e.id)
        FROM pos.reminder_delivery_events e WHERE e.reminder_id = r.id), '[]') AS delivery_events
    FROM pos.credit_reminders r WHERE r.account_id = v_account ORDER BY r.period DESC LIMIT p_limit OFFSET p_offset
  ) q;
  v_result := jsonb_build_object('account', pos.get_credit_account(p_actor, p_customer), 'purchases', v_purchases,
    'receipts', v_receipts, 'limit_authorizations', v_limits, 'reminders', v_reminders,
    'pagination', jsonb_build_object('offset', p_offset, 'limit_per_history', p_limit));
  RETURN v_result;
END $$;
COMMIT;
