BEGIN;
-- Input is the server purchase date in America/Bogota (see confirm_sale).
CREATE FUNCTION pos.credit_due_date(p_purchase date) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pos, pg_temp AS $$
BEGIN
  IF p_purchase IS NULL OR NOT isfinite(p_purchase) THEN RAISE EXCEPTION 'INVALID_PURCHASE_DATE'; END IF;
  RETURN (date_trunc('month', p_purchase::timestamp)
    + CASE WHEN extract(day FROM p_purchase) > 28 THEN interval '1 month' ELSE interval '0 months' END
    + interval '27 days')::date;
END $$;

CREATE TABLE pos.credit_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL UNIQUE REFERENCES pos.customers(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT pos.business_now(),
  UNIQUE(id, customer_id)
);
CREATE TABLE pos.credit_limit_authorizations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES pos.credit_accounts(id),
  previous_limit numeric(18,2) NOT NULL CHECK (previous_limit >= 0),
  new_limit numeric(18,2) NOT NULL CHECK (new_limit >= 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  authorized_by uuid NOT NULL REFERENCES pos.profiles(id),
  authorized_at timestamptz NOT NULL DEFAULT pos.business_now(),
  UNIQUE(id, account_id)
);
CREATE INDEX credit_limits_account_idx ON pos.credit_limit_authorizations(account_id, id DESC);

CREATE TABLE pos.credit_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  sale_id uuid NOT NULL UNIQUE,
  principal numeric(18,2) NOT NULL CHECK (principal > 0),
  authorization_id bigint NOT NULL,
  purchased_on date NOT NULL,
  due_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pos.business_now(),
  FOREIGN KEY(account_id, customer_id) REFERENCES pos.credit_accounts(id, customer_id),
  FOREIGN KEY(authorization_id, account_id) REFERENCES pos.credit_limit_authorizations(id, account_id),
  FOREIGN KEY(sale_id, customer_id) REFERENCES pos.sales(id, customer_id),
  CONSTRAINT credit_charges_due_policy CHECK (due_on >= purchased_on
    AND due_on = pos.credit_due_date(purchased_on)),
  UNIQUE(id, account_id)
);
CREATE INDEX credit_charges_fifo_idx ON pos.credit_charges(account_id, purchased_on, created_at, id);
CREATE INDEX credit_charges_due_idx ON pos.credit_charges(due_on, account_id);

CREATE TABLE pos.credit_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES pos.credit_accounts(id),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  method_id uuid NOT NULL REFERENCES pos.payment_methods(id),
  reference text,
  affects_cash_snapshot boolean NOT NULL,
  cash_session_id uuid NOT NULL REFERENCES pos.cash_sessions(id),
  received_by uuid NOT NULL REFERENCES pos.profiles(id),
  received_at timestamptz NOT NULL DEFAULT pos.business_now(),
  UNIQUE(id, account_id)
);
ALTER TABLE pos.cash_entries ADD FOREIGN KEY(receipt_id) REFERENCES pos.credit_receipts(id);
CREATE INDEX credit_receipts_account_idx ON pos.credit_receipts(account_id, received_at, id);
CREATE INDEX credit_receipts_date_idx ON pos.credit_receipts(received_at, id);

CREATE TABLE pos.credit_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  charge_id uuid NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  FOREIGN KEY(receipt_id, account_id) REFERENCES pos.credit_receipts(id, account_id),
  FOREIGN KEY(charge_id, account_id) REFERENCES pos.credit_charges(id, account_id),
  UNIQUE(receipt_id, charge_id)
);
CREATE INDEX credit_allocations_charge_idx ON pos.credit_allocations(charge_id);

CREATE VIEW pos.credit_charge_balances AS
SELECT c.*, c.principal - coalesce(a.allocated, 0) AS outstanding,
  CASE WHEN c.principal = coalesce(a.allocated, 0) THEN 'paid'
    WHEN c.due_on < (pos.business_now() AT TIME ZONE 'America/Bogota')::date THEN 'overdue'
    ELSE 'active' END AS status,
  CASE WHEN c.principal = coalesce(a.allocated, 0) THEN a.last_paid_at END AS settled_at
