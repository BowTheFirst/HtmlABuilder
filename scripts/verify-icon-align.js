#!/usr/bin/env node
'use strict';
// Proves the icon preview and the 512x512 export describe the same picture.
//
//   node scripts/verify-icon-align.js
//
// The preview is DOM/CSS, the export is canvas 2D. Both are affine, so we can
// compose their matrices exactly and compare where every corner of the source
// image lands, normalised to the icon viewport. No browser needed.

const ICON_UNITS = 200;
const ICON_EXPORT = 512;

// ── 2D affine helpers (column-vector convention, m = [a,b,c,d,e,f]) ──────────
const ident = () => [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x, y) => [1, 0, 0, 1, x, y];
const scale = (s) => [s, 0, 0, s, 0, 0];
const rotate = (deg) => {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
};
const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const chain = (...ms) => ms.reduce(mul, ident());

// ── FIXED preview ───────────────────────────────────────────────────────────
// .crop-stage is 200x200 with transform-origin 0 0 and scale(box/200).
// #cropImage is natural-size at (0,0) with transform-origin center center and
// transform: translate(imgX,imgY) rotate(r) scale(zoom).
function previewMatrix({ W, H, imgX, imgY, zoom, deg, box }) {
  const O = [W / 2, H / 2];
  const img = chain(
    translate(O[0], O[1]),
    translate(imgX, imgY),
    rotate(deg),
    scale(zoom),
    translate(-O[0], -O[1]),
  );
  return chain(scale(box / ICON_UNITS), img); // -> container pixels
}

// ── OLD preview (no stage, raw icon-unit px inside a box that is not 200px) ──
function oldPreviewMatrix({ W, H, imgX, imgY, zoom, deg }) {
  const O = [W / 2, H / 2];
  return chain(
    translate(O[0], O[1]), translate(imgX, imgY), rotate(deg), scale(zoom),
    translate(-O[0], -O[1]),
  );
}

// ── Export (canvas 2D, matches getCroppedIconBlob) ──────────────────────────
function exportMatrix({ W, H, imgX, imgY, zoom, deg }) {
  const u = ICON_EXPORT / ICON_UNITS;
  const cx = W / 2 + imgX, cy = H / 2 + imgY;
  return chain(translate(cx * u, cy * u), rotate(deg), scale(zoom * u), translate(-W / 2, -H / 2));
}

const corners = (W, H) => [[0, 0], [W, 0], [W, H], [0, H], [W / 2, H / 2]];

function maxDeltaNorm(mA, divA, mB, divB, W, H) {
  let worst = 0;
  for (const p of corners(W, H)) {
    const a = apply(mA, p).map(v => v / divA);
    const b = apply(mB, p).map(v => v / divB);
    worst = Math.max(worst, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  }
  return worst;
}

// ── sweep ───────────────────────────────────────────────────────────────────
const boxes = [130, 132, 138, 140, 143, 145, 168, 170, 200, 96.5]; // real content-box widths
const sizes = [[1000, 1000], [512, 512], [1200, 800], [64, 64], [3000, 1200], [750, 1334]];
let fixedWorst = 0, oldWorst = 0, cases = 0;
const oldSamples = [];

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

for (const box of boxes) {
  for (const [W, H] of sizes) {
    for (let i = 0; i < 60; i++) {
      const fit = Math.min(ICON_UNITS / W, ICON_UNITS / H);
      const st = {
        W, H, box,
        zoom: Math.max(0.02, Math.min(5, fit * (0.4 + rnd() * 2))),
        deg: Math.round(rnd() * 360 - 180),
        imgX: ICON_UNITS / 2 - W / 2 + (rnd() * 120 - 60),
        imgY: ICON_UNITS / 2 - H / 2 + (rnd() * 120 - 60),
      };
      const ex = exportMatrix(st);
      fixedWorst = Math.max(fixedWorst, maxDeltaNorm(previewMatrix(st), box, ex, ICON_EXPORT, W, H));
      const od = maxDeltaNorm(oldPreviewMatrix(st), box, ex, ICON_EXPORT, W, H);
      oldWorst = Math.max(oldWorst, od);
      cases++;
    }
    // The exact scenario the user hit: "fit the image properly in the preview".
    // In the OLD preview you had to zoom to box/W and centre at box/2 to look
    // right, because the visible window was box px of a 200-unit space.
    const [W2, H2] = [W, H];
    const fitOld = Math.min(box / W2, box / H2);
    const st = { W: W2, H: H2, box, zoom: fitOld, deg: 0, imgX: box / 2 - W2 / 2, imgY: box / 2 - H2 / 2 };
    const centreExport = apply(exportMatrix(st), [W2 / 2, H2 / 2]).map(v => v / ICON_EXPORT);
    const edgeLen = W2 * fitOld * (ICON_EXPORT / ICON_UNITS) / ICON_EXPORT;
    if (box === 170 && W2 === 1000) {
      oldSamples.push({ box, src: `${W2}x${H2}`, centreExport, fill: edgeLen });
    }
  }
}

console.log(`cases compared: ${cases}`);
console.log(`FIXED preview vs export  max normalised deviation: ${fixedWorst.toExponential(3)}`);
console.log(`OLD   preview vs export  max normalised deviation: ${oldWorst.toExponential(3)}`);
console.log('');
console.log('User scenario — "fit it nicely in the preview", 1000x1000 source, 170px box:');
for (const s of oldSamples) {
  console.log(`  exported centre = (${s.centreExport[0].toFixed(3)}, ${s.centreExport[1].toFixed(3)})  [want 0.500, 0.500]`);
  console.log(`  exported fill   = ${(s.fill * 100).toFixed(1)}% of the icon edge  [want 100%]`);
}
console.log('');

// ── drag delta: old handler jumped on the first move frame ──────────────────
{
  const W = 1000, box = 170, imgX0 = ICON_UNITS / 2 - W / 2; // -400
  const cx0 = 500, cx1 = 503;                               // 3px drag
  const oldStart = cx0 - imgX0;                             // mixes px and units
  const oldAfter = (cx1 - oldStart) * (ICON_UNITS / box);
  const newAfter = imgX0 + (cx1 - cx0) * (ICON_UNITS / box);
  console.log('3px drag on a 1000px source in a 170px box:');
  console.log(`  OLD imgX: ${imgX0} -> ${oldAfter.toFixed(2)}  (jump ${(oldAfter - imgX0).toFixed(2)} units)`);
  console.log(`  NEW imgX: ${imgX0} -> ${newAfter.toFixed(2)}  (delta ${(newAfter - imgX0).toFixed(2)} units = 3px)`);
}

const tol = 1e-9;
if (fixedWorst > tol) { console.error(`\nFAIL: fixed preview deviates by ${fixedWorst}`); process.exit(1); }
console.log(`\nPASS: preview is WYSIWYG with the export at every breakpoint (<= ${tol}).`);
