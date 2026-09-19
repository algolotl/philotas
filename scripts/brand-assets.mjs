#!/usr/bin/env node
// Generates the Philotas brand asset kit into site/assets/.
//
// The mark is a constructed "P": flat, chamfered 45-degree corners, monochrome,
// no container. Its distinguishing move is the bowl counter cut as a wedge --
// the Macedonian cavalry wedge (embolon) inside the letterform, and the product
// idea (many sources converging on one point) at the same time. It reads at 16px.
//
// Run: node scripts/brand-assets.mjs
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ASSETS = path.join(ROOT, 'site', 'assets');
const FONTS = path.join(ASSETS, 'fonts');
// Build inputs live outside site/: that directory is the nginx document root,
// so anything written into it is published on the next sync.
const BUILD = path.join(ROOT, '.brand-build');

// Palette. Navy-cast rather than a neutral black, because the product is maritime.
const C = {
  ink:    '#0A1628',  // near-black, cold cast
  deep:   '#0E2A47',  // deep hull -- the mark on light surfaces
  signal: '#1B4F8A',  // primary: links, CTA (8.29:1 on white)
  beacon: '#2E8FE0',  // accent only, never body text (3.43:1)
  shaft:  '#6FD3F2',  // on dark surfaces (10.60:1 on ink)
};

// Mark geometry, in a 64x64 box. Bounds x 12..52 (w 40), y 8..56 (h 48); centre (32,32).
const MARK = 'M12 8 H40 L52 20 V30 L40 42 H24 V56 H12 Z M24 17 L44 25 L24 33 Z';
const BW = 40, BH = 48;

function markSvg(o) {
  const size = o.size, bg = o.bg, fg = o.fg, rx = o.rx || 0, pad = o.pad || 0;
  const avail = size - 2 * pad;
  const s = Math.min(avail / BW, avail / BH);
  const t = 'translate(' + (size / 2) + ',' + (size / 2) + ') scale(' + s.toFixed(6) + ') translate(-32,-32)';
  let out = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size
    + '" viewBox="0 0 ' + size + ' ' + size + '">';
  if (o.bleed) out += '<rect width="' + size + '" height="' + size + '" fill="' + bg + '"/>';
  else if (rx > 0) out += '<rect width="' + size + '" height="' + size + '" rx="' + rx + '" fill="' + bg + '"/>';
  out += '<path transform="' + t + '" fill="' + fg + '" fill-rule="evenodd" d="' + MARK + '"/></svg>';
  return out;
}

async function png(svg, size, out) {
  const buf = await sharp(Buffer.from(svg), { density: 384 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 }).toBuffer();
  await writeFile(out, buf);
  return buf;
}

// ICO with PNG payloads: supported by every browser in use and by Windows Vista+.
function ico(entries) {
  const n = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(n, 4);
  const dir = Buffer.alloc(16 * n);
  let offset = 6 + 16 * n;
  entries.forEach(function (e, i) {
    const o = 16 * i;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.buf.length;
  });
  return Buffer.concat([header, dir].concat(entries.map(function (e) { return e.buf; })));
}

// Self-hosted IBM Plex: same families Bylazora uses, so the portfolio coheres,
// and it drops the third-party Google Fonts request the site used to make.
async function fonts() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const families = [
    { css: 'IBM+Plex+Sans:wght@400;500;600;700', slug: 'ibm-plex-sans', family: 'IBM Plex Sans' },
    { css: 'IBM+Plex+Mono:wght@400;500',         slug: 'ibm-plex-mono', family: 'IBM Plex Mono' }
  ];
  const faces = [];
  for (const f of families) {
    const url = 'https://fonts.googleapis.com/css2?family=' + f.css + '&display=swap';
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error('font css ' + f.slug + ' -> ' + res.status);
    const css = await res.text();
    const blocks = css.split('@font-face').slice(1).filter(function (b) {
      return !/unicode-range/.test(b) || /U\+0000-00FF/.test(b);
    });
    // Group by file URL: a variable family serves one file for every requested
    // weight, so downloading per-weight would write the same bytes four times.
    const byUrl = new Map();
    for (const b of blocks) {
      const wm = /font-weight:\s*([\d ]+);/.exec(b);
      const um = /url\((https:[^)]+\.woff2)\)/.exec(b);
      if (!wm || !um) continue;
      if (!byUrl.has(um[1])) byUrl.set(um[1], []);
      const w = wm[1].trim();
      if (byUrl.get(um[1]).indexOf(w) === -1) byUrl.get(um[1]).push(w);
    }
    for (const entry of byUrl) {
      const weights = entry[1];
      const variable = weights.length > 1;
      const range = variable ? weights[0] + ' ' + weights[weights.length - 1] : weights[0];
      const name = f.slug + '-latin-' + (variable ? 'var' : weights[0]) + '.woff2';
      const got = await fetch(entry[0], { headers: { 'User-Agent': UA } });
      const buf = Buffer.from(await got.arrayBuffer());
      await writeFile(path.join(FONTS, name), buf);
      faces.push({ family: f.family, weight: range, name: name, bytes: buf.length, variable: variable });
    }
  }
  const css = faces.map(function (f) {
    return "@font-face{font-family:'" + f.family + "';font-style:normal;font-weight:" + f.weight
      + ";font-display:swap;src:url('fonts/" + f.name + "') format('woff2');}";
  }).join('\n') + '\n';
  await writeFile(path.join(ASSETS, 'fonts.css'), css);
  return faces;
}