FROM pos.credit_charges c LEFT JOIN LATERAL (
  SELECT sum(x.amount) AS allocated, max(r.received_at) AS last_paid_at
  FROM pos.credit_allocations x JOIN pos.credit_receipts r ON r.id = x.receipt_id WHERE x.charge_id = c.id
) a ON true;

CREATE VIEW pos.credit_account_balances AS
SELECT a.*, coalesce(l.new_limit, 0) AS authorized_limit, l.id AS authorization_id,
  coalesce(d.outstanding, 0) AS outstanding,
  coalesce(l.new_limit, 0) - coalesce(d.outstanding, 0) AS available
FROM pos.credit_accounts a
LEFT JOIN LATERAL (SELECT id, new_limit FROM pos.credit_limit_authorizations WHERE account_id = a.id ORDER BY id DESC LIMIT 1) l ON true
LEFT JOIN LATERAL (SELECT sum(outstanding) AS outstanding FROM pos.credit_charge_balances WHERE account_id = a.id) d ON true;

CREATE VIEW pos.credit_receipt_history AS
SELECT r.account_id, r.id AS source_id, 'receipt'::text AS kind, r.amount, r.method_id,
  r.received_by AS actor_id, r.received_at AS occurred_at FROM pos.credit_receipts r
UNION ALL
SELECT c.account_id, p.id, 'initial_payment', p.amount, p.method_id, s.created_by, s.created_at
FROM pos.credit_charges c JOIN pos.sales s ON s.id = c.sale_id JOIN pos.payments p ON p.sale_id = s.id;

