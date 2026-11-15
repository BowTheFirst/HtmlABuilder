#!/usr/bin/env node
'use strict';

// Add Android's native file chooser to Nitron without replacing its existing
// WebChromeClient (which handles microphone/camera and geolocation permissions).
const fs = require('fs');

const target = process.argv[2] ||
  '/opt/nitron/template-src/base/MainActivity.java';
if (!fs.existsSync(target)) {
  console.error(`patch-nitron-file-chooser: file not found: ${target}`);
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
const marker = 'FORGE_FILE_CHOOSER_PATCH';
if (src.includes(marker)) {
  console.log('patch-nitron-file-chooser: already applied');
  process.exit(0);
}

function die(message) {
  console.error(`patch-nitron-file-chooser: ${message}`);
  process.exit(1);
}

// Ensure the Android APIs used by the file chooser are imported exactly once.
const neededImports = [
  'import android.app.Activity;',
  'import android.content.ActivityNotFoundException;',
  'import android.content.Intent;',
  'import android.net.Uri;',
  'import android.webkit.ValueCallback;',
  'import android.webkit.WebChromeClient;',
];
const importPattern = /^import\s+[\w.]+\s*;\s*$/gm;
let lastImport = null;
let importMatch;
while ((importMatch = importPattern.exec(src)) !== null) {
  lastImport = importMatch;
}
if (!lastImport) die('no Java import statements found');

const missingImports = neededImports.filter(item => !src.includes(item));
if (missingImports.length) {
  const insertAt = lastImport.index + lastImport[0].length;
  src = src.slice(0, insertAt) +
    '\n' + missingImports.join('\n') +
    src.slice(insertAt);
}

// Find the Activity class name so the nested WebChromeClient can explicitly
// call the enclosing Activity's startActivityForResult method.
const classPattern =
  /((?:public\s+)?(?:final\s+)?class\s+(\w+)\s+extends\s+[^{]+\{)/;
const classMatch = src.match(classPattern);
if (!classMatch) die('could not locate the Android Activity class declaration');
const activityClassName = classMatch[2];
const classOpenIndex = classMatch.index + classMatch[0].length;

// Do not remove or overwrite a template's existing result handler.
if (/@Override\s*(?:public|protected)\s+void\s+onActivityResult\s*\(/m.test(src)) {
  die('an onActivityResult override already exists; refusing to replace existing Activity behavior');
}

const classMembers = `
    /* ${marker} */
    private static final int FORGE_FILE_CHOOSER_REQUEST = 1001;
    private ValueCallback<Uri[]> forgeFileCallback;

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FORGE_FILE_CHOOSER_REQUEST) {
            ValueCallback<Uri[]> callback = forgeFileCallback;
            forgeFileCallback = null;
            if (callback == null) return;

            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                }
            }
            callback.onReceiveValue(results);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }
`;
src = src.slice(0, classOpenIndex) + classMembers + src.slice(classOpenIndex);

// Extend Nitron's existing WebChromeClient instead of replacing it. This keeps
// its trusted-origin media permission and geolocation behavior intact.
const chromeAnchor =
  /(\b\w+\.setWebChromeClient\s*\(\s*new\s+WebChromeClient\s*\(\s*\)\s*\{)/g;
const chromeMatches = [...src.matchAll(chromeAnchor)];
if (chromeMatches.length !== 1) {
  die(`expected one existing WebChromeClient, found ${chromeMatches.length}`);
}
const chromeMatch = chromeMatches[0];
const webViewName = chromeMatch[1].split('.')[0];

const chooserOverride = `
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             WebChromeClient.FileChooserParams params) {
                if (forgeFileCallback != null) {
                    forgeFileCallback.onReceiveValue(null);
                }
                forgeFileCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    ${activityClassName}.this.startActivityForResult(
                            intent, FORGE_FILE_CHOOSER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException e) {
                    forgeFileCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
            }
`;
const insertAt = chromeMatch.index + chromeMatch[0].length;
src = src.slice(0, insertAt) + chooserOverride + src.slice(insertAt);

fs.writeFileSync(target, src, 'utf8');
console.log(`patch-nitron-file-chooser: applied to ${target}`);
console.log(`  WebView: ${webViewName}`);
console.log(`  Existing WebChromeClient permission handlers preserved.`);
