-- Proposal for a NEW database. Do not apply to Supabase/production at this stage.
-- auth.users is managed by Supabase; local tests provide an isolated fixture.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pos_owner') THEN CREATE ROLE pos_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pos_app') THEN CREATE ROLE pos_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pos_scheduler') THEN CREATE ROLE pos_scheduler NOLOGIN; END IF;
END $$;
-- Existing roles must not silently import privileges from another application.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('pos_owner','pos_app','pos_scheduler')
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      WHERE r.rolname IN ('pos_owner','pos_app','pos_scheduler'))
    OR EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
      JOIN pg_roles member_role ON member_role.oid = m.member
      WHERE r.rolname IN ('pos_owner','pos_app','pos_scheduler')
      AND member_role.rolname <> current_user) THEN
    RAISE EXCEPTION 'UNSAFE_POS_ROLE_CONFIGURATION';
  END IF;
END $$;
-- Migration administrator must be able to transfer ownership without using a
-- superuser. Do not grant this ownership role to the application credentials.
GRANT pos_owner TO CURRENT_USER;
-- PostgreSQL 16+ separates SET from ADMIN membership. Support hosted PG15 too.
DO $$ BEGIN
  IF current_setting('server_version_num')::integer >= 160000 THEN
    EXECUTE format('GRANT pos_owner TO %I WITH SET TRUE, INHERIT FALSE', current_user);
  END IF;
END $$;

CREATE SCHEMA pos;
REVOKE ALL ON SCHEMA pos FROM PUBLIC;

-- Server clock, never supplied by React. Tests replace it only in an isolated DB.
CREATE FUNCTION pos.business_now() RETURNS timestamptz
LANGUAGE sql VOLATILE SET search_path = pg_catalog AS $$ SELECT clock_timestamp() $$;

CREATE TABLE pos.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  role text NOT NULL CHECK (role IN ('admin', 'supervisor', 'cashier')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pos.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pos.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  price numeric(18,2) NOT NULL CHECK (price > 0),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE pos.inventory_balances (
  product_id uuid PRIMARY KEY REFERENCES pos.products(id) ON DELETE RESTRICT,
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0)
);
CREATE TABLE pos.payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code <> 'credit'),
  name text NOT NULL,
  affects_cash boolean NOT NULL,
  requires_reference boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true
);
INSERT INTO pos.payment_methods(code, name, affects_cash, requires_reference) VALUES
  ('cash', 'Efectivo', true, false), ('transfer', 'Transferencia', false, true), ('card', 'Tarjeta', false, true);

CREATE TABLE pos.cash_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_code text NOT NULL DEFAULT 'MAIN',
  operator_id uuid NOT NULL REFERENCES pos.profiles(id),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  opening_float numeric(18,2) NOT NULL CHECK (opening_float >= 0),
  closed_at timestamptz,
  CHECK (closed_at IS NULL OR closed_at >= opened_at)
);
CREATE UNIQUE INDEX cash_one_open_register ON pos.cash_sessions(register_code) WHERE closed_at IS NULL;
CREATE UNIQUE INDEX cash_one_open_operator ON pos.cash_sessions(operator_id) WHERE closed_at IS NULL;

CREATE TABLE pos.sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  customer_id uuid REFERENCES pos.customers(id) ON DELETE RESTRICT,
  cash_session_id uuid NOT NULL REFERENCES pos.cash_sessions(id),
  created_by uuid NOT NULL REFERENCES pos.profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  total numeric(18,2) NOT NULL CHECK (total > 0),
  UNIQUE(id, customer_id)
);
CREATE TABLE pos.sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES pos.sales(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES pos.products(id),
  name_snapshot text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(18,2) NOT NULL CHECK (unit_price > 0),
  total numeric(18,2) NOT NULL CHECK (total = quantity * unit_price),
  UNIQUE(sale_id, product_id)
);
CREATE TABLE pos.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES pos.sales(id),
  method_id uuid NOT NULL REFERENCES pos.payment_methods(id),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  reference text,
  affects_cash_snapshot boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pos.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES pos.sales(id),
  product_id uuid NOT NULL REFERENCES pos.products(id),
  quantity_delta integer NOT NULL CHECK (quantity_delta < 0),
  created_by uuid NOT NULL REFERENCES pos.profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(sale_id, product_id)
);
CREATE TABLE pos.cash_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES pos.cash_sessions(id),
  payment_id uuid UNIQUE REFERENCES pos.payments(id),
  -- receipt_id FK added after credit_receipts exists.
  receipt_id uuid UNIQUE,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  created_by uuid NOT NULL REFERENCES pos.profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(payment_id, receipt_id) = 1)
);
CREATE TABLE pos.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES pos.profiles(id),
  action text NOT NULL,
  entity_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pos.idempotency_requests (
  actor_id uuid NOT NULL REFERENCES pos.profiles(id),
  operation text NOT NULL,
  key text NOT NULL CHECK (length(btrim(key)) BETWEEN 1 AND 128),
  request jsonb NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_id, operation, key)
);
CREATE INDEX sales_date_idx ON pos.sales(created_at, id);
CREATE INDEX sales_customer_idx ON pos.sales(customer_id, created_at, id);
CREATE INDEX sale_items_product_idx ON pos.sale_items(product_id);
CREATE INDEX payments_sale_idx ON pos.payments(sale_id);
CREATE INDEX inventory_movements_product_idx ON pos.inventory_movements(product_id, created_at);
CREATE INDEX cash_entries_session_idx ON pos.cash_entries(session_id);