CREATE FUNCTION pos.authorize_credit_limit(p_actor uuid, p_customer uuid, p_limit numeric, p_reason text, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_account uuid; v_old numeric; v_debt numeric; v_id bigint; v_response jsonb;
  v_request jsonb := jsonb_build_object('customer', p_customer, 'limit', p_limit, 'reason', p_reason);
BEGIN
  PERFORM pos.require_staff(p_actor);
  PERFORM pos.require_amount(p_limit, true);
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  v_response := pos.begin_request(p_actor, 'authorize_limit', p_key, v_request);
  IF v_response IS NOT NULL THEN RETURN v_response; END IF;
  IF NOT EXISTS (SELECT FROM pos.customers WHERE id = p_customer AND active) THEN RAISE EXCEPTION 'CUSTOMER_NOT_ACTIVE'; END IF;
  INSERT INTO pos.credit_accounts(customer_id) VALUES(p_customer) ON CONFLICT(customer_id) DO NOTHING;
  SELECT id INTO v_account FROM pos.credit_accounts WHERE customer_id = p_customer AND active FOR UPDATE;
  IF v_account IS NULL THEN RAISE EXCEPTION 'ACCOUNT_NOT_ACTIVE'; END IF;
  SELECT authorized_limit, outstanding INTO v_old, v_debt FROM pos.credit_account_balances WHERE id = v_account;
  IF p_limit < v_debt THEN RAISE EXCEPTION 'LIMIT_BELOW_DEBT'; END IF;
  INSERT INTO pos.credit_limit_authorizations(account_id, previous_limit, new_limit, reason, authorized_by)
    VALUES(v_account, v_old, p_limit, btrim(p_reason), p_actor) RETURNING id INTO v_id;
  INSERT INTO pos.audit_events(actor_id, action, entity_id, details)
    VALUES(p_actor, 'credit.limit_authorized', v_account, jsonb_build_object('authorization_id', v_id, 'old', v_old, 'new', p_limit));
  v_response := jsonb_build_object('authorization_id', v_id, 'account_id', v_account, 'authorized_limit', p_limit::text);
  INSERT INTO pos.idempotency_requests VALUES(p_actor, 'authorize_limit', p_key, v_request, v_response, pos.business_now());
  RETURN v_response;
END $$;

CREATE FUNCTION pos.confirm_sale(p_actor uuid, p_customer uuid, p_session uuid, p_lines jsonb, p_payments jsonb, p_finance_remainder boolean, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_account uuid; v_sale uuid := gen_random_uuid(); v_charge uuid; v_payment uuid;
  v_total numeric := 0; v_paid numeric := 0; v_financed numeric; v_available numeric; v_amount numeric;
  v_method pos.payment_methods; v_line jsonb; v_lines jsonb; v_item record; v_due date;
  v_now timestamptz; v_response jsonb; v_authorization_id bigint;
  v_request jsonb := jsonb_build_object('customer', p_customer, 'session', p_session, 'lines', p_lines, 'payments', p_payments, 'finance', p_finance_remainder);
BEGIN
  PERFORM pos.require_staff(p_actor);
  v_response := pos.begin_request(p_actor, 'sale', p_key, v_request);
  IF v_response IS NOT NULL THEN RETURN v_response; END IF;
  IF p_finance_remainder IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_payments) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'INVALID_SALE'; END IF;
  IF jsonb_array_length(p_lines) NOT BETWEEN 1 AND 100 OR jsonb_array_length(p_payments) > 10 THEN RAISE EXCEPTION 'INVALID_SALE'; END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number'
      OR (v_line->>'quantity')::numeric NOT BETWEEN 1 AND 1000000
      OR (v_line->>'quantity')::numeric <> trunc((v_line->>'quantity')::numeric)
      OR v_line->>'product_id' IS NULL THEN RAISE EXCEPTION 'INVALID_QUANTITY'; END IF;
  END LOOP;
  SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity) ORDER BY product_id) INTO v_lines
  FROM (SELECT (value->>'product_id')::uuid product_id, sum((value->>'quantity')::integer)::integer quantity
    FROM jsonb_array_elements(p_lines) GROUP BY (value->>'product_id')::uuid) q;

  IF p_customer IS NOT NULL AND NOT EXISTS (SELECT FROM pos.customers WHERE id = p_customer AND active) THEN RAISE EXCEPTION 'CUSTOMER_NOT_ACTIVE'; END IF;
  IF p_finance_remainder THEN
    IF p_customer IS NULL THEN RAISE EXCEPTION 'CREDIT_CUSTOMER_REQUIRED'; END IF;
    SELECT id INTO v_account FROM pos.credit_accounts WHERE customer_id = p_customer AND active FOR UPDATE;
    IF v_account IS NULL THEN RAISE EXCEPTION 'CREDIT_ACCOUNT_REQUIRED'; END IF;
  END IF;
  PERFORM pos.lock_cash_session(p_actor, p_session);
  PERFORM p.id FROM pos.products p JOIN jsonb_to_recordset(v_lines) x(product_id uuid, quantity integer) ON p.id = x.product_id ORDER BY p.id FOR SHARE OF p;
  PERFORM b.product_id FROM pos.inventory_balances b JOIN jsonb_to_recordset(v_lines) x(product_id uuid, quantity integer) ON b.product_id = x.product_id ORDER BY b.product_id FOR UPDATE OF b;
  FOR v_item IN SELECT x.*, p.name, p.price, p.active, b.quantity AS stock FROM jsonb_to_recordset(v_lines) x(product_id uuid, quantity integer)
    LEFT JOIN pos.products p ON p.id = x.product_id LEFT JOIN pos.inventory_balances b ON b.product_id = x.product_id ORDER BY x.product_id LOOP
    IF v_item.active IS DISTINCT FROM true OR v_item.stock IS NULL THEN RAISE EXCEPTION 'PRODUCT_NOT_AVAILABLE'; END IF;
    IF v_item.quantity > v_item.stock THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK'; END IF;
    v_total := v_total + v_item.price * v_item.quantity;
  END LOOP;
  PERFORM pos.require_amount(v_total);
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    v_amount := (v_line->>'amount')::numeric;
    PERFORM pos.require_amount(v_amount);
    SELECT * INTO v_method FROM pos.payment_methods WHERE id = (v_line->>'method_id')::uuid AND active FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_PAYMENT_METHOD'; END IF;
    IF v_method.requires_reference AND nullif(btrim(v_line->>'reference'), '') IS NULL THEN RAISE EXCEPTION 'PAYMENT_REFERENCE_REQUIRED'; END IF;
    v_paid := v_paid + v_amount;
  END LOOP;
  IF v_paid > v_total THEN RAISE EXCEPTION 'PAYMENT_EXCEEDS_TOTAL'; END IF;
  v_financed := v_total - v_paid;
  v_now := pos.business_now();
  IF v_financed > 0 THEN
    IF NOT p_finance_remainder THEN RAISE EXCEPTION 'PAYMENTS_DO_NOT_MATCH'; END IF;
    v_due := pos.credit_due_date((v_now AT TIME ZONE 'America/Bogota')::date);
    SELECT available, authorization_id INTO v_available, v_authorization_id FROM pos.credit_account_balances WHERE id = v_account;
    IF v_financed > v_available THEN RAISE EXCEPTION 'CREDIT_LIMIT_EXCEEDED'; END IF;
  END IF;
  INSERT INTO pos.sales(id, customer_id, cash_session_id, created_by, created_at, total) VALUES(v_sale, p_customer, p_session, p_actor, v_now, v_total);
  FOR v_item IN SELECT x.*, p.name, p.price FROM jsonb_to_recordset(v_lines) x(product_id uuid, quantity integer) JOIN pos.products p ON p.id = x.product_id LOOP
    INSERT INTO pos.sale_items(sale_id, product_id, name_snapshot, quantity, unit_price, total) VALUES(v_sale, v_item.product_id, v_item.name, v_item.quantity, v_item.price, v_item.quantity * v_item.price);
    UPDATE pos.inventory_balances SET quantity = quantity - v_item.quantity WHERE product_id = v_item.product_id;
    INSERT INTO pos.inventory_movements(sale_id, product_id, quantity_delta, created_by, created_at) VALUES(v_sale, v_item.product_id, -v_item.quantity, p_actor, v_now);
  END LOOP;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_payments) LOOP
    SELECT * INTO v_method FROM pos.payment_methods WHERE id = (v_line->>'method_id')::uuid;
    INSERT INTO pos.payments(sale_id, method_id, amount, reference, affects_cash_snapshot) VALUES(v_sale, v_method.id, (v_line->>'amount')::numeric, v_line->>'reference', v_method.affects_cash) RETURNING id INTO v_payment;
    IF v_method.affects_cash THEN
      INSERT INTO pos.cash_entries(session_id, payment_id, amount, created_by) VALUES(p_session, v_payment, (v_line->>'amount')::numeric, p_actor);
    END IF;
  END LOOP;
  IF v_financed > 0 THEN
    INSERT INTO pos.credit_charges(account_id, customer_id, sale_id, principal, authorization_id, purchased_on, due_on, created_at)
      VALUES(v_account, p_customer, v_sale, v_financed, v_authorization_id, (v_now AT TIME ZONE 'America/Bogota')::date, v_due, v_now) RETURNING id INTO v_charge;
  END IF;
  INSERT INTO pos.audit_events(actor_id, action, entity_id, details) VALUES(p_actor, 'sale.confirmed', v_sale, jsonb_build_object('total', v_total, 'received', v_paid, 'financed', v_financed));
  v_response := jsonb_build_object('sale_id', v_sale, 'charge_id', v_charge, 'total', v_total::text, 'received', v_paid::text, 'financed', v_financed::text, 'due_on', v_due);
  INSERT INTO pos.idempotency_requests VALUES(p_actor, 'sale', p_key, v_request, v_response, pos.business_now());
  RETURN v_response;
