#!/usr/bin/env node
// Forge patch: wire WebChromeClient.onShowFileChooser so <input type="file">
// opens the Android document picker. Nitron 3.2.0 never overrides this, so
// every file input in every generated APK silently does nothing.
const fs = require('fs');

const target = process.argv[2] ||
  '/opt/nitron/template-src/base/MainActivity.java';
if (!fs.existsSync(target)) {
  console.error(`patch-nitron-file-chooser: file not found: ${target}`);
  process.exit(1);
}
let src = fs.readFileSync(target, 'utf8');

if (src.includes('FORGE_FILE_CHOOSER_PATCH')) {
  console.log('patch-nitron-file-chooser: already applied');
  process.exit(0);
}

function die(msg, hint) {
  console.error(`patch-nitron-file-chooser: ${msg}`);
  if (hint) console.error(hint);
  process.exit(1);
}

// --- 1. Imports -------------------------------------------------------------
const needed = [
  'import android.app.Activity;',
  'import android.content.ActivityNotFoundException;',
  'import android.content.Intent;',
  'import android.net.Uri;',
  'import android.webkit.ValueCallback;',
  'import android.webkit.WebChromeClient;',
];
const lastImportRe = /^import\s+[\w.]+\s*;\s*$/gm;
let lastImport = null, m;
while ((m = lastImportRe.exec(src)) !== null) lastImport = m;
if (!lastImport) die('no import statements found to anchor on');
const missing = needed.filter(l => !src.includes(l.trim()));
if (missing.length) {
  const insertAt = lastImport.index + lastImport[0].length;
  src = src.slice(0, insertAt) + '\n' + missing.join('\n') + src.slice(insertAt);
}

// --- 2. Find the MainActivity class body ------------------------------------
const classRe = /((?:public\s+)?(?:final\s+)?class\s+\w+\s+extends\s+[^{]+\{)/;
const cm = src.match(classRe);
if (!cm) die('could not locate "class X extends Y {" declaration');
const classOpenIdx = cm.index + cm[0].length;

const patchBlock = `
    /* FORGE_FILE_CHOOSER_PATCH */
    private ValueCallback<Uri[]> forgeFileCallback;
    private static final int FORGE_FILE_CHOOSER_REQUEST = 1001;

    private void forgeInstallFileChooser(android.webkit.WebView webView) {
        webView.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onShowFileChooser(android.webkit.WebView view,
                                             ValueCallback<Uri[]> callback,
                                             android.webkit.WebChromeClient.FileChooserParams params) {
                if (forgeFileCallback != null) forgeFileCallback.onReceiveValue(null);
                forgeFileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                    "audio/*","audio/mpeg","audio/mp3","audio/mp4","audio/aac",
                    "audio/ogg","audio/wav","audio/x-wav","audio/flac",
                    "audio/x-m4a","audio/webm","application/octet-stream"
                });
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,
                    params.getMode() == android.webkit.WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(Intent.createChooser(intent, "Choose a file"),
                        FORGE_FILE_CHOOSER_REQUEST);
                } catch (ActivityNotFoundException e) {
                    forgeFileCallback = null;
                    return false;
                }
                return true;
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FORGE_FILE_CHOOSER_REQUEST) {
            if (forgeFileCallback == null) return;
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    results = new Uri[n];
                    for (int i = 0; i < n; i++)
                        results[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                }
            }
            forgeFileCallback.onReceiveValue(results);
            forgeFileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }
`;
// Strip any existing onActivityResult override so ours doesn't collide.
(function stripExistingOnActivityResult(){
  const re = /@Override\s*(?:public|protected|private)?\s*void\s+onActivityResult\s*\([^)]*\)\s*\{/m;
  const match = re.exec(src);
  if (!match) return;
  let i = match.index + match[0].length, depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i++];
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  while (i < src.length && (src[i] === '\n' || src[i] === '\r' || src[i] === ' ' || src[i] === '\t')) i++;
  src = src.slice(0, match.index) + src.slice(i);
})();
src = src.slice(0, classOpenIdx) + patchBlock + src.slice(classOpenIdx);

// --- 3. Find the WebView field name ----------------------------------------
const wvAssignRe = /(\w+)\s*=\s*new\s+(?:android\.webkit\.)?WebView\s*\(/;
const wvMatch = src.match(wvAssignRe);
const webViewName = wvMatch ? wvMatch[1] : 'webView';

// --- 4. Replace the first setWebChromeClient(...) call with our installer ---
const chromeCallRe = /([ \t]*)(\w+\.setWebChromeClient\s*\([^;]*\)\s*;)/;
const chromeMatch = src.match(chromeCallRe);
if (chromeMatch) {
  src = src.slice(0, chromeMatch.index) +
        `${chromeMatch[1]}forgeInstallFileChooser(${webViewName});` +
        src.slice(chromeMatch.index + chromeMatch[0].length);
} else {
  const loadRe = /([ \t]*)(\w+\.loadUrl\s*\([^;]*\)\s*;)/;
  const loadMatch = src.match(loadRe);
  if (!loadMatch) {
    die('could not find setWebChromeClient(...) or loadUrl(...) to anchor on',
        'Run: grep -n "WebChromeClient\\|loadUrl" /opt/nitron/template-src/base/MainActivity.java');
  }
  src = src.slice(0, loadMatch.index) +
        `${loadMatch[1]}forgeInstallFileChooser(${webViewName});\n${loadMatch[1]}${loadMatch[2]}` +
        src.slice(loadMatch.index + loadMatch[0].length);
}

fs.writeFileSync(target, src);
console.log(`patch-nitron-file-chooser: applied to ${target}`);
console.log(`  WebView field: ${webViewName}`);