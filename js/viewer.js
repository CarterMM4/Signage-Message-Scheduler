// viewer.js — renders pages to canvas, pan/zoom, grid, pins, PDF import (robust)

export class Viewer{
  constructor(opts={}){
    this.onPinDrop    = opts.onPinDrop    || (()=>{});
    this.onPageChange = opts.onPageChange || (()=>{});

    this.stage  = document.getElementById('stage');
    this.canvas = document.getElementById('pageCanvas');
    this.ctx    = this.canvas.getContext('2d');

    this.pageIndex   = 0;
    this.zoom        = 1;
    this.originX     = 0;
    this.originY     = 0;
    this.isDragging  = false;
    this.activePreset= null;
    this.showGrid    = false;

    this.project = null;
    this._wire();
  }

  setActivePreset(p){ this.activePreset=p; }
  toScreen(x,y){ return { x:(x*this.zoom)+this.originX, y:(y*this.zoom)+this.originY }; }
  toWorld(x,y){ return { x:(x-this.originX)/this.zoom, y:(y-this.originY)/this.zoom }; }

  // ---------------------------------------------------------------------------
  // Import files (PDFs & images) with multiple fallbacks and password support
  // ---------------------------------------------------------------------------
  async addFileToProject(file, project){
    const name=(file.name||'').toLowerCase();
    const type=(file.type||'').toLowerCase();
    const isPdf = type.includes('pdf') || name.endsWith('.pdf');

    if (isPdf){
      if (!window.pdfjsLib){
        alert('PDF engine not loaded. Ensure pdf.js is included before app.js.');
        return;
      }

      // Helper to open a PDF with password prompt
      const openWith = async (src) => {
        const loadingTask = pdfjsLib.getDocument(src);
        // Password prompt flow
        if ('onPassword' in loadingTask){
          loadingTask.onPassword = (updatePassword, reason) => {
            const need = pdfjsLib.PasswordResponses?.NEED_PASSWORD;
            const wrong = pdfjsLib.PasswordResponses?.INCORRECT_PASSWORD;
            const msg = (reason===need) ? 'This PDF is password-protected.' :
                        (reason===wrong) ? 'Wrong password.' : 'Password required.';
            const pwd = prompt(`${msg}\nEnter password:`);
            if (pwd!=null) updatePassword(pwd);
          };
        }
        return await loadingTask.promise;
      };

      // Try raw data first (best on Pages/Safari). If it fails, try blob URL.
      let pdf=null, blobUrl=null;
      try{
        const buf = await file.arrayBuffer();
        pdf = await openWith({ data: buf });
      }catch(err1){
        try{
          blobUrl = URL.createObjectURL(file);
          pdf = await openWith({ url: blobUrl });
        }catch(err2){
          console.error('PDF open failed (data and url):', err1, err2);
          alert('Could not open this PDF. Try “Print to PDF” and re-upload.');
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          return;
        }
      }

      try{
        // Render each page as an image (downscale huge pages to avoid memory issues)
        for (let i=1; i<=pdf.numPages; i++){
          const page = await pdf.getPage(i);
          const viewport1 = page.getViewport({ scale: 1 });
          const MAX = 2200; // max width/height in pixels to keep memory in check
          const scale = Math.min(1, MAX / Math.max(viewport1.width, viewport1.height));
          const viewport = page.getViewport({ scale });

          const c = document.createElement('canvas');
          const cx = c.getContext('2d', { willReadFrequently: false });
          c.width = Math.ceil(viewport.width);
          c.height= Math.ceil(viewport.height);

          await page.render({ canvasContext: cx, viewport }).promise;
          const dataUrl = c.toDataURL('image/png');

          // Embedded text (better than OCR if available)
          let txt = '';
          try{
            const tc = await page.getTextContent();
            txt = (tc.items||[]).map(it=>it.str).join('\n');
          }catch{}

          project.pages.push({
            type: 'image',
            name: `${file.name} — p${i}`,
            dataUrl,
            w: c.width,
            h: c.height,
            _pdfText: txt
          });
        }
      } finally {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
      return;
    }

    // Images with proper MIME
    if (type.startsWith('image/')){
      const dataUrl = await this._blobToDataURL(file);
      const dims = await this._imageDims(dataUrl);
      project.pages.push({ type:'image', name:file.name, dataUrl, w:dims.w, h:dims.h, _pdfText:'' });
      return;
    }

    // Images by extension (Safari sometimes omits MIME)
    if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp')){
      const dataUrl = await this._blobToDataURL(file);
      const dims = await this._imageDims(dataUrl);
      project.pages.push({ type:'image', name:file.name, dataUrl, w:dims.w, h:dims.h, _pdfText:'' });
      return;
    }

    alert('Unsupported file type. Please upload PDFs or images.');
  }

  async extractPdfTextIfAvailable(page){ return page ? (page._pdfText || '') : ''; }

  // ---------------------------------------------------------------------------
  // Viewer ops
  // ---------------------------------------------------------------------------
  openPage(project, index){
    this.project   = project;
    this.pageIndex = index;
    this.zoom      = this._fit();
    this.originX = 0; this.originY = 0;
    this._draw(); this._renderPins();
    this.onPageChange(index);
  }

  zoomBy(f){
    this.zoom *= f;
    const zb = document.getElementById('zoomBadge');
    if (zb) zb.textContent = Math.round(this.zoom*100)+'%';
    this._draw(); this._renderPins();
  }

