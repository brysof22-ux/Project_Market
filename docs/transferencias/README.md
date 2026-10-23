# Transferencias con imágenes QR fijas

Implementación de interfaz y repositorio **local de demostración**. No se configuraron servicios remotos, claves bancarias ni Supabase, no se ejecutaron migraciones y no se verifica ningún banco. La confirmación manual es una declaración del usuario en una simulación, nunca evidencia de conciliación bancaria.

## Recorrido de uso

1. Abrir **Configuración → Métodos de pago**. El perfil administrador de demostración puede agregar QR, poner nombre, entidad y titular, cambiar su imagen o activar/desactivar el método.
2. Cargar PNG, JPG o WebP: máximo 2 MB, firma de archivo concordante y decodificación válida; dimensiones entre 64 y 4096 px por lado. Se normalizan los píxeles a PNG para descartar metadatos antes de guardarlos. No se aceptan SVG, HTML ni URLs externas.
3. En POS, agregar productos y elegir **Transferencia**. Se abre automáticamente el modal con el QR fijo activo, la entidad, el titular y el importe exacto en COP. Se puede elegir otro QR y ampliarlo.
4. Digitar referencia y marcar expresamente la verificación manual. Escribir una referencia o mostrar el QR no habilita por sí solo la confirmación. El propio modal indica que no hay conexión bancaria.
5. **Confirmar pago recibido** crea un borrador local; todavía no agrega filas al historial. Cancelar cierra el modal sin confirmar una transferencia nueva.
6. **Simular venta** registra una venta y sus pagos exclusivamente en IndexedDB. El historial local está disponible en POS y Contabilidad; conserva método, entidad/titular históricos, importe, referencia, usuario y hora de confirmación, versión y ruta de QR usados.

En **Pago mixto**, repartir el importe entre al menos dos métodos (efectivo, transferencia, tarjeta). La suma debe coincidir exactamente con el total, con hasta dos decimales. El modal muestra solamente la parte que se debe transferir. Transferencias y tarjetas se acumulan aparte del **efectivo físico simulado**.

La opción **Crédito** se muestra como pendiente de conexión al módulo de cartera y no permite finalizar una venta. No se agrega una simulación de cupo o vencimiento distinta de la arquitectura de créditos existente.

Cambiar carrito, modo de pago o importe transferido invalida la confirmación aplicable. Un cambio de QR o versión exige nueva referencia/verificación; un método desactivado no puede confirmarse ni incorporarse a una nueva venta. Se vuelven a consultar método, revisión e importe al confirmar y al finalizar la venta. Dos clics rápidos no duplican el registro: el repositorio dispone de una clave de operación única y una transacción IndexedDB.

Los QR iniciales son **dos archivos PNG estáticos de ejemplo**, sin datos de pago: contienen texto de demostración. No se generan QR en tiempo de ejecución ni se modifica el contenido del QR para insertar el importe. El cliente debe escribir/verificar ese importe en su aplicación financiera al usar un QR bancario fijo real en la futura versión conectada.

## Persistencia y permisos de demostración

Base IndexedDB: `cai-market-payments-demo-v1`, del mismo origen del frontend.

| Almacén         | Contenido                                                                        |
| --------------- | -------------------------------------------------------------------------------- |
| `methods`       | Nombre, entidad, titular, ruta lógica, activo, revisión, fecha y responsable     |
| `images`        | Blobs PNG normalizados por rutas aleatorias; nunca imágenes base64 en PostgreSQL |
| `methodChanges` | Registro de cada modificación, autor y versiones anterior/nueva                  |
| `sales`         | Ventas/pagos simulados y clave única `operationKey`                              |

Las imágenes anteriores se conservan para sostener el historial de versiones; una edición no sobrescribe las usadas previamente. Al borrar los datos del sitio se pierde la demostración. No se presenta IndexedDB como una bóveda de datos bancarios ni como almacenamiento de producción.

**Configuración → Usuarios y permisos → Rol de demostración** permite ensayar administrador, supervisor y cajero. Solo administrador puede editar QR; también hay una comprobación en el repositorio local. El perfil permanece durante la sesión del navegador y la barra superior refleja el usuario correspondiente. Este selector no autentica a nadie: cualquier permiso real debe verificarse en el backend. No usar el prototipo con datos sensibles ni para autorizar cobros reales.

Si IndexedDB no está disponible o falla al guardar, se muestra el error y no se indica que la venta fue guardada. Los errores de QR bloquean la confirmación manual. Las pestañas notifican cambios mediante BroadcastChannel y el repositorio vuelve a validar la revisión dentro de la transacción de escritura.

Los resúmenes añadidos son únicamente de las ventas locales. No se mezclan con los indicadores y ventas ficticias preexistentes del dashboard y Contabilidad ni se presentan como arqueos reales.

## Estructura implementada

```text
src/features/payments/
  types.ts                 Contratos y dinero en unidades menores enteras
  repository.ts            IndexedDB, validación, auditoría y escritura local
  context.ts               Contrato del contexto
  provider.tsx             Hidratación, usuario demo y actualización entre vistas
  use-payments.ts          Hook de acceso al contexto
  method-settings.tsx      Administración de QR y selector de roles demo
  qr-image.tsx             Lectura local y liberación de object URLs
  transfer-modal.tsx       QR, importe, referencia y declaración manual
  history.tsx              Historial y separación de efectivo/transferencia/tarjeta
public/demo-qr/             Dos PNG fijos de demostración
tests/transfers.spec.ts     Pruebas de interacción y persistencia
tests/fixtures/             QR de prueba en JPG y WebP
```

