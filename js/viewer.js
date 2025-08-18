// viewer.js — renders pages to canvas, pan/zoom, grid, pins, PDF import

export class Viewer{
  constructor(opts={}){
    this.onPinDrop   = opts.onPinDrop   || (()=>{});
    this.onPageChange= opts.onPageChange|| (()=>{});

    this.stage  = document.getElementById('stage');
    this.canvas = document.getElementById('pageCanvas');
    this.ctx    = this.canvas.getContext('2d');

    this.pageIndex = 0;
    this.zoom = 1;
    this.originX = 0;
    this.originY = 0;
    this.isDragging = false;
    this.activePreset = null;
    this.showGrid = false;

    this.project = null;
    this._wire();
  }

  setActivePreset(p){ this.activePreset = p; }
  toScreen(x,y){ return { x:(x*this.zoom)+this.originX, y:(y*this.zoom)+this.originY }; }
  toWorld(x,y){ return { x:(x-this.originX)/this.zoom, y:(y-this.originY)/this.zoom }; }

  // --- Import files into the project (PDFs and images) -----------------------
  async addFileToProject(file, project){
    const name=(file.name||'').toLowerCase();
    const type=(file.type||'').toLowerCase();
    const isPdf = type==='application/pdf' || type.includes('pdf') || name.endsWith('.pdf');

    if (isPdf){
      try{
        const arrayBuf = await file.arrayBuffer();
        // Raw data avoids blob URL/CORS issues (reliable on GitHub Pages + Safari)
        const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;

        for(let i=1; i<=pdf.numPages; i++){
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 1 });

          // render to offscreen canvas
          const c = document.createElement('canvas');
          const cx = c.getContext('2d');
          c.width = viewport.width; c.height = viewport.height;
          await page.render({ canvasContext: cx, viewport }).promise;
          const dataUrl = c.toDataURL('image/png');

          // Try reading embedded text (better than OCR)
          let txt = '';
          try {
            const textContent = await page.getTextContent();
            txt = (textContent.items || []).map(it=>it.str).join('\n');
          } catch {}

          project.pages.push({
            type:'image',
            name:`${file.name} — p${i}`,
            dataUrl,
            w: c.width,
            h: c.height,
            _pdfText: txt
          });
        }
      }catch(err){
        console.error('PDF load error:', err);
        alert('Could not open this PDF. Try saving a fresh copy or “Print to PDF” and re-upload.');
      }
      return;
    }

    if (type.startsWith('image/')){ // image with MIME
      const dataUrl = await this._blobToDataURL(file);
      const dims = await this._imageDims(dataUrl);
      project.pages.push({ type:'image', name:file.name, dataUrl, w:dims.w, h:dims.h, _pdfText:'' });
      return;
    }

    // image by extension (sometimes Safari omits type)
    if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp')){
      const dataUrl = await this._blobToDataURL(file);
      const dims = await this._imageDims(dataUrl);
      project.pages.push({ type:'image', name:file.name, dataUrl, w:dims.w, h:dims.h, _pdfText:'' });
      return;
    }

    alert('Unsupported file type. Please upload PDFs or images.');
  }

  async extractPdfTextIfAvailable(page){ return page ? (page._pdfText || '') : ''; }

  // --- Viewer operations ------------------------------------------------------
  openPage(project, index){
    this.project = project;
    this.pageIndex = index;
    this.zoom   = this._fit();
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
    const onClick = (e)=>{
      const rect = this.stage.getBoundingClientRect();
      const world = this.toWorld(e.clientX-rect.left, e.clientY-rect.top);
      if (!first){ first = world; }
      else{
        this.stage.removeEventListener('click', onClick);
        const dx = world.x-first.x, dy = world.y-first.y;
        const px = Math.hypot(dx,dy);
        const feet = parseFloat(prompt('Enter real length (feet):', '10'));
        if (!isNaN(feet) && feet>0){
          const ppu = px/feet;
          (this.project.scale||(this.project.scale={}))[this.pageIndex] = { ppu };
          alert(`Saved scale: ${ppu.toFixed(2)} px/ft`);
          const sb = document.getElementById('scaleBadge');
          if (sb) sb.textContent = `Scale: ${ppu.toFixed(2)} px/ft`;
        }
      }
    };
    this.stage.addEventListener('click', onClick);
  }

  renderPins(project){ this.project = project; this._renderPins(); }

  // --- DOM events -------------------------------------------------------------
  _wire(){
    const s=this.stage; let lastX=0, lastY=0;

    s.addEventListener('mousedown', (e)=>{ this.isDragging=true; lastX=e.clientX; lastY=e.clientY; s.classList.add('dragging'); });
    window.addEventListener('mouseup',   ()=>{ this.isDragging=false; s.classList.remove('dragging'); });
    window.addEventListener('mousemove', (e)=>{
      if (this.isDragging){
        this.originX += (e.clientX-lastX);
        this.originY += (e.clientY-lastY);
        lastX=e.clientX; lastY=e.clientY;
        this._draw(); this._renderPins();
      }
    });

    s.addEventListener('click', (e)=>{
      if (!this.activePreset) return;
      const rect = s.getBoundingClientRect();
      const world = this.toWorld(e.clientX-rect.left, e.clientY-rect.top);
      if (this.showGrid){ const grid=20; world.x=Math.round(world.x/grid)*grid; world.y=Math.round(world.y/grid)*grid; }
      this.onPinDrop({ world, preset:this.activePreset });
    });
  }

  // --- drawing ---------------------------------------------------------------
  _fit(){
    const p=this.project;
    if (!p || !p.pages[this.pageIndex]) return 1;
    const page = p.pages[this.pageIndex];
    const r = this.stage.getBoundingClientRect();
    const zx = r.width  / page.w;
    const zy = r.height / page.h;
    const z  = Math.min(zx,zy)*0.98;
    const zb = document.getElementById('zoomBadge');
    if (zb) zb.textContent = Math.round(z*100)+'%';
    return z;
  }

  _draw(){
    const p=this.project; if (!p) return;
    const page = p.pages[this.pageIndex]; if (!page) return;

    const rect = this.stage.getBoundingClientRect();
    this.canvas.width  = rect.width;
    this.canvas.height = rect.height;

    const img = new Image();
    img.onload = ()=>{
      this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height);
      const tl = this.toScreen(0,0);
      const w  = page.w*this.zoom, h = page.h*this.zoom;
      this.ctx.drawImage(img, tl.x, tl.y, w, h);
      if (this.showGrid) this._drawGrid();
    };
    img.src = page.dataUrl;
  }

  _drawGrid(){
    const g = 20*this.zoom;
    const r = this.canvas;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for(let x=((this.originX%g)+g)%g; x<r.width; x+=g){
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,r.height); ctx.stroke();
    }
    for(let y=((this.originY%g)+g)%g; y<r.height; y+=g){
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(r.width,y); ctx.stroke();
    }
    ctx.restore();
  }

  _renderPins(){
    this.stage.querySelectorAll('.pin').forEach(el=>el.remove());
    const p=this.project; if (!p) return;
    const pins = p.pins.filter(x=>x.page===this.pageIndex);

    pins.forEach((pin, idx)=>{
      const pos = this.toScreen(pin.x, pin.y);
      const el  = document.createElement('div');
      el.className='pin'; el.style.left=pos.x+'px'; el.style.top=pos.y+'px';
      el.title = pin.note || `${pin.preset||'Pin'} ${idx+1}`;

      let dragging=false, ox=0, oy=0;
      el.addEventListener('mousedown', (e)=>{ e.stopPropagation(); dragging=true; ox=e.clientX; oy=e.clientY; });
      window.addEventListener('mouseup', ()=> dragging=false);
      window.addEventListener('mousemove', (e)=>{
        if (!dragging) return;
        e.preventDefault();
        const dx=(e.clientX-ox)/this.zoom, dy=(e.clientY-oy)/this.zoom;
        ox=e.clientX; oy=e.clientY;
        pin.x+=dx; pin.y+=dy;
        this._draw(); this._renderPins();
      });
      el.addEventListener('dblclick', ()=>{
        const val = prompt('Pin note', pin.note||'');
        if (val!==null){ pin.note = val; }
      });

      this.stage.appendChild(el);
    });
  }

  // --- utils -----------------------------------------------------------------
  _blobToDataURL(file){
    return new Promise(res=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.readAsDataURL(file); });
  }
  _imageDims(src){
    return new Promise(res=>{ const img=new Image(); img.onload=()=>res({w:img.naturalWidth, h:img.naturalHeight}); img.src=src; });
  }
}
