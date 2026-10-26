export const catalogActions = ['qr.list', 'qr.read', 'qr.attach', 'products.list', 'directories.list', 'customers.search', 'media.read', 'media.attach', 'inventory.history',
  'product.save', 'inventory.adjust', 'customer.save', 'supplier.save'] as const
export type CatalogAction = typeof catalogActions[number]
export type Product = {
  id: string; sku?: string; name: string; price: string; purchase_price?: string | null
  category?: string; barcode?: string | null; minimum: number; supplier_id?: string | null
  active: boolean; version: number; stock: number; image_id?: string | null
}
export type Contact = { id: string; name: string; email: string; phone: string; active: boolean; version: number }
export type ProductPage = { rows: Product[]; total: number }
export type DirectoryPage = { customers: Contact[]; suppliers: Contact[]; customers_total: number; suppliers_total: number }
export type StockMovement = { id: string; quantity_delta: number; kind: string; created_at: string; created_by: string }

export type TransferQR = { code: 'nequi' | 'breb'; name: string; image_id: string | null }
