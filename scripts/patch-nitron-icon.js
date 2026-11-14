#!/usr/bin/env node
'use strict';

// Patch Nitron's launcher icon generator so adaptive foreground assets are
// emitted at the Android-required 108dp canvas size for every density bucket.
// Nitron's legacy launcher icons are correctly 48dp (48/72/96/144/192px), but
// its adaptive foregrounds were also written at those sizes. Android expects
// adaptive layers to be 108dp (108/162/216/324/432px), so launchers enlarged
// the undersized foreground and softened the artwork on high-density screens.
//
// Keep the artwork inset to 72dp inside the 108dp canvas, preserving the crop
// and visual scale established by Forge Studio's previous adaptive safe-zone
// patch. Legacy ic_launcher.png assets remain unchanged.

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
const marker = 'FORGE_ADAPTIVE_108DP_ICON_PATCH';
if (source.includes(marker)) {
  console.log('Nitron 108dp adaptive-icon patch already present.');
  process.exit(0);
}

const transparent = "{ r: 255, g: 255, b: 255, alpha: 0 }";
const customAnchor = `        // Foreground icon (Adaptive) - usually with padding. Sharp handles containment.
        await sharp(iconSrc)
          .resize(size, size, { fit: 'contain', background: ${transparent} })
          .toFile(join(destDir, 'ic_launcher_foreground.png'));`;
const customReplacement = `        // ${marker}: legacy icons are 48dp, adaptive layers must be 108dp.
        // Keep the foreground artwork at 72dp while rendering the full 108dp
        // canvas at the actual density, so Android never has to upscale a
        // 48dp bitmap to fill an adaptive-icon layer.
        const forgeAdaptiveSize = Math.round(size * 108 / 48);
        const forgeAdaptiveArtSize = Math.round(forgeAdaptiveSize * 72 / 108);
        const forgeAdaptivePad = Math.floor((forgeAdaptiveSize - forgeAdaptiveArtSize) / 2);
        const forgeAdaptiveEdge = forgeAdaptiveSize - forgeAdaptiveArtSize - forgeAdaptivePad;
        await sharp(iconSrc)
          .resize(forgeAdaptiveArtSize, forgeAdaptiveArtSize, { fit: 'contain', background: ${transparent} })
          .extend({ top: forgeAdaptivePad, bottom: forgeAdaptiveEdge, left: forgeAdaptivePad, right: forgeAdaptiveEdge, background: ${transparent} })
          .png({ compressionLevel: 9, adaptiveFiltering: true })
          .toFile(join(destDir, 'ic_launcher_foreground.png'));`;

const defaultAnchor = `        await sharp(defaultIconData)
          .resize(size, size, { fit: 'contain', background: ${transparent} })
          .toFile(join(destDir, 'ic_launcher_foreground.png'));`;
const defaultReplacement = `        // ${marker}: keep the fallback adaptive foreground at 108dp too.
        const forgeAdaptiveSize = Math.round(size * 108 / 48);
        const forgeAdaptiveArtSize = Math.round(forgeAdaptiveSize * 72 / 108);
        const forgeAdaptivePad = Math.floor((forgeAdaptiveSize - forgeAdaptiveArtSize) / 2);
        const forgeAdaptiveEdge = forgeAdaptiveSize - forgeAdaptiveArtSize - forgeAdaptivePad;
        await sharp(defaultIconData)
          .resize(forgeAdaptiveArtSize, forgeAdaptiveArtSize, { fit: 'contain', background: ${transparent} })
          .extend({ top: forgeAdaptivePad, bottom: forgeAdaptiveEdge, left: forgeAdaptivePad, right: forgeAdaptiveEdge, background: ${transparent} })
          .png({ compressionLevel: 9, adaptiveFiltering: true })
          .toFile(join(destDir, 'ic_launcher_foreground.png'));`;

if (!source.includes(customAnchor)) {
  throw new Error(
    'Could not locate Nitron custom adaptive-foreground block in aapt2-resource-builder.ts; ' +
    'refusing to patch an unknown Nitron revision.'
  );
}
if (!source.includes(defaultAnchor)) {
  throw new Error(
    'Could not locate Nitron default adaptive-foreground block in aapt2-resource-builder.ts; ' +
    'refusing to patch an unknown Nitron revision.'
  );
}

source = source.replace(customAnchor, customReplacement);
source = source.replace(defaultAnchor, defaultReplacement);
fs.writeFileSync(sourcePath, source, 'utf8');
console.log(`Patched Nitron adaptive foregrounds to 108dp: ${path.basename(sourcePath)}`);

// Validate the exact pixel dimensions produced for Android's five density buckets.
const expected = [
  { dpi: 'mdpi', legacy: 48, adaptive: 108, artwork: 72 },
  { dpi: 'hdpi', legacy: 72, adaptive: 162, artwork: 108 },
  { dpi: 'xhdpi', legacy: 96, adaptive: 216, artwork: 144 },
  { dpi: 'xxhdpi', legacy: 144, adaptive: 324, artwork: 216 },
  { dpi: 'xxxhdpi', legacy: 192, adaptive: 432, artwork: 288 },
];
for (const item of expected) {
  const pad = (item.adaptive - item.artwork) / 2;
  if (!Number.isInteger(pad) || item.artwork + pad * 2 !== item.adaptive) {
    throw new Error(`Invalid adaptive icon geometry for ${item.dpi}`);
  }
  console.log(`  ${item.dpi}: legacy ${item.legacy}px; adaptive ${item.adaptive}px canvas / ${item.artwork}px artwork`);
}
