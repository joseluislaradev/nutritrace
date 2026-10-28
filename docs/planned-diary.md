# Diario planificado y navegación semanal

Esta ampliación reutiliza SQLite, `PlanningService.execute`, sus contratos Zod,
transacciones, revisiones e idempotencia. No modifica el menú real al instalarla.
Planificar sigue siendo distinto de registrar consumo.

## Experiencia

- **Diario** consulta automáticamente el único plan activo vigente para la fecha.
  Si coinciden varios, pide elegir; no suma varios planes por accidente.
- Cada comida tiene hora, nombre, energía/proteína estimadas y estado pendiente,
  registrada, modificada u omitida. Registrar genera snapshots reales del diario.
  Ajustar permite cambiar cantidades por ingrediente, omitir ingredientes o
  sustituir por otra comida/alimento del catálogo sin editar recetas/plantillas.
- Omitir no añade alimentos ni calorías. Una omisión puede registrarse después,
  con una nueva lectura y revisión. Los consumos ya registrados se editan con
  el editor habitual del diario; nunca se vuelven a insertar con este flujo.
- Los totales planificados y los consumidos se muestran separados. Agua, notas,
  mediciones, métricas y registros ajenos al menú conservan sus flujos actuales.
- Los ingredientes guardados usan la misma convención que Diary:
  `nutrition` por `portion`, multiplicada por `quantity`. El preview muestra la
  cantidad efectiva de cada ingrediente con cantidad de porciones igual a uno,
  para poder cambiar cuatro tortillas por tres directamente. El rendimiento de una
  receta se aplica a las cantidades de ingredientes, sin alterar el catálogo.
- Si un consumo cambia o desaparece desde el diario, la consulta refleja el
  estado modificado. Si después se retira la comida del plan, el vínculo
  histórico sigue disponible. Cambiar una plantilla no reescribe lo consumido.
- **Mi semana** muestra siete días plegados, aportación semanal y diaria, horarios,
  ingredientes al expandir y cambios puntuales en un panel. Las flechas avanzan
  semanas completas, de lunes a domingo, incluso entre meses/años.
- **Compras** abre la lista correspondiente al plan y semana, con categorías,
  casillas, productos pendientes y cubiertos. Compras parciales y ajustes se
  abren en cada producto. Copiar, compartir y exportar reutilizan el servicio.
  Regenerar conserva compras y ajustes; las diferencias se consultan aparte.
- **Editar plan** presenta un día a la vez. Vigencia, repetir comidas en otros
  días, inventario/presentaciones, advertencias e historial se mantienen en
  controles secundarios. Las recetas siguen editándose en la biblioteca.

## Datos, concurrencia y reintentos

No se añaden tablas ni se reescriben datos históricos. `planning_documents`
alberga documentos internos de tipo `diary_plan`, uno por ocurrencia. Su ID es
SHA-256 de `[template_id, date, slot_id]`, independiente de la revisión del plan.
Cada documento conserva selección, preview, IDs de entradas reales, huella del
consumo y revisión leída del menú. Sus versiones se guardan en `entity_versions`
con canal y motivo pendiente si no hubo explicación. Los respaldos completos
ya incluyen ambas tablas y `planning_requests`.

Cada entrada real lleva `planned_meal` con la ocurrencia, fecha, plantilla, slot,
revisión de plantilla, excepción y huella del plan. Los filtros de persistencia
web, SQLite nativo y migración de snapshots conservan este campo. La lista de
UUIDs en el documento también permite detectar modificaciones de clientes que
no transportan el campo nuevo.

El registro exige simultáneamente:

1. Revisión del estado de la ocurrencia (`expected_revision`).
2. Huella de la planificación consultada (`expected_plan_revision`), que incluye
   la revisión de plantilla, excepción, selección y snapshot del catálogo.
3. Huella de todos los alimentos del día (`expected_items_revision`), la misma
   función que protege las correcciones MCP del diario.

