# CAI Market V1.3 — alcance, validación y publicación

## Inventario y fotografías

Los formularios de creación, edición y reabastecimiento comparten los campos de compra. Reciben unidades enteras no negativas y total de compra COP; muestran cantidad anterior, ingreso, cantidad resultante y costo unitario de solo lectura. La API calcula el costo vigente con promedio ponderado y conserva seis decimales, además de registrar el total exacto del lote. Las unidades se suman dentro de la transacción; una versión obsoleta se rechaza y una clave repetida no duplica la compra. Mínimo inicial 5, sin cambiar mínimos existentes.

La entrada interpreta `20.173` como veinte mil ciento setenta y tres y `420,27` como cuatrocientos veinte con veintisiete; también admite decimales canónicos con punto. Sin unidades nuevas, el total debe ser cero. Si hay stock anterior sin costo, el promedio sigue siendo desconocido: no se inventa una valoración. Los costos históricos ya guardados en las ventas se conservan.

Fotos originales JPG/PNG/WebP de hasta 20 MiB y 40 megapíxeles: decodificación con orientación, proporción conservada, máximo 1200 × 1500 sin ampliar pequeñas, WebP desde calidad 80 % y compresión progresiva buscando menos de 200 KiB. Se muestra vista previa. Solo se sube el optimizado; Worker valida contenedor, tipo WebP, dimensiones y máximo 2 MiB. No se regeneran QR bancarios. Un rechazo SQL definitivo elimina el objeto nuevo no asociado; un timeout ambiguo se reconcilia y nunca borra una fotografía posiblemente referenciada.

## Reinicio destructivo disponible, nunca ejecutado en producción

Configuración exige reautenticación reciente, rol administrador, vista previa ligada a sesión y huella de datos, motivo y frase exacta `ELIMINAR OPERACION`. Adquiere el bloqueo exclusivo de operación y rechaza escritores o envíos activos. El borrado es ordenado por FK, transaccional y sin `TRUNCATE CASCADE`. Elimina también períodos anteriores, historiales de ventas/deudas/caja, notificaciones y movimientos; conserva catálogos, usuarios, consentimientos y configuración. Inventario en cero y siguiente venta V-1. Un fallo revierte datos y reinicio de secuencia. No se archiva información comercial después de confirmar el reinicio; sólo queda la constancia técnica del reinicio.

La migración instala la función; NO la invoca. Ninguna verificación remota ejecuta `reset.confirm`. El borrado de la aplicación no extingue obligaciones de conservación de información que puedan resultar aplicables.

## Contabilidad y dashboard

Once indicadores y gráficas calculados en PostgreSQL: ventas netas, cobros, cartera, costos históricos vendidos, utilidad bruta, gastos, utilidad neta estimada, efectivo de cajas abiertas, transferencias, inventario a costo vigente y margen. Abonos no son nuevas ventas; créditos pendientes no son efectivo. Se netean devoluciones/reintegros y se preservan costos desconocidos como no disponibles. Caja, cartera e inventario son saldos actuales; las otras cifras corresponden al rango.

Gráficas: ventas diarias, ventas por mes dentro del rango, productos vendidos/rentables, ganancias, cartera, gastos por período y cobros por método. Filtros hoy, 7 días, 30 días, mes actual y personalizado. Datos financieros exclusivos del administrador.

## WhatsApp: implementado y desactivado hasta conexión real

Nueva cola privada `pos.notification_jobs`, configuración privada `pos.whatsapp_settings` y puente limitado `public.cai_whatsapp_dispatch`. El puente requiere una capacidad aleatoria cuyo SHA-256 se guarda en PostgreSQL; no usa `service_role` en el Worker ni concede lectura de tablas a empleados. Las ventas y abonos sólo escriben la cola dentro de su transacción y no llaman a Evolution. Desactivar globalmente evita crear nuevos avisos; una desconexión con avisos habilitados conserva los trabajos pendientes.

