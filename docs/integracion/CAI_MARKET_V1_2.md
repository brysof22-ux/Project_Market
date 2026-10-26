# CAI Market V1.2

Cambios sobre V1.1, autorizados para producción el 26/10/2026.

- Se ocultan categorías en las rutas operativas, indicadores y exportación. El gráfico usa productos más vendidos por unidades netas; PostgreSQL conserva las categorías compatibles.
- Tarjeta deja de estar disponible para nuevas operaciones. Sus métodos, pagos y referencias históricos se conservan.
- Transferencias sin referencia, con QR Nequi/Llaves Bre-B, cambio de selección y ampliación. La selección y visualización nunca confirman el pago; el vendedor declara manualmente la recepción.
- Configuración → Métodos de pago permite al administrador reemplazar cada imagen manteniendo su nombre. Cajeros tienen lectura autenticada; los controles de Worker y PostgreSQL bloquean escrituras administrativas.
- PNG/JPEG/WebP, máximo 2 MiB, 64–4096 píxeles por lado y 16 megapíxeles. Se valida el archivo en navegador y su contenedor en Worker. No se aceptan SVG/HTML ni URLs externas.
- R2 privado con claves SHA-256 sobre los bytes normalizados; las cargas repetidas reutilizan el objeto. Se eliminan metadatos sin recomprimir los píxeles ni generar QR. Supabase almacena referencias, dimensiones, tipo y auditoría; nunca Base64. Las versiones anteriores permanecen privadas para las ventas históricas.
- Venta transaccional: valida confirmación manual, método activo y versión vigente bajo bloqueo compartido; conserva versión/selección del QR en el pago. Mantiene idempotencia, precios de servidor, stock, caja, créditos y reportes.

## Base de datos y publicación

Nueva migración: `20261026001000_v12_transfer_qr.sql`. No se modifican 001–009 ni se eliminan datos. Añade dos tablas privadas y tres columnas opcionales en pagos; actualiza únicamente las funciones necesarias y las opciones de pago.

Producción tenía V1.1 instalada pero sin registro 009. Se verificaron sus funciones y la auditoría financiera existente antes de completar exclusivamente ese registro. La única diferencia de cuerpo encontrada fue la codificación de un texto de auditoría en `confirm_sale_v11`; V1.2 conserva la lógica financiera y corrige ese texto al instalar su función.

Orden: objetos privados R2 → registro pendiente 009 → migración 010 e historial atómicos → referencias originales QR → auditoría de integridad → Worker → commit/main → Pages por integración GitHub → comprobaciones públicas y de artefactos. No se generan respaldos ni simulaciones de restauración.

Las imágenes originales están en `QR Transferencias`, excluidas de Git por contener datos privados del destinatario. No se incorporan al bundle ni se convierten en activos públicos. Las pruebas usan imágenes ficticias si los originales no están disponibles.

## Validación

- API/Worker: autenticación, CORS, permisos, lectura privada, formato/tamaño, conflicto de versiones y deduplicación.
- PostgreSQL: roles, creación/edición compatible, transferencia sin referencia y con confirmación manual, versión vigente, idempotencia, efectivo y conservación del historial con tarjeta.
- Playwright: inventario, ventas, créditos, devoluciones, roles, ambos QR, reemplazos independientes, móviles y categorías ausentes.
- TypeScript, lint y compilación de producción.

Las pruebas integradas de navegador usan Worker real y SQL en PGlite con el límite Auth simulado. No realizan ventas de prueba ni alteran operaciones comerciales en producción. La comprobación remota usa catálogo/integridad, objetos R2, seguridad HTTP y recursos publicados. La revisión de la sesión abierta en Chrome no fue posible porque Computer Use no pudo identificar su URL con confianza.

## Resultado de publicación

- 182 pruebas API/Worker, 133 SQL/finanzas y 50 recorridos de navegador aprobados. TypeScript, lint y build correctos; empaquetado Worker correcto.
- Supabase 010 e historial confirmados; registro faltante 009 completado sin reejecutar DDL. Auditoría remota `V12_INTEGRITY_PASS`.
- Ambos originales cargados en R2 privado y asociados a su opción en Supabase.
- Worker publicado: versión `686e77c2-a7c8-4512-832a-1f3dc301ff69`.
- Línea base financiera: ventas, pagos, créditos/abonos, caja, perfiles, períodos y stock coinciden antes/después. Durante la ejecución el catálogo pasó de 4 a 8 productos; la auditoría registra `product.save` y `product.image_attached` concurrentes. La migración no crea productos.
- URL Pages: https://project-market.pages.dev. Worker: https://cai-market-api.brysof22.workers.dev.

## Corrección: QR en abonos de deudas (26/10/2026)

`Deudas → Detalle e historial de pagos → Registrar abono` reutiliza `TransferPicker`, el mismo componente de ventas. Transferencia muestra Nequi/Llaves Bre-B y sus imágenes autenticadas de R2; efectivo oculta el selector. Cambiar método o QR conserva el importe y exige confirmar nuevamente «Confirmo el valor recibido». El envío permanece deshabilitado hasta la confirmación y, para transferencia, hasta que el QR se cargue correctamente. No se envía una referencia bancaria.

La consulta compartida de configuración mantiene sus datos cuando no hay cambios, escucha cambios del administrador entre pestañas y actualiza al recuperar el foco o cada 30 segundos para otros dispositivos. Un QR reemplazado invalida la confirmación anterior. El botón Actualizar QR sigue disponible; actualizar una versión sin cambios no bloquea el formulario. Los cambios de imagen no reinician el importe escrito.

No requiere cambios de Worker, Supabase, R2 ni migraciones. Mantiene `debt.receipt`, la deuda seleccionada, el límite del saldo y la clave de idempotencia existente; no modifica saldos ni registros históricos en producción. La publicación se realiza por `main` y la integración GitHub → Cloudflare Pages.

Las pruebas nuevas recorren administrador/cajero con dos compras de una misma persona, ambos QR, efectivo, importe conservado, confirmación, transferencia sin referencia, abono dirigido, rechazo de sobrepago, repetición idempotente y caja sin entradas de efectivo por transferencia. También verifican el reemplazo desde otra pestaña y la reutilización en ventas. Las imágenes de prueba siguen siendo ficticias; no se generan ni reemplazan QR bancarios durante los ensayos.

Validación de esta corrección: 17 pruebas Playwright de navegador (ventas, abonos, roles, caja, inventario, reportes y administración QR), 48 SQL de regresión y 2 API de seguridad de imágenes aprobadas. TypeScript, lint y compilación correctos. No se ejecutan pruebas comerciales contra saldos reales.
