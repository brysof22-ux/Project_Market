export type StaffRole = 'admin' | 'supervisor' | 'cashier'
export type StaffProfile = {
  id: string
  display_name: string
  role: StaffRole
  active: boolean
}

export function readStaffProfile(value: unknown): StaffProfile | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)
    || typeof row.display_name !== 'string' || !row.display_name.trim() || row.display_name.length > 100
    || typeof row.role !== 'string' || !['admin', 'supervisor', 'cashier'].includes(row.role) || typeof row.active !== 'boolean') return null
  // Project only permitted fields, even if an upstream mistakenly returns more.
  return { id: row.id, display_name: row.display_name, role: row.role as StaffRole, active: row.active }
}
