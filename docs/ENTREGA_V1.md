# CAI Market 1.0: implementación local y revisión de producción

La auditoría inicial está en [AUDITORIA_V1.md](AUDITORIA_V1.md). Esta entrega conserva React/TypeScript, estilos/componentes, Supabase Auth/PostgreSQL, Worker y Pages existentes. No se instalaron nuevas dependencias, no se aplicó SQL remoto, no se cambiaron variables remotas y no se hicieron commits ni despliegues. **No se declara listo para producción**: faltan aplicación/autorización remota, verificación con JWT real y pruebas concurrentes en PostgreSQL con conexiones independientes.

## Funciones conectadas

- Auth: Workerd no soporta redirect:error. Auth y RPC usan manual y rechazan todos los 3xx, sin seguir Location ni reenviar credenciales. Se mantiene timeout, JWT original, perfil activo propio e instrumentación temporal saneada. Browser fetch sí admite error y lo conserva.
- Inventario: crear/editar/desactivar, SKU/barcode, categoría, precio/costo, proveedor, mínimo, paginación/búsqueda y filtro de stock bajo. Existencias iniciales cero; entradas/salidas firmadas, auditadas e idempotentes; no se permite stock negativo. Versión optimista evita sobrescritura silenciosa de ediciones.
- Clientes/proveedores: altas, edición, desactivación y consulta persistentes. Clientes enlazan a compras. Cajero no administra proveedores ni productos/costos.
- POS: consulta catálogo real, carrito temporal, pagos múltiples/manuales con referencias, confirmación transaccional e idempotente, stock servidor, historial/detalle real. No se aceptan precios ni actor de React como autoridad.
- Crédito: cupos autorizados por administrador/supervisor, crédito y abonos según permiso del cajero, historial, saldo y vencido. Se reutilizan FIFO, límite y política de vencimiento del día 28 ya implementados. Abonos no pueden superar deuda. No se modificó esa política histórica.
- Caja: apertura única por caja/operador, saldo inicial, ingresos/egresos de efectivo, gastos, movimientos, arqueo/cierre con esperado/contado/diferencia. Recaudos de crédito no se duplican como ventas.
- Devoluciones: completas y autorizadas por administrador/supervisor, mediante compensaciones inmutables. Reponen existencias, reintegran solo lo cobrado y cancelan la parte de crédito aún pendiente. No borran ni sobrescriben venta, pagos, cargos o abonos originales. Reintegros no efectivos requieren referencia y confirmación manual.
- Dashboard/reportes: hoy/últimos siete días/mes actual, comparación equivalente, ventas netas, recaudos, gastos, métodos, stock bajo, cartera y utilidad bruta estimada desde PostgreSQL. Sin datos: ceros/estados vacíos, nunca cifras de muestra. Costo y categoría se capturan al vender; sin costo histórico no se inventa utilidad. CSV agregado del período protegido contra fórmulas.
- Usuarios: administrador administra perfiles/rol/actividad y permisos explícitos del cajero. No puede desactivarse/degradarse a sí mismo. Las cuentas Auth deben existir previamente; no se solicitan contraseñas ni claves administrativas en este formulario.
- Auditoría: consulta paginada autorizada; eventos de catálogo, existencias, caja, venta, crédito, devolución, perfiles y preferencias.
- Configuración de nombre/ubicación persistente; tema local claro/oscuro. Se conserva navegación hash responsive y controles accesibles.

## Arquitectura y límites

React → Worker `/api/catalog` o `/api/operations` → Supabase Auth + perfil validado → RPC pública específica con el JWT original → esquema privado pos. Toda operación vuelve a autorizarse en PostgreSQL. Ninguna ruta acepta SQL arbitrario, esquemas destino o identidad de actor enviados por el navegador. JSON limitado por bytes reales a 32 KiB; paginación SQL máxima 100 filas. No se concede acceso directo a tablas ni se expone pos.

El SDK persiste/renueva sesiones; los tokens no se copian a logs ni contraseñas a almacenamiento. `public/_headers` propone CSP, bloqueo de iframes, nosniff, políticas de permisos y referrer para Pages; revisar la lista connect-src si se usan dominios propios. CSP se valida en el host estático antes de publicar, no en Vite. Proteger contra XSS sigue siendo necesario con tokens SDK en localStorage; HttpOnly/BFF no se incorporó en esta entrega.

Reintentos con los mismos datos en una vista conservan la clave idempotente mientras no se obtiene confirmación. Una respuesta de red ambigua exige revisar historial antes de repetir una operación tras recargar/salir; no hay caja offline ni cola durable del navegador.

Las 13 pruebas de QR/local IndexedDB se conservan en un harness de desarrollo bajo tests/harness, separado de las pantallas comerciales. Los componentes legados se conservan para regresión; no alimentan el POS, dashboard, estadísticas o caja operativos. QR compartidos en R2 y confirmación bancaria automática no están implementados. No confundir la comprobación manual de una transferencia con verificación de banco.