  toggleGrid(){ this.showGrid = !this.showGrid; this._draw(); }

  calibrateScale(){
    if (!this.project) return;
    alert('Draw a calibration line: click once to start, once to end, then enter the real-world feet.');
    let first=null;
    const onClick=(e)=>{
      const rect=this.stage.getBoundingClientRect();
      const world=this.toWorld(e.clientX-rect.left, e.clientY-rect.top);
      if(!first){ first=world; }
      else{
        this.stage.removeEventListener('click', onClick);
        const dx=world.x-first.x, dy=world.y-first.y;
        const px=Math.hypot(dx,dy);
        const feet=parseFloat(prompt('Enter real length (feet):','10'));
        if(!isNaN(feet)&&feet>0){
          const ppu = px/feet;
          (this.project.scale||(this.project.scale={}))[this.pageIndex]={ ppu };
          alert(`Saved scale: ${ppu.toFixed(2)} px/ft`);
          const sb=document.getElementById('scaleBadge');
          if (sb) sb.textContent = `Scale: ${ppu.toFixed(2)} px/ft`;
        }
      }
    };
    this.stage.addEventListener('click', onClick);
  }

  renderPins(project){ this.project=project; this._renderPins(); }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  _wire(){
    const s=this.stage; let lastX=0, lastY=0;

    s.addEventListener('mousedown', (e)=>{ this.isDragging=true; lastX=e.clientX; lastY=e.clientY; s.classList.add('dragging'); });
    window.addEventListener('mouseup',   ()=>{ this.isDragging=false; s.classList.remove('dragging'); });
    window.addEventListener('mousemove', (e)=>{
      if(this.isDragging){
        this.originX += (e.clientX-lastX);
        this.originY += (e.clientY-lastY);
        lastX=e.clientX; lastY=e.clientY;
        this._draw(); this._renderPins();
      }
    });

    s.addEventListener('click', (e)=>{
      if(!this.activePreset) return;
      const rect=s.getBoundingClientRect();
      const world=this.toWorld(e.clientX-rect.left, e.clientY-rect.top);
      if(this.showGrid){ const grid=20; world.x=Math.round(world.x/grid)*grid; world.y=Math.round(world.y/grid)*grid; }
      this.onPinDrop({world, preset:this.activePreset});
    });
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  _fit(){
    const p=this.project;
    if(!p || !p.pages[this.pageIndex]) return 1;
    const page=p.pages[this.pageIndex];
    const r=this.stage.getBoundingClientRect();
    const zx=r.width/page.w, zy=r.height/page.h;
    const z=Math.min(zx,zy)*0.98;
    const zb=document.getElementById('zoomBadge');
    if (zb) zb.textContent=Math.round(z*100)+'%';
    return z;
  }

  _draw(){
    const p=this.project; if(!p) return;
    const page=p.pages[this.pageIndex]; if(!page) return;

    const rect=this.stage.getBoundingClientRect();
    this.canvas.width=rect.width; this.canvas.height=rect.height;

    const img=new Image();
    img.onload=()=>{
      this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
      const tl=this.toScreen(0,0);
      const w=page.w*this.zoom, h=page.h*this.zoom;
      this.ctx.drawImage(img, tl.x, tl.y, w, h);
      if(this.showGrid) this._drawGrid();
    };
    img.src=page.dataUrl;
  }

  _drawGrid(){
    const g=20*this.zoom, r=this.canvas, ctx=this.ctx;
    ctx.save();
    ctx.strokeStyle='rgba(255,255,255,0.07)'; ctx.lineWidth=1;
    for(let x=((this.originX%g)+g)%g; x<r.width; x+=g){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,r.height); ctx.stroke(); }
    for(let y=((this.originY%g)+g)%g; y<r.height; y+=g){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(r.width,y); ctx.stroke(); }
    ctx.restore();
  }

  _renderPins(){
    this.stage.querySelectorAll('.pin').forEach(el=>el.remove());
    const p=this.project; if(!p) return;
    const pins=p.pins.filter(x=>x.page===this.pageIndex);

    pins.forEach((pin, idx)=>{
      const pos=this.toScreen(pin.x, pin.y);
      const el=document.createElement('div');
      el.className='pin'; el.style.left=pos.x+'px'; el.style.top=pos.y+'px';
      el.title = pin.note || `${pin.preset||'Pin'} ${idx+1}`;

      let dragging=false, ox=0, oy=0;
      el.addEventListener('mousedown', (e)=>{ e.stopPropagation(); dragging=true; ox=e.clientX; oy=e.clientY; });
      window.addEventListener('mouseup', ()=> dragging=false);
      window.addEventListener('mousemove', (e)=>{
        if(!dragging) return; e.preventDefault();
        const dx=(e.clientX-ox)/this.zoom, dy=(e.clientY-oy)/this.zoom; ox=e.clientX; oy=e.clientY;
        pin.x+=dx; pin.y+=dy; this._draw(); this._renderPins();
      });
      el.addEventListener('dblclick', ()=>{
        const val=prompt('Pin note', pin.note||''); if(val!==null){ pin.note=val; }
      });

      this.stage.appendChild(el);
    });
  }

  // ---------------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------------
  _blobToDataURL(file){
    return new Promise(res=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.readAsDataURL(file); });
  }
  _imageDims(src){
    return new Promise(res=>{ const img=new Image(); img.onload=()=>res({w:img.naturalWidth,h:img.naturalHeight}); img.src=src; });
  }
}