(async function () {
  await mkdir(FONTS, { recursive: true });

  // Standalone marks: deep for light surfaces, light for dark ones.
  await writeFile(path.join(ASSETS, 'mark.svg'), markSvg({ size: 64, fg: C.deep }));
  await writeFile(path.join(ASSETS, 'mark-reverse.svg'), markSvg({ size: 64, fg: C.shaft }));

  // Favicon: a solid tile guarantees the mark survives against any tab-strip colour.
  await writeFile(path.join(ASSETS, 'favicon.svg'),
    markSvg({ size: 32, bg: C.deep, fg: C.shaft, rx: 7, pad: 6 }));

  const tiles = [[16, 3, 'favicon-16.png'], [32, 6, 'favicon-32.png'], [48, 9, 'favicon-48.png']];
  for (const t of tiles) {
    await png(markSvg({ size: t[0], bg: C.deep, fg: C.shaft, rx: t[0] * 7 / 32, pad: t[1] }), t[0], path.join(ASSETS, t[2]));
  }
  // apple-touch-icon is full-bleed: iOS applies its own mask, and transparency goes black.
  await png(markSvg({ size: 180, bg: C.deep, fg: C.shaft, bleed: true, pad: 40 }), 180,
    path.join(ASSETS, 'apple-touch-icon.png'));

  const entries = [];
  for (const size of [16, 32, 48]) {
    const buf = await sharp(Buffer.from(markSvg({ size: size, bg: C.deep, fg: C.shaft, rx: size * 7 / 32, pad: size * 3 / 16 })), { density: 384 })
      .resize(size, size).png().toBuffer();
    entries.push({ size: size, buf: buf });
  }
  await writeFile(path.join(ASSETS, 'favicon.ico'), ico(entries));

  // The Next app icon is the same tile, served from app/.
  await writeFile(path.join(ROOT, 'app', 'icon.svg'), markSvg({ size: 64, bg: C.deep, fg: C.shaft, rx: 14, pad: 12 }));

  // Dark OG/social card source, at exactly 1200x630. Chrome renders it (see below).
  const ogHtml = '<!doctype html><html><head><meta charset="utf-8">'
    + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">'
    + '<style>*{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;overflow:hidden}'
    + 'body{background:' + C.ink + ';font-family:"IBM Plex Sans",sans-serif;position:relative;display:flex;flex-direction:column;justify-content:space-between;padding:64px 70px}'
    + '.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(111,211,242,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(111,211,242,.06) 1px,transparent 1px);background-size:60px 60px}'
    + '.edge{position:absolute;inset:22px;border:1px solid rgba(111,211,242,.20)}'
    + '.brand{display:flex;align-items:center;gap:20px;position:relative}'
    + '.brand span{font-size:60px;font-weight:700;letter-spacing:.09em;color:#fff}'
    + 'h1{position:relative;font-size:46px;line-height:1.16;font-weight:600;color:#fff;margin:0;letter-spacing:-.015em;max-width:960px}'
    + 'h1 em{font-style:normal;color:' + C.shaft + '}'
    + '.foot{position:relative;display:flex;justify-content:space-between;align-items:baseline;font-family:"IBM Plex Mono",monospace;font-size:19px;letter-spacing:.06em}'
    + '.foot .u{color:' + C.beacon + '}.foot .t{color:#8FA6BE}'
    + '</style></head><body><div class="grid"></div><div class="edge"></div>'
    + '<div class="brand">' + markSvg({ size: 68, fg: C.shaft }) + '<span>PHILOTAS</span></div>'
    + '<div><h1>Your data says what you own.<br><em>Open sources say what is happening to it.</em></h1></div>'
    + '<div class="foot"><span class="u">philotas.com</span><span class="t">Open-source common operating picture</span></div>'
    + '</body></html>';
  await mkdir(BUILD, { recursive: true });
  await writeFile(path.join(BUILD, 'og-source.html'), ogHtml);

  const faces = await fonts();
  console.log('fonts: ' + faces.length + ' woff2, ' + faces.reduce(function (a, f) { return a + f.bytes; }, 0) + ' bytes');
  faces.forEach(function (f) { console.log('  ' + f.name + '  ' + f.bytes); });
  console.log('marks: mark.svg, mark-reverse.svg, favicon.svg, favicon.ico, app/icon.svg');
  console.log('tiles: favicon-16/32/48.png, apple-touch-icon.png');
  console.log('og source written to .brand-build/og-source.html');
  console.log('render it with:  chrome --headless=new --screenshot=site/assets/philotas-og.png'
    + ' --window-size=1200,630 file:///<repo>/.brand-build/og-source.html');
})();
