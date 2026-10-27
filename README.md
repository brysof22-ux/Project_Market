# CAI Market V1.3

Inventario con costos ponderados, fotografías WebP optimizadas, panel financiero y reinicio destructivo disponible para administradores. WhatsApp tiene cola y controles implementados; permanece desactivado hasta resolver Docker, túnel y vinculación. Ver [estado y validación V1.3](docs/integracion/CAI_MARKET_V1_3.md).

---

# CAI Market V1.2

Gestión comercial con React/TypeScript, Supabase y Cloudflare Workers/Pages/R2.

V1.2 elimina las categorías visibles y el pago con tarjeta, muestra productos más vendidos y permite transferencias sin referencia mediante los QR originales de Nequi y Llaves Bre-B. La administración de QR está restringida al administrador y las imágenes se sirven con autenticación desde R2 privado.

La documentación vigente de cambios, permisos, migración incremental, pruebas y publicación está en [CAI Market V1.2](docs/integracion/CAI_MARKET_V1_2.md). Producción: [CAI Market](https://project-market.pages.dev).

Los apartados siguientes se conservan como referencia histórica de V1.0; sus estados pendientes y la descripción de QR de demostración no representan V1.2.

---

# CAI Market 1.0

Implementación local de gestión comercial con React, TypeScript, Supabase Auth/PostgreSQL y Cloudflare Workers/Pages. **Pendiente de revisión y validación alojada; no se declara lista para producción.** No se ejecutaron migraciones remotas, commits ni despliegues.

- [Auditoría inicial](docs/AUDITORIA_V1.md).
- [Entrega, funciones, límites, migraciones y lista de producción](docs/ENTREGA_V1.md).
- [Diagnóstico aislado del TypeError de workerd](worker/auth-diagnostic/README.md).
- [Estado y recuperación de la migración 005](docs/integracion/MIGRACION_005.md).
- [Lote de producción preparado: proyecto original, main y autorizaciones pendientes](docs/integracion/PRODUCCION_V1.md).

## Funciones locales

Login/logout y perfiles reales; catálogo persistente con entradas/salidas auditadas; clientes/proveedores; POS transaccional y pagos múltiples; crédito/abonos; apertura, gastos, arqueo y cierre de caja; devoluciones completas por compensación; reportes/dashboard desde PostgreSQL; perfiles/permisos y configuración persistente. Tema claro/oscuro, navegación hash y pantallas adaptables.

La interfaz comercial utiliza Worker y RPCs públicas controladas; no lee tablas privadas ni usa mocks como fuente operativa. Se mantienen componentes QR legados exclusivamente para regresión en un harness de pruebas, fuera de las rutas comerciales y del bundle de producción. Pagos bancarios son registros de confirmación manual, no verificaciones de banco. Contabilidad operativa, no fiscal.

## Configuración local

Requiere Node compatible con Vite 8, npm y dependencias del lockfile existente.

En `.env.local`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_API_URL`. En `worker/api/.dev.vars`: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ALLOWED_ORIGIN` exacto. Utilizar URL y publishable del mismo proyecto. No almacenar contraseñas, service_role ni claves secretas en frontend o Git. Reiniciar servidores al cambiar valores. No sobrescribir archivos locales existentes.

```powershell
npm ci
npm run dev:api
# En otra terminal, después de apuntar VITE_API_URL al Worker local:
npm run dev
```

La app usa rutas como `/#/inventario`. El acceso sigue bloqueado si Auth, perfil o RPC no están disponibles; no hay fallback de permisos. Las cuentas Auth deben existir y tener un perfil activo; el primer administrador se provisiona por un procedimiento autorizado, nunca desde una petición pública.

El esquema `pos` debe permanecer fuera de Data API. Revisar/aplicar únicamente migraciones pendientes; 001–004 no se reejecutan. El estado remoto de 005 no se comprobó en esta tarea. Las nuevas 006–008 están propuestas localmente; ver la guía de entrega antes de autorizar su aplicación.

## Verificación

```powershell
npm run check:api
npm run check:credit
npm run test:api
npm run test:credit
npm run lint
npm run check:frontend-config
npm run build
npm run test:e2e -- --workers=1 --max-failures=1
```

Las pruebas de comercio en navegador usan UI → Worker → SQL/PGlite y un límite Auth simulado, sin cuentas reales. Las pruebas SQL verifican roles, RLS, stock, idempotencia, crédito, caja y compensaciones. No sustituyen la concurrencia de dos conexiones PostgreSQL ni el recorrido alojado con JWT real. No lanzar dos suites de navegador simultáneamente: comparten puerto y artefactos.

## Preparación de publicación

Confirmar proyecto, backup, versiones aplicadas, ACL y datos existentes. Probar en staging operaciones concurrentes, fallos parciales y permisos. Autorizar migraciones/despliegues por separado; verificar Worker, después reconstruir Pages con variables reales y revisar CSP/CORS. Las instrucciones y el checklist completos están en [ENTREGA_V1.md](docs/ENTREGA_V1.md).

Límites deliberados: devoluciones completas, ajustes/gastos de efectivo y administración de perfiles de cuentas Auth existentes. No incluye impuestos/facturación fiscal, devoluciones parciales, conciliación bancaria, invitaciones Auth desde UI, venta offline, WhatsApp real ni QR compartidos en R2. No importar historial local de demostración como operaciones reales.