MVP: devoluciones completas, gastos/ajustes de efectivo y perfiles de cuentas Auth existentes. No incluye devoluciones parciales, conciliación bancaria, gastos bancarios, compras/facturación tributaria, invitaciones Auth desde la UI, venta offline ni WhatsApp real. La utilidad usa costo configurado al vender, no valoración contable FIFO de mercancía. No migrar historiales locales de demostración a PostgreSQL como transacciones reales.

## Migraciones y seguridad de aplicación

No se editaron ni se deben reejecutar 001–004. Para 005, usar el preflight y procedimiento de [MIGRACION_005.md](integracion/MIGRACION_005.md): hay un intento fallido comunicado, pero no se consultó el historial remoto. Si ya está aplicada correctamente, no reejecutarla.

Nuevas propuestas locales (cada archivo BEGIN/COMMIT):

| Versión | Contenido |
| --- | --- |
| 006 | Catálogo, directorios, ajustes de stock y public.cai_catalog. |
| 007 | Caja, devoluciones compensatorias, costo/categoría históricos, permisos y public.cai_operations. Reemplaza la vista de saldo de cargos para restar la cancelación por devolución, manteniendo columnas/consumidores originales. |
| 008 | public.cai_report, agregaciones reales en America/Bogota, costos desconocidos y comparaciones. |

Los propietarios de tablas financieras existentes siguen siendo pos_owner. Los nuevos objetos de negocio se crean bajo ese rol, sin LOGIN/administración. CREATE temporal de pos/public se concede y revoca dentro de la transacción antes del COMMIT; no queda disponible para sesiones de aplicación. Los wrappers son SECURITY DEFINER con búsqueda fija; solo authenticated recibe EXECUTE específico. Se conservan RLS y revocaciones de tablas. Sin permisos nuevos en auth y sin service_role.

Antes de aplicar, revisar diff/backup y el estado de datos existentes, permisos del migrador (SET ROLE pos_owner, CREATE con capacidad de delegación en pos/public), y resultados de pruebas en un proyecto de staging aislado. No ejecutar reset ni modificar datos de producción para probar. Un fallo SQL debe abortar todo el archivo; reconectar/ROLLBACK si la sesión permanece abortada. No reparar historial marcando applied sin verificar aplicación real.

Se preparó `supabase/checks/v1_preflight.sql`, solo catálogos READ ONLY: rol propietario, membresías peligrosas, CREATE residual, propietarios/RLS, accesos directos, wrappers/ACL e historial 001–008 cuando existe. No se ejecutó remotamente. La configuración de esquemas expuestos se revisa además en Data API.

## Configuración

Frontend `.env.local`/Pages: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY y VITE_API_URL del mismo proyecto/Worker. Nunca service_role, passwords PostgreSQL ni claves privadas bajo VITE_.

Worker: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ALLOWED_ORIGIN exacto. MEDIA se conserva sin nuevas operaciones R2. Variables locales en worker/api/.dev.vars; no se presume que dev remoto herede secretos de producción. Solo public expuesto en Data API; pos fuera de exposed schemas.

Primera cuenta: el administrador de Supabase debe provisionar la cuenta Auth/perfil inicial mediante procedimiento autorizado. La UI de perfiles requiere un administrador ya activo; no hay autoasignación ni primer administrador por petición pública. Revisar CSP/connect-src y preservar configuraciones existentes en Cloudflare al desplegar.

## Comprobaciones locales

```powershell
npm run check:api
npm run check:credit
npm run test:api
npm run test:credit
npm run lint
npm run build
node scripts/check-v1-build.mjs
npm run test:e2e -- --workers=1 --max-failures=1
node node_modules/@playwright/test/cli.js test -c worker/auth-diagnostic/playwright.config.ts
node node_modules/typescript/bin/tsc -p worker/auth-diagnostic/tsconfig.json
```

No lanzar dos ejecuciones E2E a la vez: comparten puerto 5174 y carpeta de artefactos. Las expectativas tienen presupuesto de integración para el arranque frío de PGlite; los controles HTTP, límites de stock, timeout API y aserciones de negocio no se relajaron.

La suite de navegador de comercio recorre UI → Worker real → RPC SQL real en PGlite, con Auth simulado. No valida firma real, ACL del Supabase remoto ni concurrencia de conexiones PostgreSQL distintas. Los controles de rol/atomicidad/idempotencia se prueban además en SQL.

Resultados locales del 23 de octubre de 2026:

| Comprobación | Resultado |
| --- | --- |
| API, contratos, CORS y saneamiento de registros | 78/78 correctas |
| SQL: permisos, identidad, inventario, venta, crédito, caja, devolución y reportes | 82/82 correctas |
| Playwright navegador: acceso, módulos, comercio integrado y regresión QR aislada | 41/41 correctas (5,2 minutos), sin omisiones |
| Worker de diagnóstico independiente | 23/23 correctas y TypeScript correcto |
| TypeScript API/SQL, lint | Correctos |
| Variables públicas frontend | Formato válido; no verifica proyecto, claves ni conectividad remota |
| Compilación de producción | Correcta; advertencia por chunk principal de 505,12 kB (147,26 kB gzip) |
| Revisión del bundle | Sin marcadores demo/harness ni claves secretas de los patrones comprobados; no sustituye una auditoría de secretos |

