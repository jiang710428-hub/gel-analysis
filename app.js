(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('gelCanvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  const sourceCanvas=document.createElement('canvas'),sourceCtx=sourceCanvas.getContext('2d',{willReadFrequently:true});
  const state = { image: null, imageFile: null, imageName: '', analysisEngine: 'browser', lanes: [], laneWidth: null, bandHeight: null, selectedLane: -1, selectedBand: -1, selectedResultLane: 0, markerLaneIndex: null, referenceLaneIndex: null, referenceBandKey: '', polarity: 1, results: [], calibration: null, editMode: 'select', selection: null, gesture: null };
  const palette = ['#347fc2','#4b9a80','#ad7bce','#cf8852','#5c91a9','#c46c80','#84964c','#7381c5'];
  const input = $('fileInput');

  $('uploadBtn').onclick = () => input.click();
  input.onchange = (e) => { const file = e.target.files?.[0]; if (file) loadFile(file); input.value = ''; };
  const wrap = $('canvasWrap');
  wrap.ondragover = (e) => { e.preventDefault(); wrap.classList.add('dragging'); };
  wrap.ondragleave = () => wrap.classList.remove('dragging');
  wrap.ondrop = (e) => { e.preventDefault(); wrap.classList.remove('dragging'); const file = e.dataTransfer.files?.[0]; if (file && file.type.startsWith('image/')) loadFile(file); };
  $('sensitivity').oninput = () => { $('sensitivityValue').textContent = ['很低','偏低','中','偏高','很高'][+$('sensitivity').value - 1]; };
  $('sensitivity').onchange = () => runDetection();
  $('resetBtn').onclick = () => runDetection();
  document.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{state.editMode=button.dataset.mode;document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b===button));canvas.style.cursor=state.editMode==='select'?'default':'crosshair';$('editStatus').textContent=state.editMode==='select'?'拖动已有框可移动位置':state.editMode==='lane'?'在胶图上拖动，框出泳道宽度':'在所属泳道内拖动，框选条带区域';});
  $('recognizeSelectionBtn').onclick = recognizeSelection;
  $('deleteSelectionBtn').onclick = deleteSelection;
  $('markerLaneSelect').onchange = () => setMarkerLane($('markerLaneSelect').value===''?null:+$('markerLaneSelect').value);
  $('referenceLaneSelect').onchange = () => setReferenceLane($('referenceLaneSelect').value===''?null:+$('referenceLaneSelect').value);
  $('referenceBandSelect').onchange = () => setReferenceBand($('referenceBandSelect').value);
  $('refConcInput').oninput = () => { const band=referenceBand();if(band){band.refConc=numberOrNull($('refConcInput').value);invalidate();} };
  $('mwUnit').onchange = (e) => { const lane=state.markerLaneIndex==null?null:state.lanes[state.markerLaneIndex],hasValues=lane?.bands.some(b=>b.mw!=null);if(hasValues&&!confirm('更改单位后，已填写的 Marker 数值需要重新录入。继续更改？')){e.target.value=e.target.value==='bp'?'kDa':'bp';return;}if(lane)lane.bands.forEach(b=>b.mw=null);invalidate();renderAnnotation(); };
  $('wellY').oninput = () => invalidate();
  $('gelEndY').oninput = () => invalidate();
  $('laneWidth').oninput = () => { state.laneWidth=+$('laneWidth').value;regularizeLaneGeometry();invalidate();render();schedulePythonMeasurements(); };
  $('bandHeight').oninput = () => { state.bandHeight=+$('bandHeight').value;regularizeLaneGeometry();invalidate();render();schedulePythonMeasurements(); };
  $('calculateBtn').onclick = calculate;
  $('exportBtn').onclick = exportCsv;
  canvas.addEventListener('pointerdown',onCanvasPointerDown);
  canvas.addEventListener('pointermove',onCanvasPointerMove);
  canvas.addEventListener('pointerup',onCanvasPointerUp);
  canvas.addEventListener('pointercancel',onCanvasPointerUp);

  function numberOrNull(v) { const n = Number(v); return v === '' || !Number.isFinite(n) ? null : n; }
  function loadFile(file) {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); state.image = img; state.imageFile = file; state.imageName = file.name;state.laneWidth=null;state.bandHeight=null; canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; sourceCanvas.width=img.naturalWidth;sourceCanvas.height=img.naturalHeight;sourceCtx.drawImage(img,0,0);ctx.drawImage(img,0,0); $('emptyState').hidden = true; canvas.hidden = false; $('sensitivity').disabled = false; $('resetBtn').disabled = false; document.querySelectorAll('[data-mode]').forEach(b=>b.disabled=false); $('wellY').value=0; $('gelEndY').value=img.naturalHeight; $('imageInfo').textContent = `${img.naturalWidth} × ${img.naturalHeight} px · ${file.name}`; runDetection(); };
    img.onerror = () => { URL.revokeObjectURL(url); alert('无法读取该图像，请尝试 PNG 或 JPG 格式。'); };
    img.src = url;
  }
  function grayData() {
    const {data} = sourceCtx.getImageData(0,0,canvas.width,canvas.height), gray = new Float32Array(canvas.width*canvas.height);
    for (let i=0,j=0;i<data.length;i+=4,j++) gray[j]=.2126*data[i]+.7152*data[i+1]+.0722*data[i+2];
    return gray;
  }
  function smooth(a, radius) {
    const out = new Float32Array(a.length);
    for(let i=0;i<a.length;i++){let s=0,n=0;for(let j=Math.max(0,i-radius);j<=Math.min(a.length-1,i+radius);j++){s+=a[j];n++;}out[i]=s/n;}
    return out;
  }
  function robustRegions(profile, threshold, gap, minWidth) {
    const regions=[]; let start=-1,last=-1;
    for(let i=0;i<profile.length;i++){if(profile[i]>=threshold){if(start<0)start=i;last=i;}else if(start>=0&&i-last>gap){if(last-start+1>=minWidth)regions.push([start,last]);start=-1;last=-1;}}
    if(start>=0&&last-start+1>=minWidth)regions.push([start,last]); return regions;
  }
  async function analyzeWithPython(file, roi = null) {
    const params = new URLSearchParams({sensitivity: $('sensitivity').value});
    if (roi) for (const [key, value] of Object.entries(roi)) params.set(key, String(Math.round(value)));
    const apiBase = window.GELLENS_API_BASE || '';
    const response = await fetch(`${apiBase}/api/analyze?${params}`, {
      method: 'POST',
      headers: {'Content-Type': file.type || 'application/octet-stream'},
      body: file
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || `Python 服务返回 ${response.status}`);
    return payload;
  }
  function schedulePythonMeasurements() {
    if (state.analysisEngine !== 'python' || !state.imageFile) return;
    clearTimeout(state.measurementTimer);
    state.measurementTimer = setTimeout(async () => {
      const requestId = (state.measureRequestId || 0) + 1;
      state.measureRequestId = requestId;
      const bands = state.lanes.flatMap(lane => lane.bands);
      if (!bands.length) return;
      const form = new FormData();
      form.append('image', state.imageFile, state.imageFile.name);
      form.append('rois', JSON.stringify(bands.map(b => ({x1:b.x1,x2:b.x2,y1:b.y1,y2:b.y2}))));
      try {
        const apiBase = window.GELLENS_API_BASE || '';
        const response = await fetch(`${apiBase}/api/measure`, {method:'POST',body:form});
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.detail || `Python 服务返回 ${response.status}`);
        if (requestId !== state.measureRequestId) return;
        result.measurements.forEach((value, index) => {
          if (bands[index]) Object.assign(bands[index], {iod:value.iod,saturated_fraction:value.saturated_fraction,quantification_usable:value.quantification_usable});
        });
        renderResultTable(); renderAnnotation(); draw();
        if (canCalculateAnything()) calculate(false);
      } catch (error) {
        if (requestId === state.measureRequestId) console.info('Python IOD measurement failed:', error.message);
      }
    }, 250);
  }
  function mapPythonLanes(result) {
    state.polarity = result.polarity;
    return result.lanes.map((lane, li) => ({
      x1: lane.x1, x2: lane.x2, role: 'sample', volume: null, confidence: lane.confidence,
      bands: lane.bands.map((band, bi) => ({
        ...band, yCenter: band.y_center, mw: null, reference: false, refConc: null,
        id: band.id || `${li}-${bi}`
      }))
    }));
  }
  function preserveAnnotations(detected, previous) {
    detected.forEach(lane => {
      const old = previous.reduce((best, candidate) => !best || Math.abs((candidate.x1+candidate.x2)/2-(lane.x1+lane.x2)/2) < Math.abs((best.x1+best.x2)/2-(lane.x1+lane.x2)/2) ? candidate : best, null);
      if (!old || Math.abs((old.x1+old.x2-lane.x1-lane.x2)/2) > canvas.width*.06) return;
      lane.role = old.role; lane.volume = old.volume;
      lane.bands.forEach(band => {
        const match = old.bands.reduce((best, candidate) => !best || Math.abs(candidate.yCenter-band.yCenter) < Math.abs(best.yCenter-band.yCenter) ? candidate : best, null);
        if (match && Math.abs(match.yCenter-band.yCenter) < canvas.height*.025) Object.assign(band, {mw:match.mw,reference:match.reference,refConc:match.refConc,refVolume:match.refVolume,manual:match.manual});
      });
    });
    return detected;
  }
  async function runDetection() {
    if (!state.image) return;
    const requestId = (state.detectionRequestId || 0) + 1;
    state.detectionRequestId = requestId;
    const previous = state.lanes, manualLanes = previous.filter(l => l.manual);
    $('detectionInfo').textContent = 'Python 图像算法识别中…';
    try {
      const result = await analyzeWithPython(state.imageFile);
      if (requestId !== state.detectionRequestId) return;
      let lanes = preserveAnnotations(mapPythonLanes(result), previous);
      const movedManual = manualLanes.filter(l => Number.isFinite(l.originalAutoCenter));
      lanes = lanes.filter(l => !movedManual.some(m => Math.abs((l.x1+l.x2)/2-m.originalAutoCenter) < Math.max(8,(m.x2-m.x1)*.5)));
      manualLanes.forEach(manual => { const center=(manual.x1+manual.x2)/2, duplicate=lanes.some(l=>Math.abs((l.x1+l.x2)/2-center)<Math.max(8,(manual.x2-manual.x1)*.5)); if(!duplicate||Number.isFinite(manual.originalAutoCenter))lanes.push(manual); });
      state.analysisEngine = 'python'; state.lanes = lanes;
      finishDetection();
      $('detectionInfo').textContent += ' · Python CV';
      schedulePythonMeasurements();
    } catch (error) {
      if (requestId !== state.detectionRequestId) return;
      state.analysisEngine = 'browser';
      runBrowserDetection();
      $('detectionInfo').textContent += ' · 浏览器算法（Python 服务未连接）';
      console.info('Python CV unavailable; using browser detector:', error.message);
    }
  }
  function finishDetection() {
    state.markerLaneIndex=state.lanes.findIndex(l=>l.role==='marker');const refLoc=state.lanes.flatMap((l,li)=>l.bands.map((b,bi)=>b.reference?`${li}:${bi}`:null)).find(Boolean);state.referenceBandKey=refLoc||'';state.referenceLaneIndex=refLoc?+refLoc.split(':')[0]:null;
    state.selectedLane=state.lanes.length?0:-1;state.selectedBand=state.lanes[0]?.bands.length?0:-1;state.selectedResultLane=0;state.selection=null;state.gesture=null;regularizeLaneGeometry();state.results=[];state.calibration=null;
    $('detectionInfo').textContent=`检测到 ${state.lanes.length} 条泳道 · ${state.lanes.reduce((s,l)=>s+l.bands.length,0)} 条条带`;updateLaneWidthControl();
    $('calculateBtn').disabled=!state.lanes.length; render();
  }
  function runBrowserDetection() {
    if(!state.image)return;
    const previous=state.lanes;
    const manualLanes=previous.filter(l=>l.manual);
    const w=canvas.width,h=canvas.height,g=grayData();
    const border=[];const step=Math.max(1,Math.floor(Math.min(w,h)/220));
    for(let x=0;x<w;x+=step){border.push(g[x],g[(h-1)*w+x]);} for(let y=0;y<h;y+=step){border.push(g[y*w],g[y*w+w-1]);}
    border.sort((a,b)=>a-b); const bg=border[Math.floor(border.length*.5)]; state.polarity=bg<128?1:-1;
    const xProfile=new Float32Array(w); const stride=Math.max(1,Math.floor(h/700));
    for(let y=0;y<h;y+=stride)for(let x=0;x<w;x++)xProfile[x]+=Math.max(0,(g[y*w+x]-bg)*state.polarity);
    const xs=smooth(xProfile,Math.max(2,Math.round(w*.006))); let sorted=Array.from(xs).sort((a,b)=>a-b), median=sorted[Math.floor(sorted.length*.5)], max=Math.max(...xs);
    const sensitivity=+$('sensitivity').value, dynamic=Math.max(0,max-median);
    // A higher sensitivity must lower the threshold. The earlier version had
    // this direction reversed and also discarded narrow lanes aggressively.
    const threshold=median+Math.max(dynamic*.025,dynamic*(.12-(sensitivity-1)*.02));
    const minGap=Math.max(1,Math.round(w*(.010-(sensitivity-1)*.001)));
    const minWidth=Math.max(3,Math.round(w*(.006-(sensitivity-1)*.0005)));
    let regions=robustRegions(xs,threshold,minGap,minWidth);
    regions=regions.filter(([a,b])=>b-a< w*.38);
    state.lanes=regions.map(([x1,x2],idx)=>detectLaneBands(g,w,h,x1,x2,idx));
    state.lanes.forEach((lane,li)=>{const old=previous.reduce((best,candidate)=>!best||Math.abs((candidate.x1+candidate.x2)/2-(lane.x1+lane.x2)/2)<Math.abs((best.x1+best.x2)/2-(lane.x1+lane.x2)/2)?candidate:best,null);if(!old||Math.abs((old.x1+old.x2-lane.x1-lane.x2)/2)>w*.06)return;lane.role=old.role;lane.volume=old.volume;lane.bands.forEach(band=>{const match=old.bands.reduce((best,candidate)=>!best||Math.abs(candidate.yCenter-band.yCenter)<Math.abs(best.yCenter-band.yCenter)?candidate:best,null);if(match&&Math.abs(match.yCenter-band.yCenter)<h*.025)Object.assign(band,{mw:match.mw,reference:match.reference,refConc:match.refConc,refVolume:match.refVolume});});});
    const movedManual=manualLanes.filter(l=>Number.isFinite(l.originalAutoCenter));state.lanes=state.lanes.filter(l=>!movedManual.some(m=>Math.abs((l.x1+l.x2)/2-m.originalAutoCenter)<Math.max(8,(m.x2-m.x1)*.5)));
    manualLanes.forEach(manual=>{const center=(manual.x1+manual.x2)/2,duplicate=state.lanes.some(l=>Math.abs((l.x1+l.x2)/2-center)<Math.max(8,(manual.x2-manual.x1)*.5));if(!duplicate||Number.isFinite(manual.originalAutoCenter))state.lanes.push(manual);});
    state.markerLaneIndex=state.lanes.findIndex(l=>l.role==='marker');const refLoc=state.lanes.flatMap((l,li)=>l.bands.map((b,bi)=>b.reference?`${li}:${bi}`:null)).find(Boolean);state.referenceBandKey=refLoc||'';state.referenceLaneIndex=refLoc?+refLoc.split(':')[0]:null;
    state.selectedLane=state.lanes.length?0:-1;state.selectedBand=state.lanes[0]?.bands.length?0:-1;state.selectedResultLane=0;state.selection=null;state.gesture=null;regularizeLaneGeometry();state.results=[];state.calibration=null;
    $('detectionInfo').textContent=`检测到 ${state.lanes.length} 条泳道 · ${state.lanes.reduce((s,l)=>s+l.bands.length,0)} 条条带`;updateLaneWidthControl();
    $('calculateBtn').disabled=!state.lanes.length; render();
  }
  function detectLaneBands(gray,w,h,x1,x2,laneIndex) {
    const pad=Math.max(2,Math.round((x2-x1)*.12)), left=Math.max(0,x1+pad),right=Math.min(w,x2-pad),profile=new Float32Array(h);
    for(let y=0;y<h;y++){let s=0;for(let x=left;x<right;x++)s+=Math.max(0,(gray[y*w+x]-backgroundAt(gray,w,h,x,y))*state.polarity);profile[y]=s/Math.max(1,right-left);}
    const sm=smooth(profile,Math.max(1,Math.round(h*.003))), ordered=Array.from(sm).sort((a,b)=>a-b), base=ordered[Math.floor(ordered.length*.28)], peak=Math.max(...sm), dynamic=peak-base;
    const sens=+$('sensitivity').value, th=base+dynamic*Math.max(.06,.28-(sens-1)*.055); let ys=robustRegions(sm,th,Math.max(1,Math.round(h*(.008-(sens-1)*.001))),Math.max(2,Math.round(h*.003)));
    ys=ys.filter(([a,b])=>b-a<h*.10);
    const bands=ys.map(([y1,y2],i)=>{
      let iod=0;const ypad=Math.max(1,Math.round((y2-y1)*.5));
      for(let y=y1;y<=y2;y++)for(let x=left;x<right;x++)iod+=Math.max(0,(gray[y*w+x]-backgroundAt(gray,w,h,x,y))*state.polarity);
      return {x1:left,x2:right,y1,y2,yCenter:(y1+y2)/2,iod, mw:null, reference:false, refConc:null, id:`${laneIndex}-${i}`};
    });
    return {x1,x2,role:'sample',volume:null,bands};
  }
  function regularizeLaneGeometry(){
    if(!state.lanes.length)return;
    const selectedLane=state.lanes[state.selectedLane],resultLane=state.lanes[state.selectedResultLane];
    const markerLane=state.lanes[state.markerLaneIndex],reference=referenceBand();
    const selectionLane=state.selection?state.lanes[state.selection.laneIndex]:null;
    const selectionBand=state.selection?.type==='band'?selectionLane?.bands[state.selection.bandIndex]:null;
    const lanes=[...state.lanes].sort((a,b)=>(a.x1+a.x2)-(b.x1+b.x2));
    const widths=lanes.map(l=>l.x2-l.x1).sort((a,b)=>a-b),mid=Math.floor(widths.length/2);
    let width=state.laneWidth??(widths.length%2?widths[mid]:(widths[mid-1]+widths[mid])/2);
    width=Math.max(4,Math.min(Math.max(4,Math.floor(canvas.width*.4)),Math.round(width)));state.laneWidth=width;updateLaneWidthControl();
    const bands=lanes.flatMap(l=>l.bands),heights=bands.map(b=>b.y2-b.y1).filter(h=>h>0).sort((a,b)=>a-b);
    if(state.bandHeight==null&&heights.length){const m=Math.floor(heights.length/2);state.bandHeight=heights.length%2?heights[m]:(heights[m-1]+heights[m])/2;}
    if(state.bandHeight!=null)state.bandHeight=Math.max(2,Math.min(Math.max(2,Math.floor(canvas.height*.2)),Math.round(state.bandHeight)));
    updateBandHeightControl();
    const gray=state.analysisEngine==='python'?null:grayData();lanes.forEach((lane,i)=>{
      const center=(lane.x1+lane.x2)/2;lane.x1=Math.max(0,Math.min(canvas.width-width,Math.round(center-width/2)));lane.x2=lane.x1+width;
      const bx1=lane.x1,bx2=lane.x2;
      lane.bands.forEach(band=>{const centerY=band.yCenter??(band.y1+band.y2)/2,height=state.bandHeight??(band.y2-band.y1),y1=Math.max(0,Math.min(canvas.height-height,Math.round(centerY-height/2)));band.x1=bx1;band.x2=bx2;band.y1=y1;band.y2=y1+height;band.yCenter=(band.y1+band.y2)/2;if(state.analysisEngine!=='python')band.iod=calculateBandIodFromGray(band,gray);});
    });
    state.lanes=lanes;
    state.markerLaneIndex=markerLane?lanes.indexOf(markerLane):null;
    state.referenceLaneIndex=reference?lanes.findIndex(l=>l.bands.includes(reference)):null;
    state.referenceBandKey=reference&&state.referenceLaneIndex>=0?`${state.referenceLaneIndex}:${lanes[state.referenceLaneIndex].bands.indexOf(reference)}`:'';
    state.selectedLane=selectedLane?lanes.indexOf(selectedLane):(lanes.length?0:-1);
    state.selectedResultLane=resultLane?lanes.indexOf(resultLane):0;
    if(selectionLane){const li=lanes.indexOf(selectionLane);state.selection=state.selection.type==='band'&&selectionBand?{type:'band',laneIndex:li,bandIndex:selectionLane.bands.indexOf(selectionBand)}:{type:'lane',laneIndex:li};}
  }
  function updateLaneWidthControl(){const input=$('laneWidth'),max=Math.max(5,Math.floor(canvas.width*.4));input.max=String(max);input.value=String(Math.min(max,Math.max(4,Math.round(state.laneWidth??0))));$('laneWidthValue').textContent=`${input.value} px`;input.disabled=!state.image||!state.lanes.length;}
  function updateBandHeightControl(){const input=$('bandHeight'),max=Math.max(3,Math.floor(canvas.height*.2));input.max=String(max);input.value=String(Math.min(max,Math.max(2,Math.round(state.bandHeight??0))));$('bandHeightValue').textContent=state.bandHeight==null?'—':`${input.value} px`;input.disabled=!state.image||!state.lanes.some(l=>l.bands.length);}
  function backgroundAt(gray,w,h,x,y){
    // Local background estimate from nearby rows suppresses lane-wide illumination drift.
    const d=Math.max(3,Math.round(h*.015)), a=gray[Math.max(0,y-d)*w+x],b=gray[Math.min(h-1,y+d)*w+x]; return (a+b)*.5;
  }
  function referenceBand(){if(!state.referenceBandKey)return null;const [li,bi]=state.referenceBandKey.split(':').map(Number);return state.lanes[li]?.bands[bi]||null;}
  function setMarkerLane(index){state.markerLaneIndex=index;state.lanes.forEach((lane,li)=>lane.role=li===index?'marker':'sample');if(index!=null&&state.referenceLaneIndex===index){state.referenceLaneIndex=null;state.referenceBandKey='';state.lanes.forEach(l=>l.bands.forEach(b=>b.reference=false));$('refConcInput').value='';}if(index!=null){state.lanes[index].bands.forEach(b=>{if(b.reference){b.reference=false;b.refConc=null;}});state.referenceBandKey='';$('refConcInput').value='';}invalidate();renderAnnotation();}
  function setReferenceLane(index){state.referenceLaneIndex=index;state.referenceBandKey='';state.lanes.forEach(l=>l.bands.forEach(b=>b.reference=false));$('refConcInput').value='';invalidate();renderAnnotation();}
  function setReferenceBand(key){state.referenceBandKey=key;if(key)state.referenceLaneIndex=+key.split(':')[0];state.lanes.forEach(l=>l.bands.forEach(b=>b.reference=false));const band=referenceBand();if(band)band.reference=true;$('refConcInput').value=band?.refConc??'';invalidate();renderAnnotation();}
  function invalidate(){state.results=[];state.calibration=null;$('r2Value').textContent='—';$('exportBtn').disabled=true;renderResultTable();updateCalculationState();draw();if(canCalculateAnything())calculate(false);}
  function render(){draw();renderAnnotation();updateCalculationState();renderResultTable();updateEditControls();updateLaneWidthControl();updateBandHeightControl();}
  function renderResultTabs(){const tabs=$('resultLaneTabs');if(!state.lanes.length){tabs.innerHTML='';return;}if(state.selectedResultLane>=state.lanes.length)state.selectedResultLane=0;tabs.innerHTML=state.lanes.map((lane,li)=>`<button class="lane-tab ${li===state.selectedResultLane?'active':''}" role="tab" aria-selected="${li===state.selectedResultLane}" data-result-lane="${li}">泳道 ${li+1}<span>${lane.bands.length} 条带</span></button>`).join('');tabs.querySelectorAll('[data-result-lane]').forEach(button=>button.onclick=()=>{state.selectedResultLane=+button.dataset.resultLane;renderResultTable();});}
  function renderResultTable(){renderResultTabs();const li=state.selectedResultLane,lane=state.lanes[li];const totalBands=state.lanes.reduce((n,l)=>n+l.bands.length,0);$('resultCount').textContent=state.lanes.length?`${state.lanes.length} 条泳道 · ${totalBands} 条带`:'等待上传胶图';if(!lane){$('resultsBody').innerHTML='<tr><td colspan="7" class="table-empty">上传胶图后将自动识别并显示条带 IOD。</td></tr>';return;}if(state.results.length){const rows=state.results.filter(r=>r.li===li);$('resultsBody').innerHTML=rows.length?rows.map(r=>`<tr><td>条带 ${r.bi+1}</td><td>${Math.round(state.lanes[li].bands[r.bi].yCenter)}</td><td>${r.rf==null?'—':r.rf.toFixed(4)}</td><td class="result-value">${Math.round(r.iod).toLocaleString()}</td><td>${formatNum(r.mw)} ${$('mwUnit').value}${r.extrap?'†':''}</td><td>${r.conc==null?'—':`${formatNum(r.conc)} ng/μL`}</td><td><span class="result-tag ${r.marker?'marker':''}">${r.marker?'Marker':r.extrap?'超出标定范围':'样品'}</span></td></tr>`).join(''):'<tr><td colspan="7" class="table-empty">该泳道没有识别到条带。</td></tr>';return;}const rows=lane.bands.map((band,bi)=>{const well=numberOrNull($('wellY').value)??0,end=numberOrNull($('gelEndY').value)??canvas.height,rf=end>well?(band.yCenter-well)/(end-well):null,status=lane.role==='marker'?(band.mw>0?'Marker 已标注':'Marker 待标注'):band.reference?'浓度参考条带':'等待计算';return `<tr><td>条带 ${bi+1}</td><td>${Math.round(band.yCenter)}</td><td>${rf==null?'—':rf.toFixed(4)}</td><td class="result-value">${Math.round(band.iod).toLocaleString()}</td><td>${band.mw?`${formatNum(band.mw)} ${$('mwUnit').value}`:'—'}</td><td>${band.reference&&band.refConc!=null?`${formatNum(band.refConc)} ng/μL`:'—'}</td><td><span class="result-tag ${lane.role==='marker'?'marker':''}">${status}</span></td></tr>`;});$('resultsBody').innerHTML=rows.length?rows.join(''):'<tr><td colspan="7" class="table-empty">该泳道没有识别到条带。可调整灵敏度或手动补加条带。</td></tr>';}
  function renderAnnotation(){const laneSelect=$('markerLaneSelect'),marker=state.markerLaneIndex==null?null:state.lanes[state.markerLaneIndex];laneSelect.disabled=!state.lanes.length;laneSelect.innerHTML='<option value="">请选择 Marker 泳道</option>'+state.lanes.map((l,li)=>`<option value="${li}">泳道 ${li+1} · ${l.bands.length} 条带</option>`).join('');laneSelect.value=marker?String(state.markerLaneIndex):'';const editor=$('markerBandsEditor');if(!marker){editor.innerHTML='<div class="field-hint">请选择 Marker 泳道，系统会列出该泳道的所有条带。</div>';}else if(!marker.bands.length){editor.innerHTML='<div class="field-hint">该泳道未识别到条带，请调整图像识别灵敏度。</div>';}else{editor.innerHTML='<div class="marker-band-row header"><span>条带</span><span>位置 y</span><span>IOD</span><span>已知分子量</span></div>'+marker.bands.map((band,bi)=>`<div class="marker-band-row"><span>条带 ${bi+1}</span><span>${Math.round(band.yCenter)}</span><span class="iod-cell">${Math.round(band.iod).toLocaleString()}</span><input type="number" min="0" step="any" data-marker-band="${bi}" value="${band.mw??''}" placeholder="${$('mwUnit').value}"></div>`).join('');editor.querySelectorAll('[data-marker-band]').forEach(input=>input.onchange=()=>{const band=marker.bands[+input.dataset.markerBand];band.mw=numberOrNull(input.value);invalidate();});}
    const refLaneSelect=$('referenceLaneSelect'),sampleLanes=state.lanes.map((l,li)=>({lane:l,index:li})).filter(item=>item.lane.role!=='marker');if(!sampleLanes.some(item=>item.index===state.referenceLaneIndex)){state.referenceLaneIndex=null;state.referenceBandKey='';}refLaneSelect.disabled=!sampleLanes.length;refLaneSelect.innerHTML='<option value="">请选择参考泳道</option>'+sampleLanes.map(item=>`<option value="${item.index}">泳道 ${item.index+1} · ${item.lane.bands.length} 条带</option>`).join('');refLaneSelect.value=state.referenceLaneIndex==null?'':String(state.referenceLaneIndex);const refSelect=$('referenceBandSelect'),refs=state.referenceLaneIndex==null?[]:(state.lanes[state.referenceLaneIndex]?.bands||[]).map((b,bi)=>({key:`${state.referenceLaneIndex}:${bi}`,band:bi}));refSelect.disabled=!refs.length;refSelect.innerHTML=`<option value="">${state.referenceLaneIndex==null?'请先选择参考泳道':'请选择该泳道上的条带'}</option>`+refs.map(r=>`<option value="${r.key}">条带 ${r.band+1}</option>`).join('');if(!refs.some(r=>r.key===state.referenceBandKey))state.referenceBandKey='';refSelect.value=state.referenceBandKey;const ref=referenceBand();$('refConcInput').disabled=!ref;$('refConcInput').value=ref?.refConc??'';}
  function updateEditControls(){const hasImage=!!state.image;document.querySelectorAll('[data-mode]').forEach(b=>b.disabled=!hasImage);$('recognizeSelectionBtn').disabled=!hasImage||!state.selection;$('deleteSelectionBtn').disabled=!hasImage||!state.selection;if(!state.selection)$('editStatus').textContent=state.editMode==='select'?'拖动已有框可移动位置':state.editMode==='lane'?'在胶图上拖动，框出泳道宽度':'在所属泳道内拖动，框选条带区域';else if(state.selection.type==='lane')$('editStatus').textContent=`已选中泳道 ${state.selection.laneIndex+1} · 拖动可移动框`;else $('editStatus').textContent=`已选中泳道 ${state.selection.laneIndex+1} 条带 ${state.selection.bandIndex+1} · 拖动可移动框`;}
  function pointFromEvent(event){const rect=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(canvas.width,(event.clientX-rect.left)*canvas.width/rect.width)),y:Math.max(0,Math.min(canvas.height,(event.clientY-rect.top)*canvas.height/rect.height))};}
  function onCanvasPointerDown(event){if(!state.image)return;event.preventDefault();canvas.setPointerCapture(event.pointerId);const p=pointFromEvent(event);if(state.editMode==='lane'||state.editMode==='band'){state.gesture={kind:'draw',mode:state.editMode,start:p,current:p};draw();return;}const hit=hitTest(p);state.selection=hit;if(!hit){updateEditControls();draw();return;}const lane=state.lanes[hit.laneIndex];state.selectedLane=hit.laneIndex;state.selectedResultLane=hit.laneIndex;if(hit.type==='lane')state.gesture={kind:'move-lane',selection:hit,start:p,original:{x1:lane.x1,x2:lane.x2,bands:lane.bands.map(b=>({x1:b.x1,x2:b.x2}))}};else{const band=lane.bands[hit.bandIndex];state.gesture={kind:'move-band',selection:hit,start:p,original:{x1:band.x1??lane.x1,x2:band.x2??lane.x2,y1:band.y1,y2:band.y2}};}updateEditControls();draw();renderResultTable();}
  function hitTest(p){for(let li=state.lanes.length-1;li>=0;li--){const lane=state.lanes[li];for(let bi=lane.bands.length-1;bi>=0;bi--){const b=lane.bands[bi],x1=b.x1??lane.x1,x2=b.x2??lane.x2;if(p.x>=x1&&p.x<=x2&&p.y>=b.y1&&p.y<=b.y2)return{type:'band',laneIndex:li,bandIndex:bi};}if(p.x>=lane.x1&&p.x<=lane.x2)return{type:'lane',laneIndex:li};}return null;}
  function onCanvasPointerMove(event){const g=state.gesture;if(!g)return;event.preventDefault();const p=pointFromEvent(event);if(g.kind==='draw'){g.current=p;draw();return;}const dx=p.x-g.start.x,dy=p.y-g.start.y;if(g.kind==='move-lane'){const lane=state.lanes[g.selection.laneIndex];if(!lane.manual)lane.originalAutoCenter=(lane.x1+lane.x2)/2;lane.manual=true;const width=g.original.x2-g.original.x1,x1=Math.max(0,Math.min(canvas.width-width,g.original.x1+dx)),shift=x1-g.original.x1;lane.x1=x1;lane.x2=x1+width;lane.bands.forEach((b,i)=>{if(b.x1!=null){b.x1=g.original.bands[i].x1+shift;b.x2=g.original.bands[i].x2+shift;}});}else{const lane=state.lanes[g.selection.laneIndex],band=lane.bands[g.selection.bandIndex],height=g.original.y2-g.original.y1,y1=Math.max(0,Math.min(canvas.height-height,g.original.y1+dy));band.x1=lane.x1;band.x2=lane.x2;band.y1=y1;band.y2=y1+height;band.yCenter=y1+height/2;}draw();}
  function onCanvasPointerUp(event){const g=state.gesture;if(!g)return;const p=pointFromEvent(event);state.gesture=null;if(g.kind==='draw')finishDraw(g,p);else{if(g.kind==='move-band'){const band=state.lanes[g.selection.laneIndex].bands[g.selection.bandIndex];if(state.analysisEngine!=='python')band.iod=calculateBandIod(band);band.manual=true;}else regularizeLaneGeometry();invalidate();render();if(state.analysisEngine==='python'){if(g.kind==='move-lane')recognizeSelection();else schedulePythonMeasurements();}}}
  function finishDraw(g,p){const x1=Math.min(g.start.x,p.x),x2=Math.max(g.start.x,p.x),y1=Math.min(g.start.y,p.y),y2=Math.max(g.start.y,p.y);if(g.mode==='lane'){if(x2-x1<Math.max(5,canvas.width*.003)){$('editStatus').textContent='泳道框太窄，请重新框选';draw();return;}const lane=detectLaneBands(grayData(),canvas.width,canvas.height,Math.round(x1),Math.round(x2),state.lanes.length);lane.manual=true;lane.x1=Math.round(x1);lane.x2=Math.round(x2);state.lanes.push(lane);state.selectedLane=state.lanes.length-1;state.selectedResultLane=state.selectedLane;state.selection={type:'lane',laneIndex:state.selectedLane};regularizeLaneGeometry();const li=state.lanes.indexOf(lane);state.selection={type:'lane',laneIndex:li};$('detectionInfo').textContent=`检测到 ${state.lanes.length} 条泳道 · ${state.lanes.reduce((n,l)=>n+l.bands.length,0)} 条条带`;$('editStatus').textContent=`已新增泳道 ${li+1}，初步识别 ${lane.bands.length} 条带` ;invalidate();render();if(state.analysisEngine==='python')recognizeSelection();return;}const li=state.lanes.findIndex(l=>g.start.x>=l.x1&&g.start.x<=l.x2);if(li<0){$('editStatus').textContent='条带框必须从已有泳道内开始；请先框选泳道';draw();return;}const lane=state.lanes[li],bx1=lane.x1,bx2=lane.x2,by1=Math.round(y1),by2=Math.round(y2);if(x2-x1<2||by2-by1<2){$('editStatus').textContent='条带框太小，请重新框选';draw();return;}const refObject=referenceBand(),band={x1:bx1,x2:bx2,y1:by1,y2:by2,yCenter:(by1+by2)/2,iod:0,mw:null,reference:false,refConc:null,manual:true};band.iod=calculateBandIod(band);lane.bands.push(band);lane.bands.sort((a,b)=>a.yCenter-b.yCenter);const bi=lane.bands.indexOf(band);if(refObject&&state.referenceLaneIndex===li)state.referenceBandKey=`${li}:${lane.bands.indexOf(refObject)}`;state.selection={type:'band',laneIndex:li,bandIndex:bi};state.selectedLane=li;state.selectedResultLane=li;regularizeLaneGeometry();$('detectionInfo').textContent=`检测到 ${state.lanes.length} 条泳道 · ${state.lanes.reduce((n,l)=>n+l.bands.length,0)} 条条带`;$('editStatus').textContent=`已框选条带，IOD ${Math.round(band.iod).toLocaleString()}`;invalidate();render();if(state.analysisEngine==='python')recognizeSelection();}
  function calculateBandIod(band){return calculateBandIodFromGray(band,grayData());}
  function calculateBandIodFromGray(band,gray){const w=canvas.width,h=canvas.height,x1=Math.max(0,Math.floor(band.x1)),x2=Math.min(w,Math.ceil(band.x2)),y1=Math.max(0,Math.floor(band.y1)),y2=Math.min(h,Math.ceil(band.y2));let iod=0;for(let y=y1;y<y2;y++)for(let x=x1;x<x2;x++)iod+=Math.max(0,(gray[y*w+x]-backgroundAt(gray,w,h,x,y))*state.polarity);return iod;}
  async function recognizeSelection(){
    if(!state.selection){runDetection();return;}
    const selection=state.selection,li=selection.laneIndex,lane=state.lanes[li];
    if(state.analysisEngine==='python'){
      try{
        if(selection.type==='band'){
          const band=lane.bands[selection.bandIndex],pad=Math.max(4,(band.y2-band.y1)*1.5);
          const result=await analyzeWithPython(state.imageFile,{roi_x1:lane.x1,roi_x2:lane.x2,roi_y1:Math.max(0,band.y1-pad),roi_y2:Math.min(canvas.height,band.y2+pad)});
          const detected=result.lanes.flatMap(l=>l.bands).sort((a,b)=>Math.abs(a.y_center-band.yCenter)-Math.abs(b.y_center-band.yCenter))[0];
          if(detected){band.iod=detected.iod;band.confidence=detected.confidence;band.saturated_fraction=detected.saturated_fraction;band.quantification_usable=detected.quantification_usable;}
          band.manual=true;invalidate();render();schedulePythonMeasurements();return;
        }
        const old=lane.bands,refObject=referenceBand();
        const result=await analyzeWithPython(state.imageFile,{roi_x1:lane.x1,roi_x2:lane.x2,roi_y1:0,roi_y2:canvas.height});
        const candidate=mapPythonLanes(result).sort((a,b)=>b.bands.length-a.bands.length)[0];
        if(candidate){candidate.x1=lane.x1;candidate.x2=lane.x2;candidate.manual=lane.manual;candidate.role=lane.role;preserveAnnotations([candidate],[lane]);old.filter(b=>b.manual).forEach(manualBand=>{if(!candidate.bands.some(b=>Math.abs(b.yCenter-manualBand.yCenter)<canvas.height*.01))candidate.bands.push(manualBand);});candidate.bands.sort((a,b)=>a.yCenter-b.yCenter);state.lanes[li]=candidate;if(refObject&&state.referenceLaneIndex===li){const newRefIndex=candidate.bands.findIndex(b=>b.reference);state.referenceBandKey=newRefIndex<0?'':`${li}:${newRefIndex}`;}}
        state.analysisEngine='python';state.selection={type:'lane',laneIndex:li};regularizeLaneGeometry();$('detectionInfo').textContent=`泳道 ${li+1} 重新识别出 ${state.lanes[li].bands.length} 条带 · Python CV`;$('editStatus').textContent=`泳道 ${li+1} 已由 Python 重新识别`;invalidate();render();schedulePythonMeasurements();return;
      }catch(error){$('editStatus').textContent=`Python 识别失败，已使用浏览器算法：${error.message}`;}
    }
    if(selection.type==='band'){const b=state.lanes[li].bands[selection.bandIndex];b.iod=calculateBandIod(b);b.manual=true;invalidate();render();return;}
    const old=lane.bands,refObject=referenceBand(),next=detectLaneBands(grayData(),canvas.width,canvas.height,lane.x1,lane.x2,li);next.manual=lane.manual;next.role=lane.role;next.bands.forEach(b=>{const prior=old.reduce((best,candidate)=>!best||Math.abs(candidate.yCenter-b.yCenter)<Math.abs(best.yCenter-b.yCenter)?candidate:best,null);if(prior&&Math.abs(prior.yCenter-b.yCenter)<canvas.height*.025)Object.assign(b,{mw:prior.mw,reference:prior.reference,refConc:prior.refConc,refVolume:prior.refVolume});});old.filter(b=>b.manual).forEach(manualBand=>{if(!next.bands.some(b=>Math.abs(b.yCenter-manualBand.yCenter)<canvas.height*.01))next.bands.push(manualBand);});next.bands.sort((a,b)=>a.yCenter-b.yCenter);state.lanes[li]=next;if(refObject&&state.referenceLaneIndex===li){const newRefIndex=next.bands.findIndex(b=>b.reference);state.referenceBandKey=newRefIndex<0?'':`${li}:${newRefIndex}`;}state.analysisEngine='browser';state.selection={type:'lane',laneIndex:li};regularizeLaneGeometry();$('detectionInfo').textContent=`泳道 ${li+1} 重新识别出 ${next.bands.length} 条带 · 浏览器算法`;$('editStatus').textContent=`泳道 ${li+1} 已重新识别`;invalidate();render();
  }
  function deleteSelection(){if(!state.selection)return;const s=state.selection;if(s.type==='lane'){state.lanes.splice(s.laneIndex,1);if(state.markerLaneIndex===s.laneIndex)state.markerLaneIndex=null;else if(state.markerLaneIndex>s.laneIndex)state.markerLaneIndex--;if(state.referenceLaneIndex===s.laneIndex){state.referenceLaneIndex=null;state.referenceBandKey='';}else if(state.referenceLaneIndex>s.laneIndex){state.referenceLaneIndex--;if(state.referenceBandKey)state.referenceBandKey=`${state.referenceLaneIndex}:${state.referenceBandKey.split(':')[1]}`;}if(state.selectedResultLane>=state.lanes.length)state.selectedResultLane=Math.max(0,state.lanes.length-1);}else{const lane=state.lanes[s.laneIndex];lane.bands.splice(s.bandIndex,1);if(state.referenceBandKey){const [li,bi]=state.referenceBandKey.split(':').map(Number);if(li===s.laneIndex&&bi===s.bandIndex){state.referenceBandKey='';state.referenceLaneIndex=null;}else if(li===s.laneIndex&&bi>s.bandIndex)state.referenceBandKey=`${li}:${bi-1}`;}}state.selection=null;if(s.type==='lane')regularizeLaneGeometry();$('detectionInfo').textContent=`检测到 ${state.lanes.length} 条泳道 · ${state.lanes.reduce((n,l)=>n+l.bands.length,0)} 条条带`;invalidate();render();}
  function draw(){if(!state.image)return;ctx.drawImage(state.image,0,0);state.lanes.forEach((lane,li)=>{const laneSelected=state.selection?.type==='lane'&&state.selection.laneIndex===li;ctx.fillStyle=laneSelected?'rgba(231,158,68,.10)':'rgba(45,126,197,.045)';ctx.fillRect(lane.x1,0,lane.x2-lane.x1,canvas.height);ctx.strokeStyle=laneSelected?'#e09b42':palette[li%palette.length];ctx.lineWidth=Math.max(1,canvas.width/900);ctx.setLineDash(lane.manual?[5,4]:[]);ctx.strokeRect(lane.x1,0,lane.x2-lane.x1,canvas.height);ctx.setLineDash([]);ctx.fillStyle=palette[li%palette.length];ctx.font=`${Math.max(10,canvas.width/90)}px sans-serif`;ctx.fillText(`L${li+1}${lane.manual?' · 手动':''}`,lane.x1+3,Math.max(14,canvas.height*.03));lane.bands.forEach((band,bi)=>{const x1=band.x1??lane.x1,x2=band.x2??lane.x2,selected=state.selection?.type==='band'&&state.selection.laneIndex===li&&state.selection.bandIndex===bi;ctx.fillStyle=selected?'rgba(231,158,68,.45)':'rgba(25,139,113,.30)';ctx.fillRect(x1,band.y1,x2-x1,Math.max(2,band.y2-band.y1));ctx.strokeStyle=selected?'#e09b42':'#16826d';ctx.lineWidth=Math.max(1,canvas.width/850);ctx.setLineDash(band.manual?[4,3]:[]);ctx.strokeRect(x1,band.y1,x2-x1,Math.max(2,band.y2-band.y1));ctx.setLineDash([]);});});const g=state.gesture;if(g?.kind==='draw'){const x=Math.min(g.start.x,g.current.x),y=Math.min(g.start.y,g.current.y),w=Math.abs(g.current.x-g.start.x),h=Math.abs(g.current.y-g.start.y);ctx.fillStyle='rgba(45,126,197,.12)';ctx.fillRect(x,y,w,h);ctx.strokeStyle='#267db9';ctx.lineWidth=Math.max(2,canvas.width/700);ctx.setLineDash([7,5]);ctx.strokeRect(x,y,w,h);ctx.setLineDash([]);}}
  function hasValidReference(){return state.lanes.some(l=>l.bands.some(b=>b.reference&&b.refConc>0&&b.iod>0));}
  function hasMolecularWeightCalibration(){return state.lanes.reduce((n,l)=>n+(l.role==='marker'?l.bands.filter(b=>Number.isFinite(b.mw)&&b.mw>0).length:0),0)>=2;}
  function canCalculateAnything(){return hasValidReference()||hasMolecularWeightCalibration();}
  function updateCalculationState(){const hasMarker=hasMolecularWeightCalibration(),hasRef=hasValidReference(),ready=hasMarker||hasRef;$('calculateBtn').disabled=!ready;$('calculateBtn').textContent=hasMarker&&hasRef?'计算分子量与浓度':hasRef?'计算分子浓度':'计算分子量';$('fitStatus').textContent=hasMarker&&hasRef?'可计算分子量与浓度':hasRef?'可计算浓度':hasMarker?'可计算分子量':'待标注';$('fitStatus').className=`chip ${ready?'':'chip-muted'}`;$('calculationNote').textContent=hasMarker&&hasRef?'已标定 Marker 和参考条带显示输入值；其他条带按 Marker 拟合与 IOD 比例估算。':hasRef?'参考浓度已设置，可计算浓度；标注至少 2 个 Marker 后还可计算分子量。':hasMarker?'Marker 已标注；设置参考条带浓度后可计算浓度。':'请设置参考条带浓度，或标注至少 2 个 Marker 条带。';}
  function calculate(scroll=true){
    const {well,end}=gelBounds(),validBounds=end>well,rfOf=(y)=>validBounds?(y-well)/(end-well):null;
    const markers=[];state.lanes.forEach((l,li)=>{if(l.role==='marker')l.bands.forEach((b,bi)=>{if(Number.isFinite(b.mw)&&b.mw>0&&validBounds)markers.push({rf:rfOf(b.yCenter),mw:b.mw,li,bi});});});
    let calibration=null,r2=null;
    if(markers.length>=2){const x=markers.map(m=>m.rf),y=markers.map(m=>Math.log10(m.mw)),xm=mean(x),ym=mean(y);let cov=0,vx=0,vy=0;for(let i=0;i<x.length;i++){cov+=(x[i]-xm)*(y[i]-ym);vx+=(x[i]-xm)**2;vy+=(y[i]-ym)**2;}if(vx>0){const k=cov/vx,b=ym-k*xm;let sse=0;for(let i=0;i<x.length;i++)sse+=(y[i]-(k*x[i]+b))**2;r2=vy===0?1:1-sse/vy;calibration={k,b,r2,minRf:Math.min(...x),maxRf:Math.max(...x)};}else if(scroll)alert('Marker 条带的位置相同，无法拟合分子量；浓度仍可按参考条带计算。');}
    state.calibration=calibration;
    const ref=state.lanes.flatMap((l,li)=>l.bands.map((band,bi)=>({lane:l,band,li,bi}))).find(o=>o.band.reference&&o.band.refConc>0&&o.band.iod>0);
    if(!ref&&!calibration){state.results=[];renderResultTable();updateCalculationState();return;}
    const refVolume=ref?(ref.band.refVolume??ref.lane.volume):null,rows=[];
    state.lanes.forEach((lane,li)=>lane.bands.forEach((band,bi)=>{const rf=rfOf(band.yCenter),isReference=ref?.band===band;let conc=null;if(ref){if(isReference)conc=ref.band.refConc;else{const vol=lane.volume??refVolume;if(refVolume>0&&vol>0)conc=ref.band.refConc*(band.iod/ref.band.iod)*(refVolume/vol);else if(refVolume==null&&lane.volume==null)conc=ref.band.refConc*(band.iod/ref.band.iod);}}
      const extrap=calibration&&rf!=null?(rf<calibration.minRf||rf>calibration.maxRf):false,mw=lane.role==='marker'&&Number.isFinite(band.mw)&&band.mw>0?band.mw:calibration&&rf!=null?Math.pow(10,calibration.k*rf+calibration.b):null;rows.push({li,bi,rf,iod:band.iod,mw,conc,extrap,marker:lane.role==='marker'});
    }));state.results=rows;
    if(calibration){$('r2Value').textContent=r2.toFixed(4);$('fitStatus').textContent=r2>=.95?'拟合良好':'需检查标注';$('fitStatus').className=`chip ${r2>=.95?'':'chip-muted'}`;$('calculationNote').textContent=`log₁₀(MW) = ${calibration.k.toFixed(4)} × Rf + ${calibration.b.toFixed(4)} · ${markers.length} 个 Marker 标注${ref?' · 浓度按参考条带 IOD 比例估算':''}${r2<.95?' · R² 偏低，请检查标注或 Marker 条带':''}`;}else{$('r2Value').textContent='—';$('fitStatus').textContent=ref?'浓度已计算':'待标注';$('fitStatus').className=`chip ${ref?'':'chip-muted'}`;$('calculationNote').textContent=ref?'浓度已按参考条带 IOD 比例更新；标注至少 2 个 Marker 后可计算分子量。':'标注至少 2 个 Marker 条带后可计算分子量。';}
    renderResultTable();$('exportBtn').disabled=false;if(scroll)$('resultsPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
  }
  function gelBounds(){return {well:numberOrNull($('wellY').value)??0,end:numberOrNull($('gelEndY').value)??canvas.height};}
  function mean(a){return a.reduce((s,v)=>s+v,0)/a.length;}function formatNum(n){return n==null?'—':Number(n).toLocaleString('zh-CN',{maximumFractionDigits:2});}
  function exportCsv(){if(!state.results.length)return;const rows=[['lane','band','y_px','Rf','IOD','molecular_weight','concentration_ng_uL','status'],...state.results.map(r=>[r.li+1,r.bi+1,Math.round(state.lanes[r.li].bands[r.bi].yCenter),r.rf==null?'':r.rf.toFixed(5),r.iod.toFixed(1),r.mw==null?'':r.mw.toFixed(2),r.conc==null?'':r.conc.toFixed(3),r.marker?'marker':r.extrap?'extrapolated':'sample'])];const csv='\ufeff'+rows.map(row=>row.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\r\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download='gel-analysis-results.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
})();
