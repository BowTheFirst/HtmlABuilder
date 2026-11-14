#!/usr/bin/env node
'use strict';

// Patch Nitron so the Android adaptive-icon foreground respects the launcher's
// masked viewport.
//
// Nitron writes mipmap-anydpi-v26/ic_launcher.xml with the SAME full-bleed PNG
// as both the legacy icon and the adaptive foreground. An adaptive layer is
// 108dp but launchers mask it down to a 72dp viewport, so the art arrives ~1.5x
// zoomed with its edges cut off — the built icon never matches the studio
// preview. This insets the foreground into the 72/108 viewport and leaves the
// legacy icon (and the 512px Play listing icon) full-bleed.
//
// Ref: adaptive icons are 108dp, masked to at most 72dp, with a 66dp safe zone.

const fs = require('fs');
const path = require('path');

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error('Usage: node patch-nitron-icon.js <Nitron aapt2-resource-builder.ts>');
  process.exit(2);
}
if (!fs.existsSync(sourcePath)) {
  throw new Error(`Nitron resource builder not found: ${sourcePath}`);
}

let source = fs.readFileSync(sourcePath, 'utf8');
const marker = 'FORGE_ADAPTIVE_SAFE_ZONE_PATCH';
if (source.includes(marker)) {
  console.log('Nitron adaptive safe-zone patch already present.');
  process.exit(0);
}

// The custom-icon branch is indented 8 spaces; the default-icon fallback is
// indented 6. Anchor on the 8-space block so we only rewrite the custom path.
const anchor = `        // Foreground icon (Adaptive) - usually with padding. Sharp handles containment.
        await sharp(iconSrc)
          .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
          .toFile(join(destDir, 'ic_launcher_foreground.png'));`;

if (!source.includes(anchor)) {
  throw new Error(
    'Could not locate the adaptive-foreground block in aapt2-resource-builder.ts; ' +
    'refusing to patch an unknown Nitron revision.'
  );
}

const replacement = `        // ${marker}: an adaptive layer is 108dp but launchers mask it to a
        // 72dp viewport. Using the full-bleed art as the foreground made the
        // installed icon ~1.5x zoomed and cropped versus the studio preview.
        // Inset the art into the 72/108 viewport; legacy ic_launcher.png stays
        // full-bleed so the Play listing icon is unaffected.
        const forgeFgInner = Math.round(size * 72 / 108);
        const forgeFgPad = Math.floor((size - forgeFgInner) / 2);
        const forgeFgEdge = size - forgeFgInner - forgeFgPad;
        await sharp(iconSrc)
          .resize(forgeFgInner, forgeFgInner, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
          .extend({ top: forgeFgPad, bottom: forgeFgEdge, left: forgeFgPad, right: forgeFgEdge, background: { r: 255, g: 255, b: 255, alpha: 0 } })
          .toFile(join(destDir, 'ic_launcher_foreground.png'));`;

source = source.replace(anchor, replacement);
fs.writeFileSync(sourcePath, source, 'utf8');
console.log(`Patched Nitron adaptive-icon safe zone: ${path.basename(sourcePath)}`);

// Every mipmap size Nitron emits divides cleanly by 3, so the inset is exact.
for (const size of [48, 72, 96, 144, 192]) {
  const inner = Math.round(size * 72 / 108);
  const pad = Math.floor((size - inner) / 2);
  const edge = size - inner - pad;
  if (pad + inner + edge !== size) throw new Error(`Inset does not add up for size ${size}`);
  console.log(`  mipmap ${size}px -> art ${inner}px + ${pad}/${edge}px transparent border`);
}