La comparación, escritura del diario, estado, historial y respuesta idempotente
se ejecutan en la transacción inmediata del servicio. Un conflicto responde
HTTP 409: releer y revisar la intención, nunca sustituir revisiones a ciegas.
Un día eliminado no se resucita. Los alimentos existentes, agua y notas se
conservan mediante `mutateDiaryDay`; las correcciones existentes mantienen
UUIDs/tombstones. También se admite el modo sin gestión de usuarios, respetando
la fila anónima existente.

La misma `idempotency_key` y argumentos devuelven la respuesta original. Si se
pierde la respuesta y se recarga la página, el estado persistido impide añadir
la misma comida con otra clave. Los clientes no deben llamar `log_meal` o
`log_food` para repetir una ocurrencia ya registrada: esos append tradicionales
siguen sin ser idempotentes y no deducen vínculos por semejanza de nombres.

## REST y MCP

Se conservan las 41 herramientas previas y se añaden dos, disponibles por los
mismos endpoints `POST /api/planning/:command` y por MCP:

### `get_diary_plan` — `mcp:read`

```json
{"date":"2026-10-27"}
```

`template_id` es opcional para elegir un plan específico. La respuesta contiene
`template`, `templates`, `needs_selection`, `slots`, `items_revision`,
`planned_totals`, `consumed_totals` y `day_deleted`.
Cada slot incluye `preview.items`, `preview.nutrition`, `plan_revision`,
`state_revision`, `entry_ids`, `status` y avisos sobre registros históricos o
catálogo no disponible. Nutrientes no informados se muestran como desconocidos.

### `record_planned_meal` — `mcp:write`, `MCP_WRITE_ENABLED=1`

Después de leer, pasar los valores devueltos, sin inventar revisiones:

```js
{
  date: view.date,
  template_id: slot.template_id,
  slot_id: slot.slot_id,
  action: 'consume', // 'skip' omite sin consumo
  meal: 2,          // índice del grupo real del diario, no índice del plan
  expected_revision: slot.state_revision,
  expected_plan_revision: slot.plan_revision,
  expected_items_revision: view.items_revision,
  idempotency_key: crypto.randomUUID()
}
```

Opcionalmente `adjustments: [{index: 0, portion: 3, quantity: 1}]` ajusta el
ingrediente del preview. `omit:true` lo retira del consumo; no elimina nada del
catálogo. Todas las cantidades usadas deben ser positivas. `replacement:
{type:'food', id:123, servings:1}` o `type:'meal'` sustituye el consumo por un
snapshot propio del catálogo. La interfaz indica que la sustitución usa una
porción; MCP permite especificarla. No enviar nutrientes arbitrarios.

La respuesta incluye el documento de estado y la vista actualizada. Las dos
herramientas usan las mismas validaciones y permisos que sus endpoints; no
necesitan scopes nuevos. `get_entity_versions` y `compare_entity_versions`
admiten `kind:'diary_plan'` con `id:slot.occurrence_id`. Estos estados no están
expuestos a los comandos genéricos de borrado/restauración, para preservar la
protección contra registros duplicados.

Las correcciones posteriores usan `edit_diary_entry` / `delete_diary_entry` con
UUID y revisión actual del diario, o los editores manuales existentes.

## Despliegue y conexión

Hace falta desplegar el código y frontend juntos. No hay migración destructiva,
importación de menús ni cambio de almacenamiento. Respaldar por el procedimiento
habitual antes de desplegar. La configuración OAuth existente se conserva.
Después, refrescar el catálogo de la conexión privada NutriTrace, confirmar que
aparecen las dos herramientas y abrir un chat nuevo si la conversación conserva
el catálogo antiguo. El consentimiento solo cambia si faltan scopes ya usados.

Verificación real pendiente de realizar en la cuenta desplegada:

