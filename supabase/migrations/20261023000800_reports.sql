-- NEW local proposal. Read models over persisted ledgers, never demo series.
BEGIN;
DO $$ BEGIN
  IF has_schema_privilege('pos_owner','public','CREATE') THEN RAISE EXCEPTION 'REVIEW_OWNER_CREATE_PRIVILEGES'; END IF;
END $$;
GRANT CREATE ON SCHEMA public TO pos_owner;
SELECT set_config('cai.reports_migration_role',current_user,true);
SET LOCAL ROLE pos_owner;
CREATE FUNCTION public.cai_report(p_data jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pos,pg_temp AS $$
DECLARE v_actor uuid; v_role text; v_from date; v_to date; v_days integer; v_result jsonb; v_start timestamptz; v_end timestamptz;
BEGIN
  v_actor := pos.current_profile_auth_uid(); v_role := pos.require_staff(v_actor);
  IF jsonb_typeof(p_data) IS DISTINCT FROM 'object' OR octet_length(p_data::text)>32768 THEN RAISE EXCEPTION 'INVALID_INPUT' USING ERRCODE='22023'; END IF;
  v_to := coalesce((p_data->>'to')::date,(pos.business_now() AT TIME ZONE 'America/Bogota')::date);
  v_from := coalesce((p_data->>'from')::date,v_to-6);
  IF NOT isfinite(v_from) OR NOT isfinite(v_to) OR v_from>v_to OR v_to-v_from>365 THEN RAISE EXCEPTION 'INVALID_PERIOD' USING ERRCODE='22023'; END IF;
  v_days := v_to-v_from+1;
  v_start := ((v_from-v_days)::timestamp AT TIME ZONE 'America/Bogota');
  v_end := ((v_to+1)::timestamp AT TIME ZONE 'America/Bogota');
  WITH selected_sales AS (
    SELECT s.* FROM pos.sales s WHERE (v_role<>'cashier' OR s.created_by=v_actor)
      AND s.created_at>=v_start AND s.created_at<v_end
  ), selected_returns AS (
    SELECT r.* FROM pos.sale_returns r JOIN pos.sales s ON s.id=r.sale_id
      WHERE (v_role<>'cashier' OR s.created_by=v_actor) AND r.created_at>=v_start AND r.created_at<v_end
  ), gross AS (
    SELECT coalesce(sum(total),0) AS amount,count(*) AS count FROM selected_sales
      WHERE (created_at AT TIME ZONE 'America/Bogota')::date BETWEEN v_from AND v_to
  ), returned AS (
    SELECT coalesce(sum(total),0) AS amount FROM selected_returns
      WHERE (created_at AT TIME ZONE 'America/Bogota')::date BETWEEN v_from AND v_to
  ), previous AS (
    SELECT coalesce((SELECT sum(total) FROM selected_sales WHERE (created_at AT TIME ZONE 'America/Bogota')::date BETWEEN v_from-v_days AND v_from-1),0)
      -coalesce((SELECT sum(total) FROM selected_returns WHERE (created_at AT TIME ZONE 'America/Bogota')::date BETWEEN v_from-v_days AND v_from-1),0) AS amount
  ), daily AS (
    SELECT day,sum(total) AS total FROM (
      SELECT (created_at AT TIME ZONE 'America/Bogota')::date AS day,total FROM selected_sales
      UNION ALL SELECT (created_at AT TIME ZONE 'America/Bogota')::date,-total FROM selected_returns
    ) events GROUP BY day
  ), series AS (
    SELECT d::date AS day,coalesce(current_day.total,0) AS actual,coalesce(previous_day.total,0) AS previous
    FROM generate_series(v_from::timestamp,v_to::timestamp,interval '1 day') d
      LEFT JOIN daily current_day ON current_day.day=d::date
      LEFT JOIN daily previous_day ON previous_day.day=d::date-v_days
  ), sold_items AS (
    SELECT i.product_id,i.name_snapshot,i.quantity,i.total,i.purchase_price_snapshot,i.category_snapshot,
      (s.created_at AT TIME ZONE 'America/Bogota')::date AS occurred_on
      FROM pos.sale_items i JOIN selected_sales s ON s.id=i.sale_id
  ), returned_items AS (
    SELECT i.product_id,i.name_snapshot,-i.quantity AS quantity,-i.total AS total,i.purchase_price_snapshot,i.category_snapshot,
      (r.created_at AT TIME ZONE 'America/Bogota')::date AS occurred_on
      FROM pos.sale_items i JOIN selected_returns r ON r.sale_id=i.sale_id
  ), items AS (SELECT * FROM sold_items UNION ALL SELECT * FROM returned_items), period_items AS (
    SELECT * FROM items WHERE occurred_on BETWEEN v_from AND v_to
  ), costs AS (
    SELECT count(*) FILTER(WHERE purchase_price_snapshot IS NULL) AS unknown,
      coalesce(sum(quantity*purchase_price_snapshot),0) AS amount FROM period_items
  ), collections AS (
    SELECT p.method_id,p.amount,p.created_at FROM pos.payments p JOIN selected_sales s ON s.id=p.sale_id
    UNION ALL SELECT r.method_id,r.amount,r.received_at FROM pos.credit_receipts r
      WHERE (v_role<>'cashier' OR r.received_by=v_actor) AND r.received_at>=v_start AND r.received_at<v_end
    UNION ALL SELECT r.refund_method_id,-r.refund_amount,r.created_at FROM selected_returns r WHERE refund_amount>0
  )
  SELECT jsonb_build_object('from',v_from,'to',v_to,'limited',v_role='cashier',
    'gross_sales',g.amount::text,'returns',r.amount::text,'net_sales',(g.amount-r.amount)::text,
    'transactions',g.count,'previous_sales',prev.amount::text,
    'gross_profit',CASE WHEN v_role='cashier' OR c.unknown>0 THEN NULL ELSE (g.amount-r.amount-c.amount)::text END,
    'unknown_cost_items',CASE WHEN v_role='cashier' THEN 0 ELSE c.unknown END,
    'expenses',CASE WHEN v_role='cashier' THEN NULL ELSE (SELECT coalesce(-sum(amount),0)::text FROM pos.cash_adjustments
      WHERE kind='expense' AND created_at>=(v_from::timestamp AT TIME ZONE 'America/Bogota') AND created_at<v_end) END,
    'cash_income',CASE WHEN v_role='cashier' THEN NULL ELSE (SELECT coalesce(sum(amount),0)::text FROM pos.cash_adjustments
      WHERE kind='income' AND created_at>=(v_from::timestamp AT TIME ZONE 'America/Bogota') AND created_at<v_end) END,
    'collections',(SELECT coalesce(sum(amount),0)::text FROM collections WHERE (created_at AT TIME ZONE 'America/Bogota')::date BETWEEN v_from AND v_to),
    'outstanding',CASE WHEN v_role='cashier' THEN NULL ELSE (SELECT coalesce(sum(outstanding),0)::text FROM pos.credit_account_balances) END,
    'products',(SELECT count(*) FROM pos.products WHERE active),
    'low_stock',(SELECT count(*) FROM pos.products p JOIN pos.inventory_balances b ON b.product_id=p.id WHERE p.active AND b.quantity<=p.minimum),
    'series',(SELECT jsonb_agg(jsonb_build_object('day',day,'actual',actual::text,'previous',previous::text) ORDER BY day) FROM series),
    'top_products',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT product_id,max(name_snapshot) AS name,sum(quantity) AS quantity,sum(total)::text AS total
        FROM period_items GROUP BY product_id ORDER BY sum(total) DESC,product_id LIMIT 10
    ) x),'[]'::jsonb),
    'categories',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT coalesce(category_snapshot,'Sin categoría histórica') AS category,sum(total)::text AS total,
        CASE WHEN v_role='cashier' OR count(*) FILTER(WHERE purchase_price_snapshot IS NULL)>0
          THEN NULL ELSE sum(total-quantity*purchase_price_snapshot)::text END AS gross_profit FROM period_items
        GROUP BY category_snapshot ORDER BY sum(total) DESC,category_snapshot
    ) x),'[]'::jsonb),
    'methods',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM (
      SELECT m.name,m.code,sum(col.amount)::text AS total FROM collections col JOIN pos.payment_methods m ON m.id=col.method_id
        WHERE (col.created_at AT TIME ZONE 'America/Bogota')::date BETWEEN v_from AND v_to GROUP BY m.id,m.name,m.code ORDER BY m.code
    ) x),'[]'::jsonb)) INTO v_result FROM gross g CROSS JOIN returned r CROSS JOIN previous prev CROSS JOIN costs c;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.cai_report(jsonb) FROM PUBLIC,anon,authenticated,service_role,pos_app,pos_scheduler;
GRANT EXECUTE ON FUNCTION public.cai_report(jsonb) TO authenticated;
DO $$ BEGIN EXECUTE format('SET LOCAL ROLE %I',current_setting('cai.reports_migration_role')); END $$;
REVOKE CREATE ON SCHEMA public FROM pos_owner;
NOTIFY pgrst,'reload schema';
COMMIT;