Integraciones: `src/App.tsx` envuelve la aplicación con el proveedor; `pos.tsx` prepara y guarda ventas simuladas; `modules.tsx` incorpora administración e historial; `layout.tsx` refleja el perfil de demostración; `ui/dialog.tsx` admite referencia opcional para devolver el foco al control original. Los estilos nuevos están acotados a clases del módulo en `src/index.css` y utilizan los tokens existentes, incluido modo oscuro.

## Modelo PostgreSQL propuesto para la conexión futura

Estas son ampliaciones de diseño, **no migraciones aplicadas ni un backend operativo**. Antes de generar SQL definitivo deben integrarse con `confirm_sale`, `record_credit_receipt` y las restricciones del libro de caja existentes.

| Objeto                     | Diseño                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pos.transfer_methods`     | `id uuid`, `payment_method_id` único/FK, `name`, `institution`, `holder`, `active`, `revision`, `updated_at`, `updated_by → profiles`                                                 |
| `pos.transfer_qr_versions` | `id uuid`, `transfer_method_id` FK, `revision`, `storage_path`, hash, MIME/tamaño validado, entidad/titular históricos, `created_by`, `created_at`; único método/revisión e inmutable |
| `pos.payments`             | Añadir FK a versión de QR, referencia, `confirmed_by`, `confirmed_at` y tipo de declaración manual; importe existente `numeric(18,2)`                                                 |
| `pos.credit_receipts`      | Si se aceptan transferencias con QR para abonos, conservar las mismas referencias a versión y confirmación, integradas en su transacción actual                                       |
| Auditoría                  | Cambios de métodos e imágenes, activación/desactivación y responsable de confirmación; sin guardar secretos ni imágenes en JSON de auditoría                                          |

Cada método bancario se relaciona con un método de pago cuyo `affects_cash=false`. Su importe cuenta como cobro registrado por transferencia en reportes, pero nunca genera una entrada en el libro de efectivo físico. No se debe seguir aceptando el método genérico de transferencia por una ruta alternativa sin los datos de confirmación una vez que se active este contrato.

La función de venta futura debe, en una sola transacción, comprobar perfil activo, caja abierta, productos/precios, suma de pagos, método de transferencia activo y revisión esperada; registrar pagos, venta, stock y auditoría. La fecha y el usuario provienen del servidor y del JWT verificado, no del objeto `confirmedBy` de este mock. La referencia se conserva como dato de trazabilidad, no como prueba automática de pago.

Los importes de `ConfirmSaleRequest` se enviarán como cadenas decimales; los precios y totales serán recalculados por PostgreSQL. La UI usa centavos enteros y no redondea importes mixtos con `parseFloat`. La idempotencia de producción debe mantenerse en PostgreSQL, no depender de la protección local contra doble clic.

## Storage y API futura en Cloudflare Workers

- Bucket privado de Supabase Storage para imágenes; PostgreSQL guarda únicamente rutas y versiones. Servirlas mediante acceso autorizado o URLs firmadas de corta duración. Configurar MIME y tamaño en el bucket y repetir validación de bytes, decodificación y límites de recursos en el servidor. [Documentación oficial de buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals).
- Solo administrador autenticado puede solicitar una carga o cambiar metadatos/estado. El Worker obtiene el rol desde la fuente autorizada; nunca acepta el selector de rol ni el actor enviados por React como credenciales.
- Cargar a una ruta nueva generada por el servidor, en cuarentena. Validar/normalizar y publicar la nueva versión mediante una operación autorizada; no sobrescribir un objeto usado por pagos históricos. Limpiar cargas fallidas sin borrar objetos referenciados.
- `GET /api/v1/payment-methods/transfers`: métodos activos para POS, versiones y lectura autorizada de QR; administración puede incluir inactivos.
- `POST /api/v1/payment-methods/transfers/uploads`: administrador, ticket y ruta de carga autorizada con MIME/tamaño esperado.
- `POST /api/v1/payment-methods/transfers`: registrar método usando un ticket propio ya validado.
- `PATCH /api/v1/payment-methods/transfers/:id`: nueva imagen, metadatos o estado con revisión esperada, validación y auditoría.
- `POST /api/v1/sales`: pagos mixtos con `transferMethodId`, `expectedRevision`, `reference` y declaración `manuallyVerified`; actor/fecha se resuelven en servidor. Rechazar versión obsoleta, referencia vacía, método inactivo o suma incorrecta.
- Consultas de historial y reportes devuelven snapshots históricos y separan efectivo, tarjeta, transferencias y financiación. No inferir un pago por descargar una imagen.

No hay llamadas bancarias, scraping, códigos QR dinámicos, validación automática de referencias, credenciales privadas o endpoints reales en esta entrega.

## Ejecutar y verificar

```powershell
npm run dev
npm run build
npm run lint
npm run test:e2e -- --workers=1 --max-failures=1
# Solo el módulo de transferencias:
npm run test:e2e -- tests/transfers.spec.ts --workers=1
# La cartera SQL tiene una suite separada, no modificada por esta interfaz:
npm run check:credit
npm run test:credit
```

Las pruebas cubren modal automático, QR/importe, selección/ampliación, referencia insuficiente sin declaración, cancelación, cambios de carrito, pagos mixtos con centavos, subida de PNG/JPG/WebP, reemplazo y recarga, archivos falsos/SVG/grandes, perfiles de solo lectura, métodos desactivados, móvil, actualización entre pestañas y doble clic. No validan conciliación bancaria, Supabase Auth ni pagos reales.

Validación realizada: **21 pruebas Playwright aprobadas (13 nuevas y 8 de regresión)**, compilación TypeScript/Vite y Oxlint correctos. Se revisaron las capturas del modal de escritorio/móvil; sus controles no desbordan horizontalmente y el foco regresa al selector de pago al cancelar. No se alteraron las migraciones de créditos ni se ejecutó SQL remoto.
