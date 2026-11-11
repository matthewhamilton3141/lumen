// Builds site/index.html: the template with every piece in site/pieces inlined.
//   node site/build.mjs
// Pieces are HTML embed snippets from `npm run cut -- … -f html --embed snippet`,
// named <work>-<look>-embed.html, e.g. lilies-2-led-embed.html.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LOOKS = { led: 'LED wall', neonascii: 'Neon ASCII' };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

const files = readdirSync(join(here, 'pieces')).filter((f) => f.endsWith('-embed.html')).sort();
const works = new Map();
const blocks = [];
for (const f of files) {
  const m = f.match(/^(.+)-(\d+)-([a-z]+)-embed\.html$/);
  if (!m || !(m[3] in LOOKS)) continue;
  const [, kind, num, look] = m, id = `${kind}-${num}`;
  const html = readFileSync(join(here, 'pieces', f), 'utf8');
  const meta = JSON.parse(html.match(/<script type="application\/json">([\s\S]*?)<\/script>/)[1]);
  if (!works.has(id)) {
    works.set(id, { id, title: `${kind[0].toUpperCase()}${kind.slice(1)} ${ROMAN[num - 1] || num}`, pieces: {} });
  }
  works.get(id).pieces[look] = {
    w: meta.w, h: meta.h, seconds: Math.round(meta.frames / meta.fps), kb: Math.round(Buffer.byteLength(html) / 1000),
  };
  blocks.push(`<div class="piece" data-key="${id}/${look}" hidden>\n${html}</div>`);
}
// Lilies first, then orchids, each in number order.
const list = [...works.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
const looks = Object.fromEntries(Object.entries(LOOKS).filter(([k]) => list.some((w) => w.pieces[k])));

const page = readFileSync(join(here, 'template.html'), 'utf8')
  .replace('<!--pieces-->', () => blocks.join('\n'))
  .replace('/*works*/[]', () => JSON.stringify(list))
  .replace('/*looks*/{}', () => JSON.stringify(looks));
writeFileSync(join(here, 'index.html'), page);
console.log(`site/index.html: ${list.length} works × ${Object.keys(looks).length} looks, ${(Buffer.byteLength(page) / 1e6).toFixed(1)} MB`);
