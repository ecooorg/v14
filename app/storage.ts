/** v15 personal storage: session cache or verified Google Drive appDataFolder. */
import { migrateV14ToV15 } from './migration';
export type StorageMode='session'|'google_drive'|null;
export type StorageErrorCode='MISSING_CONFIG'|'OAUTH_DENIED'|'GIS_MISSING'|'API_UNAVAILABLE'|'PERMISSION_DENIED'|'WRITE_FAILED'|'READ_FAILED'|'SCHEMA_INVALID'|'CONFLICT'|'UNKNOWN';
export type StorageStatus={provider:'google_drive'|'session'|null;configStatus:'CONFIGURED'|'MISSING';authStatus:'AUTHORIZED'|'DENIED'|'UNKNOWN';healthStatus:'HEALTHY'|'UNAVAILABLE'|'UNKNOWN';libraryStatus:'VERIFIED'|'UNVERIFIED'|'FAILED';syncStatus:'SYNCED'|'ERROR'|'PENDING'|'UNVERIFIED';libraryFileId?:string;lastSyncedAt?:number;lastErrorCode?:StorageErrorCode;schemaVersion:15};
export type StorageHealth={ok:true;libraryFileId?:string;checkedAt:number}|{ok:false;code:StorageErrorCode;message:string};
export type SyncResult={ok:true;status:StorageStatus}|{ok:false;status:StorageStatus;code:StorageErrorCode;message:string};
export type DialogMeta={id:string;title:string;createdAt:number;updatedAt:number;pinned?:boolean;archived?:boolean;phase:string;lastSnippet?:string;overdueCheckIn?:boolean};
export type DialogRecord=DialogMeta & {messages:{id:string;role:'user'|'agent';text:string;at:number}[];state:unknown;cycleCount?:number};
export type Library={version:15;schemaVersion:15;dialogs:DialogRecord[];settings:{mode:'normal'|'expert';storageMode:StorageMode;userGeminiKey?:string;privacyAccepted?:boolean};};
const SESSION_KEY='be_v15_session_library', MODE_KEY='be_v15_storage_mode', PRIVACY_KEY='be_v15_privacy', DRIVE_TOKEN_KEY='be_v15_drive_token', DRIVE_FILE_NAME='bifurcation-v15-library.json';
let memoryLib:Library|null=null; let accessToken:string|null=null;
let status:StorageStatus={provider:null,configStatus:'MISSING',authStatus:'UNKNOWN',healthStatus:'UNKNOWN',libraryStatus:'UNVERIFIED',syncStatus:'UNVERIFIED',schemaVersion:15};
const env=()=>{try{return (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID||''}catch{return ''}};
export function getGoogleClientId(){return env()} export function isDriveConfigured(){return Boolean(env())};
export function getStorageMode():StorageMode{const m=localStorage.getItem(MODE_KEY);return m==='session'||m==='google_drive'?m:null}
export function setStorageMode(m:StorageMode){if(m)localStorage.setItem(MODE_KEY,m);else localStorage.removeItem(MODE_KEY);status.provider=m}
export function getStorageStatus(): StorageStatus { return {...status, configStatus: isDriveConfigured() ? 'CONFIGURED' : 'MISSING'}; }
export function isGoogleConnected(){return status.authStatus==='AUTHORIZED' && status.libraryStatus==='VERIFIED' && status.healthStatus==='HEALTHY' && status.syncStatus==='SYNCED'}
export function isGoogleDriveActive(){return getStorageMode()==='google_drive' && isGoogleConnected()}
export function setGoogleAccessToken(token:string|null){accessToken=token;status={...status,authStatus:token?'AUTHORIZED':'UNKNOWN',syncStatus:token?'PENDING':'UNVERIFIED'};try{token?sessionStorage.setItem(DRIVE_TOKEN_KEY,token):sessionStorage.removeItem(DRIVE_TOKEN_KEY)}catch{}}
export function restoreGoogleTokenFromSession(){try{const t=sessionStorage.getItem(DRIVE_TOKEN_KEY);if(t){accessToken=t;status={...status,authStatus:'AUTHORIZED',syncStatus:'PENDING'}}}catch{}}
export function emptyLibrary(storageMode:StorageMode):Library{return {version:15,schemaVersion:15,dialogs:[],settings:{mode:'normal',storageMode,privacyAccepted:true}}}
function valid(v:any):v is Library{return Boolean(v&&v.version===15&&v.schemaVersion===15&&Array.isArray(v.dialogs)&&v.settings)}
async function driveFileId():Promise<string|null>{
  if(!accessToken) return null;
  const q=encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const r=await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)`,{headers:{Authorization:`Bearer ${accessToken}`}});
  if(!r.ok) throw Object.assign(new Error('Drive API unavailable'),{code:r.status===401||r.status===403?'PERMISSION_DENIED':'API_UNAVAILABLE'});
  const j=await r.json(); return j.files?.[0]?.id||null;
}
async function upload(lib:Library,id?:string){
  const metadata:any={name:DRIVE_FILE_NAME}; if(!id)metadata.parents=['appDataFolder'];
  const form=new FormData();form.append('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}));form.append('file',new Blob([JSON.stringify(lib)],{type:'application/json'}));
  const url=id?`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=multipart`:'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  const r=await fetch(url,{method:id?'PATCH':'POST',headers:{Authorization:`Bearer ${accessToken}`},body:form}); if(!r.ok)throw Object.assign(new Error('Drive write failed'),{code:'WRITE_FAILED'}); return (await r.json()).id as string;
}
async function read(id:string):Promise<Library>{const r=await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`,{headers:{Authorization:`Bearer ${accessToken}`}});if(!r.ok)throw Object.assign(new Error('Drive read failed'),{code:'READ_FAILED'});const j=await r.json();if(j.version===14)return migrateV14ToV15(j);if(!valid(j))throw Object.assign(new Error('Invalid library schema'),{code:'SCHEMA_INVALID'});return j}
export async function healthCheck():Promise<StorageHealth>{
  if(!isDriveConfigured()){status={...status,configStatus:'MISSING',healthStatus:'UNAVAILABLE',lastErrorCode:'MISSING_CONFIG'};return {ok:false,code:'MISSING_CONFIG',message:'Google Client ID is missing from deployment configuration.'}}
  if(!accessToken){status={...status,authStatus:'DENIED',lastErrorCode:'OAUTH_DENIED'};return {ok:false,code:'OAUTH_DENIED',message:'Google authorization is required.'}}
  try{status={...status,configStatus:'CONFIGURED',authStatus:'AUTHORIZED'};let id=await driveFileId();if(!id){id=await upload(emptyLibrary('google_drive'));status={...status,libraryFileId:id,libraryStatus:'VERIFIED'}}else status={...status,libraryFileId:id};
    const current=await read(id); const verifyId=await upload(current,id); if(verifyId!==id)throw Object.assign(new Error('Write verification failed'),{code:'WRITE_FAILED'}); const back=await read(id); if(!valid(back))throw Object.assign(new Error('Read-back schema invalid'),{code:'SCHEMA_INVALID'});
    status={...status,healthStatus:'HEALTHY',libraryStatus:'VERIFIED',syncStatus:'SYNCED',libraryFileId:id,lastSyncedAt:Date.now(),lastErrorCode:undefined};return {ok:true,libraryFileId:id,checkedAt:Date.now()};
  }catch(e:any){const code=(e.code||'UNKNOWN') as StorageErrorCode;status={...status,healthStatus:'UNAVAILABLE',libraryStatus:code==='SCHEMA_INVALID'?'FAILED':'UNVERIFIED',syncStatus:'ERROR',lastErrorCode:code};return {ok:false,code,message:e.message||'Drive check failed'}}
}
export async function connectGoogleDrive(){const token=await requestGoogleDriveToken();setGoogleAccessToken(token);return healthCheck()}
export async function loadLibrary():Promise<Library>{const mode=getStorageMode();if(mode==='session'){try{const raw=sessionStorage.getItem(SESSION_KEY);if(raw){const j=JSON.parse(raw);if(j.version===14)return migrateV14ToV15(j);if(valid(j))return memoryLib=j}}catch{} memoryLib=emptyLibrary('session');return memoryLib}
  if(mode==='google_drive'&&accessToken&&status.healthStatus==='HEALTHY'){try{const id=status.libraryFileId||await driveFileId();if(id){const remote=await read(id);try{localStorage.setItem('be_v15_drive_cache',JSON.stringify(remote))}catch{};status={...status,libraryFileId:id,syncStatus:'SYNCED'};return remote}}catch{}}
  try{const raw=localStorage.getItem('be_v15_drive_cache');if(raw){const j=JSON.parse(raw);return j.version===14?migrateV14ToV15(j):j}}catch{} return emptyLibrary(mode);
}
function cache(lib:Library){try{localStorage.setItem('be_v15_drive_cache',JSON.stringify(lib))}catch{} }
export async function saveLibrary(lib:Library):Promise<SyncResult>{const mode=getStorageMode();if(mode==='session'){memoryLib=lib;try{sessionStorage.setItem(SESSION_KEY,JSON.stringify(lib))}catch{};return {ok:true,status:getStorageStatus()}}
  if(mode!=='google_drive'){return {ok:true,status:getStorageStatus()}} cache(lib); if(!accessToken||status.healthStatus!=='HEALTHY')return {ok:false,status:getStorageStatus(),code:'API_UNAVAILABLE',message:'Drive is not verified; local cache retained.'};
  try{const id=status.libraryFileId||await driveFileId();if(!id)throw Object.assign(new Error('Library missing'),{code:'WRITE_FAILED'});const remote=await read(id);const localMax=Math.max(0,...lib.dialogs.map(d=>d.updatedAt)),remoteMax=Math.max(0,...remote.dialogs.map(d=>d.updatedAt));if(remoteMax>localMax)throw Object.assign(new Error('Remote library is newer'),{code:'CONFLICT'});await upload(lib,id);const back=await read(id);if(JSON.stringify(back)!==JSON.stringify(lib))throw Object.assign(new Error('Read-back mismatch'),{code:'READ_FAILED'});status={...status,syncStatus:'SYNCED',libraryStatus:'VERIFIED',lastSyncedAt:Date.now(),lastErrorCode:undefined};return {ok:true,status:getStorageStatus()}}
  catch(e:any){const code=(e.code||'UNKNOWN') as StorageErrorCode;status={...status,syncStatus:'ERROR',lastErrorCode:code};return {ok:false,status:getStorageStatus(),code,message:e.message||'Drive sync failed'}}
}
export function exportLibraryJson(lib:Library){return JSON.stringify(lib,null,2)}
export function importLibraryJson(raw:string,existing:Library):Library{const incoming:any=JSON.parse(raw);const migrated=incoming.version===14?migrateV14ToV15(incoming):incoming;if(!valid(migrated))throw new Error('Invalid library file');const byId=new Map(existing.dialogs.map(d=>[d.id,d]));for(const d of migrated.dialogs){const p=byId.get(d.id);if(!p||d.updatedAt>=p.updatedAt)byId.set(d.id,d)}return {...existing,dialogs:[...byId.values()].sort((a,b)=>b.updatedAt-a.updatedAt)}}
export function privacyAccepted(){return localStorage.getItem(PRIVACY_KEY)==='1'} export function setPrivacyAccepted(){localStorage.setItem(PRIVACY_KEY,'1')} export function newId(){return crypto.randomUUID()}
let gisLoading:Promise<void>|null=null;export function loadGoogleIdentityScript(){if(typeof window==='undefined')return Promise.resolve();if((window as any).google)return Promise.resolve();if(gisLoading)return gisLoading;gisLoading=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://accounts.google.com/gsi/client';s.async=true;s.onload=()=>resolve();s.onerror=()=>reject(new Error('GIS_MISSING'));document.head.appendChild(s)});return gisLoading}
export function requestGoogleDriveToken():Promise<string>{const clientId=getGoogleClientId();if(!clientId){status={...status,configStatus:'MISSING',lastErrorCode:'MISSING_CONFIG'};return Promise.reject(new Error('MISSING_CONFIG'))}return loadGoogleIdentityScript().then(()=>new Promise((resolve,reject)=>{const g=(window as any).google;if(!g){reject(new Error('GIS_MISSING'));return}try{const client=g.accounts.oauth2.initTokenClient({client_id:clientId,scope:'https://www.googleapis.com/auth/drive.appdata',callback:(r:any)=>{if(r.error||!r.access_token){reject(new Error(r.error||'OAUTH_DENIED'));return}setGoogleAccessToken(r.access_token);resolve(r.access_token)}});client.requestAccessToken()}catch{reject(new Error('TOKEN_ERROR'))}}))}
