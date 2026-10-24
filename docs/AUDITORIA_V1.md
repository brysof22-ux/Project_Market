# CAI Market 1.0: auditoría inicial y orden de implementación

23/10/2026. Fuente de alcance: especificación del usuario y documento adjunto «PROYECTO: CAI MARKET 1.0». Trabajo local autorizado; producción, datos reales, permisos remotos, commits y despliegues requieren autorización. No se certificó el estado remoto.

## Estado al comenzar

| Área | Existente y aprovechable | Brecha detectada |
| --- | --- | --- |
| Acceso | Supabase SDK, login/logout, refresh, verificación del usuario y perfil activo, guard de vistas, Worker /api/me | redirect:error incompatible con workerd; ACL/005/publicación remota no verificadas. |
| Inventario | Tabla products, balances, movimientos de ventas, bloqueo de stock en confirm_sale, filtros de UI | Catálogo UI ficticio; faltan altas/edición, costo/categoría/proveedor/stock mínimo y entradas/salidas persistentes. |
| POS | Carrito UI; SQL confirm_sale atómico con pagos, crédito, stock, idempotencia y auditoría | UI llama a IndexedDB de demostración, no al SQL; falta historial real y devoluciones. |
| Crédito | Migraciones 001–004, límites/historial/FIFO, invariantes diferidas, pruebas PGlite | Falta API pública segura y UI; no exponer pos para resolverlo. |
| Caja | cash_sessions, cash_entries de ventas/abonos, bloqueos y validación de consistencia | Sin apertura/cierre/arqueo/gastos en UI/API. |
| Directorios | customers mínimo | UI ficticia; proveedores no modelados; faltan altas/edición/historial. |
| Dashboard/reportes | Componentes reutilizables/Recharts | Importan src/data/mock, fechas fijas, exportación ficticia y cifras inventadas. |
| Usuarios/permisos | profiles y require_staff en PostgreSQL | UI usa rol demo para pagos; falta administración de perfiles/permiso por operación. |
| Auditoría | audit_events inmutable y eventos financieros | Falta consulta autorizada y cobertura de catálogo/caja/devoluciones. |
| Preferencias | Tema local y formulario general | Configuración comercial no se guarda; QR solo IndexedDB. |

## Seguridad y arquitectura

- Worker usa JWT del usuario y clave publishable; no hay clave administrativa en frontend. Perfil de Auth solo no autoriza: RPC valida gateway, claims y perfil activo.
- Problema reproducido: workerd rechaza redirect:error antes de la red. Utilizar manual y rechazar 3xx conserva la protección contra reenvío de credenciales. Node no reproduce ese fallo; diagnóstico independiente en worker/auth-diagnostic.
- Mantener pos privado. Los permisos EXECUTE financieros de 004 no autorizan exponer el esquema entero. Nuevas operaciones deben publicarse mediante wrappers con autorización explícita y datos acotados.
- SDK conserva tokens en localStorage; requiere protección contra XSS/CSP y revisión de persistencia en el modelo de amenaza. No introducir una falsa sesión ni guardar contraseñas. Considerar BFF HttpOnly como evolución, sin cambiar de arquitectura de sesión durante esta integración.
- Selector de rol de demostración no es autorización. No usarlo en operaciones reales ni permitir actor/precios/stock calculados por React como autoridad.
- CSV requiere protección contra fórmulas si exporta texto introducido por usuarios. No propagar errores SQL, JWT, credenciales o datos personales a logs.
- Base financiera tiene registros inmutables e invariantes entre ventas, pagos, crédito y caja. No sobrescribir ni borrar esos registros para devolver/anular; usar compensaciones auditadas.
- Conservar propietario de tablas financieras. No editar 001–004 aplicadas. Estado real de 005 pendiente de preflight manual; no reaplicarla si existe.

## Pruebas y rendimiento

Hay suites API con fetch simulado, interfaz con Auth interceptado y SQL PGlite. No equivalen a PostgreSQL concurrente real, JWT real o conectividad remota. Los escenarios de concurrencia de crédito están documentados, no certificados con dos conexiones alojadas.

Mantener regresiones, añadir pruebas de límites de rol, atomicidad, reintentos/duplicados, stock/caja/crédito y devoluciones; ejecutar flujos UI con API controlada y separar esas pruebas de la verificación remota. Consultas deben limitar/paginar históricos y utilizar índices. No cargar toda la base para filtrar en React. Reutilizar formatos/tablas/formularios y evitar un segundo sistema de pagos paralelo.

## Implementación por dependencias

1. Corregir transporte Auth/RPC y comprobar que 3xx nunca se siguen; conservar instrumentación temporal saneada.
2. Migración nueva de catálogo/directorios/caja y wrappers públicos; probar sin permisos administrativos de runtime.
3. Cliente HTTP reutilizable autenticado y vistas conectadas de inventario/directorios.
4. Apertura de caja, venta transaccional real, historial/detalle; reutilizar confirm_sale.
5. Cartera/abonos, gastos/arqueo/cierre y compensaciones de devolución; verificar invariantes.
6. Consultas agregadas reales/dashboard/reportes, roles/usuarios y configuración persistente.
7. Pruebas completas, revisión visual/accesibilidad, documentación y plan de publicación. La aprobación remota solo se solicita con cambios locales revisables y pruebas completas.

No presentar esta auditoría ni pruebas simuladas como certificación de producción. Si queda alguna función principal simulada, migración sin revisar o prueba crítica fallida, declarar la limitación explícitamente.
