#!/usr/bin/env node
'use strict';

// Patch Nitron's real Android Activity so the status and navigation bars are
// controlled by the app's Show Android system bars setting. This deliberately
// avoids relying on a plugin's Context being an Activity.

const fs = require('fs');
const path = require('path');

const sourcePath = process.argv[2];
if (!sourcePath) {
  console.error('Usage: node patch-nitron-system-bars.js <Nitron MainActivity.java>');
  process.exit(2);
}
if (!fs.existsSync(sourcePath)) {
  throw new Error(`Nitron template source not found: ${sourcePath}`);
}

let source = fs.readFileSync(sourcePath, 'utf8');
const marker = 'FORGE_NATIVE_SYSTEM_BARS_PATCH';
if (source.includes(marker)) {
  console.log('Nitron native system-bars patch already present.');
  process.exit(0);
}

function replaceOnce(anchor, replacement, description) {
  const first = source.indexOf(anchor);
  if (first < 0) throw new Error(`Could not locate ${description}; refusing to patch an unknown Nitron revision.`);
  if (source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`Found multiple ${description} anchors; refusing an ambiguous patch.`);
  }
  source = source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

// MainActivity is the Activity. Keep the selected state so Android can
// re-apply it after returning from another app or regaining window focus.
replaceOnce(
  '    private WebView webView;',
  `    private WebView webView;\n    // ${marker}: nullable until the app's trusted WebView sends its setting.\n    private Boolean forgeSystemBarsVisible = null;`,
  'MainActivity WebView field'
);

const helper = `    // ${marker}: apply the preference directly to this Activity's Window.\n    private void applyForgeSystemBars() {\n        if (forgeSystemBarsVisible == null) return;\n        final boolean visible = forgeSystemBarsVisible.booleanValue();\n        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {\n            android.view.WindowInsetsController controller = getWindow().getInsetsController();\n            if (controller != null) {\n                controller.setSystemBarsBehavior(\n                        android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);\n                int bars = android.view.WindowInsets.Type.statusBars()\n                        | android.view.WindowInsets.Type.navigationBars();\n                if (visible) controller.show(bars);\n                else controller.hide(bars);\n            }\n        } else {\n            int flags = View.SYSTEM_UI_FLAG_VISIBLE;\n            if (!visible) {\n                flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE\n                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION\n                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN\n                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION\n                        | View.SYSTEM_UI_FLAG_FULLSCREEN\n                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;\n            }\n            getWindow().getDecorView().setSystemUiVisibility(flags);\n        }\n    }\n\n    @Override\n    public void onWindowFocusChanged(boolean hasFocus) {\n        super.onWindowFocusChanged(hasFocus);\n        if (hasFocus) applyForgeSystemBars();\n    }\n\n`;
replaceOnce(
  '    @Override\n    protected void onCreate(Bundle savedInstanceState) {',
  helper + '    @Override\n    protected void onCreate(Bundle savedInstanceState) {',
  'MainActivity onCreate method'
);

replaceOnce(
  '    protected void onResume() {\n        super.onResume();',
  '    protected void onResume() {\n        super.onResume();\n        applyForgeSystemBars();',
  'MainActivity onResume method'
);

const nativeMethod = `        // ${marker}: this is a native MainActivity method, not a plugin Context cast.\n        @JavascriptInterface\n        public void setSystemBarsVisible(final boolean visible) {\n            runOnUiThread(new Runnable() {\n                @Override\n                public void run() {\n                    if (!isSafeOrigin()) return;\n                    forgeSystemBarsVisible = Boolean.valueOf(visible);\n                    applyForgeSystemBars();\n                }\n            });\n        }\n\n        @JavascriptInterface\n        public void showNotification(String title, String message) {`;
replaceOnce(
  '        @JavascriptInterface\n        public void showNotification(String title, String message) {',
  nativeMethod,
  'NitronJSInterface showNotification method'
);

fs.writeFileSync(sourcePath, source, 'utf8');
console.log(`Patched Nitron MainActivity with native status/navigation bar control: ${path.basename(sourcePath)}`);
console.log('  Native JS bridge: Nitron.setSystemBarsVisible(boolean)');
console.log('  Lifecycle re-apply: onResume() and onWindowFocusChanged()');