-- Account row locks serialize commands; balances must be reread after waiting.
-- A repeatable-read snapshot could otherwise retain a stale portfolio balance.
CREATE FUNCTION pos.require_read_committed() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pos, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'READ_COMMITTED_REQUIRED';
  END IF;
END $$;

CREATE FUNCTION pos.require_staff(p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_role text;
BEGIN
  PERFORM pos.require_read_committed();
  -- Only PostgREST's JWT-verifying gateway may establish this request context.
  -- A direct pos_app SQL connection can SET custom GUCs: never trust those alone.
  IF session_user <> 'authenticator'
    OR coalesce(current_setting('request.jwt.claims', true), '') = '' THEN
    RAISE EXCEPTION 'UNTRUSTED_AUTH_CONTEXT' USING ERRCODE = '42501';
  END IF;
  IF (current_setting('request.jwt.claims', true)::jsonb->>'role') IS DISTINCT FROM 'authenticated'
    OR p_actor IS NULL
    OR (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid IS DISTINCT FROM p_actor
    OR coalesce((current_setting('request.jwt.claims', true)::jsonb->>'exp')::numeric, 0)
      <= extract(epoch FROM clock_timestamp()) THEN
    RAISE EXCEPTION 'FORBIDDEN_ACTOR' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO v_role FROM pos.profiles WHERE id = p_actor AND active FOR SHARE;
  IF v_role IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  RETURN v_role;
END $$;

CREATE FUNCTION pos.require_amount(p_amount numeric, p_allow_zero boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pos, pg_temp AS $$
BEGIN
  IF p_amount IS NULL OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_amount <> round(p_amount, 2) OR p_amount >= 10000000000000000
    OR p_amount < 0 OR (NOT p_allow_zero AND p_amount = 0) THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;
END $$;

CREATE FUNCTION pos.begin_request(p_actor uuid, p_operation text, p_key text, p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_old pos.idempotency_requests;
BEGIN
  IF p_key IS NULL OR length(btrim(p_key)) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_operation || ':' || p_key, 0));
  SELECT * INTO v_old FROM pos.idempotency_requests WHERE actor_id = p_actor AND operation = p_operation AND key = p_key;
  IF FOUND THEN
    IF v_old.request IS DISTINCT FROM p_request THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    RETURN v_old.response;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION pos.lock_cash_session(p_actor uuid, p_session uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pos, pg_temp AS $$
DECLARE v_session pos.cash_sessions;
BEGIN
  SELECT * INTO v_session FROM pos.cash_sessions WHERE id = p_session FOR UPDATE;
  IF NOT FOUND OR v_session.closed_at IS NOT NULL THEN RAISE EXCEPTION 'CASH_SESSION_NOT_OPEN'; END IF;
  IF v_session.operator_id <> p_actor AND (SELECT role FROM pos.profiles WHERE id = p_actor) = 'cashier' THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
END $$;

CREATE FUNCTION pos.prevent_financial_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pos, pg_temp AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_FINANCIAL_RECORD'; END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sales','sale_items','payments','inventory_movements','cash_entries','audit_events','idempotency_requests'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON pos.%I FOR EACH ROW EXECUTE FUNCTION pos.prevent_financial_mutation()', t);
  END LOOP;
END $$;
COMMIT;
