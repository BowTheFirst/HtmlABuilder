#!/usr/bin/env node
// Patches Nitron's MainActivity.java to wire up WebChromeClient.onShowFileChooser
// so <input type="file"> opens the Android document picker instead of silently
// doing nothing. Without this, every file input in every Forge app is dead.
const fs = require('fs');
const path = require('path');

const target = process.argv[2] ||
  '/opt/nitron/template-src/base/MainActivity.java';

if (!fs.existsSync(target)) {
  console.error(`patch-nitron-file-chooser: not found: ${target}`);
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');

if (src.includes('FORGE_FILE_CHOOSER_PATCH')) {
  console.log('patch-nitron-file-chooser: already applied');
  process.exit(0);
}

// --- 1. Add imports ---------------------------------------------------------
const importAnchor = 'import android.webkit.WebView;';
if (!src.includes(importAnchor)) {
  console.error('patch-nitron-file-chooser: import anchor missing');
  process.exit(1);
}
const extraImports = `
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebChromeClient.FileChooserParams;
`;
// Only add imports that aren't already present.
const missingImports = extraImports
  .split('\n')
  .filter(l => l.trim() && !src.includes(l.trim()))
  .join('\n');
src = src.replace(importAnchor, importAnchor + '\n' + missingImports);

// --- 2. Insert the field + override inside the class -----------------------
// We anchor on the class body by inserting right after the first "{"
// following "public class MainActivity" (handles "extends ..." variants).
const classRe = /(public\s+class\s+MainActivity[^{]*\{)/;
const classMatch = src.match(classRe);
if (!classMatch) {
  console.error('patch-nitron-file-chooser: MainActivity class anchor missing');
  process.exit(1);
}

const patchBlock = `
    // FORGE_FILE_CHOOSER_PATCH — makes <input type="file"> work inside the APK.
    private ValueCallback<Uri[]> forgeFileCallback;
    private static final int FORGE_FILE_CHOOSER_REQUEST = 1001;

    private void forgeInstallFileChooser(WebView webView) {
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (forgeFileCallback != null) forgeFileCallback.onReceiveValue(null);
                forgeFileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                // Widen MIME so audio is offered even when the page uses accept="audio/*".
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                    "audio/*",
                    "audio/mpeg", "audio/mp3", "audio/mp4", "audio/aac",
                    "audio/ogg", "audio/wav", "audio/x-wav", "audio/flac",
                    "audio/x-m4a", "audio/webm",
                    "application/octet-stream"
                });
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(
                        Intent.createChooser(intent, "Choose a file"),
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
                    for (int i = 0; i < n; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
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
src = src.replace(classRe, classMatch[1] + patchBlock);

// --- 3. Call forgeInstallFileChooser(webView) right after the WebView is
//        created. Nitron's MainActivity typically calls setWebChromeClient
//        already (for console/progress), so we insert before any existing
//        setWebViewClient/setWebChromeClient call — order doesn't matter for
//        onShowFileChooser, but installing our client LAST wins.
const chromeAnchor = /(setWebChromeClient\s*\([^)]*\)\s*;)/;
if (!chromeAnchor.test(src)) {
  console.error('patch-nitron-file-chooser: no setWebChromeClient call to anchor on');
  process.exit(1);
}
// Replace the *last* existing setWebChromeClient(...) call by appending our
// installer after it — but since a second setWebChromeClient would overwrite
// the first, we instead install ours, then re-run. Simplest correct approach:
// replace the FIRST setWebChromeClient(...) call with our installer call,
// keeping the original client installed afterwards by NOT replacing it — so
// call ours BEFORE the original so the original still wins for console logs,
// but we need OUR client to win for onShowFileChooser. Therefore: replace the
// original setWebChromeClient(...) with ours, and chain to a null client.
// Safest: wrap — install ours, and forward other events to a fresh WebChromeClient.
// We keep it simple: our client handles onShowFileChooser; default client handles the rest.
src = src.replace(
  chromeAnchor,
  (m) => `forgeInstallFileChooser(webView); // FORGE_FILE_CHOOSER_PATCH: <input type=file> support\n        ${m}`
);

// Re-install OUR chrome client AFTER the original so onShowFileChooser wins.
// (Nitron's client is a plain WebChromeClient for logging; ours only overrides
// onShowFileChooser, so replacing is safe.)
src = src.replace(
  /setWebChromeClient\s*\(([^)]*)\)\s*;/,
  (m, arg) => `forgeInstallFileChooser(webView); /* FORGE_FILE_CHOOSER_PATCH */`
);

fs.writeFileSync(target, src);
console.log('patch-nitron-file-chooser: applied');
