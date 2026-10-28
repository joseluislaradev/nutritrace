# Fase 1: planificación recurrente y compras

Estado: implementación local; pendiente de despliegue y verificación en la cuenta
real de ChatGPT.

Implementación integrada en NutriTrace. No crea otra base de datos ni modifica
Gym Log. Los ejemplos de pruebas son sintéticos: no se migró el nuevo plan
alimenticio ni se documentaron decisiones científicas del propietario.

## Interfaz y arquitectura

Abrir **Planificación y compras** desde el carrito en Biblioteca o desde el
menú lateral. La pantalla `/planning` permite:

- Crear y editar plantillas semanales que se repiten sin generar semanas.
- Elegir fechas de vigencia, zona horaria, estado y tipo de día.
- Repetir una comida en días seleccionados, ajustar porciones y horarios.
- Sustituir, añadir o retirar una comida de una fecha, o dejar ese día vacío.
- Consultar aportes estimados y metas guardadas.
- Generar listas de compras por fechas, consultar las guardadas y regenerarlas.
- Administrar inventario, categorías, presentaciones y precios por presentación.
- Añadir artículos manuales, ajustar cantidades y registrar compras parciales.
- Compartir texto o descargar TXT, CSV y JSON sin publicar enlaces de acceso.
- Consultar, comparar y restaurar versiones, incluidos registros retirados.

Los editores originales siguen administrando comidas, recetas e ingredientes.
El selector **Estado para compras** distingue crudo/cocido/sin especificar; no
cambia por sí mismo la composición nutricional del alimento elegido.

La pantalla de planificación requiere conexión al servidor. No confirma guardados
offline ni implementa un segundo planificador en el SQLite independiente de
Android. En Android conectado utiliza IDs del catálogo **del servidor**,
no IDs locales. La edición offline preexistente de recetas mantiene su cola;
los conflictos devuelven error en lugar de reemplazar silenciosamente cambios.

```
Pantalla /planning → POST /api/planning/:command ─┐
                                               ├→ PlanningService → SQLite actual
MCP → autenticación/scopes → mismo comando ──────┘
Editores de recetas / sync → prepareMeal + revisiones + captura de versiones
```

`planning-contracts.js` define los argumentos compartidos. `planning-service.js`
resuelve recurrencia, calcula ingredientes y aplica cambios. La interfaz y MCP
utilizan los mismos comandos. Los resultados de listas se envuelven en
`{items:[...]}` en MCP porque `structuredContent` debe ser un objeto.

## Almacenamiento y migración

La migración de `planning-storage.js` corre en una transacción al abrir la base:

Las funciones SQLite del historial se registran en cada conexión antes de las
migraciones de arranque. Los triggers persisten en el archivo de base de datos;
las funciones no. Registrarlas tarde provoca `no such function:
nt_history_enabled` al reiniciar una instalación que ya tiene esos triggers.
La corrección solo cambia el orden de registro: no requiere borrar el volumen,
eliminar triggers ni reconstruir los datos. La prueba `planning-restart.test.js`
abre la misma base en procesos sucesivos y comprueba datos, revisiones e historial.

| Tabla/cambio | Uso |
|---|---|
| `planning_documents` | Plantillas, excepciones, inventario y listas; JSON y revisión por documento |
| `entity_versions` | Snapshots inmutables, canal, fecha y motivo opcional |
| `planning_requests` | Respuestas de escrituras idempotentes, aisladas por usuario |
| `foods.revision`, `meals.revision` | Revisión numérica de contenido del catálogo |

No cambia los IDs, ingredientes, nutrientes, consumos ni marcas de sincronización
de los registros anteriores. El estado encontrado se registra como `baseline`,
con motivo pendiente y fecha de captura; no se atribuye una historia anterior.

Triggers de SQLite registran cambios de alimentos y comidas/recetas aunque los
escriba la interfaz, MCP, la sincronización o una importación. Los contadores de
uso y las marcas de transporte no crean versiones de contenido. El historial
incluye el estado anterior conservado y el nuevo estado; se pueden consultar
sus diferencias. El motivo no es obligatorio. Los canales explícitos son
`manual`, `mcp` y `sync`; otros escritores anteriores quedan como
`manual_or_sync`, sin atribuirles un actor que no se conoce.

Los cambios de metas y el resto de entidades existentes todavía requieren la
ampliación de auditoría de las fases siguientes. Esta fase no presenta ese
trabajo como terminado.

