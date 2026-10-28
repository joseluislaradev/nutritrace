<script>
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import {displayUnit} from '../../lib/planning-view.js';
  import Sheet from '../ui/Sheet.svelte';
  import { planningCall as call, mutation } from '../../lib/planning-api.js';
  export let date;
  export let entry = null;
  export let mealNames = [];
  const dispatch = createEventDispatcher();
  const statuses={pending:'Pendiente',consumed:'Registrada',modified:'Modificada',skipped:'Omitida'};
  let view=null,selected='',loading=false,saving=false,error='',mounted=false,serial=0;
  let editing=null,adjustments=[],replacement='',catalogue=[],meal=0;
  const fmt=n=>n==null?'—':Number(n).toLocaleString('es-MX',{maximumFractionDigits:0});
  $: if(mounted) refresh(date,entry,selected);
  onMount(()=>{mounted=true;});
  onDestroy(()=>{mounted=false;serial++;});
  async function refresh(day,_entry,template) {
    const request=++serial;loading=true;error='';if(view?.date!==day)view=null;
    try {const result=await call('get_diary_plan',{date:day,...(template?{template_id:template}:{})});
      if(request===serial){view=result;editing=null;}}
    catch(e){if(request===serial){error=e.message;view=null;}}
    finally{if(request===serial)loading=false;}
  }
  function defaultMeal(slot) {
    const match=mealNames.findIndex(n=>n.toLocaleLowerCase()===slot.label.toLocaleLowerCase());
    return match>=0?match: Number(slot.time.slice(0,2))<11?0:Number(slot.time.slice(0,2))<17?1:Number(slot.time.slice(0,2))<20?Math.min(3,mealNames.length-1):Math.min(2,mealNames.length-1);
  }
  async function edit(slot) {
    error='';editing=slot;meal=Math.max(0,defaultMeal(slot));replacement='';
    adjustments=slot.preview.items.map(i=>({portion:i.portion,quantity:i.quantity,omit:false}));
    if(!catalogue.length)try {
      for(let offset=0;;offset+=200){const p=await call('get_planning_catalog',{limit:200,offset});
        catalogue=[...catalogue,...p.foods.map(f=>({...f,type:'food'})),...p.meals.map(m=>({...m,type:'meal'}))];
        if(p.foods.length<200&&p.meals.length<200)break;}
    }catch(e){error=e.message;}
  }
  async function record(slot,action,adjust=false) {
    if(saving || loading)return;saving=true;error='';
    const day=date;
    try {
      const changes=adjust?adjustments.flatMap((a,index)=>{
        const original=slot.preview.items[index];
        return a.omit||Number(a.portion)!==Number(original.portion)||Number(a.quantity)!==Number(original.quantity)
          ?[{index,...(a.portion!=null?{portion:Number(a.portion)}:{}),quantity:Number(a.quantity),omit:a.omit}]:[];
      }):[];
      const [type,id]=replacement.split(':');
      const result=await call('record_planned_meal',{date:day,template_id:slot.template_id,slot_id:slot.slot_id,action,
        meal:adjust?Number(meal):Math.max(0,defaultMeal(slot)),expected_plan_revision:slot.plan_revision,
        expected_items_revision:view.items_revision,...mutation(slot.state_revision),
        ...(adjust&&id?{replacement:{type,id:Number(id),servings:1}}:changes.length?{adjustments:changes}:{})});
      if(date===day){view=result.view;editing=null;dispatch('recorded',{date:day});}
    }catch(e){error=e.message;}
    finally{saving=false;}
  }
</script>

