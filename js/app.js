// app.js — wires up: projects, PDF/image uploads, OCR, rules, viewer, exports

import { Store } from './storage.js';
import { Viewer } from './viewer.js';
import { OCR } from './ocr.js';
import { Rules } from './rules.js';
import { Exporter } from './exporter.js';

const $  = (s, r=document) => r.querySelector(s);

// -----------------------------------------------------------------------------
// App state
// -----------------------------------------------------------------------------
const store   = new Store('sw-signage-projects-v3');
let projects  = await store.load();
let currentId = projects[0]?.id || null;

// Per-page text cache: pageKey() -> text (from embedded PDF text or OCR)
const ocrIndex = {};

const viewer   = new Viewer({ onPinDrop: handlePinDrop, onPageChange: ()=>renderPageBadge() });
const ocr      = new OCR();
const rules    = new Rules();
const exporter = new Exporter();

function getProject(){ return projects.find(p => p.id === currentId); }
function save(){ store.save(projects); renderProjects(); }
function uuid(){ return 'p-' + Math.random().toString(36).slice(2, 9); }
function pageKey(){ return (getProject()?.id || '') + ':' + viewer.pageIndex; }

// -----------------------------------------------------------------------------
// UI wiring (buttons, inputs). All are optional: code checks existence first.
// -----------------------------------------------------------------------------
bind('#btnNew', 'click', ()=>{ createProject($('#projectName')?.value?.trim() || 'Untitled'); if($('#projectName')) $('#projectName').value=''; });
bind('#btnSave','click', save);

bind('#building','change', ()=> updateProject({ building: $('#building').value }));
bind('#level','change',    ()=> updateProject({ level:    $('#level').value }));

bind('#btnZoomIn',    'click', ()=> viewer.zoomBy(1.1));
bind('#btnZoomOut',   'click', ()=> viewer.zoomBy(1/1.1));
bind('#btnToggleGrid','click', ()=> viewer.toggleGrid());
bind('#btnScale',     'click', ()=> viewer.calibrateScale());

bind('#btnClearPins','click', ()=>{
  const p=getProject(); if(!p) return;
  if(confirm('Clear pins on this page?')){
    p.pins = p.pins.filter(x=>x.page !== viewer.pageIndex);
    save(); renderPins();
  }
});

// Schedule controls
bind('#btnAddRow','click', ()=>{
  const p=getProject(); if(!p) return;
  p.schedule.push(blankRow()); save(); renderSchedule();
});
bind('#btnClearSchedule','click', ()=>{
  const p=getProject(); if(!p) return;
  if(confirm('Clear entire schedule?')){ p.schedule=[]; save(); renderSchedule(); }
});
bind('#btnExportCSV',  'click', ()=> exporter.exportCSV(getProject()));
bind('#btnExportXLSX', 'click', ()=> exporter.exportXLSX(getProject()));
bind('#btnExportXLSX2','click', ()=> exporter.exportXLSX(getProject())); // some UIs have a 2nd button

// Generate + OCR
bind('#btnGenerate','click', generateSchedule);
bind('#btnScanAll','click', scanAllPages);
bind('#btnScanPage','click', async ()=>{
  await runOCRForPage(viewer.pageIndex);
  alert('OCR done for this page. Click Generate.');
});
bind('#btnOCR','click', async ()=>{ // some UIs use a single "Scan Text" button
  await runOCRForPage(viewer.pageIndex);
  alert('OCR done for this page. Click Generate.');
});

