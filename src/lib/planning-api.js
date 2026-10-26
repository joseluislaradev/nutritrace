import { apiUrl, getAuthToken, isNative, getNativeMode } from './platform.js';

const uncertainWrites=new Map();
let accountScope;

// Explicit server operations: never let an offline mirror acknowledge a write
// that the MCP resource server cannot yet see.
export async function planningCall(command,input={}) {
  if(isNative && getNativeMode()==='local')throw new Error('La planificación necesita una conexión con tu servidor NutriTrace.');
  const account=localStorage.getItem('wl:userId');
  if(account!==accountScope){uncertainWrites.clear();accountScope=account;}
  const args={...input};
  let intent;
  if(args.idempotency_key){
    const {idempotency_key,...data}=args;
    intent=command+JSON.stringify(data,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
    args.idempotency_key=uncertainWrites.get(intent)||idempotency_key;
    uncertainWrites.set(intent,args.idempotency_key);
  }
  const headers={'Content-Type':'application/json'};
  const token=isNative?getAuthToken():null;
  if(token)headers.Authorization='Bearer '+token;
  const csrf=localStorage.getItem('nt:csrf');if(csrf)headers['X-CSRF-Token']=csrf;
  const response=await fetch(apiUrl('/api/planning/'+command),{method:'POST',headers,credentials:'include',cache:'no-store',body:JSON.stringify(args)});
  const data=await response.json();
  if(response.ok || (response.status>=400 && response.status<500))uncertainWrites.delete(intent);
  if(!response.ok)throw new Error(data.error||'No se pudo guardar. Tus cambios del formulario se conservan.');
  return data;
}
export const mutation=revision=>({expected_revision:revision||0,idempotency_key:crypto.randomUUID()});
