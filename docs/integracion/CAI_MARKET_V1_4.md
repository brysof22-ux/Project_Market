# CAI Market V1.4 — panel administrativo

## Alcance

Se conserva la identidad visual verde y los permisos vigentes. Se elimina la vista Dashboard independiente; el administrador entra en Estadísticas y las rutas `/dashboard` y `/#/dashboard` se normalizan a `/#/estadisticas`. El cajero sigue entrando en POS; los perfiles Supervisor conservan la clasificación pendiente ya existente. El menú separa PRINCIPAL y ADMINISTRACIÓN.

Estadísticas reúne los once indicadores y ocho gráficas del servidor, sin repetir los paneles auxiliares. `MetricTooltip` ofrece ayuda por hover, foco y toque, Escape y posicionamiento dentro de la pantalla. El margen explica cuánto queda por cada $100 antes de gastos; la utilidad negativa se explica expresamente. Los costos desconocidos siguen siendo desconocidos.

`TodaySalesHistory` consulta el día de Bogotá calculado en PostgreSQL, con búsqueda, método, estado, orden descendente, páginas de 20, actualización manual, al recuperar foco y cada minuto mientras la pestaña es visible. Los resúmenes corresponden a todo el día; los filtros afectan la tabla. El detalle reutiliza `SaleDetail`. Lo vendido se netea con devoluciones; lo recibido incluye abonos y descuenta reintegros; crédito es el principal financiado de las ventas de hoy menos sus devoluciones. No se confunde con dinero recibido. Los reportes mantienen el período operativo activo.

Contabilidad tiene cuatro áreas: Control de caja, Movimientos financieros, Historial de cajas y Resumen de ingresos y egresos. No monta gráficas ni tarjetas de ganancias. Apertura y cierre conservan observaciones. El arqueo muestra contado menos esperado, requiere confirmación y nunca reescribe cierres anteriores. El historial administrativo incluye períodos previos, filtros, detalle y exportación CSV paginada con protección contra fórmulas de hoja de cálculo.

Los movimientos manuales distinguen efectivo/transferencia y operativo/capital/interno. Solo el efectivo altera el efectivo esperado. Aportes, retiros, traslados y compras de inventario no aumentan ventas ni costo vendido. Los egresos operativos sí forman parte de los gastos del reporte, cualquiera que sea su método. Los ajustes de devolución se incluyen una sola vez. El balance del resumen es el flujo del período, excluye el efectivo inicial y no pretende ser un saldo bancario acumulado. La fecha del movimiento es la fecha del servidor; no se permite crear egresos retroactivos en cajas cerradas.

Configuración usa siete grupos, monta únicamente la sección seleccionada y conserva mensajes de carga/error/guardado. Los cambios pendientes se advierten antes de cambiar de grupo, navegar o cerrar la pestaña. Negocio y preferencias WhatsApp validan una revisión bajo bloqueo para evitar sobrescrituras silenciosas. Los QR mantienen su control de concurrencia por imagen. Las preferencias que el backend no permite editar se explican como información o enlaces: no se inventan controles para moneda, zona, numeración, mínimos globales ni categorías de movimientos. Reinicio queda en Datos y mantenimiento, dentro de la zona avanzada protegida.

## Archivos y componentes

- Navegación: `src/App.tsx`, `src/data/navigation.ts`, `src/components/layout.tsx`, `shared/permissions.ts`.
- Se elimina `src/features/dashboard.tsx`; análisis compartido pasa a `src/features/statistics.tsx` y continúa usando `operations/financial-report.tsx`.
- Nuevos: `src/components/metric-tooltip.tsx`, `src/features/operations/today-sales.tsx`, `src/features/operations/settings-guard.ts`, `src/lib/business-format.ts`.
- Reorganizados: `operations/cash.tsx`, `operations/settings.tsx`, `operations/sales.tsx`, preferencias WhatsApp y confirmación de guardado de QR. Estilos en `src/index.css`.
- Contratos: `shared/operations.ts`, `shared/business-response.ts`; autorización HTTP del Worker consume la lista compartida. No se agregan dependencias.
- Pruebas nuevas: `tests/v14-ui.spec.ts`, `tests/api/v14.spec.ts`, `tests/credit/v14.spec.ts` y fixture V1.4. Se ajustan regresiones a la nueva navegación.