Los respaldos completos ZIP incluyen documentos, versiones, revisiones del
catálogo y respuestas idempotentes. Su restauración conserva las revisiones y
no produce eventos falsos de edición. Un respaldo antiguo recibe solo una
línea base. La exportación JSON antigua de Biblioteca no equivale a un respaldo
completo del servidor; usar el ZIP completo para recuperar también planificación
e historial. La exportación JSON de una lista conserva su detalle de cálculo.

Los triggers de contenido utilizan funciones registradas por la conexión de la
aplicación. Herramientas externas que escriban directamente en SQLite deben
registrar esas funciones o utilizar los servicios de NutriTrace.

## Recurrencia y excepciones

Cada plantilla tiene siete días: índice 0 lunes, índice 6 domingo. Las fechas
son fechas de calendario explícitas; la zona horaria se conserva en la plantilla.
No se crea ningún registro en `diary` al planificar, resolver o generar compras.
Los estados propuesta/aprobada/activa/archivada describen la plantilla; todas se
pueden previsualizar seleccionándolas explícitamente.

Cada comida tiene `slot_id` estable y una referencia separada `type` + `id` al
alimento o comida/receta. `servings` indica cuántas porciones del catálogo se
prepararán. Una excepción pertenece a una plantilla y una fecha. Su arreglo
`slots` reemplaza solo los `slot_id` indicados; `replacement:null` los retira.
Una sustitución también puede añadir una comida usando un `slot_id` nuevo.
`skip:true` deja el día vacío. Hay una sola excepción por plantilla/fecha.
Eliminarla recupera la semana recurrente. Resolver un rango admite hasta 93 días.

## Cálculos de recetas y compras

En una receta, `items` describe la tanda completa, `servings` su rendimiento en
porciones y `portion` el tamaño de cada porción. Nutrición se guarda por porción.
Una comida guardada sin `is_recipe` representa una porción de su conjunto de
ingredientes. La expansión de compras divide los ingredientes por el rendimiento
y multiplica por las porciones planificadas. Las recetas anidadas se expanden
con detección de ciclos y límite de profundidad.

Los ingredientes MCP usan `food_id` o `meal_id`, `portion`, `unit`, `quantity`
y `state` opcional. El servicio calcula sus nutrientes desde el catálogo.
Los snapshots históricos conservan la composición utilizada. Las restauraciones
recuperan esa composición, aunque el alimento actual haya cambiado. Los
ingredientes importados o compartidos antiguos pueden conservar sus snapshots;
si su identidad de compra no es verificable, se informa como pendiente de
resolver y no se une con un producto distinto por coincidencia de nombre.

Para compras:

- Se agrupa por identidad del alimento, estado y unidad compatible, no por nombre.
- Masa se normaliza a gramos y volumen a mililitros. Las conversiones de medidas
  estadounidenses usan su definición estadounidense. Unidades opacas solo se
  combinan con la misma unidad, salvo equivalencias explícitas `alt_units` del
  alimento (por ejemplo, una rebanada de 35 g), que se reutilizan del catálogo.
- No se supone que 1 ml equivale a 1 g. Cruzar masa y volumen requiere
  `density_g_ml` explícita en la configuración de compras o ya guardada en el catálogo.
- `cooked_yield` significa **peso cocido / peso crudo**. Sin ese dato, se conservan
  cantidades cocidas separadas y se muestra una advertencia. No se inventan mermas.
- El inventario se descuenta una vez de la necesidad agregada cuando sus unidades
  y estado son compatibles. No se consume ni reserva inventario automáticamente.
- `state` del inventario también describe el producto de su presentación de compra.
- Los tamaños de presentación se convierten y redondean hacia arriba. Sin una
  conversión válida se conserva la cantidad necesaria sin inventar paquetes.
- Los precios son por presentación; el presupuesto pendiente se agrupa por moneda.
  Es parcial cuando faltan precios o tamaños. No se convierten monedas.
- Los nutrientes ausentes no son ceros. Se señalan composiciones incompletas al
  compararlas con metas. Los objetivos dinámicos no resueltos se identifican,
  sin inventar una necesidad calórica efectiva.

Una lista guarda el menú resuelto, las revisiones de recetas/alimentos e
inventario utilizadas, advertencias, diferencias y fecha de generación.

## Regeneración y compras parciales

`override_quantity` sustituye la cantidad total que se quiere comprar **después**
de descontar inventario y **antes** de descontar lo comprado. `null` vuelve al
cálculo automático. `purchased_quantity` se guarda en la unidad de la fila.

