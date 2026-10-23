# CAI Market · Panel administrativo

La interfaz de transferencias con QR fijos y su historial local de prueba se documentan en [docs/transferencias](docs/transferencias/README.md).

La ampliación de arquitectura y migraciones de **Créditos y cuentas por cobrar** está en [docs/creditos](docs/creditos/README.md). Incluye SQL propuesto y pruebas locales aisladas (`npm run test:credit`, `npm run check:credit`); no se aplicó a Supabase ni se conectó a la interfaz. El transporte de WhatsApp es únicamente mock.

Primera versión visual del sistema de gestión de una tienda física. Interfaz en español, responsive, con tema claro y oscuro. **Todos los registros, indicadores y comparaciones son ficticios.** No tiene backend conectado, autenticación real ni pagos bancarios; IndexedDB conserva únicamente la configuración y el historial de demostración del navegador.

## Ejecutar

Requiere una versión de Node.js compatible con Vite 8 y npm.

```sh
npm ci
npm run dev
```

Abrir la URL que indica Vite. La navegación utiliza rutas hash (`/#/inventario`), por lo que admite enlaces directos y los botones atrás/adelante del navegador sin configurar un servidor de rutas.

```sh
npm run build       # TypeScript y compilación de producción
npm run lint        # Oxlint
npx playwright install chromium
npm run test:e2e    # Pruebas de interfaz con Chromium
npm run preview    # Vista previa del build
```

## Alcance de la interfaz

| Módulo         | Comportamiento de esta versión                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard      | Indicadores de hoy/ayer, gráficas con tooltips y cambio semana/mes, ventas de ejemplo, detalle en diálogo y alertas de stock.                                          |
| Punto de venta | Carrito temporal, QR fijos configurables, confirmación manual de transferencia y pagos mixtos. Guarda ventas/pagos solo en el historial local de demostración; no cobra ni descuenta existencias. |
| Inventario     | Ocho productos de muestra, búsqueda por nombre/código, categorías y filtro de stock bajo. Solo consulta.                                                               |
| Estadísticas   | Series y distribución de categorías ficticias. Los totales y el crecimiento de la gráfica se calculan desde sus series.                                                |
| Contabilidad   | Resumen ilustrativo, filtro de las cinco ventas de muestra e historial separado de pagos locales, con efectivo, transferencias y tarjeta diferenciados. No es un libro contable. |
| Clientes       | Directorio ficticio con búsqueda local.                                                                                                                                |
| Proveedores    | Directorio ficticio con búsqueda local.                                                                                                                                |
| Configuración  | Formulario general con validación sin guardar, tema, selector de roles demo y administración local de QR con PNG/JPG/WebP, vista previa, cambios y activación. |

La búsqueda superior localiza módulos; `Ctrl+K` o `Cmd+K` enfoca el buscador en escritorio. El menú móvil se cierra al navegar o al pulsar Escape. Las notificaciones, el perfil y la ayuda muestran información de demostración. Los diálogos administran el foco y admiten Escape mediante Radix UI.

La exportación genera **un CSV con las cinco ventas ficticias del 23 de octubre de 2026**, independientemente del período elegido para los indicadores. El diálogo indica expresamente ese alcance. No exporta operaciones reales ni un reporte contable.

## Arquitectura y archivos

```text
src/
  App.tsx                   Rutas hash, carga de vistas y tema
  index.css                 Tailwind, tokens, componentes y responsive
  components/
    layout.tsx              Sidebar, barra superior y búsqueda global
    common.tsx              Panel, indicadores, badges y encabezados
    charts.tsx              Gráficas de Recharts
    sales-table.tsx         Tabla reutilizable y detalle de venta
    ui/button.tsx           Patrón Button de shadcn/ui
    ui/dialog.tsx           Composición Dialog de shadcn/ui con Radix
  data/
    mock.ts                 Datos ficticios tipados
    navigation.ts           Definición central de los ocho módulos
  features/
    dashboard.tsx           Dashboard y exportación de ejemplo
    inventory.tsx           Consulta y filtros de inventario
    pos.tsx                 Carrito de demostración
    modules.tsx             Estadísticas, contabilidad, directorios y ajustes
  lib/utils.ts              Clases y formato monetario COP
tests/admin.spec.ts         Recorridos de interfaz
playwright.config.ts        Chromium y servidor local para pruebas
```

Se sustituyó la pantalla inicial de Vite y se eliminó `src/App.css`. Se actualizaron `index.html` (idioma y título), `vite.config.ts` (Tailwind y alias), `tsconfig.app.json` (alias), `package.json`/`package-lock.json` (dependencias y pruebas), `.gitignore` y este documento. `components.json` configura shadcn/ui y `.prettierrc.json` define el formato del código. Las vistas se cargan bajo demanda.

Tecnologías: React, TypeScript, Vite, Tailwind CSS, componentes locales basados en los patrones de shadcn/ui, Radix Dialog/Slot, Lucide React y Recharts. Integración de Tailwind conforme a su [documentación de Vite](https://tailwindcss.com/docs/installation/using-vite); componentes de referencia en [shadcn/ui](https://ui.shadcn.com/docs/components).

## Datos y persistencia

- Datos de demostración centralizados en `src/data/mock.ts`; correos bajo `example.com`.
- Carrito, filtros y formulario general viven en memoria y se descartan al salir del módulo o recargar.
- Los QR, sus metadatos, cambios y ventas/pagos locales de demostración se guardan en IndexedDB. El rol de demostración se guarda en `sessionStorage`; no representa autenticación real.
- Únicamente el tema se guarda en `localStorage`, bajo `cai-market:theme:v1`. La interfaz tolera el bloqueo del almacenamiento.
- El dashboard conserva fechas fijas de demostración: 23 de octubre de 2026 y su día anterior. El historial local de pagos registra el reloj del navegador, sin representar una conexión a operaciones en vivo.
- Las cinco filas de ventas son una muestra; no representan el total diario de 68 transacciones ficticias indicado en el dashboard.
- No se solicitan contraseñas ni tokens. Usar únicamente datos de prueba al cargar QR o referencias en este prototipo.

## Pruebas y revisión

La suite visual conserva las ocho pruebas originales de navegación, inventario, carrito, reportes, formularios, temas y responsive, y añade trece pruebas de transferencias: modal, QR/importe, referencia y declaración manual, cancelación, pagos mixtos, cargas/reemplazos, persistencia, permisos demo, desactivación, cambios entre pestañas, doble clic y móvil. Las capturas quedan en `test-results/`, excluido del control de versiones. Ejecutar con `--workers=1` en equipos con memoria limitada.

## Pendiente

Cloudflare Workers/TypeScript y Supabase PostgreSQL/Auth/Storage; autorización real por roles; almacenamiento compartido de QR; movimientos de inventario; conexión de créditos; transacciones y pagos reales; facturación; gastos, impuestos, cierres y conciliación; métricas desde operaciones reales. La demostración actual no verifica estos procesos. La suite utiliza Chromium; otros navegadores y dispositivos físicos requieren una validación posterior.
