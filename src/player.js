// Builds the HTML export: a standalone page, or a snippet you paste into a site.
// The runtime below is written out as a string so the output has no dependencies.
// It finds its own nodes through document.currentScript, so a snippet can be pasted
// several times on one page.
import { glowFrame } from './glow.js';
import { findTwinkles, drawTwinkles } from './twinkle.js';
import { maskSpans, spreadFrame } from './looks.js';

const RUNTIME = String.raw`
(async()=>{
const R=document.currentScript.parentNode,q=s=>R.querySelector(s);
const M=JSON.parse(q('[type="application/json"]').textContent);
const un=t=>{const b=atob(t.trim()),z=new Uint8Array(b.length);for(let i=0;i<b.length;i++)z[i]=b.charCodeAt(i);return z};
const raw=new Uint8Array(await new Response(new Blob([un(q('[type="text/plain"]').textContent)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
const L=M.look,s=L?L.s:1,w=M.w,h=M.h,W=w*s,n=w*h,bits=M.bits,size=Math.ceil(n*bits/8),cur=new Uint8Array(size);
const c=q('canvas');c.width=W;c.height=h*s;
const g=c.getContext('2d'),img=g.createImageData(W,h*s),u=new Uint32Array(img.data.buffer);
const rgb=p=>(255<<24|p[2]<<16|p[1]<<8|p[0])>>>0;
const lut=M.palette.map(rgb);
// One s*s block of pixels per palette entry: mask 1 -> its colour, mask 0 -> background.
const mk=K=>{const m=un(K.m),bg=lut[lut.length-1],a=s*s;
  return lut.map((_,i)=>{const o=(K.cov[i]||0)*a,ink=lut[K.col[i]],r=[];
    for(let y=0;y<s;y++){const t=new Uint32Array(s);for(let x=0;x<s;x++){const k=o+y*s+x;t[x]=m[k>>3]>>(k&7)&1?ink:bg}r.push(t)}
    return r})};
// Overlapping looks (o: how far stamps reach past the cell) are drawn whole by spreadFrame.
const sp=L&&(L.o||M.lens&&M.lens.o);
let rows,rowsL,SP;
if(L){lut.push(rgb(L.bg));if(!sp){rows=mk(L);if(M.lens)rowsL=mk(M.lens)}}
if(sp){const tb=K=>{const o=K.o||0,e=s+2*o,a=e*e,m=un(K.m),r=[];
    for(let j=0;j<K.k;j++){const z=new Uint8Array(a);for(let i=0;i<a;i++){const b=j*a+i;z[i]=m[b>>3]>>(b&7)&1}r.push(maskSpans(z,e))}
    return{spans:r,off:o,cov:K.cov,col:K.col}};
  SP={ls:M.lens?[tb(L),tb(M.lens)]:[tb(L)],v:new Uint8Array(n),sel:M.lens?new Uint8Array(n):null,out:new Uint8Array(W*h*s),pri:new Uint8Array(W*h*s)}}
const G=M.glow,T=M.tw,ws={};
let f=-1,playing=!matchMedia('(prefers-reduced-motion:reduce)').matches,seen=true,last=0,acc=0,raf=0,drawn=0;
const dt=1000/M.fps,Z=M.lens&&lensRT(M,c,w,h,s,kick);
function advance(){f++;if(f>=M.frames){f=0;cur.fill(0)}const o=f*size;for(let i=0;i<size;i++)cur[i]^=raw[o+i]}
function draw(){
  let bit=0;
  for(let i=0;i<n;i++){
    let v=0;for(let k=0;k<bits;k++,bit++)v|=(cur[bit>>3]>>(bit&7)&1)<<k;
    if(SP){SP.v[i]=v;if(SP.sel)SP.sel[i]=Z.has(i)?1:0}
    else if(L){const r=(Z&&Z.has(i)?rowsL:rows)[v],p=((i/w|0)*W+i%w)*s;for(let y=0;y<s;y++)u.set(r[y],p+y*W)}
    else u[i]=lut[v];
  }
  if(SP){spreadFrame(SP.v,w,h,s,SP.ls,SP.sel,lut.length-1,SP.out,SP.pri);for(let q=0;q<SP.out.length;q++)u[q]=lut[SP.out[q]]}
  const tl=T&&findTwinkles(img.data,W,h*s,s,T.bg,T.t0+f/M.fps,T.a);
  if(G)glowFrame(img.data,W,h*s,G.bg,G.a,G.r,ws);
  if(tl)drawTwinkles(img.data,W,h*s,s,tl);
  g.putImageData(img,0,0);
}
advance();draw();
// One loop for playback and the lens: frames advance at fps, and the picture is redrawn
// at most once per animation frame (and at most ~30 times a second for lens moves alone).
function tick(t){
  raf=0;if(!seen)return;
  let d=0;
  if(playing&&M.frames>1){acc+=Math.min(250,t-(last||t));last=t;let k=0;
    while(acc>=dt&&k++<4){acc-=dt;if(!M.loop&&f===M.frames-1){playing=false;break}advance();d=1}}
  if(Z&&Z.move(t,playing&&M.frames>1)&&t-drawn>32)d=1;
  if(d){draw();drawn=t}
  if((playing&&M.frames>1)||(Z&&Z.busy()))raf=requestAnimationFrame(tick);
}
function kick(){if(!raf&&seen)raf=requestAnimationFrame(tick)}
const go=()=>{last=acc=0;if((playing&&M.frames>1)||(Z&&Z.busy()))kick()};
if(M.frames>1)c.addEventListener('click',()=>{if(Z&&Z.touch)return;playing=!playing;if(playing&&!M.loop&&f===M.frames-1){f=-1;cur.fill(0)}go()});
if(self.IntersectionObserver)new IntersectionObserver(e=>{seen=e[e.length-1].isIntersecting;go()}).observe(c);
go();
})();
`;

