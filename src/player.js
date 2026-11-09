// Builds the self-contained HTML player. The runtime below is written out as a
// string so the exported file has no dependencies.

const RUNTIME = String.raw`
(async()=>{
const M=JSON.parse(document.getElementById('dith-meta').textContent);
const b=atob(document.getElementById('dith-data').textContent.trim());
const z=new Uint8Array(b.length);for(let i=0;i<b.length;i++)z[i]=b.charCodeAt(i);
const raw=new Uint8Array(await new Response(new Blob([z]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
const c=document.getElementById('dith');c.width=M.w;c.height=M.h;
const g=c.getContext('2d'),img=g.createImageData(M.w,M.h),u=new Uint32Array(img.data.buffer);
const lut=M.palette.map(p=>(255<<24|p[2]<<16|p[1]<<8|p[0])>>>0);
const n=M.w*M.h,bits=M.bits,size=Math.ceil(n*bits/8),cur=new Uint8Array(size);
let f=-1,playing=true,last=0,acc=0;const dt=1000/M.fps;
function step(){
  f++;if(f>=M.frames){f=0;cur.fill(0);}
  const o=f*size;for(let i=0;i<size;i++)cur[i]^=raw[o+i];
  let bit=0;for(let i=0;i<n;i++){let v=0;for(let k=0;k<bits;k++,bit++)v|=((cur[bit>>3]>>(bit&7))&1)<<k;u[i]=lut[v];}
  g.putImageData(img,0,0);
}
step();
function tick(t){
  if(playing){acc+=Math.min(250,t-(last||t));let k=0;while(acc>=dt&&k++<4){acc-=dt;if(f===M.frames-1&&!M.loop){playing=false;break;}step();}}
  last=t;requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
c.addEventListener('click',()=>{playing=!playing;acc=0;});
})();
`;

export function buildPlayer({ w, h, fps, frames, levels, bits, palette, loop = true, data, title = 'Dithered video' }) {
  const meta = JSON.stringify({ w, h, fps, frames, levels, bits, palette, loop });
  const bg = `rgb(${palette[palette.length - 1].join(',')})`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<&]/g, '')}</title>
<style>
html,body{margin:0;height:100%;background:${bg}}
body{display:grid;place-items:center}
#dith{display:block;max-width:100vw;max-height:100vh;width:100%;height:100%;object-fit:contain;image-rendering:pixelated;image-rendering:crisp-edges;cursor:pointer}
</style>
</head>
<body>
<canvas id="dith" aria-label="Dithered video, click to pause"></canvas>
<script type="application/json" id="dith-meta">${meta}</script>
<script type="text/plain" id="dith-data">${data}</script>
<script>${RUNTIME}</script>
</body>
</html>
`;
}
