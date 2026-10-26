-- READ ONLY. Save output privately before/after migration in the SAME maintenance
-- window. Never commit exported data. Aggregates complement, not replace, backup
-- restoration and comparison of original rows. No financial function is called.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE pos_owner;
SET LOCAL statement_timeout = '30s';
SELECT 'sales' AS ledger,count(*) AS rows,coalesce(sum(total),0) AS amount FROM pos.sales
UNION ALL SELECT 'sale_items',count(*),coalesce(sum(total),0) FROM pos.sale_items
UNION ALL SELECT 'payments',count(*),coalesce(sum(amount),0) FROM pos.payments
UNION ALL SELECT 'credit_charges',count(*),coalesce(sum(principal),0) FROM pos.credit_charges
UNION ALL SELECT 'credit_receipts',count(*),coalesce(sum(amount),0) FROM pos.credit_receipts
UNION ALL SELECT 'credit_allocations',count(*),coalesce(sum(amount),0) FROM pos.credit_allocations
UNION ALL SELECT 'cash_entries',count(*),coalesce(sum(amount),0) FROM pos.cash_entries
UNION ALL SELECT 'cash_sessions',count(*),coalesce(sum(opening_float),0) FROM pos.cash_sessions
UNION ALL SELECT 'inventory_balances',count(*),coalesce(sum(quantity),0) FROM pos.inventory_balances
UNION ALL SELECT 'inventory_movements',count(*),coalesce(sum(quantity_delta),0) FROM pos.inventory_movements
UNION ALL SELECT 'audit_events',count(*),NULL::numeric FROM pos.audit_events
UNION ALL SELECT 'idempotency_requests',count(*),NULL::numeric FROM pos.idempotency_requests;
SELECT count(*) AS accounts,coalesce(sum(outstanding),0) AS outstanding,
  coalesce(sum(authorized_limit),0) AS authorized_limit,coalesce(sum(available),0) AS available
FROM pos.credit_account_balances;
SELECT count(*) AS invalid_sale_totals FROM pos.sales s WHERE
  s.total<>(SELECT coalesce(sum(total),0) FROM pos.sale_items WHERE sale_id=s.id)
  OR s.total<>(SELECT coalesce(sum(amount),0) FROM pos.payments WHERE sale_id=s.id)
    +(SELECT coalesce(sum(principal),0) FROM pos.credit_charges WHERE sale_id=s.id);
SELECT count(*) AS invalid_stock FROM pos.inventory_balances WHERE quantity<0;
SELECT count(*) AS invalid_credit FROM pos.credit_charge_balances WHERE outstanding<0;
ROLLBACK;