export const RUNTIME_BYTES = RUNTIME.length;

// The cursor lens, injected into the runtime only when a piece has one. Cells near the
// lens centre are drawn with the alternate look; a band around the edge mixes the two by
// a per-cell hash, so the rim is dithered too. The lens follows the pointer with easing,
// drifts on its own while playing and nobody is pointing (not with reduced motion), and
// a tap on touch screens moves it there. Must stay self-contained: shipped as source.
export function lensRT(M, c, w, h, s, kick) {
  const Z = M.lens, r = Z.r, th = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let a = Math.imul(i ^ 0x5bd1e995, 0x85ebca6b); a ^= a >>> 13; a = Math.imul(a, 0xc2b2ae35); a ^= a >>> 16;
    th[i] = (a >>> 0) / 4294967296;
  }
  const still = matchMedia('(prefers-reduced-motion:reduce)').matches;
  let cx = Z.at ? Z.at[0] : w / 2, cy = Z.at ? Z.at[1] : h / 2, tx = cx, ty = cy, lt = 0, hover = false, pin = -1, busy = false;
  // Pointer → cell coordinates, through the canvas's object-fit box.
  const pos = (e) => {
    const b = c.getBoundingClientRect(), W = c.width, H = c.height;
    const k = (M.fit === 'cover' ? Math.max : Math.min)(b.width / W, b.height / H);
    tx = (e.clientX - b.left - (b.width - W * k) / 2) / k / s;
    ty = (e.clientY - b.top - (b.height - H * k) / 2) / k / s;
  };
  c.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') return; hover = true; pos(e); busy = true; kick(); });
  c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'touch') return; hover = false; kick(); });
  c.addEventListener('pointerdown', (e) => {
    o.touch = e.pointerType === 'touch';
    if (o.touch) { pin = e.timeStamp + 4000; pos(e); busy = true; kick(); }
  });
  const o = {
    touch: false,
    busy: () => busy,
    // Advance the lens to time t; true when it moved enough to redraw.
    move(t, playing) {
      const d = Math.min(100, t - (lt || t));
      lt = t;
      if (!hover && t > pin && playing && !still) {
        tx = w * (0.5 + 0.3 * Math.sin(t * 2.7e-4));
        ty = h * (0.5 + 0.28 * Math.sin(t * 4.1e-4 + 1.3));
      }
      const k = 1 - Math.exp(-d / 110), ox = cx, oy = cy;
      cx += (tx - cx) * k; cy += (ty - cy) * k;
      busy = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.05;
      return Math.abs(cx - ox) + Math.abs(cy - oy) > 0.01;
    },
    has(i) {
      const x = (i % w) + 0.5 - cx, y = ((i / w) | 0) + 0.5 - cy;
      if (x > r + 1.5 || x < -r - 1.5 || y > r + 1.5 || y < -r - 1.5) return false;
      const d = Math.sqrt(x * x + y * y);
      return d < r - 1.5 || (d < r + 1.5 && th[i] < (r + 1.5 - d) / 3);
    },
  };
  return o;
}

// Effects ship only when they're used: their source, without comments and indentation.
const strip = (fn) => fn.toString().replace(/^\s*\/\/.*$\n?/gm, '').replace(/^\s+/gm, '');
export const GLOW_SOURCE = strip(glowFrame);
export const TWINKLE_SOURCE = `const findTwinkles=${strip(findTwinkles)};\nconst drawTwinkles=${strip(drawTwinkles)};`;
export const LENS_SOURCE = `const lensRT=${strip(lensRT)};`;
export const SPREAD_SOURCE = `const maskSpans=${strip(maskSpans)};\nconst spreadFrame=${strip(spreadFrame)};`;
const runtime = (glow, tw, lens, spread) => RUNTIME.replace('(async()=>{', () => `(async()=>{${glow ? `\nconst glowFrame=${GLOW_SOURCE};` : ''}${tw ? `\n${TWINKLE_SOURCE}` : ''}${lens ? `\n${LENS_SOURCE}` : ''}${spread ? `\n${SPREAD_SOURCE}` : ''}`);

