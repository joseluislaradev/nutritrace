<script>
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { planningCall as call, mutation } from '../lib/planning-api.js';
  import { NUTRIMENTS } from '../lib/nutrition.js';
  import { localDateStr } from '../lib/db.js';
  const weekdays=['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
  const categories=['carnes','pescados','lácteos','frutas','verduras','cereales','legumbres','grasas','otros'];
  let templates=[],foods=[],meals=[],lists=[],pantry=[],selected='',current=null,shopping=null,menu=null,nutrition=null;
  let busy=false,error='',message='',tab='menu',from=localDateStr(),to=localDateStr(new Date(Date.now()+6*86400000));
  let draft=null,templateDoc=null,newName='',choice='',time='14:00',label='Comida',servings=1,selectedDays=[0];
  let exceptionTime='',exceptionLabel='',exceptionDayType='';
  let exceptionDate=localDateStr(),exceptionDoc=null,exceptionSkip=false,exceptionSlot='',exceptionChoice='',exceptionServings=1;
  let pantryDraft=null,pantryDoc=null,manualName='',manualQuantity=1,manualUnit='piece',manualCategory='otros';
  let historyChoices=[],includeRetired=false;
  let historyKind='template',historyId='',versions=[],left=0,right=0,comparison=null;
  $: catalogue=[...foods.map(f=>({...f,type:'food',key:'food:'+f.id})),...meals.map(m=>({...m,type:'meal',key:'meal:'+m.id}))];
  $: grouped=shopping ? categories.map(category=>({category,items:shopping.payload.items.filter(i=>(categories.includes(i.category)?i.category:'otros')===category)})).filter(g=>g.items.length):[];
  $: exceptionBase=menu?.days.find(d=>d.date===exceptionDate);
  async function work(fn){if(busy)return;busy=true;error='';message='';try{await fn();}catch(e){error=e.message;}finally{busy=false;}}
  async function reload(){[templates,lists,pantry]=await Promise.all([call('list_planning_templates'),call('list_shopping_lists'),call('list_pantry')]);
    const allFoods=[],allMeals=[];for(let offset=0;;offset+=200){const page=await call('get_planning_catalog',{offset,limit:200});allFoods.push(...page.foods);allMeals.push(...page.meals);if(page.foods.length<200&&page.meals.length<200)break;}foods=allFoods;meals=allMeals;}
  onMount(()=>work(reload));
  function newTemplate(){templateDoc=null;draft={name:'',timezone:'America/Mexico_City',starts_on:from,ends_on:null,status:'proposed',days:weekdays.map(()=>({day_type:'rest',slots:[]}))};}
  function editTemplate(doc){templateDoc=doc;draft=structuredClone(doc.payload);}
  async function chooseTemplate(){if(exceptionDoc?.payload.template_id!==selected)exceptionDoc=null;current=templates.find(t=>t.id===selected)||null;menu=null;nutrition=null;if(current){menu=await call('resolve_planned_menu',{template_id:selected,from,to});}}
  function addSlot(){const [type,id]=choice.split(':');if(!id)return;
    for(const index of selectedDays)draft.days[index].slots.push({slot_id:crypto.randomUUID(),type,id:Number(id),servings:Number(servings),time,label});draft={...draft};}
  async function saveTemplate(){const doc=await call('save_planning_template',{...(templateDoc?{id:templateDoc.id}:{}),data:draft,...mutation(templateDoc?.revision)});selected=doc.id;draft=null;await reload();await chooseTemplate();message='Plantilla guardada. Se repetirá cada semana dentro de sus fechas.';}
  async function saveException(){const base=exceptionBase?.slots.find(s=>s.slot_id===exceptionSlot),[type,id]=exceptionChoice.split(':');
    const replacement=id?{slot_id:exceptionSlot||crypto.randomUUID(),type,id:Number(id),servings:Number(exceptionServings),time:exceptionTime||base?.time||time,label:exceptionLabel||base?.label||label}:null;
    const existing=exceptionDoc?.payload.slots||[];
    const slots=exceptionSlot?[...existing.filter(s=>s.slot_id!==exceptionSlot),{slot_id:exceptionSlot,replacement}]:id?[...existing,{slot_id:replacement.slot_id,replacement}]:existing;
    exceptionDoc=await call('save_planning_exception',{...(exceptionDoc?{id:exceptionDoc.id}:{}),data:{template_id:selected,date:exceptionDate,skip:exceptionSkip,slots,...(exceptionDayType?{day_type:exceptionDayType}:{})},...mutation(exceptionDoc?.revision)});
    await chooseTemplate();message='Excepción guardada para esta fecha.';}
  async function loadException(){exceptionDoc=null;exceptionSkip=false;exceptionSlot='';exceptionChoice='';exceptionTime='';exceptionLabel='';exceptionDayType='';
    try{exceptionDoc=await call('get_planning_document',{kind:'exception',id:selected+':'+exceptionDate});exceptionSkip=exceptionDoc.payload.skip;exceptionDayType=exceptionDoc.payload.day_type||'';}catch(e){if(!e.message.includes('not found'))throw e;}}
  async function removeDocument(doc){if(!confirm('¿Retirar este registro? Se conservará su historial.'))return;
    await call('delete_planning_document',{kind:doc.kind,id:doc.id,...mutation(doc.revision),confirm:true});await reload();
    if(doc.kind==='exception'){exceptionDoc=null;await chooseTemplate();}if(doc.kind==='shopping')shopping=null;if(doc.kind==='template'){selected='';current=null;menu=null;}}
  async function generate(regenerate=false){shopping=await call('generate_shopping_list',{...(regenerate?{id:shopping.id}:{}),name:regenerate?shopping.payload.name:(newName||`Compras ${from} — ${to}`),template_id:regenerate?shopping.payload.template_id:selected,
    from:regenerate?shopping.payload.from:from,to:regenerate?shopping.payload.to:to,...mutation(regenerate?shopping.revision:0)});await reload();tab='shopping';}
  async function changeItem(item,patch){shopping=await call('update_shopping_item',{id:shopping.id,patch:{key:item.key,...patch},...mutation(shopping.revision)});}
  function newPantry(food){pantryDoc=pantry.find(p=>p.payload.food_id===food.id)||null;pantryDraft=pantryDoc?structuredClone(pantryDoc.payload):{food_id:food.id,stock:0,unit:food.unit||'g',state:'unspecified',category:'otros',density_g_ml:null,cooked_yield:null,package_size:null,package_unit:food.unit||'g',package_label:'paquete',price:null,currency:'MXN'};}
  async function savePantry(){pantryDoc=await call('save_pantry_item',{data:pantryDraft,...mutation(pantryDoc?.revision)});pantryDraft=null;await reload();message='Inventario y presentación guardados.';}
  async function addManual(){shopping=await call('add_shopping_item',{id:shopping.id,name:manualName,quantity:Number(manualQuantity),unit:manualUnit,category:manualCategory,...mutation(shopping.revision)});manualName='';}
  async function exportList(format,share=false){const r=await call('export_shopping_list',{id:shopping.id,format});
    if(share && navigator.share){await navigator.share({title:shopping.payload.name,text:r.content});return;}
    const url=URL.createObjectURL(new Blob([r.content],{type:format==='json'?'application/json':format==='csv'?'text/csv':'text/plain'}));
    const a=document.createElement('a');a.href=url;a.download=`compras.${format==='text'?'txt':format}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function loadHistoryChoices(){
    if(['meals','foods'].includes(historyKind)){const rows=[];for(let offset=0;;offset+=200){const p=await call('get_planning_catalog',{include_deleted:includeRetired,offset,limit:200});rows.push(...p[historyKind]);if(p[historyKind].length<200)break;}historyChoices=rows;}
    else historyChoices=await call('list_planning_documents',{kind:historyKind,include_deleted:includeRetired});
  }
  async function loadHistory(){versions=await call('get_entity_versions',{kind:historyKind,id:historyId});left=versions.at(-1)?.revision??0;right=versions[0]?.revision??0;comparison=null;}
  async function compare(){comparison=await call('compare_entity_versions',{kind:historyKind,id:historyId,left:Number(left),right:Number(right)});}
  async function restore(v){if(!confirm('¿Restaurar esta versión como una versión nueva?'))return;
    if(historyKind==='meals'){await call('restore_catalog_meal',{id:Number(historyId),revision:v.revision,...mutation(versions[0].revision),confirm:true});}
    else {await call('restore_planning_version',{kind:historyKind,id:historyId,revision:v.revision,...mutation(versions[0].revision),confirm:true});}
    await reload();await loadHistory();message='Versión restaurada; el historial anterior se conserva.';}
  const nutrient=k=>NUTRIMENTS.find(n=>n.id===k)||{label:k,unit:''};
  function selectExceptionSlot(){const s=exceptionBase?.slots.find(s=>s.slot_id===exceptionSlot);exceptionTime=s?.time||'14:00';exceptionLabel=s?.label||'Comida';exceptionServings=s?.servings||1;exceptionChoice=s?`${s.type}:${s.id}`:'';}
  const fmt=n=>Number(n||0).toLocaleString('es-MX',{maximumFractionDigits:3});
</script>

<div class="planning-page">
  <h1>Planificación y compras</h1>
  <p>Tu menú se repite cada semana. Los cambios por fecha afectan solo ese día. Planificar no registra alimentos consumidos.</p>
  <nav aria-label="Planificación">
    {#each [['menu','Menú semanal'],['shopping','Compras'],['pantry','En casa y presentaciones'],['history','Historial']] as [key,title]}
      <button class:active={tab===key} on:click={()=>{tab=key;if(key==='history')work(loadHistoryChoices);}}>{title}</button>
    {/each}
  </nav>
  {#if error}<p role="alert" class="error">{error} Si hay un conflicto, vuelve a consultar antes de aplicar tus cambios.</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if busy}<p role="status">Consultando o guardando…</p>{/if}
  <fieldset disabled={busy}>
  {#if tab==='menu'}
    <section>
      <label>Plantilla <select bind:value={selected} on:change={()=>work(chooseTemplate)}><option value="">Selecciona</option>{#each templates as t}<option value={t.id}>{t.payload.name} · {t.payload.status}</option>{/each}</select></label>
      <div class="row"><label>Desde <input type="date" bind:value={from}/></label><label>Hasta <input type="date" bind:value={to}/></label><button disabled={!selected} on:click={()=>work(chooseTemplate)}>Consultar fechas</button></div>
      <button on:click={newTemplate}>Nueva plantilla</button>
      {#if current}<button on:click={()=>editTemplate(current)}>Editar semana recurrente</button><button on:click={()=>work(()=>removeDocument(current))}>Retirar plantilla</button>{/if}
    </section>
    {#if draft}<section>
      <h2>{templateDoc?'Editar':'Crear'} plantilla</h2>
      <label>Nombre <input bind:value={draft.name}/></label><label>Zona horaria <input bind:value={draft.timezone}/></label>
      <div class="row"><label>Empieza <input type="date" bind:value={draft.starts_on}/></label><label>Termina (opcional) <input type="date" value={draft.ends_on||''} on:change={e=>draft.ends_on=e.currentTarget.value||null}/></label></div>
      <label>Estado <select bind:value={draft.status}>{#each ['proposed','approved','active','archived'] as s}<option value={s}>{s}</option>{/each}</select></label>
      {#each draft.days as day,index}<div class="day"><h3>{weekdays[index]}</h3><label>Tipo de día <select bind:value={day.day_type}><option value="training">Entrenamiento</option><option value="rest">Descanso</option><option value="recovery">Recuperación</option></select></label>
        {#each day.slots as slot,i}<div class="row"><input aria-label="Horario" type="time" bind:value={slot.time}/><input aria-label="Nombre de comida" bind:value={slot.label}/><label>Alimento o receta <select value={`${slot.type}:${slot.id}`} on:change={e=>{const [type,id]=e.currentTarget.value.split(':');slot.type=type;slot.id=Number(id);draft={...draft};}}>{#each catalogue as c}<option value={c.key}>{c.name}</option>{/each}</select></label><label>Porciones <input type="number" min="0.001" step="any" bind:value={slot.servings}/></label><button on:click={()=>{day.slots=day.slots.filter((_,j)=>i!==j);draft={...draft};}}>Quitar</button></div>{/each}
      </div>{/each}
      <h3>Añadir o repetir una comida</h3>
      <label>Del catálogo <select bind:value={choice}><option value="">Selecciona</option>{#each catalogue as c}<option value={c.key}>{c.name} ({c.type==='meal'?'comida/receta':'alimento'})</option>{/each}</select></label>
      <div class="row"><label>Nombre <input bind:value={label}/></label><label>Horario <input type="time" bind:value={time}/></label><label>Porciones <input type="number" min="0.001" step="any" bind:value={servings}/></label></div>
      <div class="row">{#each weekdays as d,i}<label><input type="checkbox" bind:group={selectedDays} value={i}/>{d}</label>{/each}</div>
      <button disabled={!choice||!selectedDays.length} on:click={addSlot}>Añadir a los días seleccionados</button>
      <div class="row"><button on:click={()=>work(saveTemplate)}>Guardar plantilla</button><button on:click={()=>draft=null}>Cancelar</button></div>
    </section>{/if}
    {#if menu}<section><h2>Menú resuelto</h2>{#each menu.days as day}<div class="day"><h3>{day.date} · {day.day_type}{day.exception?' · excepción':''}</h3>{#each day.slots as slot}<p>{slot.time} · {slot.label}: {catalogue.find(c=>c.type===slot.type&&c.id===slot.id)?.name||'Alimento'} · {slot.servings} porciones</p>{/each}{#if !day.slots.length}<p>Sin comidas planificadas</p>{/if}</div>{/each}
      <button on:click={()=>work(async()=>nutrition=await call('get_planned_nutrition',{template_id:selected,from,to}))}>Calcular aportación y consultar metas</button>
      {#if nutrition}<h3>Aportación estimada</h3>{#each nutrition.days as d}<details><summary>{d.date} · {d.nutrition.calories==null?'Energía no informada':fmt(d.nutrition.calories)+' kcal'}{d.incomplete_nutrients.includes('calories')?' · parcial':''}</summary>{#each Object.entries(d.nutrition) as [k,v]}<p>{nutrient(k).label}: {fmt(v)} {nutrient(k).unit}</p>{/each}{#each Object.entries(d.comparison||{}) as [k,c]}<p>{nutrient(k).label}: meta {c.target??'no resuelta'} {nutrient(k).unit} · {c.complete?'composición completa':'información incompleta'}{c.difference!=null?' · diferencia '+fmt(c.difference):''}</p>{/each}</details>{/each}
        <h3>Aportación estimada del rango</h3>{#each Object.entries(nutrition.weekly) as [k,v]}<p>{nutrient(k).label}: {fmt(v)} {nutrient(k).unit}</p>{/each}<p>Las metas se comparan para cada fecha.</p><button on:click={()=>push('/goals')}>Consultar o editar metas</button>
        <p>Los nutrientes ausentes son desconocidos, no cero.</p>{#each nutrition.warnings as w}<p class="warning">{w}</p>{/each}
      {/if}
      <h3>Cambiar solo una fecha</h3><label>Fecha <input type="date" bind:value={exceptionDate} on:change={()=>work(loadException)}/></label><button on:click={()=>work(loadException)}>Consultar excepción</button>
      <label><input type="checkbox" bind:checked={exceptionSkip}/>Dejar el día sin comidas</label>
      <label>Comida a cambiar <select bind:value={exceptionSlot} on:change={selectExceptionSlot}><option value="">Añadir comida</option>{#each exceptionBase?.slots||[] as s}<option value={s.slot_id}>{s.time} · {s.label}</option>{/each}</select></label>
      <label>Sustitución <select bind:value={exceptionChoice}><option value="">Quitar esta comida</option>{#each catalogue as c}<option value={c.key}>{c.name}</option>{/each}</select></label><label>Porciones <input type="number" min="0.001" step="any" bind:value={exceptionServings}/></label><div class="row"><label>Horario de esta fecha <input type="time" bind:value={exceptionTime}/></label><label>Nombre de esta comida <input bind:value={exceptionLabel}/></label><label>Tipo de día <select bind:value={exceptionDayType}><option value="">Usar plantilla</option><option value="training">Entrenamiento</option><option value="rest">Descanso</option><option value="recovery">Recuperación</option></select></label></div>
      <button on:click={()=>work(saveException)}>Guardar cambio de esta fecha</button>{#if exceptionDoc}<button on:click={()=>work(()=>removeDocument(exceptionDoc))}>Volver a la semana recurrente</button>{/if}
      <h3>Compras para estas fechas</h3><label>Nombre de la lista <input bind:value={newName}/></label><button on:click={()=>work(()=>generate())}>Generar lista</button>
    </section>{/if}
    <section><h2>Comidas y recetas</h2><button on:click={()=>push('/foods')}>Abrir biblioteca y editar ingredientes</button><button on:click={()=>push('/meal-editor')}>Crear comida o receta</button></section>
  {:else if tab==='shopping'}
    <section><h2>Listas guardadas</h2>{#each lists as l}<button on:click={()=>shopping=structuredClone(l)}>{l.payload.name}</button>{/each}{#if !lists.length}<p>Selecciona un menú y un rango de fechas para generar tu primera lista.</p>{/if}</section>
    {#if shopping}<section><h2>{shopping.payload.name}</h2><p>{shopping.payload.from} — {shopping.payload.to}</p>
      <div class="row"><button on:click={()=>work(()=>generate(true))}>Actualizar desde el menú</button><button on:click={()=>work(()=>removeDocument(shopping))}>Retirar lista</button><button on:click={()=>work(()=>exportList('text',true))}>Compartir</button>{#each ['text','csv','json'] as f}<button on:click={()=>work(()=>exportList(f))}>Exportar {f}</button>{/each}</div>
      {#each shopping.payload.warnings as w}<p class="warning">{w}</p>{/each}
      {#each grouped as group}<h3>{group.category}</h3>{#each group.items as item}<article>
        <div class="row"><input type="checkbox" aria-label={'Comprado '+item.name} checked={item.to_buy===0&&item.purchased_quantity>0} on:change={e=>work(()=>changeItem(item,{purchased:e.currentTarget.checked}))}/><strong>{item.name}</strong><span>{item.state==='unspecified'?'':item.state==='raw'?'crudo':'cocido'}</span></div>
        <p>Menú: {fmt(item.required)} {item.unit} · En casa: {fmt(item.stock)} · Comprado: {fmt(item.purchased_quantity)}</p><p><b>Falta: {fmt(item.display.amount)} {item.display.unit}</b>{#if item.packages!=null} · {item.packages} {item.package.package_label}{/if}{#if item.removed_from_menu} · Ya no está en el menú; se conserva tu ajuste o compra{/if}</p>
        <details><summary>Nombre y categoría</summary><label>Nombre <input value={item.name} on:change={e=>{const name=e.currentTarget.value;work(()=>changeItem(item,{name}));}}/></label><label>Categoría <select value={categories.includes(item.category)?item.category:'otros'} on:change={e=>{const category=e.currentTarget.value;work(()=>changeItem(item,{category}));}}>{#each categories as c}<option value={c}>{c}</option>{/each}</select></label></details>
        <label>Comprar en total ({item.unit}, después de descontar inventario) <input type="number" min="0" step="any" value={item.override_quantity??''} placeholder="Automático" on:change={e=>{const value=e.currentTarget.value;work(()=>changeItem(item,{override_quantity:value===''?null:Number(value)}));}}/></label>
        <label>Cantidad ya comprada ({item.unit}) <input type="number" min="0" step="any" value={item.purchased_quantity} on:change={e=>{const value=Number(e.currentTarget.value);work(()=>changeItem(item,{purchased_quantity:value}));}}/></label>
        {#if item.estimated_cost!=null}<p>Estimación pendiente de compra: {fmt(item.estimated_cost)} {item.package.currency}</p>{/if}
      </article>{/each}{/each}
      <h3>Presupuesto pendiente</h3>{#each Object.entries(shopping.payload.budget.totals) as [currency,total]}<p>{fmt(total)} {currency}</p>{/each}{#if shopping.payload.budget.incomplete}<p>Presupuesto parcial: faltan precios o presentaciones.</p>{/if}
      <details><summary>Diferencias de la última actualización</summary>{#each shopping.payload.differences as d}<p>{d.before_name||d.name} → {d.after_name||d.name}: menú {fmt(d.before_required)} → {fmt(d.after_required)} {d.unit}; por comprar {fmt(d.before_to_buy)} → {fmt(d.after_to_buy)} {d.unit}{d.before_brand!==d.after_brand?' · marca: '+(d.before_brand||'sin marca')+' → '+(d.after_brand||'sin marca'):''}</p>{/each}{#each shopping.payload.source_changes||[] as source}<p>{source.name}: versión {source.before_revision??'nueva'} → {source.after_revision}</p>{/each}</details>
      <h3>Añadir artículo manual</h3><div class="row"><label>Nombre <input bind:value={manualName}/></label><label>Cantidad <input type="number" min="0.001" step="any" bind:value={manualQuantity}/></label><label>Unidad <input bind:value={manualUnit}/></label><label>Categoría <select bind:value={manualCategory}>{#each categories as c}<option value={c}>{c}</option>{/each}</select></label><button on:click={()=>work(addManual)}>Añadir artículo</button></div>
    </section>{/if}
  {:else if tab==='pantry'}
    <section><h2>Inventario y formatos de compra</h2><p>Indica existencias y presentaciones conocidas. La merma de cocción y la densidad son opcionales; no se suponen.</p>{#each foods as food}<button on:click={()=>newPantry(food)}>{food.name}{pantry.some(p=>p.payload.food_id===food.id)?' · configurado':''}</button>{/each}</section>
    {#if pantryDraft}<section><h2>{foods.find(f=>f.id===pantryDraft.food_id)?.name}</h2>
      <div class="row"><label>En casa <input type="number" min="0" step="any" bind:value={pantryDraft.stock}/></label><label>Unidad <input bind:value={pantryDraft.unit}/></label><label>Estado <select bind:value={pantryDraft.state}><option value="unspecified">Sin especificar</option><option value="raw">Crudo</option><option value="cooked">Cocido</option></select></label></div>
      <label>Categoría <select bind:value={pantryDraft.category}>{#each categories as c}<option value={c}>{c}</option>{/each}</select></label>
      <label>Densidad conocida (g/ml) <input type="number" min="0.001" step="any" value={pantryDraft.density_g_ml??''} on:input={e=>pantryDraft.density_g_ml=e.currentTarget.value===''?null:Number(e.currentTarget.value)}/></label>
      <label>Rendimiento conocido (peso cocido / peso crudo) <input type="number" min="0.001" step="any" value={pantryDraft.cooked_yield??''} on:input={e=>pantryDraft.cooked_yield=e.currentTarget.value===''?null:Number(e.currentTarget.value)}/></label>
      <div class="row"><label>Tamaño de presentación <input type="number" min="0.001" step="any" value={pantryDraft.package_size??''} on:input={e=>pantryDraft.package_size=e.currentTarget.value===''?null:Number(e.currentTarget.value)}/></label><label>Unidad de presentación <input bind:value={pantryDraft.package_unit}/></label><label>Nombre (paquete, lata…) <input bind:value={pantryDraft.package_label}/></label></div>
      <div class="row"><label>Precio por presentación <input type="number" min="0" step="any" value={pantryDraft.price??''} on:input={e=>pantryDraft.price=e.currentTarget.value===''?null:Number(e.currentTarget.value)}/></label><label>Moneda <input bind:value={pantryDraft.currency}/></label></div>
      <button on:click={()=>work(savePantry)}>Guardar</button>{#if pantryDoc}<button on:click={()=>work(async()=>{await removeDocument(pantryDoc);pantryDraft=null;})}>Retirar configuración</button>{/if}<button on:click={()=>pantryDraft=null}>Cancelar</button>
    </section>{/if}
  {:else}
    <section><h2>Historial automático</h2><p>Las modificaciones se registran al guardar. El motivo queda pendiente si no se proporcionó; no hace falta justificar cada edición.</p>
      <label>Tipo <select bind:value={historyKind} on:change={()=>work(loadHistoryChoices)}><option value="template">Plantilla</option><option value="exception">Excepción</option><option value="shopping">Compras</option><option value="pantry">Inventario</option><option value="meals">Comida/receta</option><option value="foods">Alimento</option></select></label>
      <label><input type="checkbox" bind:checked={includeRetired} on:change={()=>work(loadHistoryChoices)}/>Incluir registros retirados</label>
      <label>Registro <select bind:value={historyId}><option value="">Selecciona</option>{#each historyChoices as d}<option value={String(d.id)}>{d.payload?.name||d.name||d.id}</option>{/each}</select></label><button disabled={!historyId} on:click={()=>work(loadHistory)}>Consultar historial</button>
      {#if versions.length}<div class="row"><label>Desde <select bind:value={left}>{#each versions as v}<option value={v.revision}>{v.revision}</option>{/each}</select></label><label>Hasta <select bind:value={right}>{#each versions as v}<option value={v.revision}>{v.revision}</option>{/each}</select></label><button on:click={()=>work(compare)}>Comparar</button></div>{/if}
      {#each versions as v}<article><b>Versión {v.revision}</b><p>{v.recorded_at} · {v.source==='baseline'?'Estado al habilitar historial':v.source}</p><p>Motivo: {v.reason||'Pendiente de documentar'}</p>{#if historyKind!=='foods'}<button on:click={()=>work(()=>restore(v))}>Restaurar como nueva versión</button>{/if}</article>{/each}
      {#if comparison}<h3>Diferencias</h3>{#each comparison.differences as d}<details><summary>{d.path}</summary><p>Antes: {JSON.stringify(d.before)}</p><p>Después: {JSON.stringify(d.after)}</p></details>{/each}{/if}
    </section>
  {/if}
  </fieldset>
</div>

<style>
  .planning-page{max-width:1000px;margin:auto;padding:20px 16px 100px}nav,.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}nav{margin:18px 0}section{padding:18px;margin:16px 0;background:var(--surface);border:1px solid var(--border);border-radius:16px}article,.day{border-top:1px solid var(--border);padding:14px 0}label{display:flex;flex-direction:column;gap:5px;margin:8px 0}button,input,select{font:inherit;padding:9px;border-radius:8px;border:1px solid var(--border);background:var(--surface-2);color:inherit}button{cursor:pointer;margin:3px}button:disabled{opacity:.5}.active{outline:2px solid var(--accent)}fieldset{border:0;padding:0;min-width:0}.error{color:#ed7676}.warning{color:var(--warning,#b98b30)}input[type=number]{max-width:160px}p{overflow-wrap:anywhere}details{margin:10px 0}summary{cursor:pointer}
</style>