// Palette presets (if palette exists in your UI)
const PRESETS = [
  {key:'1', label:'FOH',            payload:{SignType:'FOH'}},
  {key:'2', label:'BOH',            payload:{SignType:'BOH'}},
  {key:'S', label:'Stair Bundle',   bundle:'STAIR'},
  {key:'L', label:'Elevator Bundle',bundle:'ELEV'},
  {key:'X', label:'Exit',           payload:{SignType:'EXIT'}},
];
const palette = $('#pinPalette');
if (palette){
  PRESETS.forEach(p=>{
    const b=document.createElement('button');
    b.className='btn'; b.textContent=p.label; b.title=p.key?`${p.label} [${p.key}]`:p.label;
    b.onclick=()=>viewer.setActivePreset(p);
    palette.appendChild(b);
  });
  window.addEventListener('keydown', (e)=>{
    if (document.activeElement && ['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
    const hit = PRESETS.find(p=>p.key && p.key.toLowerCase()===e.key.toLowerCase());
    if (hit){ viewer.setActivePreset(hit); e.preventDefault(); }
    if (e.key.toLowerCase()==='g'){ viewer.toggleGrid(); }
  });
}

// File input
const fileInput = $('#fileInput');
if (fileInput){
  fileInput.addEventListener('change', async (e)=>{
    const files = Array.from(e.target.files || []);
    const p = getProject(); if (!p) { alert('Create/select a project first.'); return; }
    for (const f of files){ await viewer.addFileToProject(f, p); }
    save(); renderPages(); if (p.pages.length) openPage(0);
  });
}

// Helpers
function bind(sel, ev, fn){ const el=$(sel); if(el) el.addEventListener(ev, fn); }

// -----------------------------------------------------------------------------
// Core functions
// -----------------------------------------------------------------------------
function blankRow(){
  const p=getProject();
  return { SignType:'', RoomNumber:'', RoomName:'', Building:p?.building||'', Level:p?.level||'', Notes:'' };
}

function createProject(name){
  const id = uuid();
  projects.push({ id, name, building:'', level:'', pages:[], pins:[], schedule:[], scale:{} });
  currentId = id; save(); renderAll();
}
function updateProject(part){ Object.assign(getProject(), part); save(); }

function openPage(i){ viewer.openPage(getProject(), i); renderPageBadge(); renderPins(); }

async function runOCRForPage(i){
  const p = getProject(); if(!p) return;
  const pg = p.pages[i];  if(!pg) return;
  // Prefer embedded PDF text (far more accurate)
  const fromPdf = await viewer.extractPdfTextIfAvailable(pg);
  if (fromPdf && fromPdf.trim()){ ocrIndex[(getProject().id+':'+i)] = fromPdf; return 'pdf'; }
  // Fallback: OCR the rendered image
  const txt = await ocr.recognize(pg.dataUrl);
  ocrIndex[(getProject().id+':'+i)] = txt;
  return 'ocr';
}

async function scanAllPages(){
  const p=getProject(); if(!p||!p.pages.length){ alert('Upload plan(s) first.'); return; }
  let ok=0;
  for (let i=0;i<p.pages.length;i++){
    await runOCRForPage(i); ok++;
    const badge = $('#pageBadge'); if (badge) badge.textContent = `Scanning ${ok}/${p.pages.length}…`;
  }
  alert('Scanning complete. Now click Generate Schedule.');
}

function generateSchedule(){
  const p=getProject(); if(!p){ alert('No project selected.'); return; }
  if(!p.pages.length){ alert('No pages uploaded yet. Click "Upload Plan(s)".'); return; }
  const text = ocrIndex[pageKey()] || '';
  if(!text.trim()){
    alert('No OCR/text for this page. Click "Scan This Page" (or "Scan Text") or run "Scan All Pages" first.');
    return;
  }
  const preset = $('#rulePreset')?.value || 'southwood';
  const added  = rules.apply(text, p, preset);
  save(); renderSchedule(); validate();
  if (added<=0) alert('No keyword matches found. You can still add rows manually or drop bundles from the palette.');
  else alert(`Added ${added} row(s) from text.`);
}

function handlePinDrop({world, preset}){
  const p = getProject(); if(!p) return;
  const rnGuess = rules.deriveRoomFromText(ocrIndex[pageKey()]||'') || '';
  if (preset?.bundle==='ELEV'){
    p.schedule.push({...blankRow(), SignType:'CALLBOX',     RoomNumber:'1-100', RoomName:'ELEV. LOBBY', Notes:'Bundle'});
    p.schedule.push({...blankRow(), SignType:'EVAC',        RoomNumber:'1-100', RoomName:'ELEV. LOBBY', Notes:'Bundle'});
    p.schedule.push({...blankRow(), SignType:'HALL DIRECT', RoomNumber:'C1-100',RoomName:'ELEV. LOBBY', Notes:'Bundle'});
  } else if (preset?.bundle==='STAIR'){
    p.schedule.push({...blankRow(), SignType:'INGRESS', RoomNumber:rnGuess, RoomName:'STAIR', Notes:'Bundle'});
    p.schedule.push({...blankRow(), SignType:'EGRESS',  RoomNumber:rnGuess, RoomName:'STAIR', Notes:'Bundle'});
  } else if (preset?.payload){
    p.schedule.push({...blankRow(), ...preset.payload, RoomNumber:rnGuess, RoomName:rules.defaultRoomNameFor(preset.payload.SignType)});
  }
  p.pins.push({page: viewer.pageIndex, x:world.x, y:world.y, preset:preset?.label||'', note:''});
  save(); renderPins(); renderSchedule(); validate();
}

// -----------------------------------------------------------------------------
// Renderers
// -----------------------------------------------------------------------------
function renderProjects(){
  const list = $('#projectList'); if (!list) return;
  list.innerHTML='';
  projects.forEach(p=>{
    const div=document.createElement('div'); div.className='item';
    const left=document.createElement('div'); left.className='inline';
    const name=document.createElement('input'); name.className='input'; name.value=p.name; name.style.width='170px';
    name.onchange=()=>{ p.name=name.value; save(); };
    const small=document.createElement('small'); small.textContent = `${p.pages.length} page(s)`;
    left.append(name, small);

    const right=document.createElement('div'); right.className='inline';
    const open=document.createElement('button'); open.className='btn'; open.textContent='Open'; open.onclick=()=>{ currentId=p.id; renderAll(); };
    const del=document.createElement('button');  del.className='btn danger'; del.textContent='Delete';
    del.onclick=()=>{ if(confirm('Delete project?')){ projects = projects.filter(x=>x.id!==p.id); if(currentId===p.id) currentId=projects[0]?.id||null; save(); renderAll(); } };
    right.append(open, del);

    div.append(left, right); list.append(div);
  });
}

function renderPages(){
  const list = $('#pageList'); if(!list) return;
  list.innerHTML='';
  const p = getProject();
  if(!p){ list.innerHTML='<div class="note">No project selected.</div>'; return; }
  p.pages.forEach((page, idx)=>{
    const row=document.createElement('div'); row.className='item';
    const left=document.createElement('div'); left.textContent = page.name || `Page ${idx+1}`;
    const right=document.createElement('div');
    const btn=document.createElement('button'); btn.className='btn'; btn.textContent='View'; btn.onclick=()=>openPage(idx);
    right.append(btn); row.append(left,right); list.append(row);
  });
}

function renderPageBadge(){
  const badge = $('#pageBadge'); if(!badge) return;
  badge.textContent = `Page ${viewer.pageIndex+1} / ${getProject()?.pages.length||0}`;
  const zoomBadge = $('#zoomBadge'); if(zoomBadge) zoomBadge.textContent = Math.round(viewer.zoom*100)+'%';
  const sc = getProject()?.scale?.[viewer.pageIndex];
  const sb = $('#scaleBadge'); if (sb) sb.textContent = sc?`Scale: ${sc.ppu.toFixed(2)} px/ft`:'Scale: not set';
}

function renderPins(){ viewer.renderPins(getProject()); }

function renderSchedule(){
  const body = $('#scheduleBody'); if(!body) return;
  const p=getProject(); if(!p) return;
  body.innerHTML='';
  p.schedule.forEach((row, idx)=>{
    const tr=document.createElement('tr');
    const fields=['SignType','RoomNumber','RoomName','Building','Level','Notes'];
    fields.forEach(f=>{
      const td=document.createElement('td');
      const input=document.createElement('input'); input.className='input'; input.value=row[f]||'';
      input.onchange=()=>{ row[f]=input.value; save(); validate(); };
      td.append(input); tr.append(td);
    });
    const tdDel=document.createElement('td');
    const btn=document.createElement('button'); btn.className='btn danger'; btn.textContent='✕';
    btn.onclick=()=>{ p.schedule.splice(idx,1); save(); renderSchedule(); validate(); };
    tdDel.append(btn); tr.append(tdDel);
    body.append(tr);
  });
  const rc = $('#rowCount'); if (rc) rc.textContent = `${p.schedule.length} rows`;
}

function validate(){
  const p=getProject(); if(!p) return;
  const box = $('#issues'); if(!box) return; // optional panel
  const issues = rules.validate(p);
  box.innerHTML='';
  if(!issues.length){
    const ok=document.createElement('div'); ok.className='issue ok'; ok.textContent='All good!';
    box.append(ok); return;
  }
  issues.forEach(txt=>{ const div=document.createElement('div'); div.className='issue'; div.textContent=txt; box.append(div); });
}

function renderSettings(){
  const p=getProject();
  const b=$('#building'), l=$('#level');
  if(!p){ if(b) b.value=''; if(l) l.value=''; return; }
  if(b) b.value=p.building||''; if(l) l.value=p.level||'';
}

function renderAll(){ renderProjects(); renderPages(); renderSettings(); if(getProject()?.pages.length){ openPage(0); } renderSchedule(); validate(); }

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
if(!getProject()) createProject('New Project'); else renderAll();
