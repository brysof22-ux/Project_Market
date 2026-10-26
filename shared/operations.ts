export const operationActions = ['bootstrap', 'cash.list', 'cash.entries', 'sales.list', 'sales.detail',
  'credits.list', 'credit.history', 'users.list', 'audit.list', 'cash.open', 'cash.move', 'cash.close',
  'sale.confirm', 'sale.return', 'credit.limit', 'credit.receipt', 'user.save', 'settings.save', 'report',
  'debts.list', 'debt.detail', 'debt.receipt', 'reset.preview', 'reset.confirm', 'periods.list', 'periods.detail'] as const
export type OperationAction = typeof operationActions[number]
export type PaymentMethod = { id: string; code: string; name: string; affects_cash: boolean; requires_reference: boolean }
export type CashSession = { id: string; register_code: string; operator_id: string; opened_at: string; closed_at: string | null; opening_float: number; expected: number; counted?: number; difference?: number }
export type StoreSettings = { name: string; address: string; version: number }
export type Bootstrap = { period_id?: string; permissions: { credit: boolean; expenses: boolean }; methods: PaymentMethod[]; session: CashSession | null; settings: StoreSettings | null }
export type Debt = {
  id: string; charge_id: string; sale_id: string; customer_id: string; name: string; phone: string
  purchased_on: string; due_on: string | null; total: string; initial_payment: string; principal: string
  paid: string; outstanding: string; status: 'pending' | 'overdue' | 'paid'
  returned: boolean; refund_amount: string; return_credit_reduction: string
  products: { name: string; quantity: number; unit_price: string; total: string }[]
}
export type DebtPage = { total: number; rows: Debt[] }
export type DebtDetail = Debt & { receipts: { id: string; amount: string; received_at: string; method: string; reference: string | null; kind?: string }[] }
export type ResetPreview = { intent_id: string; expires_at: string; period_id: string; sales: number; debts: number; outstanding: string; stock: number; open_sessions: number }
export type OperatingPeriod = { id: string; opened_at: string; closed_at: string | null; reason: string | null; closing_snapshot: Record<string, unknown> | null }
export type ArchivedPeriod = { period_id: string; totals: { sales: number; debts: number; stock: number }; sales: { id: string; number: number; buyer_name: string; total: string; created_at: string }[]; debts: Debt[]; stock: { product_id: string; quantity: number }[] }
export type SalesPage = { total: number; rows: { id: string; number: number; created_at: string; total: string; customer_id: string | null; customer: string | null; returned: boolean }[] }
export type CreditAccount = { id: string; customer_id: string; name: string; authorized_limit: number; outstanding: number; available: number; overdue: number }
export type StaffAccount = { id: string; display_name: string; role: 'admin' | 'supervisor' | 'cashier'; active: boolean; can_credit: boolean; can_expenses: boolean }
export type AuditEvent = { id: number; actor_id: string; actor_name: string; action: string; entity_id: string; created_at: string }
export type Report = {
  from: string; to: string; limited: boolean; gross_sales: string; returns: string; net_sales: string; transactions: number
  previous_sales: string; gross_profit: string | null; unknown_cost_items: number; expenses: string | null
  collections: string; cash_income: string | null; outstanding: string | null; products: number; low_stock: number
  series: { day: string; actual: string; previous: string }[]
  top_products: { product_id: string; name: string; quantity: number; total: string }[]
  categories: { category: string; total: string; gross_profit: string | null }[]; methods: { name: string; code: string; total: string }[]
}
