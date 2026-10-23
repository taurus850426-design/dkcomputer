/* Local, on-demand Canvas 3D projection. Generic geometry, never a fit certificate. */
(function(){
 'use strict';
 const $=id=>document.getElementById(id),canvas=$('buildCanvas'),core=window.DKBuilder;
 if(!canvas||!core)return;
 let ctx;try{ctx=canvas.getContext('2d');}catch(_){}
 if(!ctx){canvas.hidden=true;$('previewFallback').hidden=false;return;}
 let parts={},yaw=-.52,pitch=.16,zoom=1,frame=0,drag=null,width=270,height=300;
 const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
 const slots=core.slots,amber='#d4a55c',ghost='#596772';
 function status(key){return !parts[key]?'empty':parts[key].isCustom?'unknown':'selected';}
 function paint(key,fallback){const p=parts[key];if(!p)return ghost;if(p.isCustom)return amber;const c=core.colorOf(p);return c==='white'?'#dce6e8':c==='black'?'#36424d':fallback;}
 function transform([x,y,z]){const a=x*Math.cos(yaw)+z*Math.sin(yaw),b=-x*Math.sin(yaw)+z*Math.cos(yaw);return [a,y*Math.cos(pitch)-b*Math.sin(pitch),y*Math.sin(pitch)+b*Math.cos(pitch)];}
 function project(v){const [x,y,z]=transform(v),s=Math.min(width/6.3,height/6.5)*zoom;return [width/2+x*s,height*.52-y*s,z];}
 function draw(){
  frame=0;if(!canvas.isConnected||!$('buildPreview').open)return;
  const rect=canvas.getBoundingClientRect();if(!rect.width)return;
  width=rect.width;height=rect.height;const ratio=Math.min(window.devicePixelRatio||1,2);
  canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);ctx.setTransform(ratio,0,0,ratio,0,0);
  const bg=ctx.createRadialGradient(width*.5,height*.42,5,width*.5,height*.5,height*.75);bg.addColorStop(0,'#24343b');bg.addColorStop(1,'#0c131a');ctx.fillStyle=bg;ctx.fillRect(0,0,width,height);
  ctx.fillStyle='#0005';ctx.beginPath();ctx.ellipse(width/2,height*.89,width*.34,height*.045,0,0,Math.PI*2);ctx.fill();
  const faces=[],edges=[];
  function box(key,cx,cy,cz,w,h,d,color){
   const v=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(([x,y,z])=>[cx+x*w/2,cy+y*h/2,cz+z*d/2]);
   const state=status(key),polys=[[0,1,2,3],[4,7,6,5],[0,4,5,1],[3,2,6,7],[1,5,6,2],[0,3,7,4]];
   if(state==='empty'){for(const [a,b]of [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]])edges.push({v:[v[a],v[b]],color:ghost,dash:true});return;}
   polys.forEach((indices,i)=>{const points=indices.map(j=>project(v[j]));faces.push({points,z:points.reduce((s,p)=>s+p[2],0)/4,color,shade:[.22,0,.28,.04,.13,.2][i],key});});
  }
  // Universal mid-tower, open side; dimensions here are drawing units only.
  const shell=paint('case','#71818a');
  for(const x of [-1.45,1.45])for(const z of [-.87,.87])box('case',x,0,z,.075,3.9,.075,shell);
  for(const y of [-1.95,1.95]){box('case',0,y,0,3,.075,1.8,shell);}
  box('case',0,-1.42,0,2.9,.07,1.73,shell);
  box('board',-.35,.35,-.72,1.9,2.65,.085,paint('board','#355b62'));
  box('cpu',-.43,.84,-.59,.47,.47,.12,paint('cpu','#b7c9cd'));
  for(const x of [.4,.62])box('ram',x,.81,-.43,.11,1.25,.43,paint('ram','#92bba0'));
  box('ssd',-.43,-.13,-.6,.72,.17,.07,paint('ssd','#b1a778'));
  box('gpu',-.23,-.66,-.02,2.05,.34,1.06,paint('gpu','#719782'));
  box('cooler',-.43,.84,-.14,.76,.87,.75,paint('cooler','#9ba9ac'));
  box('psu',-.8,-1.72,0,1.16,.42,1.32,paint('psu','#52616a'));
  // Non-SKU illustrative fan/fin detail, omitted for unknown and unselected parts.
  if(status('cooler')==='selected')for(let y=.48;y<1.25;y+=.09)box('cooler',-.43,y,.25,.72,.018,.015,'#5e737b');
  function ring(key,cx,cy,cz,r,axis){
   if(status(key)!=='selected')return;
   const color=paint(key,'#94c1b6'),v=[];for(let i=0;i<=32;i++){const a=i/32*Math.PI*2;v.push(axis==='x'?[cx,cy+Math.cos(a)*r,cz+Math.sin(a)*r]:[cx+Math.cos(a)*r,cy+Math.sin(a)*r,cz]);}
   // Fan lines participate in depth sorting, so a rear detail cannot shine through a front panel.
   for(let i=1;i<v.length;i++){const points=[project(v[i-1]),project(v[i])];faces.push({points,z:(points[0][2]+points[1][2])/2,color,line:true});}
   for(let i=0;i<7;i++){const a=i/7*Math.PI*2,outer=axis==='x'?[cx,cy+Math.cos(a)*r*.8,cz+Math.sin(a)*r*.8]:[cx+Math.cos(a)*r*.8,cy+Math.sin(a)*r*.8,cz];const points=[project([cx,cy,cz]),project(outer)];faces.push({points,z:(points[0][2]+points[1][2])/2,color,line:true});}
  }
  for(const y of [-.77,.35,1.47])ring('case',1.46,y,0,.43,'x');
  for(const x of [-.78,.27])ring('gpu',x,-.66,.52,.12,'z');
  faces.sort((a,b)=>a.z-b.z).forEach(f=>{ctx.beginPath();f.points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));if(f.line){ctx.strokeStyle=f.color;ctx.lineWidth=1.6;ctx.stroke();return;}ctx.closePath();ctx.fillStyle=f.color;ctx.fill();ctx.fillStyle='rgba(0,0,0,'+f.shade+')';ctx.fill();ctx.strokeStyle='#0a131944';ctx.lineWidth=.65;ctx.stroke();});
  ctx.setLineDash([3,4]);ctx.lineWidth=.8;edges.forEach(e=>{ctx.strokeStyle=e.color+'88';ctx.beginPath();e.v.map(project).forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.stroke();});ctx.setLineDash([]);
  canvas.dataset.yaw=yaw.toFixed(3);canvas.dataset.zoom=zoom.toFixed(2);canvas.dataset.selected=String(Object.keys(parts).length);
 }
 function request(){if(!frame)frame=requestAnimationFrame(draw);}
 function rotate(x,y=0){yaw+=x;pitch=clamp(pitch+y,-.65,.65);request();}
 function scale(x){zoom=clamp(zoom+x,.7,1.25);request();}
 function reset(){yaw=-.52;pitch=.16;zoom=1;request();}
 canvas.addEventListener('pointerdown',e=>{if(!e.isPrimary||e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);});
 canvas.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;rotate((e.clientX-drag.x)*.012,(e.clientY-drag.y)*.008);drag={id:e.pointerId,x:e.clientX,y:e.clientY};});
 const end=e=>{if(drag?.id===e.pointerId)drag=null;};for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,end);
 canvas.addEventListener('keydown',e=>{const keys={ArrowLeft:()=>rotate(-.2),ArrowRight:()=>rotate(.2),ArrowUp:()=>rotate(0,-.12),ArrowDown:()=>rotate(0,.12),'+':()=>scale(.1),'=':()=>scale(.1),'-':()=>scale(-.1),'0':reset};if(keys[e.key]){e.preventDefault();keys[e.key]();}});
 $('previewLeft').onclick=()=>rotate(-.25);$('previewRight').onclick=()=>rotate(.25);$('previewIn').onclick=()=>scale(.1);$('previewOut').onclick=()=>scale(-.1);$('previewReset').onclick=reset;
 $('buildPreview').addEventListener('toggle',request);
 if(window.ResizeObserver)new ResizeObserver(request).observe(canvas);else window.addEventListener('resize',request);
 window.DKBuilderPreview={update(selected){parts=Object.fromEntries(slots.filter(s=>selected[s.key]).map(s=>[s.key,selected[s.key]]));const known=slots.filter(s=>parts[s.key]&&!parts[s.key].isCustom),unknown=slots.filter(s=>parts[s.key]?.isCustom);$('previewState').textContent=known.length+' 項已選'+(unknown.length?'；'+unknown.map(s=>s.title).join('、')+'規格待確認':'')+'；'+(8-known.length-unknown.length)+' 項未選。';canvas.setAttribute('aria-label','電腦組裝通用示意：'+slots.map(s=>s.title+'（'+({empty:'未選',unknown:'規格待確認',selected:'已選'})[status(s.key)]+'）').join('、'));request();}};
 request();
})();
