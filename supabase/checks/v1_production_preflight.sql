-- Prepared only. Run with the migration administrator in the ORIGINAL project.
-- Confirm Connect host/project sauoekefntzxhqxycdgo separately: database name
-- "postgres" does not identify a Supabase project. No business RPC is invoked.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT current_database(), current_user, session_user, current_setting('server_version');
DO $$ DECLARE v text; n integer; BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'STOP_MIGRATION_HISTORY_MISSING';
  END IF;
  FOREACH v IN ARRAY ARRAY['20261023000100','20261023000200','20261023000300','20261023000400','20261023000500'] LOOP
    EXECUTE 'SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version::text=$1' INTO n USING v;
    IF n<>1 THEN RAISE EXCEPTION 'STOP_BASELINE_HISTORY_%',v; END IF;
  END LOOP;
  FOREACH v IN ARRAY ARRAY['20261023000600','20261023000700','20261023000800'] LOOP
    EXECUTE 'SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version::text=$1' INTO n USING v;
    IF n<>0 THEN RAISE EXCEPTION 'STOP_ALREADY_RECORDED_%',v; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='pos_owner') THEN RAISE EXCEPTION 'STOP_OWNER_MISSING'; END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='pos_owner' AND
    (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'STOP_UNSAFE_OWNER';
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname IN ('anon','authenticated','pos_app','pos_scheduler','service_role')
    AND pg_has_role(oid,'pos_owner','MEMBER')) THEN RAISE EXCEPTION 'STOP_OWNER_MEMBERSHIP'; END IF;
  FOREACH v IN ARRAY ARRAY['pos','public'] LOOP
    IF has_schema_privilege('pos_owner',v,'CREATE') THEN RAISE EXCEPTION 'STOP_RESIDUAL_CREATE_%',v; END IF;
    IF NOT has_schema_privilege(current_user,v,'CREATE WITH GRANT OPTION') THEN
      RAISE EXCEPTION 'STOP_MIGRATOR_CANNOT_GRANT_CREATE_%',v;
    END IF;
    IF NOT has_schema_privilege('pos_owner',v,'USAGE') THEN RAISE EXCEPTION 'STOP_OWNER_USAGE_%',v; END IF;
  END LOOP;
  IF current_setting('server_version_num')::integer>=160000 THEN
    IF NOT pg_has_role(current_user,'pos_owner','SET') THEN RAISE EXCEPTION 'STOP_MIGRATOR_CANNOT_SET_ROLE'; END IF;
  ELSIF NOT pg_has_role(current_user,'pos_owner','MEMBER') THEN
    RAISE EXCEPTION 'STOP_MIGRATOR_NOT_MEMBER';
  END IF;
  FOREACH v IN ARRAY ARRAY['public.cai_current_profile()','pos.current_profile_auth_uid()',
    'pos.require_staff(uuid)','pos.begin_request(uuid,text,text,jsonb)','pos.require_amount(numeric,boolean)',
    'pos.business_now()','pos.prevent_financial_mutation()','pos.lock_cash_session(uuid,uuid)',
    'pos.confirm_sale(uuid,uuid,uuid,jsonb,jsonb,boolean,text)',
    'pos.authorize_credit_limit(uuid,uuid,numeric,text,text)',
    'pos.record_credit_receipt(uuid,uuid,uuid,numeric,uuid,text,text)',
    'pos.get_credit_history(uuid,uuid,integer,integer)'] LOOP
    IF to_regprocedure(v) IS NULL THEN RAISE EXCEPTION 'STOP_DEPENDENCY_MISSING_%',v; END IF;
    IF NOT has_function_privilege('pos_owner',v,'EXECUTE') THEN RAISE EXCEPTION 'STOP_DEPENDENCY_EXECUTE_%',v; END IF;
  END LOOP;
  IF EXISTS(SELECT FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
    WHERE (s.nspname='public' AND p.proname IN ('cai_catalog','cai_operations','cai_report'))
       OR (s.nspname='pos' AND p.proname='capture_sale_cost')) THEN
    RAISE EXCEPTION 'STOP_PARTIAL_FUNCTIONS';
  END IF;
  FOREACH v IN ARRAY ARRAY['pos.suppliers','pos.inventory_adjustments','pos.sale_returns','pos.cash_adjustments',
    'pos.cash_closings','pos.store_settings','pos.inventory_adjustments_product_idx','pos.products_category_idx',
    'pos.products_supplier_idx','pos.sale_returns_date_idx','pos.cash_adjustments_session_idx',
    'pos.cash_adjustments_date_idx','pos.sales_actor_date_idx','pos.cash_sessions_operator_date_idx',
    'pos.audit_events_date_idx'] LOOP
    IF to_regclass(v) IS NOT NULL THEN RAISE EXCEPTION 'STOP_PARTIAL_RELATION_%',v; END IF;
  END LOOP;
  IF EXISTS(SELECT FROM (VALUES
    ('customers','email'),('customers','phone'),('customers','version'),
    ('products','category'),('products','barcode'),('products','purchase_price'),
    ('products','minimum'),('products','supplier_id'),('products','version'),
    ('profiles','can_credit'),('profiles','can_expenses'),
    ('sale_items','purchase_price_snapshot'),('sale_items','category_snapshot')) x(t,c)
    JOIN pg_attribute a ON a.attrelid=to_regclass('pos.'||x.t) AND a.attname=x.c
    WHERE a.attnum>0 AND NOT a.attisdropped) THEN RAISE EXCEPTION 'STOP_PARTIAL_COLUMNS'; END IF;
  IF EXISTS(SELECT FROM pg_trigger WHERE tgrelid=to_regclass('pos.sale_items')
    AND tgname='sale_cost_snapshot' AND NOT tgisinternal) THEN RAISE EXCEPTION 'STOP_PARTIAL_TRIGGER'; END IF;
  IF EXISTS(SELECT FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
    WHERE s.nspname='pos' AND c.relkind IN ('r','v') AND pg_get_userbyid(c.relowner)<>'pos_owner') THEN
    RAISE EXCEPTION 'STOP_FINANCIAL_OWNER';
  END IF;
  IF EXISTS(SELECT FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
    WHERE s.nspname='pos' AND c.relkind='r' AND NOT c.relrowsecurity) THEN RAISE EXCEPTION 'STOP_RLS'; END IF;
END $$;
-- Review the view against 002 and default ACLs; success of DO is not a full audit.
SELECT pg_get_viewdef('pos.credit_charge_balances'::regclass,true) AS credit_balance_definition;
SELECT pg_get_userbyid(defaclrole) AS owner, defaclnamespace::regnamespace AS schema_name,
  defaclobjtype,defaclacl FROM pg_default_acl WHERE defaclrole='pos_owner'::regrole;
SELECT p.oid::regprocedure AS signature,pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.proconfig,p.proacl
FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.cai_current_profile()'),to_regprocedure('pos.current_profile_auth_uid()'));
ROLLBACK;