END $$;

CREATE FUNCTION pos.record_credit_receipt(p_actor uuid, p_customer uuid, p_session uuid, p_amount numeric, p_method uuid, p_reference text, p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_account uuid; v_debt numeric; v_left numeric := p_amount; v_take numeric; v_charge record;
  v_method pos.payment_methods; v_receipt uuid := gen_random_uuid(); v_response jsonb;
  v_request jsonb := jsonb_build_object('customer', p_customer, 'session', p_session, 'amount', p_amount, 'method', p_method, 'reference', p_reference);
BEGIN
  PERFORM pos.require_staff(p_actor);
  PERFORM pos.require_amount(p_amount);
  v_response := pos.begin_request(p_actor, 'credit_receipt', p_key, v_request);
  IF v_response IS NOT NULL THEN RETURN v_response; END IF;
  -- Receipts are allowed even when an account/customer is disabled for new credit.
  SELECT id INTO v_account FROM pos.credit_accounts WHERE customer_id = p_customer FOR UPDATE;
  IF v_account IS NULL THEN RAISE EXCEPTION 'CREDIT_ACCOUNT_REQUIRED'; END IF;
  PERFORM pos.lock_cash_session(p_actor, p_session);
  SELECT * INTO v_method FROM pos.payment_methods WHERE id = p_method AND active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_PAYMENT_METHOD'; END IF;
  IF v_method.requires_reference AND nullif(btrim(p_reference), '') IS NULL THEN RAISE EXCEPTION 'PAYMENT_REFERENCE_REQUIRED'; END IF;
  SELECT outstanding INTO v_debt FROM pos.credit_account_balances WHERE id = v_account;
  IF p_amount > v_debt THEN RAISE EXCEPTION 'AMOUNT_EXCEEDS_DEBT'; END IF;
  INSERT INTO pos.credit_receipts(id, account_id, amount, method_id, reference, affects_cash_snapshot, cash_session_id, received_by)
    VALUES(v_receipt, v_account, p_amount, p_method, p_reference, v_method.affects_cash, p_session, p_actor);
  FOR v_charge IN SELECT * FROM pos.credit_charge_balances WHERE account_id = v_account AND outstanding > 0 ORDER BY purchased_on, created_at, id LOOP
    v_take := least(v_left, v_charge.outstanding);
    INSERT INTO pos.credit_allocations(account_id, receipt_id, charge_id, amount) VALUES(v_account, v_receipt, v_charge.id, v_take);
    v_left := v_left - v_take;
    EXIT WHEN v_left = 0;
  END LOOP;
  IF v_left <> 0 THEN RAISE EXCEPTION 'ALLOCATION_INTEGRITY_ERROR'; END IF;
  IF v_method.affects_cash THEN
    INSERT INTO pos.cash_entries(session_id, receipt_id, amount, created_by) VALUES(p_session, v_receipt, p_amount, p_actor);
  END IF;
  INSERT INTO pos.audit_events(actor_id, action, entity_id, details) VALUES(p_actor, 'credit.receipt_recorded', v_receipt, jsonb_build_object('account_id', v_account, 'amount', p_amount));
  v_response := jsonb_build_object('receipt_id', v_receipt, 'outstanding', (v_debt - p_amount)::text, 'status', CASE WHEN v_debt = p_amount THEN 'paid' ELSE 'outstanding' END);
  INSERT INTO pos.idempotency_requests VALUES(p_actor, 'credit_receipt', p_key, v_request, v_response, pos.business_now());
  RETURN v_response;
END $$;

-- Deferred cross-row invariants: run after the complete business transaction.
CREATE FUNCTION pos.assert_credit_integrity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_sale uuid; v_receipt uuid; v_account uuid;
BEGIN
  IF TG_TABLE_NAME = 'sales' THEN v_sale := NEW.id;
  ELSIF TG_TABLE_NAME IN ('sale_items', 'payments', 'credit_charges', 'inventory_movements') THEN v_sale := NEW.sale_id; END IF;
  IF v_sale IS NOT NULL THEN
    IF EXISTS (SELECT FROM pos.sales s WHERE s.id = v_sale AND (
      s.total <> (SELECT coalesce(sum(total), 0) FROM pos.sale_items WHERE sale_id = s.id)
      OR s.total <> (SELECT coalesce(sum(amount), 0) FROM pos.payments WHERE sale_id = s.id) + (SELECT coalesce(sum(principal), 0) FROM pos.credit_charges WHERE sale_id = s.id))) THEN
      RAISE EXCEPTION 'SALE_TOTAL_INTEGRITY_ERROR';
    END IF;
    IF EXISTS (SELECT FROM pos.credit_charges c JOIN pos.sales s ON s.id = c.sale_id WHERE c.sale_id = v_sale
      AND c.purchased_on <> (s.created_at AT TIME ZONE 'America/Bogota')::date) THEN RAISE EXCEPTION 'CREDIT_PURCHASE_DATE_MISMATCH'; END IF;
    IF EXISTS (SELECT FROM pos.sale_items i FULL JOIN pos.inventory_movements m ON m.sale_id = i.sale_id AND m.product_id = i.product_id
      WHERE coalesce(i.sale_id, m.sale_id) = v_sale AND (i.id IS NULL OR m.id IS NULL OR i.quantity <> -m.quantity_delta)) THEN RAISE EXCEPTION 'STOCK_MOVEMENT_INTEGRITY_ERROR'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'credit_receipts' THEN v_receipt := NEW.id;
  ELSIF TG_TABLE_NAME = 'credit_allocations' THEN v_receipt := NEW.receipt_id; END IF;
  IF v_receipt IS NOT NULL AND EXISTS (SELECT FROM pos.credit_receipts r WHERE r.id = v_receipt
    AND r.amount <> (SELECT coalesce(sum(amount), 0) FROM pos.credit_allocations WHERE receipt_id = r.id)) THEN RAISE EXCEPTION 'RECEIPT_ALLOCATION_INTEGRITY_ERROR'; END IF;
  IF TG_TABLE_NAME IN ('credit_charges', 'credit_receipts', 'credit_allocations', 'credit_limit_authorizations') THEN
    v_account := NEW.account_id;
    IF EXISTS (SELECT FROM pos.credit_charge_balances WHERE account_id = v_account AND outstanding < 0) THEN RAISE EXCEPTION 'OVERALLOCATED_CREDIT'; END IF;
    IF EXISTS (SELECT FROM pos.credit_account_balances WHERE id = v_account AND available < 0) THEN RAISE EXCEPTION 'CREDIT_LIMIT_EXCEEDED'; END IF;
  END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sales','sale_items','payments','inventory_movements','credit_charges','credit_receipts','credit_allocations','credit_limit_authorizations'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER credit_integrity AFTER INSERT ON pos.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pos.assert_credit_integrity()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['credit_limit_authorizations','credit_charges','credit_receipts','credit_allocations'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON pos.%I FOR EACH ROW EXECUTE FUNCTION pos.prevent_financial_mutation()', t);
  END LOOP;
