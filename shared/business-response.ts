// Runtime boundary for version mismatches/malformed successful HTTP responses.
// Do not infer missing commercial values or display arbitrary server messages.
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const integer = (value: unknown) => number(value) && Number.isInteger(value)
const text = (value: unknown): value is string => typeof value === 'string'
const uuid = (value: unknown) => text(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const money = (value: unknown) => text(value) && /^-?\d+(?:\.\d{1,2}0*)?$/.test(value) && Number.isFinite(Number(value))
const nullableMoney = (value: unknown) => value === null || money(value)
const rows = (value: unknown, valid: (row: Record<string, unknown>) => boolean) => Array.isArray(value) && value.every((row) => record(row) && valid(row))
const contact = (row: Record<string, unknown>) => uuid(row.id) && text(row.name) && text(row.email) && text(row.phone) && typeof row.active === 'boolean' && integer(row.version)
const session = (row: unknown) => record(row) && uuid(row.id) && number(row.opening_float) && number(row.expected)
const debt = (row: Record<string, unknown>) => uuid(row.id) && uuid(row.charge_id) && uuid(row.sale_id) && uuid(row.customer_id)
  && text(row.name) && text(row.phone) && text(row.purchased_on) && (row.due_on === null || text(row.due_on))
  && ['total','initial_payment','principal','paid','outstanding','refund_amount','return_credit_reduction'].every((key) => money(row[key]))
  && typeof row.returned === 'boolean'
  && ['pending','overdue','paid'].includes(String(row.status))
  && rows(row.products, (item) => text(item.name) && integer(item.quantity) && money(item.unit_price) && money(item.total))

export function validBusinessResponse(action: string, value: unknown): boolean {
  switch (action) {
    case 'products.list':
      return record(value) && integer(value.total) && rows(value.rows, (row) => uuid(row.id) && (row.sku === undefined || text(row.sku)) && text(row.name)
        && money(row.price) && (row.purchase_price === undefined || nullableMoney(row.purchase_price)) && (row.category === undefined || text(row.category)) && integer(row.stock)
        && integer(row.minimum) && integer(row.version) && typeof row.active === 'boolean')
    case 'directories.list':
      return record(value) && rows(value.customers, contact) && rows(value.suppliers, contact) && integer(value.customers_total) && integer(value.suppliers_total)
    case 'customers.search':
      return record(value) && rows(value.customers, (row) => uuid(row.id) && text(row.name) && text(row.phone) && typeof row.active === 'boolean' && integer(row.version))
    case 'inventory.history':
      return rows(value, (row) => uuid(row.id) && integer(row.quantity_delta) && text(row.kind) && text(row.created_at))
    case 'bootstrap':
      return record(value) && record(value.permissions) && typeof value.permissions.credit === 'boolean' && typeof value.permissions.expenses === 'boolean'
        && (value.session === null || session(value.session)) && (value.settings === null || (record(value.settings) && text(value.settings.name) && text(value.settings.address)))
        && rows(value.methods, (row) => uuid(row.id) && text(row.name) && text(row.code) && typeof row.affects_cash === 'boolean' && typeof row.requires_reference === 'boolean')
    case 'sales.list':
      return record(value) && integer(value.total) && rows(value.rows, (row) => uuid(row.id) && integer(row.number) && money(row.total)
        && text(row.created_at) && typeof row.returned === 'boolean' && (row.customer === null || text(row.customer)))
    case 'sales.detail':
      return record(value) && uuid(value.id) && number(value.total)
        && rows(value.items, (row) => uuid(row.id) && text(row.name_snapshot) && integer(row.quantity) && number(row.unit_price))
        && rows(value.payments, (row) => uuid(row.id) && number(row.amount))
        && (value.credit === null || (record(value.credit) && number(value.credit.outstanding) && (value.credit.due_on === null || text(value.credit.due_on))))
        && (value.return === null || (record(value.return) && text(value.return.reason) && number(value.return.refund_amount) && number(value.return.credit_reduction)))
    case 'cash.list':
      return rows(value, (row) => uuid(row.id) && number(row.opening_float) && text(row.register_code) && text(row.opened_at)
        && (row.expected === null || number(row.expected)) && (row.closed_at === null || text(row.closed_at)))
    case 'cash.entries':
      return rows(value, (row) => uuid(row.id) && number(row.amount) && text(row.kind) && text(row.created_at))
    case 'credits.list':
      return rows(value, (row) => uuid(row.id) && uuid(row.customer_id) && text(row.name) && number(row.authorized_limit)
        && number(row.outstanding) && number(row.available) && number(row.overdue))
    case 'credit.history':
      return value === null || (record(value)
        && rows(value.purchases, (row) => uuid(row.charge_id) && text(row.purchased_on) && (row.due_on === null || text(row.due_on)) && money(row.principal) && money(row.outstanding) && text(row.responsible))
        && rows(value.receipts, (row) => uuid(row.source_id) && money(row.amount) && text(row.occurred_at) && text(row.method) && text(row.responsible))
        && rows(value.limit_authorizations, (row) => integer(row.id) && money(row.new_limit) && text(row.reason) && text(row.responsible))
        && rows(value.returns, (row) => uuid(row.id) && text(row.created_at) && money(row.refund_amount) && money(row.credit_reduction) && text(row.reason)))
    case 'users.list':
      return rows(value, (row) => uuid(row.id) && text(row.display_name) && ['admin','supervisor','cashier'].includes(String(row.role))
        && typeof row.active === 'boolean' && typeof row.can_credit === 'boolean' && typeof row.can_expenses === 'boolean')
    case 'audit.list':
      return rows(value, (row) => integer(row.id) && uuid(row.actor_id) && text(row.actor_name) && text(row.action) && uuid(row.entity_id) && text(row.created_at))
    case 'report':
      return record(value) && text(value.from) && text(value.to) && typeof value.limited === 'boolean'
        && ['gross_sales','returns','net_sales','previous_sales','collections'].every((key) => money(value[key]))
        && ['gross_profit','expenses','cash_income','outstanding'].every((key) => nullableMoney(value[key]))
        && ['transactions','products','low_stock','unknown_cost_items'].every((key) => integer(value[key]))
        && rows(value.series, (row) => text(row.day) && money(row.actual) && money(row.previous))
        && rows(value.top_products, (row) => uuid(row.product_id) && text(row.name) && integer(row.quantity) && money(row.total))
        && rows(value.categories, (row) => text(row.category) && money(row.total) && nullableMoney(row.gross_profit))
        && rows(value.methods, (row) => text(row.name) && text(row.code) && money(row.total))
    case 'sale.confirm': return record(value) && uuid(value.sale_id) && money(value.total) && money(value.received) && money(value.financed)
    case 'credit.limit': return record(value) && uuid(value.account_id) && money(value.authorized_limit)
    case 'credit.receipt': return record(value) && uuid(value.receipt_id) && money(value.outstanding)
    case 'debt.receipt': return record(value) && uuid(value.receipt_id) && money(value.outstanding)
    case 'debts.list': return record(value) && integer(value.total) && rows(value.rows, debt)
    case 'debt.detail': return record(value) && debt(value) && rows(value.receipts, (row) => uuid(row.id) && money(row.amount) && text(row.received_at) && text(row.method) && (row.reference === null || text(row.reference)))
    case 'reset.preview': return record(value) && uuid(value.intent_id) && uuid(value.period_id) && text(value.expires_at)
      && ['sales','debts','stock','open_sessions'].every((key) => integer(value[key])) && money(value.outstanding)
    case 'reset.confirm': return record(value) && uuid(value.period_id) && uuid(value.previous_period_id)
    case 'periods.list': return rows(value, (row) => uuid(row.id) && text(row.opened_at) && (row.closed_at === null || text(row.closed_at)) && (row.reason === null || text(row.reason)) && (row.closing_snapshot === null || record(row.closing_snapshot)))
    case 'periods.detail': return record(value) && uuid(value.period_id)
      && record(value.totals) && ['sales','debts','stock'].every((key) => integer((value.totals as Record<string, unknown>)[key]))
      && rows(value.sales, (row) => uuid(row.id) && integer(row.number) && (row.buyer_name === null || text(row.buyer_name)) && money(row.total) && text(row.created_at))
      && rows(value.debts, debt) && rows(value.stock, (row) => uuid(row.product_id) && integer(row.quantity))
    case 'product.save': case 'customer.save': case 'supplier.save': case 'inventory.adjust':
    case 'cash.open': case 'cash.move': case 'cash.close': case 'sale.return': case 'user.save': case 'settings.save':
      return record(value) && uuid(value.id)
    default: return false
  }
}
