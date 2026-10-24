-- NEW local proposal. Requires 001-006. Never apply remotely without review.
BEGIN;
DO $$ BEGIN
  IF has_schema_privilege('pos_owner','pos','CREATE') OR has_schema_privilege('pos_owner','public','CREATE') THEN
    RAISE EXCEPTION 'REVIEW_OWNER_CREATE_PRIVILEGES';
  END IF;
END $$;
GRANT CREATE ON SCHEMA pos, public TO pos_owner;
SELECT set_config('cai.operations_migration_role',current_user,true);
SET LOCAL ROLE pos_owner;
ALTER TABLE pos.profiles ADD COLUMN can_credit boolean NOT NULL DEFAULT false,
  ADD COLUMN can_expenses boolean NOT NULL DEFAULT false;
ALTER TABLE pos.sale_items ADD COLUMN purchase_price_snapshot numeric(18,2), ADD COLUMN category_snapshot text;
CREATE FUNCTION pos.capture_sale_cost() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pos,pg_temp AS $$ BEGIN
  SELECT purchase_price,category INTO NEW.purchase_price_snapshot,NEW.category_snapshot FROM pos.products WHERE id=NEW.product_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pos.capture_sale_cost() FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
CREATE TRIGGER sale_cost_snapshot BEFORE INSERT ON pos.sale_items FOR EACH ROW EXECUTE FUNCTION pos.capture_sale_cost();

