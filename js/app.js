import { Store } from './storage.js';
import { Viewer } from './viewer.js';
import { OCR } from './ocr.js';
import { Rules } from './rules.js';
import { Exporter } from './exporter.js';

const $ = (s, r=document)=>r.querySelector(s);

// --- App State --------------------------------------------------------------
const store = new Store('sw-signage-projects-v3');
let projects = await store.load();
let currentId = projects[0]?.id || null;
let ocrIndex = {}; // pageKey -> text

const viewer = new Viewer({ onPinDrop: handlePinDrop, onPageChange: ()=>{ renderPageBadge(); } });
const ocr = new OCR();
const rules = new Rules();
const exporter = new Exporter();

function getProject(){ return projects.find(p=>p.id===currentId) }
function save(){ store.save(projects); renderProjects(); }
function uuid(){ return 'p-' + Math.random().toString(36).slice(2,9) }
function pageKey(){ return (getProject()?.id||'')+':'+viewer.pageIndex }

// --- UI Wiring --------------------------------------------------------------
$('#btnNew').onclick = ()=>{ createProject($('#projectName').value.trim()||'Untitled'); $('#projectName').value=''; };
$('#btnSave').onclick = ()=> save();
$('#building').onchange = ()=> updateProject({building: $('#building').value});
$('#level').onchange = ()=> updateProject({level: $('#level').value});
$('#btnZoomIn').onclick = ()=> viewer.zoomBy(1.1);
$('#btnZoomOut').onclick = ()=> viewer.zoomBy(1/1.1);
$('#btnToggleGrid').onclick = ()=> viewer.toggleGrid();
$('#btnScale').onclick = ()=> viewer.calibrateScale();
$('#btnClearPins').onclick = ()=>{ const p=getProject(); if(!p) return; if(confirm('Clear pins on this page?')){ p.pins = p.pins.filter(x=>x.page!==viewer.pageIndex); save(); renderPins(); }};
$('#btnAddRow').onclick = ()=>{ const p=getProject(); if(!p) return; p.schedule.push(blankRow()); save(); renderSchedule(); };
$('#btnClearSchedule').onclick = ()=>{ const p=getProject(); if(!p) return; if(confirm('Clear entire schedule?')){ p.schedule=[]; save(); renderSchedule(); }};
$('#btnExportCSV').onclick = ()=> exporter.exportCSV(getProject());
$('#btnExportXLSX').onclick = ()=> exporter.exportXLSX(getProject());
$('#btnExportXLSX2').onclick = ()=> exporter.exportXLSX(getProject());
$('#btnGenerate').onclick = ()=> generateSchedule();
$('#btnScanAll').onclick = ()=> scanAllPages();
$('#btnScanPage').onclick = ()=> runOCRForPage(viewer.pageIndex).then(()=>alert('OCR done for this page. Click Generate.'));

