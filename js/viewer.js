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
      const world=this.toWorld(e.clientX-rect.left, e