## API y migración

Se reutiliza `POST /api/operations`; no se introduce otro punto de entrada HTTP. Acciones nuevas administrativas: `sales.today`, `finance.list`, `finance.summary`, `cash.history`, `cash.detail`. Se reutilizan `bootstrap`, `sales.detail`, `cash.open`, `cash.move`, `cash.close`, `settings.save` y acciones WhatsApp. Cada lectura valida autorización y paginación; las escrituras conservan período, transacción, idempotencia y auditoría.

Única migración: `20261027001200_v14_admin_ux.sql`. Añade metadatos a ajustes/aperturas/cierres, revisión de preferencias WhatsApp, vista privada de movimientos y helper privado de efectivo. Conserva la implementación V1.3 como función privada y amplía el RPC público. Las fórmulas publicadas se mantienen, con dos predicados explícitos: solo efectivo para arqueo, solo egresos operativos para gastos. Los registros anteriores reciben metadatos compatibles: efectivo, operativo, observación vacía. No se modifica el importe, fecha, autor, inventario, deuda ni ningún saldo histórico. Migraciones 001–011 permanecen intactas.

Preparación: preflight de solo lectura; aplicación transaccional con bloqueo de escritores y comparación de cantidades/huellas de todas las filas existentes, excluyendo exclusivamente las columnas nuevas; registro exacto del SQL en historial; auditoría posterior de permisos, integridad y WhatsApp desactivado. No se crean respaldos y no se invoca reinicio.

## Validación

Pruebas API y SQL, recorridos integrados navegador → Worker → PostgreSQL local, comprobaciones de TypeScript/lint/build y capturas en 390, 834 y 1366 píxeles. Las comprobaciones de concurrencia en PostgreSQL nativo verifican movimiento idéntico registrado una vez, cierre que espera al movimiento y configuración obsoleta rechazada. Todas usan datos ficticios locales; ninguna crea ventas, abonos o mensajes en producción.

Las pruebas heredadas que invocan reinicio se excluyen expresamente en esta versión. Se comprueba su ubicación protegida sin ejecutar esa operación. El primer intento de regresión general del navegador agotó memoria nativa; se limita la compilación WASM y se ejecuta secuencialmente, sin cambiar el comportamiento del producto.

WhatsApp conserva la implementación V1.3 y continúa desactivado. No se configuran credenciales inventadas ni se envían pruebas reales. Sigue pendiente la infraestructura Docker/Evolution y el túnel persistente documentados en `infrastructure/whatsapp/README.md`.

## Resultado de publicación V1.4

- 194 pruebas API, 141 SQL y 62 recorridos de navegador aprobados, contabilizando casos únicos entre regresión y revalidaciones dirigidas. Ocho pruebas SQL específicas de V1.4 incluyen rechazo de arqueo obsoleto y reintento idempotente del cierre. Se excluyeron las pruebas que ejecutan reinicio.
- Tres pruebas adicionales de concurrencia en PostgreSQL nativo aprobadas, y una prueba local del envoltorio transaccional de despliegue. TypeScript de aplicación/API/SQL, lint y compilación aprobados. Se revisaron capturas claras/oscuras y en móvil/tableta/escritorio.
- Migración 012 aplicada: `V14_MIGRATION_COMMITTED_EXISTING_ROWS_UNCHANGED`. Auditoría posterior: `V14_INTEGRITY_PASS`. No se invocó reinicio ni se modificaron registros comerciales existentes.
- Worker publicado: `eef38dbc-81c6-45d0-8d56-8a5813ff5245`. Mantiene R2, configuración de origen y cron de V1.3. WhatsApp continúa desactivado.
- Los ajustes detectados por la regresión fueron expectativas visuales heredadas de la reorganización: acceso de cajero a un grupo administrativo y dos títulos iguales de WhatsApp. Se corrigieron el recorrido y el título duplicado; no se ampliaron permisos.