Consentimiento explícito `credit_notifications`, teléfono normalizado y contacto activo. No se amplía automáticamente el consentimiento histórico `credit_reminder`. Compras, abonos y deuda saldada se generan con claves únicas. Cron cada cinco minutos en UTC reintenta pendientes y genera recordatorios diarios después de las 09:00 de Bogotá: el día de vencimiento y el anticipo configurable (1 día por defecto). Sin fecha, sin consentimiento, con deuda pagada/devuelta o recordatorio de otro día se cancela el envío obsoleto.

Antes del POST se revalidan consentimiento y deuda. Los rechazos definitivos o reintentables se distinguen de resultados inciertos; un timeout no se reenvía ciegamente. Evolution no ofrece un campo de idempotencia en su DTO de texto verificado: no se promete exactamente una entrega ante un resultado de red ambiguo. La aceptación no acredita entrega/lectura. Los resultados inciertos quedan visibles para revisión.

Configuración → WhatsApp es exclusiva de administradores: estado, número si el proveedor lo informa, última conexión/envío/error, contadores, preferencias, consentimiento, prueba expresamente autorizada y reintento de rechazos fallidos. No se muestran claves. Nunca se enviaron mensajes de prueba a clientes reales.

## Infraestructura pendiente comprobada

Docker Desktop 29.8.0 y Compose 5.5.1 instalados, WSL2 disponible. Docker Engine responde 502 Bad Gateway; no se pudieron levantar Evolution/PostgreSQL/Redis. Se preparó `infrastructure/whatsapp` y se validó estáticamente Compose sin iniciar servicios ni generar credenciales ficticias. Las cuatro etiquetas fijadas existen y tienen imagen amd64. La cuenta Cloudflare consultada no tiene zonas DNS; no se puede publicar un túnel persistente sin aportar un dominio compatible. No se usó un Quick Tunnel como endpoint de producción.

Ver [operación local y pasos de vinculación](../../infrastructure/whatsapp/README.md). Pendiente reparar Engine, completar credenciales locales, crear dominio/túnel persistente, configurar secretos, iniciar instancia `cai-market`, escanear QR por el propietario y verificar conexión/consentimiento antes de habilitar envíos. Esta limitación no bloquea las demás mejoras verificadas.

## Migración y publicación

Única migración nueva: `20261027001100_v13_operations.sql`. Añade `inventory_purchases`, `whatsapp_settings` y `notification_jobs`, amplía precisión de costos y reemplaza únicamente los puntos de entrada necesarios. No se modifican 001–010, no hay backfill de avisos ni llamadas destructivas. Publicación: preflight de sólo lectura → 011 con auditoría de huellas de filas existentes e historial en la misma transacción → Worker → commit/main → Pages → revisión de endpoints y recursos publicados. No se crean respaldos ni se ensayan restauraciones.

## Validaciones y estado publicado

Regresión automatizada: 192 pruebas API, 143 pruebas SQL y 56 pruebas de navegador aprobadas (los totales incluyen las suites previas y las pruebas nuevas). Tres comprobaciones adicionales en PostgreSQL nativo verificaron compras concurrentes, costo histórico de ventas concurrentes y exclusión del reinicio. También pasó la validación local de la transacción de despliegue, TypeScript, lint, compilación y empaquetado del Worker.

Supabase: migración 011 aplicada con resultado `V13_MIGRATION_COMMITTED_EXISTING_ROWS_UNCHANGED`; auditoría posterior de solo lectura `V13_INTEGRITY_PASS`. No se ejecutó el reinicio. Worker publicado con versión `73c2cafb-dd73-418c-8f68-17fdacf1638e` y cron cada cinco minutos; sin credenciales de Evolution, el cron no realiza envíos. Las pruebas de Evolution usan un proveedor simulado: la conexión y entrega reales siguen pendientes por los bloqueos documentados. Las verificaciones públicas de producción no crean ventas, abonos ni mensajes reales.

## Fuentes verificadas

- [Evolution API estable 2.3.7](https://github.com/evolution-foundation/evolution-api/releases/tag/2.3.7).
- [DTO oficial de envío](https://github.com/evolution-foundation/evolution-api/blob/2.3.7/src/api/dto/sendMessage.dto.ts).
- [Estado e información de instancia](https://github.com/evolution-foundation/evolution-api/blob/2.3.7/src/api/controllers/instance.controller.ts).
- [Cron Triggers en UTC](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