CREATE TABLE pos.sale_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sale_id uuid NOT NULL UNIQUE REFERENCES pos.sales(id),
  charge_id uuid UNIQUE REFERENCES pos.credit_charges(id),
  session_id uuid NOT NULL REFERENCES pos.cash_sessions(id),
  total numeric(18,2) NOT NULL CHECK(total>0),
  refund_amount numeric(18,2) NOT NULL CHECK(refund_amount>=0),
  credit_reduction numeric(18,2) NOT NULL CHECK(credit_reduction>=0),
  refund_method_id uuid REFERENCES pos.payment_methods(id), reference text,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  created_by uuid NOT NULL REFERENCES pos.profiles(id),
  created_at timestamptz NOT NULL DEFAULT pos.business_now(),
  CHECK(refund_amount+credit_reduction=total), CHECK(refund_amount=0 OR refund_method_id IS NOT NULL)
);
CREATE INDEX sale_returns_date_idx ON pos.sale_returns(created_at,id);
CREATE TABLE pos.cash_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES pos.cash_sessions(id),
  amount numeric(18,2) NOT NULL CHECK(amount<>0), kind text NOT NULL CHECK(kind IN ('income','expense','refund')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  return_id uuid UNIQUE REFERENCES pos.sale_returns(id),
  created_by uuid NOT NULL REFERENCES pos.profiles(id), created_at timestamptz NOT NULL DEFAULT pos.business_now(),
  CHECK((kind='income' AND amount>0 AND return_id IS NULL) OR (kind='expense' AND amount<0 AND return_id IS NULL)
    OR (kind='refund' AND amount<0 AND return_id IS NOT NULL))
);
CREATE INDEX cash_adjustments_session_idx ON pos.cash_adjustments(session_id,created_at,id);
CREATE INDEX cash_adjustments_date_idx ON pos.cash_adjustments(created_at,id);
CREATE INDEX sales_actor_date_idx ON pos.sales(created_by,created_at DESC,id);
CREATE INDEX cash_sessions_operator_date_idx ON pos.cash_sessions(operator_id,opened_at DESC,id);
CREATE INDEX audit_events_date_idx ON pos.audit_events(created_at DESC,id DESC);
CREATE TABLE pos.cash_closings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL UNIQUE REFERENCES pos.cash_sessions(id),
  expected numeric(18,2) NOT NULL, counted numeric(18,2) NOT NULL CHECK(counted>=0),
  difference numeric(18,2) NOT NULL CHECK(difference=counted-expected),
  created_by uuid NOT NULL REFERENCES pos.profiles(id), created_at timestamptz NOT NULL DEFAULT pos.business_now()
);
CREATE TABLE pos.store_settings (
  id boolean PRIMARY KEY CHECK(id), name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
  address text NOT NULL CHECK(length(address)<=160), version integer NOT NULL DEFAULT 1
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['sale_returns','cash_adjustments','cash_closings','store_settings'] LOOP
    EXECUTE format('ALTER TABLE pos.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON pos.%I FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler',t);
    IF t<>'store_settings' THEN
      EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON pos.%I FOR EACH ROW EXECUTE FUNCTION pos.prevent_financial_mutation()',t);
    END IF;
  END LOOP;
END $$;

-- Compensating returns reduce unpaid credit, never rewrite original charges,
-- receipts, allocations, sales, inventory movements or cash entries.
CREATE OR REPLACE VIEW pos.credit_charge_balances AS
SELECT c.*, c.principal-coalesce(a.allocated,0)-coalesce(r.credit_reduction,0) AS outstanding,
  CASE WHEN c.principal=coalesce(a.allocated,0)+coalesce(r.credit_reduction,0) THEN 'paid'
    WHEN c.due_on<(pos.business_now() AT TIME ZONE 'America/Bogota')::date THEN 'overdue' ELSE 'active' END AS status,
  CASE WHEN c.principal=coalesce(a.allocated,0)+coalesce(r.credit_reduction,0)
    THEN greatest(a.last_paid_at,r.created_at) END AS settled_at
FROM pos.credit_charges c LEFT JOIN LATERAL (
  SELECT sum(x.amount) AS allocated,max(cr.received_at) AS last_paid_at FROM pos.credit_allocations x
    JOIN pos.credit_receipts cr ON cr.id=x.receipt_id WHERE x.charge_id=c.id
) a ON true LEFT JOIN pos.sale_returns r ON r.charge_id=c.id;

CREATE FUNCTION public.cai_operations(p_action text,p_data jsonb DEFAULT '{}',p_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE v_actor uuid; v_role text; v_credit boolean; v_expenses boolean; v_response jsonb; v_id uuid;
  v_limit integer; v_offset integer; v_session uuid; v_amount numeric; v_expected numeric; v_counted numeric;
  v_sale pos.sales; v_charge uuid; v_account uuid; v_debt numeric; v_paid numeric; v_method pos.payment_methods;
  v_reason text; v_item record; v_from date; v_to date; v_now timestamptz := pos.business_now();
BEGIN
  v_actor := pos.current_profile_auth_uid();
  v_role := pos.require_staff(v_actor);
  SELECT can_credit OR v_role<>'cashier',can_expenses OR v_role<>'cashier' INTO v_credit,v_expenses FROM pos.profiles WHERE id=v_actor;
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text)>32768 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
  v_limit := coalesce((p_data->>'limit')::integer,20); v_offset := coalesce((p_data->>'offset')::integer,0);
  IF v_limit NOT BETWEEN 1 AND 100 OR v_offset NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'INVALID_PAGINATION' USING ERRCODE='22023'; END IF;

  IF p_action='bootstrap' THEN
    SELECT jsonb_build_object('permissions',jsonb_build_object('credit',v_credit,'expenses',v_expenses),
      'methods',coalesce((SELECT jsonb_agg(to_jsonb(m)) FROM (SELECT id,code,name,affects_cash,requires_reference FROM pos.payment_methods WHERE active ORDER BY code) m),'[]'::jsonb),
      'session',(SELECT to_jsonb(s)||jsonb_build_object('expected',
        s.opening_float+coalesce((SELECT sum(amount) FROM pos.cash_entries WHERE session_id=s.id),0)
          +coalesce((SELECT sum(amount) FROM pos.cash_adjustments WHERE session_id=s.id),0))
        FROM pos.cash_sessions s WHERE operator_id=v_actor AND closed_at IS NULL),
      'settings',(SELECT to_jsonb(x) FROM pos.store_settings x WHERE id)) INTO v_response;
    RETURN v_response;
  ELSIF p_action='cash.list' THEN
    RETURN coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT s.*,c.expected,c.counted,c.difference FROM pos.cash_sessions s LEFT JOIN pos.cash_closings c ON c.session_id=s.id
        WHERE v_role<>'cashier' OR s.operator_id=v_actor ORDER BY s.opened_at DESC,s.id LIMIT v_limit OFFSET v_offset
    ) x),'[]'::jsonb);
  ELSIF p_action='cash.entries' THEN
    v_session := (p_data->>'session_id')::uuid;
    IF NOT EXISTS(SELECT FROM pos.cash_sessions WHERE id=v_session AND (v_role<>'cashier' OR operator_id=v_actor)) THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT * FROM (
        SELECT id,amount,CASE WHEN payment_id IS NULL THEN 'credit_receipt' ELSE 'sale' END AS kind,created_at,created_by FROM pos.cash_entries WHERE session_id=v_session
        UNION ALL SELECT id,amount,kind,created_at,created_by FROM pos.cash_adjustments WHERE session_id=v_session
      ) h ORDER BY created_at DESC,id LIMIT v_limit OFFSET v_offset
    ) x),'[]'::jsonb);
  ELSIF p_action='sales.list' THEN
    WITH filtered AS (SELECT s.id,s.number,s.created_at,s.total::text AS total,s.customer_id,c.name AS customer,
      r.id IS NOT NULL AS returned FROM pos.sales s LEFT JOIN pos.customers c ON c.id=s.customer_id
        LEFT JOIN pos.sale_returns r ON r.sale_id=s.id
      WHERE (v_role<>'cashier' OR s.created_by=v_actor)
        AND (p_data->>'customer_id' IS NULL OR s.customer_id=(p_data->>'customer_id')::uuid))
    SELECT jsonb_build_object('total',(SELECT count(*) FROM filtered),'rows',coalesce((SELECT jsonb_agg(to_jsonb(x))
      FROM (SELECT * FROM filtered ORDER BY created_at DESC,id LIMIT v_limit OFFSET v_offset) x),'[]'::jsonb)) INTO v_response;
    RETURN v_response;
  ELSIF p_action='sales.detail' THEN
    SELECT * INTO v_sale FROM pos.sales WHERE id=(p_data->>'id')::uuid AND (v_role<>'cashier' OR created_by=v_actor);
    IF NOT FOUND THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN to_jsonb(v_sale)||jsonb_build_object('items',(SELECT jsonb_agg(to_jsonb(i)-'purchase_price_snapshot') FROM pos.sale_items i WHERE sale_id=v_sale.id),
      'payments',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM pos.payments p WHERE sale_id=v_sale.id),'[]'::jsonb),
      'credit',(SELECT to_jsonb(c) FROM pos.credit_charge_balances c WHERE sale_id=v_sale.id),
      'return',(SELECT to_jsonb(r) FROM pos.sale_returns r WHERE sale_id=v_sale.id));
  ELSIF p_action='credits.list' THEN
    IF NOT v_credit THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT a.*,c.name,coalesce((SELECT sum(outstanding) FROM pos.credit_charge_balances b WHERE b.account_id=a.id AND status='overdue'),0) AS overdue
        FROM pos.credit_account_balances a JOIN pos.customers c ON c.id=a.customer_id
        ORDER BY c.name,a.id LIMIT v_limit OFFSET v_offset
    ) x),'[]'::jsonb);
  ELSIF p_action='credit.history' THEN
    IF NOT v_credit THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
    v_response := pos.get_credit_history(v_actor,(p_data->>'customer_id')::uuid,v_offset,v_limit);
    IF v_response IS NULL THEN RETURN NULL; END IF;
    RETURN v_response||jsonb_build_object('returns',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT r.id,r.created_at,r.refund_amount::text,r.credit_reduction::text,r.reason
        FROM pos.sale_returns r JOIN pos.sales s ON s.id=r.sale_id
        WHERE s.customer_id=(p_data->>'customer_id')::uuid AND r.charge_id IS NOT NULL
        ORDER BY r.created_at DESC,r.id LIMIT v_limit OFFSET v_offset
    ) x),'[]'::jsonb));
  ELSIF p_action='users.list' THEN
    IF v_role<>'admin' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT id,display_name,role,active,can_credit,can_expenses
      FROM pos.profiles ORDER BY display_name,id LIMIT v_limit OFFSET v_offset) x),'[]'::jsonb);
  ELSIF p_action='audit.list' THEN
    IF v_role='cashier' THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
    RETURN coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT e.*,p.display_name AS actor_name
      FROM pos.audit_events e JOIN pos.profiles p ON p.id=e.actor_id
      ORDER BY e.created_at DESC,e.id DESC LIMIT v_limit OFFSET v_offset) x),'[]'::jsonb);
  END IF;

  IF p_action NOT IN ('cash.open','cash.move','cash.close','sale.confirm','sale.return','credit.limit','credit.receipt','user.save','settings.save') THEN
    RAISE EXCEPTION 'UNKNOWN_OPERATION' USING ERRCODE='22023';
  END IF;
  IF (p_action IN ('user.save','settings.save') AND v_role<>'admin')
    OR (p_action IN ('sale.return','credit.limit') AND v_role='cashier')
    OR (p_action='cash.move' AND NOT v_expenses)
    OR (p_action='credit.receipt' AND NOT v_credit)
    OR (p_action='sale.confirm' AND coalesce((p_data->>'finance')::boolean,false) AND NOT v_credit) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501';
  END IF;
  v_response := pos.begin_request(v_actor,'operations.'||p_action,p_key,p_data);
  IF v_response IS NOT NULL THEN RETURN v_response; END IF;
  v_id := gen_random_uuid();
  v_session := (p_data->>'session_id')::uuid;
  v_reason := btrim(p_data->>'reason');
  IF p_action IN ('cash.move','sale.return') AND (v_reason IS NULL OR length(v_reason) NOT BETWEEN 1 AND 500) THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;

  IF p_action='cash.open' THEN
    v_amount := (p_data->>'opening_float')::numeric; PERFORM pos.require_amount(v_amount,true);
    IF coalesce(p_data->>'register_code','MAIN') !~ '^[A-Za-z0-9_-]{1,30}$' THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
    INSERT INTO pos.cash_sessions(id,register_code,operator_id,opening_float,opened_at)
      VALUES(v_id,coalesce(p_data->>'register_code','MAIN'),v_actor,v_amount,v_now);
  ELSIF p_action IN ('cash.move','cash.close') THEN
    PERFORM pos.lock_cash_session(v_actor,v_session);
    SELECT s.opening_float+coalesce((SELECT sum(amount) FROM pos.cash_entries WHERE session_id=s.id),0)
      +coalesce((SELECT sum(amount) FROM pos.cash_adjustments WHERE session_id=s.id),0) INTO v_expected FROM pos.cash_sessions s WHERE id=v_session;
    IF p_action='cash.move' THEN
      v_amount := (p_data->>'amount')::numeric; PERFORM pos.require_amount(v_amount);
      IF p_data->>'kind' NOT IN ('income','expense') OR p_data->>'kind' IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
      IF p_data->>'kind'='expense' THEN
        IF v_amount>v_expected THEN RAISE EXCEPTION 'INSUFFICIENT_CASH'; END IF;
        v_amount := -v_amount;
      END IF;
      INSERT INTO pos.cash_adjustments(id,session_id,amount,kind,reason,created_by) VALUES(v_id,v_session,v_amount,p_data->>'kind',v_reason,v_actor);
    ELSE
      v_counted := (p_data->>'counted')::numeric; PERFORM pos.require_amount(v_counted,true);
      INSERT INTO pos.cash_closings(id,session_id,expected,counted,difference,created_by) VALUES(v_id,v_session,v_expected,v_counted,v_counted-v_expected,v_actor);
      UPDATE pos.cash_sessions SET closed_at=v_now WHERE id=v_session;
      v_response := jsonb_build_object('id',v_id,'expected',v_expected::text,'counted',v_counted::text,'difference',(v_counted-v_expected)::text);
    END IF;
  ELSIF p_action='sale.confirm' THEN
    v_response := pos.confirm_sale(v_actor,(p_data->>'customer_id')::uuid,v_session,p_data->'lines',p_data->'payments',coalesce((p_data->>'finance')::boolean,false),p_key);
    v_id := (v_response->>'sale_id')::uuid;
  ELSIF p_action='credit.limit' THEN
    v_response := pos.authorize_credit_limit(v_actor,(p_data->>'customer_id')::uuid,(p_data->>'amount')::numeric,v_reason,p_key);
    v_id := (v_response->>'account_id')::uuid;
  ELSIF p_action='credit.receipt' THEN
    v_response := pos.record_credit_receipt(v_actor,(p_data->>'customer_id')::uuid,v_session,(p_data->>'amount')::numeric,(p_data->>'method_id')::uuid,p_data->>'reference',p_key);
    v_id := (v_response->>'receipt_id')::uuid;
  ELSIF p_action='sale.return' THEN
    SELECT * INTO v_sale FROM pos.sales WHERE id=(p_data->>'sale_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'SALE_NOT_FOUND'; END IF;
    SELECT id,account_id INTO v_charge,v_account FROM pos.credit_charges WHERE sale_id=v_sale.id;
    -- Same account -> session -> product/balance lock order as confirm_sale.
    IF v_account IS NOT NULL THEN PERFORM id FROM pos.credit_accounts WHERE id=v_account FOR UPDATE; END IF;
    PERFORM pos.lock_cash_session(v_actor,v_session);
    PERFORM id FROM pos.sales WHERE id=v_sale.id FOR UPDATE;
    IF EXISTS(SELECT FROM pos.sale_returns WHERE sale_id=v_sale.id) THEN RAISE EXCEPTION 'SALE_ALREADY_RETURNED'; END IF;
    SELECT coalesce(outstanding,0) INTO v_debt FROM pos.credit_charge_balances WHERE id=v_charge;
    v_debt := coalesce(v_debt,0); v_paid := v_sale.total-v_debt;
    IF v_paid>0 THEN
      SELECT * INTO v_method FROM pos.payment_methods WHERE id=(p_data->>'method_id')::uuid AND active FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_PAYMENT_METHOD'; END IF;
      IF v_method.requires_reference AND nullif(btrim(p_data->>'reference'),'') IS NULL THEN RAISE EXCEPTION 'PAYMENT_REFERENCE_REQUIRED'; END IF;
      IF v_method.affects_cash THEN
        SELECT s.opening_float+coalesce((SELECT sum(amount) FROM pos.cash_entries WHERE session_id=s.id),0)
          +coalesce((SELECT sum(amount) FROM pos.cash_adjustments WHERE session_id=s.id),0) INTO v_expected FROM pos.cash_sessions s WHERE id=v_session;
        IF v_paid>v_expected THEN RAISE EXCEPTION 'INSUFFICIENT_CASH'; END IF;
      END IF;
    END IF;
    INSERT INTO pos.sale_returns(id,sale_id,charge_id,session_id,total,refund_amount,credit_reduction,refund_method_id,reference,reason,created_by)
      VALUES(v_id,v_sale.id,v_charge,v_session,v_sale.total,v_paid,v_debt,v_method.id,p_data->>'reference',v_reason,v_actor);
    PERFORM p.id FROM pos.products p JOIN pos.sale_items i ON i.product_id=p.id WHERE i.sale_id=v_sale.id ORDER BY p.id FOR SHARE OF p;
    PERFORM b.product_id FROM pos.inventory_balances b JOIN pos.sale_items i ON i.product_id=b.product_id WHERE i.sale_id=v_sale.id ORDER BY b.product_id FOR UPDATE OF b;
    FOR v_item IN SELECT product_id,quantity FROM pos.sale_items WHERE sale_id=v_sale.id ORDER BY product_id LOOP
      UPDATE pos.inventory_balances SET quantity=quantity+v_item.quantity WHERE product_id=v_item.product_id;
      INSERT INTO pos.inventory_adjustments(product_id,quantity_delta,reason,created_by) VALUES(v_item.product_id,v_item.quantity,'Devolución: '||left(v_reason,480),v_actor);
    END LOOP;
    IF v_paid>0 AND v_method.affects_cash THEN
      INSERT INTO pos.cash_adjustments(session_id,amount,kind,reason,return_id,created_by) VALUES(v_session,-v_paid,'refund',v_reason,v_id,v_actor);
    END IF;
    v_response := jsonb_build_object('id',v_id,'refund',v_paid::text,'credit_reduction',v_debt::text);
  ELSIF p_action='user.save' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('cai.admin.profiles',0));
    v_id := (p_data->>'id')::uuid;
    IF v_id IS NULL OR jsonb_typeof(p_data->'display_name') IS DISTINCT FROM 'string'
      OR length(btrim(coalesce(p_data->>'display_name',''))) NOT BETWEEN 1 AND 100
      OR p_data->>'role' IS NULL OR p_data->>'role' NOT IN ('admin','supervisor','cashier') THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
    IF v_id=v_actor AND (p_data->>'role'<>'admin' OR NOT coalesce((p_data->>'active')::boolean,true)) THEN RAISE EXCEPTION 'CANNOT_DISABLE_SELF'; END IF;
    INSERT INTO pos.profiles(id,display_name,role,active,can_credit,can_expenses)
      VALUES(v_id,btrim(p_data->>'display_name'),p_data->>'role',coalesce((p_data->>'active')::boolean,true),coalesce((p_data->>'can_credit')::boolean,false),coalesce((p_data->>'can_expenses')::boolean,false))
      ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name,role=EXCLUDED.role,active=EXCLUDED.active,can_credit=EXCLUDED.can_credit,can_expenses=EXCLUDED.can_expenses;
  ELSIF p_action='settings.save' THEN
    IF length(btrim(coalesce(p_data->>'name',''))) NOT BETWEEN 1 AND 80 OR length(coalesce(p_data->>'address',''))>160 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
    INSERT INTO pos.store_settings(id,name,address) VALUES(true,btrim(p_data->>'name'),coalesce(p_data->>'address',''))
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,version=pos.store_settings.version+1;
  END IF;
  v_response := coalesce(v_response,jsonb_build_object('id',v_id));
  INSERT INTO pos.audit_events(actor_id,action,entity_id) VALUES(v_actor,p_action,v_id);
  INSERT INTO pos.idempotency_requests VALUES(v_actor,'operations.'||p_action,p_key,p_data,v_response,v_now);
  RETURN v_response;
END $$;
REVOKE ALL ON FUNCTION public.cai_operations(text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
GRANT EXECUTE ON FUNCTION public.cai_operations(text,jsonb,text) TO authenticated;
DO $$ BEGIN EXECUTE format('SET LOCAL ROLE %I',current_setting('cai.operations_migration_role')); END $$;
REVOKE CREATE ON SCHEMA pos,public FROM pos_owner;
NOTIFY pgrst,'reload schema';
COMMIT;