```
needed = override_quantity ?? max(required - stock, 0)
to_buy = max(needed - purchased_quantity, 0)
```

`purchased:true` marca la necesidad actual como comprada. Si el menú requiere
más después, la cantidad comprada se conserva y se muestra solo lo adicional.
Los artículos manuales, ajustes de nombre/categoría y cantidades compradas no
se borran al regenerar. Una fila que desaparece del menú se conserva si tiene
compras o un ajuste manual, con `removed_from_menu:true`. La diferencia expone
necesidad anterior/nueva y cantidad pendiente anterior/nueva.
`source_changes` identifica las recetas y alimentos cuya revisión cambió,
incluso cuando las cantidades de compra resultantes son iguales.

Cambios que hagan incompatibles las unidades o el estado de una identidad no
fusionan compras antiguas a ciegas: se mantienen las filas anteriores ajustadas
y se deben revisar las advertencias y diferencias antes de comprar.

## Contratos REST y MCP

REST usa `POST /api/planning/<nombre_tool>` con la sesión y protección CSRF
existentes. Se utiliza POST también en las consultas para transmitir contratos
estructurados; las consultas no escriben datos. MCP mantiene OAuth/PAT y los
flags actuales.

| Permiso | Herramientas |
|---|---|
| `mcp:read` | `get_planning_catalog`, `list_planning_templates`, `list_planning_documents`, `get_planning_document`, `resolve_planned_menu`, `get_planned_nutrition`, `list_pantry`, `list_shopping_lists`, `export_shopping_list`, `get_entity_versions`, `compare_entity_versions` |
| `mcp:write` y escritura habilitada | `save_planning_template`, `save_planning_exception`, `save_pantry_item`, `generate_shopping_list`, `update_shopping_item`, `add_shopping_item`, `save_catalog_meal` |
| `mcp:destroy` y administración habilitada | `delete_planning_document`, `restore_planning_version`, `restore_catalog_meal`, `delete_catalog_meal` |

Las últimas cuatro requieren además `confirm:true`. El consentimiento y los
controles del cliente siguen aplicándose. Descubrir una herramienta no concede
permiso para ejecutarla. No se añaden scopes de Auth0.

Toda escritura nueva exige:

```json
{
  "expected_revision": 1,
  "idempotency_key": "una-clave-nueva-por-cambio-logico"
}
```

Usar `expected_revision:0` para crear documentos. Leer la revisión devuelta
antes de editarlos. En el catálogo, una comida recién creada empieza en revisión
0; las actualizaciones de contenido la incrementan. `get_meal_details` devuelve
la revisión y las referencias de ingredientes necesarias para editarla.

`reason` es opcional. Repetir exactamente la misma clave y argumentos devuelve
la respuesta original sin otro cambio ni otra versión. Reutilizar la clave con
otros argumentos falla. Ante `VERSION_CONFLICT`, releer y resolver la intención;
no actualizar automáticamente la precondición y reintentar el mismo cambio.
Las escrituras de planificación y sus eventos se guardan en una transacción
SQLite `IMMEDIATE`. La versión leída por el cliente es la precondición.
La pantalla conserva en memoria la clave de una escritura con respuesta incierta
para un reintento explícito del mismo formulario. No repite escrituras por su
cuenta. Si se cerró la pantalla tras una respuesta perdida, consultar los
registros guardados antes de volver a crear uno.

Los PUT y DELETE originales de recetas utilizan `revision`/`expected_revision`.
Clientes anteriores sin revisión solo pueden trabajar sobre revisión 0. Una
receta que ya cambió exige actualizar el cliente/releer. La sincronización
comprueba la revisión y devuelve 409 sin confirmar ni descartar el lote local
cuando detecta una edición competidora. En el cliente nativo, las ediciones de
recetas se envían exclusivamente por la cola de sincronización, evitando la
carrera entre un PUT directo y un push del mismo cambio.

Los registros antiguos `log_food`, `log_meal` y `log_water` conservan su contrato
append anterior; no atribuirles la idempotencia de estas herramientas nuevas.

### Flujo de uso desde ChatGPT

1. Consultar `get_planning_catalog` (paginado) y `list_planning_templates`.
2. Leer la plantilla y sus restricciones antes de proponer cambios.
3. Crear/editar `save_planning_template`; cada día contiene, por ejemplo:

   ```json
   {"day_type":"training","slots":[{"slot_id":"cena","time":"20:00","label":"Cena","type":"meal","id":42,"servings":2}]}
   ```

   El ID 42 es ilustrativo: sustituirlo por uno consultado del catálogo.