// Stamp masks (each s*s of 0/1) → one bit-packed base64 string, and back.
export function packMasks(masks) {
  const total = masks.reduce((a, m) => a + m.length, 0);
  const out = new Uint8Array(Math.ceil(total / 8));
  let bit = 0;
  for (const m of masks) for (let i = 0; i < m.length; i++, bit++) if (m[i]) out[bit >> 3] |= 1 << (bit & 7);
  let str = '';
  for (let i = 0; i < out.length; i++) str += String.fromCharCode(out[i]);
  return btoa(str);
}

export function unpackMasks(b64, K, s) {
  const b = atob(b64), a = s * s, masks = [];
  for (let k = 0; k < K; k++) {
    const m = new Uint8Array(a);
    for (let i = 0; i < a; i++) { const bit = k * a + i; m[i] = (b.charCodeAt(bit >> 3) >> (bit & 7)) & 1; }
    masks.push(m);
  }
  return masks;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// JSON inside a <script> block: keep "</script" and "<!--" from ever appearing.
const safeJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const cover0 = (fit) => fit === 'cover';

export function buildPlayer({
  w, h, fps, frames, bits, palette, loop = true, data, title = 'Dithered video',
  look = null, glow = null, twinkle = null, lens = null, fit = 'contain', embed = 'page',
}) {
  const meta = { w, h, fps: fps || 1, frames, bits, palette, loop };
  if (glow) meta.glow = { a: glow.amount, r: glow.radius, bg: Array.from(glow.bg) };
  // Frame f shows source time t0 + f / fps, which drives the twinkles.
  if (twinkle) meta.tw = { a: twinkle.amount, bg: Array.from(twinkle.bg), t0: twinkle.t0 || 0 };
  // lens: a second look over the same cells, { masks, cov, col, off?, r (radius in cells), at? }.
  // off (look and lens): how far an overlapping look's stamps reach past the cell, in px.
  if (lens && !look) throw new Error('A lens needs a stamped look.');
  if (lens) {
    meta.lens = { k: lens.masks.length, m: packMasks(lens.masks), cov: Array.from(lens.cov), col: Array.from(lens.col), r: lens.r };
    if (lens.off) meta.lens.o = lens.off;
    if (lens.at) meta.lens.at = lens.at;
    meta.fit = embed === 'snippet' && !cover0(fit) ? 'contain' : fit;
  }
  if (look) {
    meta.look = {
      s: look.s, k: look.masks.length, m: packMasks(look.masks),
      cov: Array.from(look.cov), col: Array.from(look.col), bg: Array.from(look.bg),
    };
    if (look.off) meta.look.o = look.off;
  }
  const spread = !!(look && (look.off || lens?.off));
  const s = look ? look.s : 1;
  const bg = `rgb(${(look ? look.bg : palette[palette.length - 1]).join(',')})`;
  const cover = fit === 'cover';
  const label = esc(title) + (frames > 1 ? ', click to pause' : '');
  // Square pixels scale crisply; stamped looks are already full size, so let the browser smooth them.
  const crisp = look ? '' : 'image-rendering:pixelated;image-rendering:crisp-edges;';
  // With a lens the pointer steers it; touch-action keeps vertical scrolling on phones.
  const cursor = lens ? 'cursor:crosshair;touch-action:pan-y;' : frames > 1 ? 'cursor:pointer;' : '';
  if (!/^[A-Za-z0-9+/=\s]*$/.test(data)) throw new Error('Player data must be base64.');
  const payload = (canvasStyle) =>
    `<canvas role="img" aria-label="${label}" style="${canvasStyle}"></canvas>
<script type="application/json">${safeJson(meta)}</script>
<script type="text/plain">${data}</script>
<script>${runtime(glow, twinkle, lens, spread)}</script>`;

  if (embed === 'snippet') {
    // Cover: fills the nearest positioned ancestor (give your hero `position: relative`).
    // Contain: a block as wide as its container, keeping the aspect ratio.
    const wrap = cover
      ? `position:absolute;inset:0;overflow:hidden;background:${bg}`
      : `width:100%;max-width:${w * s * (look ? 1 : 16)}px;background:${bg}`;
    const cv = cover
      ? `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;${crisp}${cursor}`
      : `display:block;width:100%;height:auto;aspect-ratio:${w}/${h};${crisp}${cursor}`;
    return `<!-- ${esc(title).replace(/-/g, '&#45;')} · made with Lumen${cover ? ' · parent needs position:relative' : ''} -->
<div data-lumen style="${wrap}">
${payload(cv)}
</div>
`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
html,body{margin:0;height:100%;background:${bg}}
</style>
</head>
<body>
<div data-lumen style="width:100%;height:100%;overflow:hidden">
${payload(`display:block;width:100%;height:100%;object-fit:${cover ? 'cover' : 'contain'};${crisp}${cursor}`)}
</div>
</body>
</html>
`;
}