// Palette presets
const PRESETS = [
  {key:'1', label:'FOH', payload:{SignType:'FOH'}},
  {key:'2', label:'BOH', payload:{SignType:'BOH'}},
  {key:'S', label:'Stair Bundle', bundle:'STAIR'},
  {key:'L', label:'Elevator Bundle', bundle:'ELEV'} ,
  {key:'X', label:'Exit', payload:{SignType:'EXIT'}},
];
const pal = document.getElementById('pinPalette');
PRESETS.forEach(p=>{ const b=document.createElement('button'); b.className='btn'; b.textContent=p.label; b.title=p.key?`${p.label} [${p.key}]`:p.label; b.onclick=()=>viewer.setActivePreset(p); pal.appendChild(b); });
window.addEventListener('keydown', (e)=>{
  if(document.activeElement && ['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  const hit = PRESETS.find(p=>p.key && p.key.toLowerCase()===e.key.toLowerCase());
  if(hit){ viewer.setActivePreset(hit); e.preventDefault(); }
  if(e.key.toLowerCase()==='g'){ viewer.toggleGrid(); }
});

// File input
const fileInput = document.getElementById('fileInput');
fileInput.addEventListener('change', async (e)=>{
  const files = Array.from(e.target.files||[]);
  const p = getProject(); if(!p) return;
  for(const f of files){ await viewer.addFileToProject(f, p); }
  save(); renderPages(); if(p.pages.length) openPage(0);
});

function blankRow(){ const p=getProject(); return {SignType:'',RoomNumber:'',RoomName:'',Building:p?.building||'',Level:p?.level||'',Notes:''}; }
function createProject(name){ const id = uuid(); projects.push({id,name,building:'',level:'',pages:[],pins:[],schedule:[], scale:{} }); currentId = id; save(); renderAll(); }
function updateProject(part){ Object.assign(getProject(), part); save(); }

function renderProjects(){
  const list = document.getElementById('projectList'); list.innerHTML='';
  projects.forEach(p=>{
    const div=document.createElement('div'); div.className='item';
    const left=document.createElement('div'); left.className='inline';
    const name=document.createElement('input'); name.className='input'; name.value=p.name; name.style.width='170px'; name.onchange=()=>{p.name=name.value; save()};
    const small=document.createElement('small'); small.textContent = `${p.pages.length} page(s)`;
    left.append(name, small);
    const right=document.createElement('div'); right.className='inline';
    const open=document.createElement('button'); open.className='btn'; open.textContent='Open'; open.onclick=()=>{currentId=p.id; renderAll();};
    const del=document.createElement('button'); del.className='btn danger'; del.textContent='Delete'; del.onclick=()=>{ if(confirm('Delete project?')){ projects = projects.filter(x=>x.id!==p.id); if(currentId===p.id) currentId=projects[0]?.id||null; save(); renderAll(); } };
    right.append(open, del);
    div.append(left,right); list.append(div);
  })
}

function renderPages(){
  const list = document.getElementById('pageList'); list.innerHTML='';
  const p = getProject(); if(!p){ list.innerHTML='<div class="note">No project selected.</div>'; return }
  p.pages.forEach((page, idx)=>{
    const row=document.createElement('div'); row.className='item';
    const left=document.createElement('div'); left.textContent = page.name || `Page ${idx+1}`;
    const right=document.createElement('div');
    const btn=document.createElement('button'); btn.className='btn'; btn.textContent='View'; btn.onclick=()=>openPage(idx);
    right.append(btn); row.append(left,right); list.append(row);
  })
}

function openPage(i){ viewer.openPage(getProject(), i); renderPageBadge(); renderPins(); }
function renderPageBadge(){ document.getElementById('pageBadge').textContent = `Page ${viewer.pageIndex+1} / ${getProject()?.pages.length||0}`; document.getElementById('zoomBadge').textContent = Math.round(viewer.zoom*100)+"%"; const sc=getProject()?.scale?.[viewer.pageIndex]; document.getElementById('scaleBadge').textContent = sc?`Scale: ${sc.ppu.toFixed(2)} px/ft`:'Scale: not set'; }
function renderPins(){ viewer.renderPins(getProject()); }

function renderSchedule(){
  const p=getProject(); if(!p) return; const body=document.getElementById('scheduleBody'); body.innerHTML='';
  p.schedule.forEach((row, idx)=>{
    const tr=document.createElement('tr');
    const fields=['SignType','RoomNumber','RoomName','Building','Level','Notes'];
    fields.forEach(f=>{ const td=document.createElement('td'); const input=document.createElement('input'); input.className='input'; input.value=row[f]||''; input.onchange=()=>{ row[f]=input.value; save(); validate(); }; td.append(input); tr.append(td); });
    const tdDel=document.createElement('td'); const btn=document.createElement('button'); btn.className='btn danger'; btn.textContent='✕'; btn.onclick=()=>{ p.schedule.splice(idx,1); save(); renderSchedule(); validate(); }; tdDel.append(btn); tr.append(tdDel);
    body.append(tr);
  })
  document.getElementById('rowCount').textContent = `${p.schedule.length} rows`;
}

function handlePinDrop({world, preset}){
  const p = getProject(); if(!p) return;
  const page = viewer.pageIndex;
  const roomGuess = rules.deriveRoomFromText(ocrIndex[pageKey()]||'');
  if(preset?.bundle==='ELEV'){
    p.schedule.push({...blankRow(), SignType:'CALLBOX', RoomNumber:'1-100', RoomName:'ELEV. LOBBY', Notes:'Bundle'});
    p.schedule.push({...blankRow(), SignType:'EVAC', RoomNumber:'1-100', RoomName:'ELEV. LOBBY', Notes:'Bundle'});
    p.schedule.push({...blankRow(), SignType:'HALL DIRECT', RoomNumber:'C1-100', RoomName:'ELEV. LOBBY', Notes:'Bundle'});
  } else if(preset?.bundle==='STAIR'){
    const rn = roomGuess||'';
    p.schedule.push({...blankRow(), SignType:'INGRESS', RoomNumber:rn, RoomName:'STAIR', Notes:'Bundle'});
    p.schedule.push({...blankRow(), SignType:'EGRESS', RoomNumber:rn, RoomName:'STAIR', Notes:'Bundle'});
  } else if(preset?.payload){
    p.schedule.push({...blankRow(), ...preset.payload, RoomNumber:roomGuess||'', RoomName:rules.defaultRoomNameFor(preset.payload.SignType)});
  }
  p.pins.push({page, x:world.x, y:world.y, preset:preset?.label||'', note:''});
  save(); renderPins(); renderSchedule(); validate();
}

async function runOCRForPage(i){
  const p = getProject(); if(!p) return;
  const page = p.pages[i]; if(!page) return;
  // Prefer embedded PDF text (way more accurate)
  const textFromPdf = await viewer.extractPdfTextIfAvailable(page);
  if(textFromPdf && textFromPdf.trim()){ ocrIndex[(getProject().id+':'+i)] = textFromPdf; return 'pdf'; }
  // Fallback to OCR on the page image
  const txt = await ocr.recognize(page.dataUrl);
  ocrIndex[(getProject().id+':'+i)] = txt;
  return 'ocr';
}

async function scanAllPages(){
  const p=getProject(); if(!p||!p.pages.length){ alert('Upload plan(s) first.'); return; }
  let ok=0; for(let i=0;i<p.pages.length;i++){ await runOCRForPage(i); ok++; document.getElementById('pageBadge').textContent = `Scanning ${ok}/${p.pages.length}…`; }
  alert('Scanning complete. Now click Generate Schedule.');
}

function generateSchedule(){
  const p=getProject(); if(!p){ alert('No project selected.'); return; }
  if(!p.pages.length){ alert('No pages uploaded yet. Click "Upload Plan(s)".'); return; }
  const text = ocrIndex[pageKey()]||'';
  if(!text.trim()){ alert('No OCR/text for this page. Click "Scan This Page" or "Scan All Pages".'); return; }
  const added = rules.apply(text, p, document.getElementById('rulePreset').value);
  save(); renderSchedule(); validate();
  if(added<=0) alert('No keyword matches found. You can still add rows manually or drop bundles from the palette.');
  else alert(`Added ${added} row(s) from text.`);
}

function validate(){
  const p=getProject(); if(!p) return;
  const issues = rules.validate(p);
  const box = document.getElementById('issues'); box.innerHTML='';
  if(!issues.length){ const ok=document.createElement('div'); ok.className='issue ok'; ok.textContent='All good!'; box.append(ok); return; }
  issues.forEach(i=>{ const div=document.createElement('div'); div.className='issue'; div.textContent=i; box.append(div); });
}

function renderSettings(){ const p=getProject(); if(!p){ document.getElementById('building').value=''; document.getElementById('level').value=''; return } document.getElementById('building').value=p.building||''; document.getElementById('level').value=p.level||''; }
function renderAll(){ renderProjects(); renderPages(); renderSettings(); if(getProject()?.pages.length){ openPage(0); } renderSchedule(); validate(); }

// Boot
if(!getProject()) createProject('New Project'); else renderAll();
