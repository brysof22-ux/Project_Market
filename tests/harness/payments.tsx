// Dev-server-only regression harness. Not an entry point in the production build.
// Preserves QR/IndexedDB component coverage without using demo data in the store.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PaymentsProvider } from '../../src/features/payments/provider'
import { PointOfSale } from '../../src/features/pos'
import { Settings, Accounting } from '../../src/features/modules'
import '../../src/index.css'

export function Harness() {
  const [page, setPage] = useState(window.location.hash)
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const update = () => setPage(window.location.hash)
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  return <PaymentsProvider><main style={{ padding: 16, maxWidth: 1440, margin: 'auto' }}>
    {page.includes('configuracion') ? <Settings dark={dark} toggleTheme={() => setDark(!dark)} /> : page.includes('contabilidad') ? <Accounting /> : <PointOfSale />}
  </main></PaymentsProvider>
}
createRoot(document.getElementById('root')!).render(<Harness />)
