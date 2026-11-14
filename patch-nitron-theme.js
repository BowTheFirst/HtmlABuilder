#!/usr/bin/env node
'use strict';

// Patch the pinned Nitron Android shell so WebView follows Android's
// day/night mode instead of inheriting a permanently-light template theme.
const fs = require('fs');
const path = require('path');

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error('Usage: node patch-nitron-theme.js <Nitron MainActivity.java>');
  process.exit(2);
}
if (!fs.existsSync(sourcePath)) {
  throw new Error(`Nitron template source not found: ${sourcePath}`);
}

let source = fs.readFileSync(sourcePath, 'utf8');
const marker = '// FORGE_SYSTEM_NIGHT_THEME_PATCH';
if (source.includes(marker)) {
  console.log('Nitron system night-theme patch already present.');
  process.exit(0);
}

const fieldAnchor = 'private WebView webView;';
if (!source.includes(fieldAnchor)) {
  throw new Error('Could not locate Nitron WebView field; refusing to patch an unknown template.');
}
source = source.replace(fieldAnchor, `${fieldAnchor}
    ${marker}
    private int forgeLastNightMode = -1;`);

const onCreateAnchor = 'super.onCreate(savedInstanceState);';
const onCreateIndex = source.indexOf(onCreateAnchor);
if (onCreateIndex < 0) {
  throw new Error('Could not locate MainActivity.onCreate super call.');
}
const nightTheme = `// ${marker}: WebView derives prefers-color-scheme from the host Activity theme.
        forgeLastNightMode = getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        setTheme(forgeLastNightMode == android.content.res.Configuration.UI_MODE_NIGHT_YES
                ? android.R.style.Theme_Material_NoActionBar
                : android.R.style.Theme_Material_Light_NoActionBar);
        `;
source = source.slice(0, onCreateIndex) + nightTheme + source.slice(onCreateIndex);

// If the template handles uiMode itself instead of allowing Android to recreate
// the Activity, recreate once so setTheme() runs with the new system mode.
const backAnchor = '    @Override\n    public void onBackPressed()';
if (!source.includes(backAnchor)) {
  throw new Error('Could not locate onBackPressed insertion point.');
}
const configHandler = `    // ${marker}: refresh the Activity theme if the template handles uiMode changes.
    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        int nightMode = newConfig.uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        if (nightMode != forgeLastNightMode) {
            forgeLastNightMode = nightMode;
            recreate();
        }
    }

`;
source = source.replace(backAnchor, configHandler + backAnchor);

// Android WebView requires this metadata for its default Web Theme Darkening
// strategy to honor prefers-color-scheme media queries consistently.
const runtimeAnchor = 'String result = html.substring(0, at) + RUNTIME_TAG + html.substring(at);';
if (!source.includes(runtimeAnchor)) {
  throw new Error('Could not locate Nitron HTML runtime injection point.');
}
const runtimeReplacement = `String result = html.substring(0, at)
                + "<meta name=\\"color-scheme\\" content=\\"dark light\\">"
                + RUNTIME_TAG + html.substring(at);`;
source = source.replace(runtimeAnchor, runtimeReplacement);

fs.writeFileSync(sourcePath, source, 'utf8');
console.log(`Patched Nitron Android theme + WebView color-scheme handling: ${path.basename(sourcePath)}`);