<section class="planned-meals" aria-label="Comidas planificadas" aria-busy={loading||saving}>
  <header><div><h2>Tu menú del día</h2><p>{view?.template?.name||'Planificación diaria'}</p></div><a href="#/planning">Ver semana →</a></header>
  {#if error}<div role="alert" class="plan-error">{error} <button disabled={saving} on:click={()=>refresh(date,entry,selected)}>Volver a consultar</button></div>{/if}
  {#if loading&&!view}<p role="status">Consultando tu menú…</p>
  {:else if view}
    {#if view.needs_selection}<label>¿Qué plan quieres consultar?<select bind:value={selected}><option value="">Selecciona un plan</option>{#each view.templates as t}<option value={t.id}>{t.name}</option>{/each}</select></label>{/if}
    {#if view.slots.length}
      <div class="plan-totals"><span>Planificado <b>{fmt(view.planned_totals.calories)} kcal</b></span><span>Consumido hoy <b>{fmt(view.consumed_totals.calories??(view.consumed_count===0?0:null))} kcal</b></span></div>
      <p class="hint">El menú es una guía. Solo lo que registres cuenta como consumido.</p>
      {#each view.slots as slot (slot.occurrence_id)}
        <article class:done={slot.status==='consumed'}>
          <div class="slot-heading"><time>{slot.time}</time><div><strong>{slot.label}</strong><p>{slot.preview?.name||'Comida no disponible'}</p></div><span class="status">{statuses[slot.status]}</span></div>
          <div class="slot-bottom"><span class="hint">{fmt(slot.preview?.nutrition.calories)} kcal · {fmt(slot.preview?.nutrition.proteins)} g proteína{slot.preview?.incomplete_nutrients?.length?' · estimación parcial':''}</span>
            <div class="actions">
              {#if !slot.removed_from_plan && (slot.status==='pending'||slot.status==='skipped')}
                <button class="btn btn-primary" disabled={saving||view.day_deleted||!!slot.unavailable} on:click={()=>record(slot,'consume')}>Registrar como consumida</button>
                <button class="btn btn-ghost" disabled={saving||!!slot.unavailable} on:click={()=>edit(slot)}>Ajustar</button>
                {#if slot.status!=='skipped'}<button class="btn btn-ghost" disabled={saving||!!slot.unavailable} on:click={()=>record(slot,'skip')}>Omitir</button>{/if}
              {:else}
                {#if slot.actual_entries.length>1}<details class="actual-entries"><summary>Editar consumo</summary><div>{#each slot.actual_entries as actual}<button class="btn btn-ghost" on:click={()=>dispatch('edit',{uuid:actual.uuid})}>{actual.name}</button>{/each}</div></details>
                {:else if slot.actual_entries.length}<button class="btn btn-ghost" on:click={()=>dispatch('edit',{uuid:slot.actual_entries[0].uuid})}>Editar consumo</button>{/if}
              {/if}
            </div>
          </div>
          {#if slot.unavailable}<p class="hint">{slot.unavailable}</p>{/if}
          <!-- Actual snapshots stay fixed when a plan is edited later. -->
          {#if slot.changed_since_recording}<p class="hint">El menú cambió después de este registro. Lo que consumiste se conserva en el diario.</p>{/if}
          {#if slot.removed_from_plan}<p class="hint">Este consumo pertenece a una versión anterior del menú.</p>{/if}
          {#if slot.missing_entries}<p class="hint">Las entradas se retiraron del diario. No se volverán a registrar automáticamente.</p>{/if}
        </article>
      {/each}
    {:else if !view.needs_selection}<p class="hint">{view.template?'No hay comidas programadas para esta fecha.':'No tienes un plan activo para esta fecha.'} Puedes registrar alimentos normalmente o <a href="#/planning">preparar tu semana</a>.</p>{/if}
  {/if}
</section>
<Sheet open={!!editing} title="Ajustar lo que consumiste" on:close={()=>{if(!saving)editing=null;}}>
  {#if editing}<div class="adjust-panel">
    <p>{editing.label} · {editing.preview.name}</p><p class="hint">Estos cambios solo se guardan en tu diario.</p>
    <label>Comida del diario<select bind:value={meal}>{#each mealNames as name,i}<option value={i}>{name}</option>{/each}</select></label>
    <label>¿Comiste otra cosa?<select bind:value={replacement}><option value="">Conservar comida y ajustar ingredientes</option>{#each catalogue as c}<option value={`${c.type}:${c.id}`}>{c.name}</option>{/each}</select></label>
    {#if replacement}<p class="hint">Se registrará una porción del alimento o comida seleccionado.</p>{:else}
      {#each editing.preview.items as item,i}<div class="ingredient"><strong>{item.name}</strong><div class="actions">
        <label>Cantidad ({displayUnit(item.unit)})<input type="number" min="0.001" step="any" bind:value={adjustments[i].portion}/></label>
        <label>Porciones<input type="number" min="0.001" step="any" bind:value={adjustments[i].quantity}/></label>
        <label class="omit"><input type="checkbox" bind:checked={adjustments[i].omit}/>No lo consumí</label>
      </div></div>{/each}
    {/if}
    {#if error}<p role="alert" class="plan-error">{error}</p>{/if}
    <button class="btn btn-primary" disabled={saving||loading} on:click={()=>record(editing,'consume',true)}>{saving?'Guardando…':'Registrar consumo ajustado'}</button>
  </div>{/if}
</Sheet>
<style>
  .actual-entries{position:relative;font-size:12px}.actual-entries summary{cursor:pointer;padding:9px}.actual-entries>div{position:absolute;right:0;z-index:4;min-width:190px;padding:6px;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 6px 20px #0002}.actual-entries button{display:block;text-align:left;width:100%}
  .planned-meals{margin:0 0 20px;padding:18px;border:1px solid var(--border);border-radius:var(--radius-lg,16px);background:var(--surface)}header,.slot-heading,.slot-bottom,.actions,.plan-totals{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header,.slot-bottom{justify-content:space-between}h2{font-size:17px;margin:0}p{margin:5px 0}header p,.hint{font-size:12px;color:var(--text-2)}a{color:var(--accent);font-size:13px}article{padding:14px 0;border-top:1px solid var(--border)}article:first-of-type{margin-top:12px}.slot-heading>div{flex:1;min-width:120px}time{font-size:13px;font-variant-numeric:tabular-nums;color:var(--text-2)}.status{font-size:11px;padding:4px 8px;background:var(--surface-2);border-radius:20px}.done .status{color:var(--text);border:1px solid var(--accent)}.slot-bottom{margin-top:8px}.actions{gap:6px}.actions .btn{font-size:12px;min-height:36px}.plan-totals{padding-top:12px;font-size:12px}.plan-totals span{display:flex;flex-direction:column;gap:3px;min-width:130px}.plan-totals b{font-size:16px}.plan-error{color:var(--danger,#c64c4c);font-size:13px}label{display:flex;flex-direction:column;gap:5px;font-size:13px;margin:10px 0}input,select{font:inherit;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:9px;max-width:100%;min-width:0}.adjust-panel{padding:0 20px 28px}.ingredient{border-top:1px solid var(--border);padding:10px 0}.ingredient input[type=number]{width:100px}.omit{flex-direction:row;align-items:center}@media(max-width:600px){.slot-bottom{display:block}.actions{margin-top:8px}.planned-meals{padding:14px}.slot-heading{gap:8px}}
</style>
