// Optional real-browser regression. Install Playwright separately, then set
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs and run with Node 20.
// Only an isolated temporary SQLite database is used; production is never read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {weekStart,weekEnd,shiftDate} from '../src/lib/planning-view.js';
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Mexico_City',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const start=weekStart(today),end=weekEnd(today);
const rangeLabel=(from,to)=>new Intl.DateTimeFormat('es-MX',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(from+'T12:00:00Z'))+' – '+new Intl.DateTimeFormat('es-MX',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(to+'T12:00:00Z'));
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-planning-browser-'));
const out=process.env.SCREENSHOT_DIR||fs.mkdtempSync(path.join(os.tmpdir(),'nt-planning-captures-'));fs.mkdirSync(out,{recursive:true});
Object.assign(process.env,{DB_PATH:path.join(dir,'fixture.db'),UPLOADS_PATH:path.join(dir,'uploads'),BACKUPS_PATH:path.join(dir,'backups'),JWT_SECRET:'synthetic-browser-test-only',NODE_ENV:'test',INSECURE_COOKIES:'1',BODY_MEASUREMENTS_SOURCE:'gym-log'});
const {default:db}=await import('../server/db.js');
const {planningService:s}=await import('../server/lib/planning-service.js');
const {signToken}=await import('../server/middleware/auth.js');
const u=Number(db.prepare("INSERT INTO users(username,password_hash,role,full_name)VALUES('browser-test','synthetic','admin','Prueba local')").run().lastInsertRowid);
const food=(name,unit,portion,nutrition,category)=>Number(db.prepare('INSERT INTO foods(user_id,name,unit,portion,nutrition,category) VALUES(?,?,?,?,?,?)').run(u,name,unit,portion,JSON.stringify(nutrition),category).lastInsertRowid);
const tortilla=food('Tortillas de maíz','piece',1,{calories:60,proteins:1.5},'cereales');
const milk=food('Leche','ml',250,{calories:150,proteins:8},'lácteos');
const chicken=food('Pollo','g',100,{calories:120,proteins:22},'carnes');
let seq=0;const meta=rev=>({expected_revision:rev||0,idempotency_key:'browser-key-'+(++seq)});
const meal=s.execute(u,'save_catalog_meal',{data:{name:'Tacos de pollo con tortillas',items:[{food_id:tortilla,portion:3,unit:'piece'},{food_id:chicken,portion:150,unit:'g'}]},...meta()});
const template=s.execute(u,'save_planning_template',{data:{name:'Mi menú semanal · prueba local',status:'active',starts_on:start,days:Array.from({length:7},()=>({slots:[{slot_id:'breakfast',type:'food',id:milk,servings:1,label:'Desayuno',time:'08:00'},{slot_id:'dinner',type:'meal',id:meal.id,servings:1,label:'Cena',time:'21:15'}]}))},...meta()});
s.execute(u,'generate_shopping_list',{name:'Compras de prueba',template_id:template.id,from:start,to:end,...meta()});
for(const [key,value] of Object.entries({setupComplete:true,theme:'dark',language:'es',locale:'es',mealNames:['Desayuno','Comida','Cena','Snacks'],wellnessEnabled:false,updateCheckEnabled:false}))db.prepare('INSERT INTO user_settings(user_id,key,value) VALUES(?,?,?)').run(u,key,JSON.stringify(value));
const token=signToken({id:u,username:'browser-test',role:'admin'});
const emptyUser=Number(db.prepare("INSERT INTO users(username,password_hash,role)VALUES('browser-empty','synthetic','user')").run().lastInsertRowid);
const emptyToken=signToken({id:emptyUser,username:'browser-empty',role:'user'});db.close();
const distLink=path.join(root,'server/dist');let madeLink=false,server,browser;
try{
 if(!fs.existsSync(distLink)){fs.symlinkSync(path.join(root,'dist'),distLink,'dir');madeLink=true;}
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const log=fs.openSync(path.join(dir,'server.log'),'w');
 server=spawn(process.execPath,['server/index.js'],{cwd:root,env:{...process.env,PORT:String(port)},stdio:['ignore',log,log]});fs.closeSync(log);
 const base='http://127.0.0.1:'+port;
 for(let n=0;;n++){try{if((await fetch(base+'/api/auth/status')).ok)break;}catch{}if(n>100)throw new Error('Server failed to start: '+fs.readFileSync(path.join(dir,'server.log'),'utf8'));await new Promise(r=>setTimeout(r,150));}
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'America/Mexico_City',locale:'es-MX',serviceWorkers:'block'});
 await context.addCookies([{name:'nt_token',value:token,url:base}]);
 await context.addInitScript(()=>localStorage.setItem('wl:setupComplete','true'));
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/#/planning');await page.getByRole('heading',{name:'Mi menú semanal · prueba local',exact:true}).waitFor();
 assert.equal(await page.locator('.week-day').count(),7);assert.equal(await page.locator('.week-day[open]').count(),0);
 await page.screenshot({path:path.join(out,'week-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'Semana siguiente',exact:true}).click();await page.getByText(rangeLabel(shiftDate(start,7),shiftDate(end,7)),{exact:true}).waitFor();
 await page.getByRole('button',{name:'Semana anterior',exact:true}).click();await page.getByText(rangeLabel(start,end),{exact:true}).waitFor();
 await page.getByRole('button',{name:'Compras',exact:true}).click();await page.locator('.shopping-item').first().waitFor();
 await page.getByLabel('Comprado Leche',{exact:true}).check();await page.locator('.shopping-item.covered').first().waitFor();
 const item=page.locator('.shopping-item').filter({hasText:'Tortillas de maíz'});await item.locator('summary').click();
 await item.getByLabel('Ya compré (pzas)',{exact:true}).fill('3');await item.getByLabel('Ya compré (pzas)',{exact:true}).press('Tab');await item.getByText('Compra parcial: 3 pzas',{exact:true}).waitFor();
 await item.getByLabel('Comprar en total (pzas)',{exact:true}).fill('25');await item.getByLabel('Comprar en total (pzas)',{exact:true}).press('Tab');await item.locator('.buy-amount').filter({hasText:'22'}).waitFor();
 await page.getByRole('button',{name:'Actualizar desde el menú',exact:true}).click();await item.locator('.buy-amount').filter({hasText:'22'}).waitFor();
 await page.screenshot({path:path.join(out,'shopping-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await item.locator('summary').click();await page.getByRole('heading',{name:/Compras ·/}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'shopping-mobile.png'),fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'shopping mobile overflow');
 await page.getByRole('button',{name:'Mi semana',exact:true}).click();await page.screenshot({path:path.join(out,'week-mobile.png'),fullPage:true});
 await page.locator('.week-day').nth(1).locator('summary').first().click();await page.getByRole('link',{name:'Abrir en Diario',exact:true}).click();
 await page.locator('.planned-meals article').first().waitFor();await page.waitForFunction(()=>document.querySelector('.planned-meals')?.getAttribute('aria-busy')==='false');
 assert.equal(await page.locator('.planned-meals article').count(),2);
 await page.locator('.planned-meals').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'diary-mobile.png'),fullPage:true});
 const breakfast=page.locator('.planned-meals article').filter({hasText:'Desayuno'});
 await breakfast.getByRole('button',{name:'Registrar como consumida',exact:true}).click();await breakfast.getByText('Registrada',{exact:true}).waitFor();
 await page.reload();await breakfast.getByText('Registrada',{exact:true}).waitFor();assert.equal(await breakfast.getByRole('button',{name:'Registrar como consumida',exact:true}).count(),0);
 const dinner=page.locator('.planned-meals article').filter({hasText:'Cena'});await dinner.getByRole('button',{name:'Ajustar',exact:true}).click();
 await page.getByLabel('Cantidad (pzas)',{exact:true}).fill('2');await page.getByRole('button',{name:'Registrar consumo ajustado',exact:true}).click();await dinner.getByText('Modificada',{exact:true}).waitFor();
 await dinner.locator('summary').filter({hasText:'Editar consumo'}).click();await dinner.getByRole('button',{name:'Tortillas de maíz',exact:true}).click();await page.getByRole('button',{name:/save|guardar/i}).first().waitFor();
 await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(out,'edit-consumption-desktop.png'),fullPage:true});
 await page.locator('.sheet-panel [data-field="portion"]').fill('1');await page.getByRole('button',{name:/^(save|guardar)$/i}).click();
 await page.locator('.plan-totals').getByText('390 kcal',{exact:true}).waitFor();await page.reload();await page.locator('.plan-totals').getByText('390 kcal',{exact:true}).waitFor();
 await page.locator('.planned-meals').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,'diary-desktop.png'),fullPage:true});
 await page.goto(base+'/#/planning');await page.locator('.week-summary').getByRole('button',{name:'Editar plan',exact:true}).click();await page.getByRole('heading',{name:'Editar plantilla',exact:true}).waitFor();
 assert.equal(await page.locator('.day:visible').count(),1);assert.equal(await page.locator('.slot-editor[open]').count(),0);await page.getByRole('button',{name:'Guardar plan',exact:true}).waitFor();await page.screenshot({path:path.join(out,'editor-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'editor mobile overflow');await page.screenshot({path:path.join(out,'editor-mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'Mi semana',exact:true}).click();await page.getByRole('heading',{name:'Mi menú semanal · prueba local',exact:true}).waitFor();
 await page.locator('.week-day').nth(2).locator('summary').first().click();await page.getByRole('link',{name:'Abrir en Diario',exact:true}).click();
 await page.locator('.planned-meals article').first().waitFor();await page.waitForFunction(()=>document.querySelector('.planned-meals')?.getAttribute('aria-busy')==='false');
 await page.locator('.planned-meals article').filter({hasText:'Desayuno'}).getByRole('button',{name:'Omitir',exact:true}).click();await page.locator('.planned-meals').getByText('Omitida',{exact:true}).waitFor();
 assert(await page.locator('.plan-totals').innerText().then(t=>t.includes('0 kcal')));
 await page.route('**/api/planning/get_planned_nutrition',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fallo de prueba: vuelve a consultar.'})}));
 await page.goto(base+'/#/planning');await page.getByRole('alert').filter({hasText:'Fallo de prueba'}).waitFor();
 await page.unroute('**/api/planning/get_planned_nutrition');await page.getByRole('button',{name:'Volver a consultar',exact:true}).click();await page.getByRole('heading',{name:'Mi menú semanal · prueba local',exact:true}).waitFor();
 const emptyContext=await browser.newContext({viewport:{width:390,height:844},timezoneId:'America/Mexico_City',serviceWorkers:'block'});await emptyContext.addCookies([{name:'nt_token',value:emptyToken,url:base}]);
 const emptyPage=await emptyContext.newPage();emptyPage.on('pageerror',e=>errors.push(e.message));
 await emptyPage.goto(base+'/#/planning');await emptyPage.getByRole('heading',{name:'Tu semana empieza aquí',exact:true}).waitFor();await emptyPage.screenshot({path:path.join(out,'empty-mobile.png'),fullPage:true});
 await emptyPage.goto(base+'/#/diary');await emptyPage.getByText('No tienes un plan activo para esta fecha.',{exact:false}).waitFor();await emptyContext.close();
 assert.deepEqual(errors,[],'browser runtime errors');
 console.log(JSON.stringify({passed:true,screenshots:out,checks:['week navigation','collapsed days','shopping checkbox','partial purchases','manual override','regeneration','mobile overflow','Diary date link','consume','refresh without duplicate','adjust ingredients','edit actual diary','single-day editor','skip without calories','server error and retry','empty plan','no browser runtime errors']},null,2));
}finally{
 if(browser)await browser.close();if(server&&server.exitCode===null&&server.signalCode===null){server.kill();await new Promise(r=>server.once('exit',r));}
 if(madeLink)fs.unlinkSync(distLink);
 fs.rmSync(dir,{recursive:true,force:true});
}