4. Para una cena distinta, guardar una excepción de esa fecha conservando los
   demás slots. Leer una excepción existente antes de modificarla.
5. Consultar `resolve_planned_menu` con `template_id`, `from` y `to` explícitos.
6. Consultar/configurar `list_pantry` y `save_pantry_item` con datos conocidos.
7. Ejecutar `generate_shopping_list` con nombre, plantilla, rango y metadatos de
   creación. Para regenerar pasar el mismo `id` y su revisión actual.
8. Revisar advertencias y diferencias; actualizar compras/ajustes por la `key`
   estable de cada artículo. Consultar nuevamente el documento para verificar.
9. Compartir usando `export_shopping_list`; no publicar datos automáticamente.

## Despliegue y conexión ChatGPT

Desplegar frontend y servidor juntos sobre el volumen SQLite existente. Antes,
crear un respaldo completo del servidor. La migración es automática al inicio;
no importar una dieta, no crear otra base y no alterar Gym Log Data. Actualizar
también los clientes nativos que deban editar recetas con revisiones.

Después del despliegue, abrir la conexión privada NutriTrace en ChatGPT y
seleccionar **Refresh**; comprobar el nuevo catálogo y abrir una conversación
nueva para repetir las pruebas afectadas. Si el grant no tiene un scope requerido,
completar su consentimiento mediante los controles privados existentes, sin
copiar tokens al chat. La ruta exacta depende de la superficie y permisos de la
cuenta. Este flujo sigue la [documentación oficial de conexión y actualización
de metadata](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).

Verificación real pendiente, con registros de prueba identificables:

1. Crear una plantilla desde la interfaz; leerla desde ChatGPT y comparar revisión.
2. Cambiar una comida por MCP; volver a consultar la interfaz.
3. Guardar desde dos lectores de una versión: el segundo debe recibir conflicto.
4. Generar compras con una receta compartida entre días y una excepción por fecha.
5. Marcar una compra parcial y añadir un artículo manual; modificar la receta y
   regenerar. Comprobar la diferencia y la conservación de compras/ajustes.
6. Exportar y revisar el contenido; comprobar que el diario de consumo no cambió.
7. Comparar versiones y restaurar una anterior creando una revisión nueva.

Una prueba local con el SDK oficial no demuestra que el catálogo instalado en
la cuenta real de ChatGPT se haya actualizado. Registrar separadamente pruebas
locales, despliegue y resultados de esta verificación real.

## Pruebas y límites de fase

Usar Node 20, como el Dockerfile, y un `better-sqlite3` compilado para esa versión:

```sh
node --experimental-global-webcrypto --test scripts/planning.test.js scripts/planning-http.test.js scripts/planning-backup.test.js scripts/planning-client.test.js
node --experimental-global-webcrypto --test scripts/*.test.js
npm run build
```

Las pruebas nuevas usan SQLite temporal, fixtures sintéticas y servidores en
127.0.0.1. Cubren recurrencia, ingredientes repetidos, masa/volumen, densidad,
rendimientos, recetas anidadas, excepciones, inventario, presentaciones, precios,
regeneración, idempotencia, conflictos, aislamiento de cuentas, captura manual,
restauración histórica, migración aditiva y respaldos. El cliente MCP oficial
comprueba cambios en ambos sentidos a través de los routers reales.

Resultado local de esta entrega: suite general con **961 pruebas aprobadas**,
**49 comprobaciones específicas aprobadas**, cuatro pruebas finales del cliente
aprobadas y compilación de producción correcta. Estas cifras corresponden a
ejecuciones separadas y no se suman. Se comprobó conservación mediante fixtures
de datos anteriores y restauración de respaldos, sin migrar producción.
No se ejecutó una prueba visual en un navegador/emulador ni una llamada desde
la conexión real de ChatGPT; ambas verificaciones quedan pendientes.

El modelo completo de decisiones, fuentes científicas, cálculos fundamentados,
restricciones, revisión de evidencia, auditoría de metas y versionado de Gym Log
pertenece a las siguientes fases. No se generaron justificaciones históricas ni
se investigaron las decisiones nutricionales o de entrenamiento actuales.

## Integración con Diario y nueva navegación

La ampliación [Diario planificado](planned-diary.md) organiza las vistas en
Mi semana, Compras y Editar plan, y añade `get_diary_plan` y
`record_planned_meal` sin retirar las herramientas anteriores. Allí se documentan
los vínculos con el consumo real, concurrencia, reintentos y pruebas de navegador.