Se revisaron capturas de escritorio y móvil (390 px), además de pruebas de navegación a 390 y 834 px: sin desbordamiento horizontal, con menú móvil y estados vacíos. Los ocho productos de las capturas son datos de fixture, nunca una carga para producción.

## Archivos de esta entrega

El árbol ya contenía cambios de autenticación, migración 005, configuración y pruebas previos a esta ampliación. Se conservaron; la lista siguiente describe la implementación V1 sin atribuir todos los cambios pendientes del repositorio a esta fase.

| Área | Archivos principales |
| --- | --- |
| Interfaz y navegación | src/App.tsx, src/components/layout.tsx, src/components/charts.tsx, src/data/navigation.ts, src/index.css, src/lib/utils.ts, index.html |
| Módulos persistentes | src/features/dashboard.tsx, src/features/inventory.tsx, src/features/catalog/{hooks,common,contact-picker,directory}.tsx/ts, src/features/operations/{forms,pos,sales,cash,credits,settings}.tsx |
| Contratos y cliente | shared/catalog.ts, shared/operations.ts, shared/business-response.ts, src/lib/api-client.ts |
| API | worker/api/src/index.ts, worker/api/src/catalog.ts |
| Diagnóstico separado | worker/auth-diagnostic/src/index.ts, wrangler.jsonc, .dev.vars.example, tsconfig.json, playwright.config.ts, tests/probes.spec.ts, README.md |
| PostgreSQL propuesto | supabase/migrations/20261023000600_catalog.sql, 20261023000700_operations.sql, 20261023000800_reports.sql; supabase/checks/v1_preflight.sql |
| Regresión y seguridad | tests/api/, tests/credit/{catalog,operations,reports}.spec.ts, tests/business.spec.ts, tests/admin.spec.ts, tests/fixtures/{auth,business}.ts, playwright.config.ts |
| Aislamiento del legado | tests/harness/payments.html y payments.tsx, tests/transfers.spec.ts; imágenes demo trasladadas de public/demo-qr a tests/fixtures/demo-qr |
| Artefacto y documentación | public/_headers, scripts/check-v1-build.mjs, README.md, docs/AUDITORIA_V1.md, docs/ENTREGA_V1.md y referencias actualizadas en documentación de integración |

La validación de respuestas comerciales también comprueba JSON exitoso: una respuesta HTTP 200 con forma incompatible se rechaza con INVALID_RESPONSE, en lugar de inventar valores o confirmar una operación sin su identificador.

## Puertas de producción y despliegue (pendiente de autorización)

1. Confirmar proyecto/backup y versiones realmente aplicadas; auditar esquema y permisos; revisar el reemplazo de vista de crédito y datos existentes. Preparar staging y cuentas admin/supervisor/cajero sin datos de clientes reales.
2. Aplicar únicamente migraciones pendientes y registrar su historial con la herramienta habitual. No hay comandos automáticos de reset/repair en esta entrega.
3. Con dos clientes reales contra staging: dos ventas compiten por la última unidad (solo una confirma); mismo idempotency key simultáneo (una venta/movimiento); dos abonos compiten por deuda restante (no sobrepago); cierre compite con venta/abono; devolución compite con abono y con otra devolución; edición de producto durante venta; cambio de rol durante operación. Revisar invariantes y ausencia de efectos parciales tras cada caso.
4. Desplegar Worker con autorización: manual en ambas llamadas, 3xx rechazados, JWT original, CORS exacto y logs técnicos temporales. Ensayar health, JWT falso→401, sesión real y perfil propio, roles y cuenta inactiva. Retirar instrumentación temporal cuando se confirme la causa.
5. Configurar/validar variables públicas de Pages, ejecutar check:frontend-config y compilar de nuevo; revisar que el bundle no incorpore fuentes/valores demo, secretos ni harness de tests. Aplicar headers de Pages y probar CSP/CORS real.
6. Desplegar Pages con autorización. Verificar recorrido completo, responsive/teclado, cierres, reintentos y mensajes de error. Preparar rollback del Worker/Pages; para errores SQL transaccionales revertir antes de COMMIT, y para migraciones ya aplicadas usar una corrección revisada, nunca borrar movimientos reales.

### Lista de verificación

- [ ] Historial 005 confirmado y 006–008 revisadas/aplicadas una vez.
- [ ] pos privado, ACL/RLS/propietarios y ausencia de roles peligrosos auditados.
- [ ] Cuenta administradora y permisos operativos validados, sin autoasignación.
- [ ] Flujo JWT real, Auth/Worker/RPC/CORS/CSP comprobados en entorno alojado.
- [ ] Concurrencia real y fallos parciales de venta, abono, cierre y devolución comprobados.
- [ ] Sin datos ficticios en indicadores ni importación de historial demo.
- [ ] Variables correctas y artefacto reconstruido; ninguna credencial privada en frontend/logs.
- [ ] Operador entiende límites: pagos manuales, devolución completa, contabilidad operativa.
- [ ] Copias de seguridad, recuperación y rollback revisados.
- [ ] Autorización explícita antes de producción, commits o despliegues.
