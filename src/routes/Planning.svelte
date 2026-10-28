<script>
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { planningCall as call, mutation } from '../lib/planning-api.js';
  import { weekStart, weekEnd, shiftDate, categoryName, matchingList, displayUnit } from '../lib/planning-view.js';
  import {copyText} from '../lib/clipboard.js';
  import Sheet from '../components/ui/Sheet.svelte';
  import { NUTRIMENTS } from '../lib/nutrition.js';
  import { localDateStr } from '../lib/db.js';
  const weekdays=['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
  const categories=['carnes','pescados','lácteos','frutas','verduras','cereales','legumbres','grasas','otros'];
  let templates=[],foods=[],meals=[],lists=[],pantry=[],selected='',current=null,shopping=null,menu=null,nutrition=null;
  let busy=false,error='',message='',tab='menu',from=weekStart(localDateStr()),to=weekEnd(localDateStr());
  let draft=null,templateDoc=null,newName='',choice='',time='14:00',label='Comida',servings=1,selectedDays=[0];
  let exceptionTime='',exceptionLabel='',exceptionDayType='';
  let exceptionDate=localDateStr(),exceptionDoc=null,exceptionSkip=false,exceptionSlot='',exceptionChoice='',exceptionServings=1;
  let pantryDraft=null,pantryDoc=null,manualName='',manualQuantity=1,manualUnit='piece',manualCategory='otros';
  let copyContent='',copyReady=false,copyKey='';
  let editorDay=0,showException=false,pantryChoice='';
  let historyChoices=[],includeRetired=false;
  let historyKind='template',historyId='',versions=[],left=0,right=0,comparison=null;
  $: catalogue=[...foods.map(f=>({...f,type:'food',key:'food:'+f.id})),...meals.map(m=>({...m,type:'meal',key:'meal:'+m.id}))];
  $: grouped=shopping ? categories.map(category=>({category,items:shopping.payload.items.filter(i=>(categories.includes(i.category)?i.category:'otros')===category)})).filter(g=>g.items.length):[];
  $: if(tab==='shopping'&&shopping)prepareCopy(shopping);
  $: exceptionBase=menu?.days.find(d=>d.date===exceptionDate);
  async function work(fn){if(busy)return;busy=true;error='';message='';try{await fn();}catch(e){error=e.message;}finally{busy=false;}}
  async function reload(){[templates,lists,pantry]=await Promise.all([call('list_planning_templates'),call('list_shopping_lists'),call('list_pantry')]);
    const allFoods=[],allMeals=[];for(let offset=0;;offset+=200){const page=await call('get_planning_catalog',{offset,limit:200});allFoods.push(...page.foods);allMeals.push(...page.meals);if(page.foods.length<200&&page.meals.length<200)break;}foods=allFoods;meals=allMeals;}
  onMount(()=>work(async()=>{await reload();selected=templates.find(t=>t.payload.status==='active'&&t.payload.starts_on<=to&&(!t.payload.ends_on||t.payload.ends_on>=from))?.id||templates[0]?.id||'';await chooseTemplate();}));
  async function navigateWeek(delta){from=shiftDate(from,delta*7);to=shiftDate(from,6);await chooseTemplate();}
  async function openException(day){exceptionDate=day.date;await loadException();showException=true;}
  const dayTitle=date=>new Intl.DateTimeFormat('es-MX',{weekday:'long',day:'numeric',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));
  const rangeTitle=(a,b)=>new Intl.DateTimeFormat('es-MX',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(a+'T12:00:00Z'))+' – '+new Intl.DateTimeFormat('es-MX',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(b+'T12:00:00Z'));
  async function prepareCopy(doc){
    const key=doc.id+':'+doc.revision;if(copyKey===key)return;copyKey=key;copyReady=false;
    try{const r=await call('export_shopping_list',{id:doc.id,format:'text'});if(copyKey===key){copyContent=r.content;copyReady=true;}}
    catch{if(copyKey===key){copyKey='';copyReady=false;}}
  }
  async function copyList(){await copyText(copyContent);message='Lista copiada.';}
  async function selectShopping(id){shopping=id?await call('get_planning_document',{kind:'shopping',id}):null;}

  function newTemplate(){tab='edit';editorDay=0;selectedDays=[0];templateDoc=null;draft={name:'',timezone:'America/Mexico_City',starts_on:from,ends_on:null,status:templates.some(t=>t.payload.status==='active')?'proposed':'active',days:weekdays.map(()=>({day_type:'rest',slots:[]}))};}
  function editTemplate(doc){tab='edit';templateDoc=doc;draft=structuredClone(doc.payload);}
  async function chooseTemplate(){if(exceptionDoc?.payload.template_id!==selected)exceptionDoc=null;current=templates.find(t=>t.id===selected)||null;menu=null;nutrition=null;if(current){nutrition=await call('get_planned_nutrition',{template_id:selected,from,to});menu=nutrition;}shopping=matchingList(lists,selected,from,to);}
  function addSlot(){const [type,id]=choice.split(':');if(!id)return;
    for(const index of selectedDays)draft.days[index].slots.push({slot_id:crypto.randomUUID(),type,id:Number(id),servings:Number(servings),time,label});draft={...draft};}
  async function saveTemplate(){const doc=await call('save_planning_template',{...(templateDoc?{id:templateDoc.id}:{}),data:draft,...mutation(templateDoc?.revision)});selected=doc.id;draft=null;tab='menu';await reload();await chooseTemplate();message='Plantilla guardada. Se repetirá cada semana dentro de sus fechas.';}
  async function saveException(){const base=exceptionBase?.slots.find(s=>s.slot_id===exceptionSlot),[type,id]=exceptionChoice.split(':');
    const replacement=id?{slot_id:exceptionSlot||crypto.randomUUID(),type,id:Number(id),servings:Number(exceptionServings),time:exceptionTime||base?.time||time,label:exceptionLabel||base?.label||label}:null;
    const existing=exceptionDoc?.payload.slots||[];
    const slots=exceptionSlot?[...existing.filter(s=>s.slot_id!==exceptionSlot),{slot_id:exceptionSlot,replacement}]:id?[...existing,{slot_id:replacement.slot_id,replacement}]:existing;
    exceptionDoc=await call('save_planning_exception',{...(exceptionDoc?{id:exceptionDoc.id}:{}),data:{template_id:selected,date:exceptionDate,skip:exceptionSkip,slots,...(exceptionDayType?{day_type:exceptionDayType}:{})},...mutation(exceptionDoc?.revision)});
    await chooseTemplate();showException=false;message='Excepción guardada para esta fecha.';}
  async function loadException(){exceptionDoc=null;exceptionSkip=false;exceptionSlot='';exceptionChoice='';exceptionTime='';exceptionLabel='';exceptionDayType='';
    try{exceptionDoc=await call('get_planning_document',{kind:'exception',id:selected+':'+exceptionDate});exceptionSkip=exceptionDoc.payload.skip;exceptionDayType=exceptionDoc.payload.day_type||'';}catch(e){if(!e.message.includes('not found'))throw e;}}
  async function removeDocument(doc){if(!confirm('¿Retirar este registro? Se conservará su historial.'))return;
    await call('delete_planning_document',{kind:doc.kind,id:doc.id,...mutation(doc.revision),confirm:true});await reload();
    if(doc.kind==='exception'){exceptionDoc=null;await chooseTemplate();}if(doc.kind==='shopping')shopping=null;if(doc.kind==='template'){selected='';current=null;menu=null;}}
  async function generate(regenerate=false){shopping=await call('generate_shopping_list',{...(regenerate?{id:shopping.id}:{}),name:regenerate?shopping.payload.name:(newName||`Compras ${from} — ${to}`),template_id:regenerate?shopping.payload.template_id:selected,
    from:regenerate?shopping.payload.from:from,to:regenerate?shopping.payload.to:to,...mutation(regenerate?shopping.revision:0)});await reload();tab='shopping';}
  async function changeItem(item,patch){
    try{shopping=await call('update_shopping_item',{id:shopping.id,patch:{key:item.key,...patch},...mutation(shopping.revision)});lists=lists.map(l=>l.id===shopping.id?shopping:l);}
    catch(e){shopping={...shopping,payload:{...shopping.payload,items:shopping.payload.items.map(i=>({...i}))}};throw e;}
  }
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
  <header class="page-heading"><div><p class="eyebrow">TU ALIMENTACIÓN, ORGANIZADA</p><h1>Planificación y compras</h1></div><a class="text-link" href="#/diary">Ir al diario →</a></header>
  <nav class="main-nav" aria-label="Planificación">
    {#each [['menu','Mi semana'],['shopping','Compras'],['edit','Editar plan']] as [key,title]}
      <button class:active={tab===key} aria-current={tab===key?'page':undefined} on:click={()=>{tab=key;if(key==='edit'&&!draft){if(current)editTemplate(current);else newTemplate();}}}>{title}</button>
    {/each}
    <details class="more-nav"><summary>Más</summary><div><button on:click={e=>{tab='pantry';e.currentTarget.closest('details').open=false;}}>En casa</button><button on:click={e=>{tab='history';e.currentTarget.closest('details').open=false;work(loadHistoryChoices);}}>Historial</button><button on:click={()=>push('/foods')}>Comidas y recetas</button></div></details>
  </nav>
  {#if error}<p role="alert" class="error">{error} <button disabled={busy} on:click={()=>work(async()=>{await reload();await chooseTemplate();})}>Volver a consultar</button></p>{/if}
  {#if message}<p role="status" class="success">{message}</p>{/if}
  {#if busy}<p role="status" class="loading">Consultando o guardando…</p>{/if}
  <fieldset disabled={busy}>
  {#if tab==='menu'||tab==='shopping'}
    <section class="week-toolbar">
      <label class="plan-select">Plan alimenticio<select bind:value={selected} on:change={()=>work(chooseTemplate)}><option value="">Selecciona un plan</option>{#each templates as t}<option value={t.id}>{t.payload.name}{t.payload.status==='active'?' · Activo':''}</option>{/each}</select></label>
      <div class="week-nav"><button aria-label="Semana anterior" on:click={()=>work(()=>navigateWeek(-1))}>←</button><div><strong>{rangeTitle(from,to)}</strong><button class="quiet" on:click={()=>work(async()=>{from=weekStart(localDateStr());to=weekEnd(from);await chooseTemplate();})}>Esta semana</button></div><button aria-label="Semana siguiente" on:click={()=>work(()=>navigateWeek(1))}>→</button></div>
    </section>
  {/if}
  {#if tab==='menu'}
    {#if current&&menu}
      <div class="week-summary"><div><span class="eyebrow">{current.payload.status==='active'?'PLAN ACTIVO':'VISTA PREVIA DEL PLAN'}</span><h2>{current.payload.name}</h2><p>{fmt(nutrition?.weekly.calories)} kcal · {fmt(nutrition?.weekly.proteins)} g proteína en esta semana{nutrition?.warnings.length?' · estimación parcial':''}</p></div><button class="primary" on:click={()=>editTemplate(current)}>Editar plan</button></div>
      <div class="week-grid">
        {#each menu.days as day}<details class="week-day" open={false}>
          <summary><span class="day-title">{dayTitle(day.date)}{#if day.exception}<small>Cambio puntual</small>{/if}</span><span class="day-macros">{day.nutrition.calories==null?'—':fmt(day.nutrition.calories)} kcal · {day.nutrition.proteins==null?'—':fmt(day.nutrition.proteins)} g proteína</span><span class="day-foods">{day.slots.map(s=>s.preview?.name||s.label).join(' · ')||'Sin comidas programadas'}</span><span class="expand-hint">Ver comidas y cantidades</span></summary>
          <div class="day-detail">{#each day.slots as slot}<div class="meal-preview"><div class="row"><time>{slot.time}</time><strong>{slot.label}</strong></div><p>{slot.preview?.name||'Comida no disponible'} · {fmt(slot.servings)} porciones</p><details><summary>Ingredientes</summary>{#each slot.preview?.items||[] as ingredient}<p>{ingredient.name}: {fmt(ingredient.portion)} {ingredient.unit} × {fmt(ingredient.quantity)}</p>{/each}{#if slot.unavailable}<p>{slot.unavailable}</p>{/if}</details></div>{/each}
          <div class="row"><button on:click={()=>work(()=>openException(day))}>Cambiar este día</button><a href={`#/diary?date=${day.date}`}>Abrir en Diario</a></div></div>
        </details>{/each}
      </div>
      {#if !menu.days.length}<section class="empty"><h2>Este plan no está vigente esta semana</h2><p>Cambia de semana o revisa la vigencia del plan.</p></section>{/if}
      <section class="next-action"><div><h3>Prepara tus compras</h3><p>{shopping?'Tu lista está guardada. Consulta lo que falta comprar.':'Suma los ingredientes del menú y descuenta lo que tienes en casa.'}</p></div><button class="primary" on:click={()=>shopping?tab='shopping':work(()=>generate())}>{shopping?'Ver lista de compras':'Generar compras de la semana'}</button></section>
      <details class="context-help"><summary>Estimaciones nutricionales y metas</summary><p>Planificar no registra consumo. Las cantidades se comparan con tus metas guardadas; los nutrientes desconocidos no equivalen a cero.</p>{#each nutrition?.days||[] as day}<p><b>{dayTitle(day.date)}</b></p>{#each Object.entries(day.comparison||{}) as [k,c]}<p>{nutrient(k).label}: {fmt(c.estimated)} / {c.target??'sin meta'} {nutrient(k).unit}{c.complete?'':' · información parcial'}</p>{/each}{/each}<button on:click={()=>push('/goals')}>Editar metas</button><details><summary>Detalles del cálculo</summary>{#each nutrition?.warnings||[] as w}<p>{w}</p>{/each}</details></details>
    {:else}<section class="empty"><span class="material-symbols-rounded empty-icon">calendar_month</span><h2>Tu semana empieza aquí</h2><p>Crea un menú que se repita cada semana. Podrás cambiar días puntuales sin rehacerlo.</p><button class="primary" on:click={newTemplate}>Crear mi plan semanal</button></section>{/if}
  {:else if tab==='edit'}
    <div class="section-heading"><div><h2>Editar planificación</h2><p>Elige un día y ajusta sus comidas. Se repetirán cada semana.</p></div><button on:click={newTemplate}>Crear otro plan</button></div>
    {#if draft}<section>
      <h2>{templateDoc?'Editar':'Crear'} plantilla</h2><div class="editor-actions"><button class="primary" on:click={()=>work(saveTemplate)}>Guardar plan</button><button on:click={()=>{draft=null;tab='menu';}}>Cancelar</button></div>
      <label>Nombre <input bind:value={draft.name}/></label><details><summary>Vigencia y zona horaria</summary><label>Zona horaria <input bind:value={draft.timezone}/></label>
      <div class="row"><label>Empieza <input type="date" bind:value={draft.starts_on}/></label><label>Termina (opcional) <input type="date" value={draft.ends_on||''} on:change={e=>draft.ends_on=e.currentTarget.value||null}/></label></div></details>
      <label>Estado <select bind:value={draft.status}>{#each [['proposed','Borrador'],['approved','Aprobado'],['active','Activo'],['archived','Archivado']] as [s,title]}<option value={s}>{title}</option>{/each}</select></label>
      <div class="day-picker" role="group" aria-label="Día a editar">{#each weekdays as name,i}<button class:active={editorDay===i} on:click={()=>{editorDay=i;selectedDays=[i];}}>{name.slice(0,3)}</button>{/each}</div>
      {#each draft.days as day,index}{#if index===editorDay}<div class="day"><h3>{weekdays[index]}</h3><label>Tipo de día <select bind:value={day.day_type}><option value="training">Entrenamiento</option><option value="rest">Descanso</option><option value="recovery">Recuperación</option></select></label>
        {#each day.slots as slot,i}<details class="slot-editor"><summary><strong>{slot.time} · {slot.label}</strong><span>{catalogue.find(c=>c.type===slot.type&&c.id===slot.id)?.name||'Comida'} · {fmt(slot.servings)} porciones</span></summary><div class="row"><input aria-label="Horario" type="time" bind:value={slot.time}/><input aria-label="Nombre de comida" bind:value={slot.label}/><label>Alimento o receta <select value={`${slot.type}:${slot.id}`} on:change={e=>{const [type,id]=e.currentTarget.value.split(':');slot.type=type;slot.id=Number(id);draft={...draft};}}>{#each catalogue as c}<option value={c.key}>{c.name}</option>{/each}</select></label><label>Porciones <input type="number" min="0.001" step="any" bind:value={slot.servings}/></label><button on:click={()=>{day.slots=day.slots.filter((_,j)=>i!==j);draft={...draft};}}>Quitar</button></div></details>{/each}
      </div>{/if}{/each}
      <details class="add-slot"><summary>Añadir o repetir una comida</summary>
      <label>Del catálogo <select bind:value={choice}><option value="">Selecciona</option>{#each catalogue as c}<option value={c.key}>{c.name} ({c.type==='meal'?'comida/receta':'alimento'})</option>{/each}</select></label>
      <div class="row"><label>Nombre <input bind:value={label}/></label><label>Horario <input type="time" bind:value={time}/></label><label>Porciones <input type="number" min="0.001" step="any" bind:value={servings}/></label></div>
      <details><summary>Repetir la nueva comida en otros días</summary><div class="row">{#each weekdays as d,i}<label><input type="checkbox" bind:group={selectedDays} value={i}/>{d}</label>{/each}</div></details>
      <button disabled={!choice||!selectedDays.length} on:click={addSlot}>Añadir a los días seleccionados</button></details>

    </section>{/if}
    {#if current}<details class="context-help"><summary>Administrar este plan</summary><p>Retirar el plan conserva su historial y todos los consumos registrados.</p><button class="danger" on:click={()=>work(()=>removeDocument(current))}>Retirar plan</button><button on:click={()=>push('/meal-editor')}>Crear comida o receta</button></details>{/if}
  {:else if tab==='shopping'}
    {#if shopping}
      <div class="section-heading"><div><h2>Compras · {rangeTitle(shopping.payload.from,shopping.payload.to)}</h2><p>{shopping.payload.items.filter(i=>i.to_buy>0).length} productos pendientes · {shopping.payload.items.filter(i=>i.to_buy===0).length} cubiertos</p></div><button on:click={()=>work(()=>generate(true))}>Actualizar desde el menú</button></div>
      {@const covered=shopping.payload.items.filter(i=>i.to_buy===0).length}
      <progress aria-label="Productos cubiertos" max={shopping.payload.items.length||1} value={covered}></progress>
      <div class="row shopping-actions"><button disabled={!copyReady} on:click={()=>work(copyList)}>Copiar lista</button><button on:click={()=>work(()=>exportList('text',true))}>Compartir</button><details><summary>Exportar</summary><div class="row">{#each ['text','csv','json'] as f}<button on:click={()=>work(()=>exportList(f))}>{f.toUpperCase()}</button>{/each}</div></details><button on:click={()=>tab='pantry'}>Lo que tengo en casa</button></div>
      <div class="shopping-groups">{#each grouped as group}<section class="shopping-category"><h3>{categoryName(group.category)} <small>{group.items.length}</small></h3>
        {#each group.items as item (item.key)}<div class="shopping-item" class:covered={item.to_buy===0}>
          <div class="shopping-line"><input type="checkbox" aria-label={'Comprado '+item.name} checked={item.to_buy===0&&item.purchased_quantity>0} on:change={e=>{const purchased=e.currentTarget.checked;work(()=>changeItem(item,{purchased}));}}/>
            <div class="product"><strong>{item.name}</strong>{#if item.state!=='unspecified'}<small>{item.state==='raw'?'Peso en crudo':'Peso cocido'}</small>{/if}{#if item.purchased_quantity>0&&item.to_buy>0}<small>Compra parcial: {fmt(item.purchased_quantity)} {displayUnit(item.unit)}</small>{/if}</div>
            <b class="buy-amount">{item.to_buy===0?'Cubierto':fmt(item.display.amount)+' '+displayUnit(item.display.unit)}</b>
          </div>
          <details class="product-details"><summary>Ajustar o registrar compra parcial</summary><div class="item-editor">
            <p>Menú: {fmt(item.required)} {item.unit} · En casa: {fmt(item.stock)} {item.unit}</p>
            <div class="row"><label>Ya compré ({displayUnit(item.unit)})<input type="number" min="0" step="any" value={item.purchased_quantity} on:change={e=>{const value=Number(e.currentTarget.value);work(()=>changeItem(item,{purchased_quantity:value}));}}/></label><label>Comprar en total ({displayUnit(item.unit)})<input type="number" min="0" step="any" value={item.override_quantity??''} placeholder="Automático" on:change={e=>{const value=e.currentTarget.value;work(()=>changeItem(item,{override_quantity:value===''?null:Number(value)}));}}/></label></div>
            <p class="hint">El total sustituye el cálculo después del inventario. Lo comprado se descuenta de ese total.</p>
            <div class="row"><label>Nombre<input value={item.name} on:change={e=>{const name=e.currentTarget.value;work(()=>changeItem(item,{name}));}}/></label><label>Categoría<select value={categories.includes(item.category)?item.category:'otros'} on:change={e=>{const category=e.currentTarget.value;work(()=>changeItem(item,{category}));}}>{#each categories as c}<option value={c}>{categoryName(c)}</option>{/each}</select></label></div>
            {#if item.packages!=null}<p>Presentación: {item.packages} {item.package.package_label} por comprar.</p>{/if}
            {#if item.estimated_cost!=null}<p>Estimación: {fmt(item.estimated_cost)} {item.package.currency}</p>{/if}
            {#if item.removed_from_menu}<p>Ya no figura en el menú; conservamos tu compra o ajuste.</p>{/if}
          </div></details>
        </div>{/each}
      </section>{/each}</div>
      <details class="context-help"><summary>Añadir otro producto</summary><div class="row"><label>Producto<input bind:value={manualName}/></label><label>Cantidad<input type="number" min="0.001" step="any" bind:value={manualQuantity}/></label><label>Unidad<input bind:value={manualUnit}/></label><label>Categoría<select bind:value={manualCategory}>{#each categories as c}<option value={c}>{categoryName(c)}</option>{/each}</select></label><button disabled={!manualName.trim()} on:click={()=>work(addManual)}>Añadir a la lista</button></div></details>
      <details class="context-help"><summary>Presupuesto y detalles del cálculo{shopping.payload.warnings.length?' · revisar datos pendientes':''}</summary><h3>Presupuesto pendiente</h3>{#each Object.entries(shopping.payload.budget.totals) as [currency,total]}<p>{fmt(total)} {currency}</p>{/each}{#if shopping.payload.budget.incomplete}<p>Estimación parcial: faltan precios o presentaciones.</p>{/if}{#each shopping.payload.warnings as w}<p class="warning">{w}</p>{/each}<p>Solo se descuentan existencias compatibles. Los rendimientos y las conversiones desconocidas no se suponen.</p></details>
      <details class="context-help"><summary>Qué cambió al actualizar la lista</summary>{#each shopping.payload.differences as d}<p>{d.name}: por comprar {fmt(d.before_to_buy)} → {fmt(d.after_to_buy)} {d.unit}; menú {fmt(d.before_required)} → {fmt(d.after_required)} {d.unit}</p>{/each}{#each shopping.payload.source_changes||[] as source}<p>{source.name}: composición actualizada.</p>{/each}</details>
      <details class="context-help"><summary>Administrar lista</summary><button class="danger" on:click={()=>work(()=>removeDocument(shopping))}>Retirar esta lista</button></details>
    {:else}<section class="empty"><span class="material-symbols-rounded empty-icon">shopping_basket</span><h2>Las compras de tu semana</h2><p>{selected?'Genera la lista con las comidas de esta semana y tu inventario disponible.':'Selecciona o crea un plan para calcular los ingredientes.'}</p><button class="primary" disabled={!selected} on:click={()=>work(()=>generate())}>Generar lista semanal</button></section>{/if}
    {#if lists.length}<details class="context-help"><summary>Otras listas guardadas</summary><label>Lista<select value={shopping?.id||''} on:change={e=>{const id=e.currentTarget.value;work(()=>selectShopping(id));}}><option value="">Selecciona una lista</option>{#each lists as l}<option value={l.id}>{l.payload.name}</option>{/each}</select></label></details>{/if}
  {:else if tab==='pantry'}
    <section><h2>Inventario y formatos de compra</h2><p>Indica existencias y presentaciones conocidas. La merma de cocción y la densidad son opcionales; no se suponen.</p><label>Producto<select bind:value={pantryChoice} on:change={()=>{const food=foods.find(f=>f.id===Number(pantryChoice));if(food)newPantry(food);}}><option value="">Selecciona un producto</option>{#each foods as food}<option value={food.id}>{food.name}{pantry.some(p=>p.payload.food_id===food.id)?' · en inventario':''}</option>{/each}</select></label></section>
    {#if pantryDraft}<section><h2>{foods.find(f=>f.id===pantryDraft.food_id)?.name}</h2>
      <div class="row"><label>En casa <input type="number" min="0" step="any" bind:value={pantryDraft.stock}/></label><label>Unidad <input bind:value={pantryDraft.unit}/></label><label>Estado <select bind:value={pantryDraft.state}><option value="unspecified">Sin especificar</option><option value="raw">Crudo</option><option value="cooked">Cocido</option></select></label></div>
      <label>Categoría <select bind:value={pantryDraft.category}>{#each categories as c}<option value={c}>{c}</option>{/each}</select></label>
      <details><summary>Conversión crudo/cocido y presentaciones</summary><label>Densidad conocida (g/ml) <input type="number" min="0.001" step="any" value={pantryDraft.density_g_ml??''} on:input={e=>pantryDraft.density_g_ml=e.currentTarget.value===''?null:Number(e.currentTarget.value)}/></label>
      <label>Rendimiento conocido (peso cocido / peso crudo) <input type="number" min="0.001" step="any" value={pantryDraft.cooked_yield??''} on:input={e=>pantryDraft.cooked_yield=e.currentTarget.value===''?null:Number(e.currentTarget.value)}/></label>
      <div class="row"><label>Tamaño de presentación <input type="number" min="0.001" step="any" value={pantryDraft.package_size??''} on:input={e=>pantryDraft.package_size=e.currentTarget.value===''?null:Number(e.currentTarget.value)}/></label><label>Unidad de presentación <input bind:value={pantryDraft.package_unit}/></label><label>Nombre (paquete, lata…) <input bind:value={pantryDraft.package_label}/></label></div>
      <div class="row"><label>Precio por presentación <input type="number" min="0" step="any" value={pantryDraft.price??''} on:input={e=>pantryDraft.price=e.currentTarget.value===''?null:Number(e.currentTarget.value)}/></label><label>Moneda <input bind:value={pantryDraft.currency}/></label></div>
      </details><button on:click={()=>work(savePantry)}>Guardar</button>{#if pantryDoc}<button on:click={()=>work(async()=>{await removeDocument(pantryDoc);pantryDraft=null;})}>Retirar configuración</button>{/if}<button on:click={()=>pantryDraft=null}>Cancelar</button>
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
<Sheet bind:open={showException} title="Cambiar solo este día"><div class="exception-panel"><fieldset disabled={busy}>
      <p>Este cambio afecta únicamente a la fecha seleccionada.</p><label>Fecha <input type="date" bind:value={exceptionDate} on:change={()=>work(loadException)}/></label><button on:click={()=>work(loadException)}>Consultar excepción</button>
      <label><input type="checkbox" bind:checked={exceptionSkip}/>Dejar el día sin comidas</label>
      <label>Comida a cambiar <select bind:value={exceptionSlot} on:change={selectExceptionSlot}><option value="">Añadir comida</option>{#each exceptionBase?.slots||[] as s}<option value={s.slot_id}>{s.time} · {s.label}</option>{/each}</select></label>
      <label>Sustitución <select bind:value={exceptionChoice}><option value="">Quitar esta comida</option>{#each catalogue as c}<option value={c.key}>{c.name}</option>{/each}</select></label><label>Porciones <input type="number" min="0.001" step="any" bind:value={exceptionServings}/></label><div class="row"><label>Horario de esta fecha <input type="time" bind:value={exceptionTime}/></label><label>Nombre de esta comida <input bind:value={exceptionLabel}/></label><label>Tipo de día <select bind:value={exceptionDayType}><option value="">Usar plantilla</option><option value="training">Entrenamiento</option><option value="rest">Descanso</option><option value="recovery">Recuperación</option></select></label></div>
      <button on:click={()=>work(saveException)}>Guardar cambio de esta fecha</button>{#if exceptionDoc}<button on:click={()=>work(async()=>{await removeDocument(exceptionDoc);showException=false;})}>Volver a la semana recurrente</button>{/if}
</fieldset></div></Sheet>
<style>
  .editor-actions{display:flex;gap:8px;position:sticky;top:8px;z-index:3;background:var(--surface);padding:12px 0;border-bottom:1px solid var(--border)}.slot-editor{border:1px solid var(--border);border-radius:10px;padding:12px;margin:10px 0}.slot-editor summary{font-size:13px}.slot-editor summary span{display:block;font-size:12px;color:var(--text-2);margin-top:5px}.slot-editor .row{padding-top:12px}.add-slot{padding:16px 0;font-size:13px}
  .planning-page{max-width:1100px;margin:auto;padding:24px 20px 100px;color:var(--text)}h1{font-size:clamp(23px,3vw,30px);line-height:1.2;margin:4px 0}h2{font-size:21px;margin:4px 0}h3{font-size:16px;margin:6px 0}p{color:var(--text-2);font-size:13px;line-height:1.55;margin:6px 0;overflow-wrap:anywhere}.eyebrow{font-size:10px;letter-spacing:1.5px;font-weight:700;color:var(--text-2)}.page-heading,.section-heading,.week-summary,.next-action{display:flex;justify-content:space-between;gap:18px;align-items:center}.page-heading{margin-bottom:24px}.text-link,a{color:var(--accent);font-size:13px}nav,.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.main-nav{padding:5px;border:1px solid var(--border);border-radius:14px;background:var(--surface);margin-bottom:20px}.main-nav>button{border:0;background:none;padding:11px 18px;margin:0}.main-nav>button.active{background:var(--accent);color:var(--on-accent,#111);font-weight:700}.more-nav{margin-left:auto;position:relative}.more-nav summary{padding:10px;list-style:none}.more-nav>div{position:absolute;z-index:4;right:0;min-width:180px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:6px;box-shadow:0 10px 30px #0002}.more-nav button{display:block;width:100%;text-align:left}section{padding:18px;margin:16px 0;background:var(--surface);border:1px solid var(--border);border-radius:16px}.week-toolbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:0}.plan-select{flex:1;max-width:450px}.week-nav{display:flex;gap:12px;align-items:center}.week-nav>div{display:flex;flex-direction:column;align-items:center;font-size:14px}.quiet{background:none;border:0;padding:2px;font-size:11px;color:var(--text-2)}.week-summary{padding:14px 2px 20px}.week-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.week-day{border:1px solid var(--border);background:var(--surface);border-radius:14px;overflow:hidden}.week-day>summary{list-style:none;display:flex;flex-direction:column;gap:8px;padding:16px}.day-title{display:flex;justify-content:space-between;align-items:center;font-weight:700;text-transform:capitalize;font-size:15px}.day-title small{font-size:10px;font-weight:400;color:var(--accent)}.day-macros{font-size:12px;color:var(--text-2);font-weight:500}.day-foods{font-size:13px;color:var(--text-2);line-height:1.55}.expand-hint{font-size:11px;color:var(--text-2);margin-top:4px}.week-day[open] .expand-hint{display:none}.day-detail{border-top:1px solid var(--border);padding:4px 16px 14px}.meal-preview{border-bottom:1px solid var(--border);padding:12px 0}.meal-preview time{font-size:12px;color:var(--text-3)}.meal-preview strong{font-size:13px}.meal-preview details{font-size:12px}.next-action p{max-width:500px}.empty{text-align:center;padding:45px 24px}.empty p{max-width:430px;margin:12px auto 20px}.empty-icon{font-size:38px;color:var(--accent);margin-bottom:10px}.context-help{border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin:12px 0;background:var(--surface)}.context-help>summary{font-size:13px;font-weight:600}.shopping-actions{margin:16px 0}.shopping-actions details{font-size:13px}.shopping-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}.shopping-category{margin:0;padding:8px 16px}.shopping-category h3{padding:12px 0}.shopping-category small{color:var(--text-3);font-weight:400}.shopping-item{border-top:1px solid var(--border);padding:12px 0}.shopping-line{display:flex;align-items:center;gap:12px}.product{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}.product strong{font-size:14px;overflow-wrap:anywhere}.product small{font-size:11px;color:var(--text-2)}.buy-amount{font-size:13px;text-align:right;white-space:nowrap}.covered .product strong{text-decoration:line-through;color:var(--text-3)}.covered .buy-amount{font-weight:400;color:var(--text-3)}.product-details{padding-left:32px;margin-top:7px}.product-details>summary{font-size:11px;color:var(--text-2)}.item-editor{padding-top:8px}.hint{font-size:11px;color:var(--text-3)}progress{width:100%;height:5px;accent-color:var(--accent);border:0}.day-picker{display:flex;flex-wrap:wrap;gap:4px;margin:15px 0}.day-picker .active{border-color:var(--accent);color:var(--accent)}.day{padding:12px 0;border-block:1px solid var(--border)}.day>.row{align-items:end}.exception-panel{padding:0 20px 25px}label{display:flex;flex-direction:column;gap:6px;margin:8px 0;font-size:12px;color:var(--text-2)}button,input,select{font:inherit;font-size:13px;padding:10px 12px;border-radius:9px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);min-width:0;max-width:100%}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}.primary{background:var(--accent);color:var(--on-accent,#111);border-color:var(--accent);font-weight:600}.danger{color:var(--danger,#bd4040)}input[type=number]{max-width:140px}input[type=checkbox]{width:19px;height:19px;accent-color:var(--accent);flex-shrink:0}label:has(input[type=checkbox]){flex-direction:row;align-items:center}.section-heading{margin:20px 0}fieldset{border:0;padding:0;min-width:0}summary{cursor:pointer}details:focus-within,button:focus-visible,a:focus-visible{outline-offset:3px}.error{border:1px solid var(--danger,#bd4040);padding:12px;border-radius:10px;color:var(--danger,#bd4040)}.success{color:var(--accent)}.warning{color:var(--warning,#b98b30)}.loading{font-size:12px}article{padding:10px 0;border-top:1px solid var(--border)}@media(min-width:1000px){.week-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:650px){.planning-page{padding:18px 14px 100px}.page-heading{align-items:flex-start;gap:10px;padding-top:30px}.eyebrow{font-size:9px}.text-link{white-space:nowrap;font-size:11px}.main-nav{gap:0}.main-nav>button{padding:10px 12px;font-size:12px}.more-nav summary{font-size:12px}.week-toolbar{flex-direction:column;align-items:stretch;padding:12px}.plan-select{max-width:none}.week-nav{justify-content:space-between}.week-grid,.shopping-groups{grid-template-columns:1fr}.week-summary,.section-heading,.next-action{align-items:flex-start;flex-direction:column;gap:10px}.week-day>summary{padding:14px}.shopping-actions{gap:6px}.shopping-actions button{font-size:12px;padding:8px}.week-summary h2{font-size:20px}.day>.row{flex-direction:column;align-items:stretch}.day>.row>label input,.day>.row>label select{width:100%;max-width:none}.buy-amount{font-size:12px}section{padding:14px}}
</style>