END $$;

CREATE FUNCTION pos.assert_cash_integrity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_payment uuid; v_receipt uuid;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN v_payment := NEW.id;
  ELSIF TG_TABLE_NAME = 'credit_receipts' THEN v_receipt := NEW.id;
  ELSE v_payment := NEW.payment_id; v_receipt := NEW.receipt_id; END IF;
  IF v_payment IS NOT NULL AND EXISTS (
    SELECT FROM pos.payments p JOIN pos.sales s ON s.id = p.sale_id WHERE p.id = v_payment AND (
      (p.affects_cash_snapshot AND (SELECT count(*) FROM pos.cash_entries e WHERE e.payment_id = p.id AND e.amount = p.amount AND e.session_id = s.cash_session_id) <> 1)
      OR (NOT p.affects_cash_snapshot AND EXISTS (SELECT FROM pos.cash_entries e WHERE e.payment_id = p.id))))
    THEN RAISE EXCEPTION 'CASH_PAYMENT_INTEGRITY_ERROR'; END IF;
  IF v_receipt IS NOT NULL AND EXISTS (
    SELECT FROM pos.credit_receipts r WHERE r.id = v_receipt AND (
      (r.affects_cash_snapshot AND (SELECT count(*) FROM pos.cash_entries e WHERE e.receipt_id = r.id AND e.amount = r.amount AND e.session_id = r.cash_session_id) <> 1)
      OR (NOT r.affects_cash_snapshot AND EXISTS (SELECT FROM pos.cash_entries e WHERE e.receipt_id = r.id))))
    THEN RAISE EXCEPTION 'CASH_RECEIPT_INTEGRITY_ERROR'; END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['payments','credit_receipts','cash_entries'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER cash_integrity AFTER INSERT ON pos.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pos.assert_cash_integrity()', t);
  END LOOP;
END $$;

CREATE FUNCTION pos.get_credit_account(p_actor uuid, p_customer uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_result jsonb; BEGIN
  PERFORM pos.require_staff(p_actor);
  SELECT jsonb_build_object('account_id', id, 'customer_id', customer_id, 'authorized_limit', authorized_limit::text,
    'authorization_id', authorization_id, 'outstanding', outstanding::text, 'available', available::text) INTO v_result
    FROM pos.credit_account_balances WHERE customer_id = p_customer;
  RETURN v_result;
END $$;

CREATE FUNCTION pos.list_credits(p_actor uuid, p_customer uuid DEFAULT NULL, p_status text DEFAULT NULL,
  p_from date DEFAULT NULL, p_to date DEFAULT NULL, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_result jsonb; BEGIN
  PERFORM pos.require_staff(p_actor);
  IF p_offset IS NULL OR p_limit IS NULL OR p_offset < 0 OR p_limit NOT BETWEEN 1 AND 100 OR (p_status IS NOT NULL AND p_status NOT IN ('active','overdue','paid'))
    OR (p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to) THEN RAISE EXCEPTION 'INVALID_FILTER'; END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]') INTO v_result FROM (
    SELECT c.id, c.sale_id, c.customer_id, c.purchased_on, c.due_on, c.principal::text, c.outstanding::text, c.status, c.settled_at
    FROM pos.credit_charge_balances c WHERE (p_customer IS NULL OR c.customer_id = p_customer)
      AND (p_status IS NULL OR c.status = p_status) AND (p_from IS NULL OR c.purchased_on >= p_from) AND (p_to IS NULL OR c.purchased_on <= p_to)
    ORDER BY c.purchased_on DESC, c.id LIMIT p_limit OFFSET p_offset
  ) q;
  RETURN v_result;
END $$;

CREATE FUNCTION pos.credit_summary(p_actor uuid, p_month date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_result jsonb; v_start timestamptz; v_end timestamptz; BEGIN
  PERFORM pos.require_staff(p_actor);
  IF p_month IS NULL THEN RAISE EXCEPTION 'INVALID_FILTER'; END IF;
  v_start := date_trunc('month', p_month::timestamp) AT TIME ZONE 'America/Bogota';
  v_end := (date_trunc('month', p_month::timestamp) + interval '1 month') AT TIME ZONE 'America/Bogota';
  SELECT jsonb_build_object('portfolio', coalesce(sum(outstanding), 0)::text,
    'active', count(*) FILTER (WHERE status = 'active'), 'overdue', count(*) FILTER (WHERE status = 'overdue'),
    'paid', count(*) FILTER (WHERE status = 'paid'), 'debtors', count(DISTINCT account_id) FILTER (WHERE outstanding > 0),
    'monthly_collections', (SELECT coalesce(sum(amount), 0)::text FROM pos.credit_receipt_history WHERE occurred_at >= v_start AND occurred_at < v_end),
    'collections_from', v_start, 'collections_until_exclusive', v_end, 'scope', 'global') INTO v_result FROM pos.credit_charge_balances;
  RETURN v_result;
END $$;
COMMIT;