1. Comparar una fecha y su menú en PWA y `get_diary_plan`.
2. Registrar una ocurrencia de prueba acordada desde la interfaz y consultar
   sus UUIDs/estado desde MCP. Repetir/recargar no debe duplicar.
3. Omitir o registrar una segunda ocurrencia de prueba desde MCP y consultar
   el resultado en Diario. Editar allí una cantidad y comprobar `modified`.
4. Comprobar que el plan y receta originales siguen iguales; retirar solo los
   registros de prueba acordados usando las correcciones normales.
5. Comparar compras parciales/ajustes después de regenerar en ambas superficies.

Las pruebas locales no demuestran que la conexión ChatGPT de producción tenga
el catálogo actualizado. No se usan datos personales para las pruebas locales.

## Pruebas reproducibles

Node 20 (la versión del contenedor) y dependencias instaladas:

```sh
node --experimental-global-webcrypto --test scripts/planned-diary.test.js scripts/planning-view.test.js scripts/planning-http.test.js scripts/planning.test.js scripts/planning-backup.test.js scripts/planning-restart.test.js scripts/mcp-discovery.test.js scripts/planning-client.test.js
npm run build
```

La prueba opcional `scripts/planning-browser.mjs` usa Chromium/Playwright, el
frontend compilado, los routers reales y una base SQLite temporal independiente.
Se ejecuta aparte, sin añadir Playwright a las dependencias de producción:

```sh
PLAYWRIGHT_MODULE=/ruta/a/playwright/index.mjs \
SCREENSHOT_DIR=/tmp/nutritrace-capturas node scripts/planning-browser.mjs
```

Necesita `npm run build` previo, Chromium instalado por Playwright y permiso
para abrir un servidor HTTP local. Crea y retira un enlace `server/dist` solo si
no existía. Cierra servidor/navegador y elimina su base temporal al terminar.
Verifica fechas, compras parciales, ajustes, regeneración, registro, recarga,
edición y ausencia de desbordamiento en móvil; guarda capturas para inspección.

Limitación deliberada: consultar/registrar planificación requiere conexión al
servidor. En Android conectado se sincroniza el diario tras el registro. El modo
local independiente y las escrituras planificadas sin conexión no se añaden en
esta ampliación.

## Resultado de la verificación local (27 de octubre de 2026)

- Suite general: **982 pruebas aprobadas, 0 fallidas**.
- Regresión final de MCP, planificación, persistencia, portapapeles y conexión
  SQLite inyectada: **185 aprobadas, 0 fallidas**. Se solapa con la suite general
  e incluye una comprobación adicional de aislamiento de conexión.
- Compilación de producción completada. Persisten avisos existentes de
  accesibilidad en otras pantallas y de tamaño de bundles.
- Chromium real, servidor local con los routers de producción y SQLite
  temporal: 17 flujos verificados en 390×844 y 1440×1000, sin errores JavaScript.
  Incluye guardar desde el editor habitual de Diary y recargar conservando la
  cantidad y el vínculo; se inspeccionaron las capturas resultantes.
- Se corrigió además un defecto del contrato de compras: una actualización de
  cantidad o checkbox ya no aplica implícitamente la categoría por defecto
  «otros». La categoría solo cambia cuando se pide en el patch.

Las capturas de esta sesión están en `/tmp/nutritrace-diary-screens/`, incluyendo
`week-desktop.png`, `week-mobile.png`, `shopping-desktop.png`,
`shopping-mobile.png`, `diary-desktop.png`, `diary-mobile.png`,
`editor-desktop.png`, `editor-mobile.png`, `empty-mobile.png` y
`edit-consumption-desktop.png`. El script permite regenerarlas con
`SCREENSHOT_DIR`. Son datos sintéticos, no el menú ni consumos del propietario.

No se ha verificado esta ampliación contra Railway ni con la conexión ChatGPT
real. No se han importado planes, modificado datos reales ni realizado un
despliegue como parte de esta tarea.
