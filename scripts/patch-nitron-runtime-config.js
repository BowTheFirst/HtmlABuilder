#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// FORGE FIX: make nitron.* runtime configuration actually reach MainActivity.
//
// Root cause (Nitron 3.2.0, commit d2071302):
//
//   src/engines/nitronoid/manifest.ts emits every <meta-data> tag INSIDE
//   <activity>:
//
//       <application ...>
//           <activity ...>
//               <intent-filter> ... </intent-filter>
//               <meta-data android:name="nitron.externalLinks" ... />   <-- here
//           </activity>
//       </application>
//
//   but template-src/base/MainActivity.java reads it from ApplicationInfo:
//
//       getPackageManager().getApplicationInfo(pkg, GET_META_DATA).metaData
//
//   ApplicationInfo.metaData only contains <application>-level <meta-data>.
//   Activity-level <meta-data> lives in ActivityInfo.metaData. So appInfo.metaData
//   is null, the `if (meta != null)` block never runs, and EVERY runtime setting
//   silently falls back to its default:
//
//       nitron.externalLinks     -> "browser"   (config "inapp" ignored)
//       nitron.allowedHosts      -> empty
//       nitron.backButton        -> "history"   (config "exit" ignored)
//       nitron.clearCacheOnStart -> false
//       nitron.splashBackground  -> "#FFFFFF"
//
//   With externalLinks stuck on "browser", shouldOverrideUrlLoading() hands the
//   live-URL wrapper's redirect to the system browser and returns true, so the
//   WebView never leaves the local "Opening website… / Continue to website" page.
//
// This script fixes both sides:
//   1. manifest.ts   -> emit the <meta-data> under <application> (correct scope).
//   2. MainActivity  -> merge ApplicationInfo + ActivityInfo meta-data, so the
//                       config is read correctly no matter which scope it is in.
//
// Usage: node patch-nitron-runtime-config.js <nitron-root>
//   e.g. node patch-nitron-runtime-config.js /opt/nitron
//
// Must run BEFORE `npm run build` (it edits TypeScript) and BEFORE
// `node scripts/prepare-template.js` (it edits Java).
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const root = process.argv[2];
if (!root) {
  console.error('Usage: node patch-nitron-runtime-config.js <nitron-root>');
  process.exit(2);
}

const manifestPath = path.join(root, 'src/engines/nitronoid/manifest.ts');
const activityPath = path.join(root, 'template-src/base/MainActivity.java');

for (const file of [manifestPath, activityPath]) {
  if (!fs.existsSync(file)) throw new Error(`Nitron source not found: ${file}`);
}

const MARKER = 'FORGE_RUNTIME_METADATA_PATCH';

// ── 1. manifest.ts: move <meta-data> from <activity> into <application> ───────
{
  let ts = fs.readFileSync(manifestPath, 'utf8');
  if (ts.includes(MARKER)) {
    console.log('manifest.ts: runtime meta-data scope already patched.');
  } else {
    const anchor = '\n${metaDataXml}\n        </activity>\n    </application>';
    const first = ts.indexOf(anchor);
    if (first < 0) {
      throw new Error(
        'manifest.ts: could not locate the <meta-data> block inside <activity>; ' +
        'refusing to build with an unknown Nitron revision.'
      );
    }
    if (ts.indexOf(anchor, first + anchor.length) >= 0) {
      throw new Error('manifest.ts: ambiguous <meta-data> anchor; refusing to patch.');
    }
    const replacement =
      '\n        </activity>\n\n' +
      `        <!-- ${MARKER}: nitron.* runtime config must live under <application>,\n` +
      '             because MainActivity reads ApplicationInfo.metaData. -->\n' +
      '${metaDataXml}\n    </application>';
    ts = ts.slice(0, first) + replacement + ts.slice(first + anchor.length);
    fs.writeFileSync(manifestPath, ts, 'utf8');
    console.log('manifest.ts: moved nitron.* <meta-data> into <application> scope.');
  }
}

// ── 2. MainActivity.java: read both meta-data scopes ─────────────────────────
{
  let java = fs.readFileSync(activityPath, 'utf8');
  if (java.includes(MARKER)) {
    console.log('MainActivity.java: runtime meta-data reader already patched.');
  } else {
    const helperAnchor = '    private void readMetaData() {';
    if (!java.includes(helperAnchor)) {
      throw new Error('MainActivity.java: readMetaData() not found; refusing to patch an unknown template.');
    }

    // Inserted just above readMetaData(). Takes the already-fetched ApplicationInfo
    // so the existing `try { ... } catch (NameNotFoundException)` stays valid Java.
    const helper = `    // ${MARKER}
    // Nitron may place nitron.* <meta-data> under <activity> (ActivityInfo) or
    // under <application> (ApplicationInfo). Read both, activity scope winning,
    // so settings such as nitron.externalLinks are never silently dropped.
    private Bundle forgeRuntimeMetaData(ApplicationInfo appInfo) {
        Bundle merged = new Bundle();
        if (appInfo != null && appInfo.metaData != null) {
            merged.putAll(appInfo.metaData);
        }
        try {
            android.content.pm.ActivityInfo activityInfo = getPackageManager()
                .getActivityInfo(getComponentName(), PackageManager.GET_META_DATA);
            if (activityInfo != null && activityInfo.metaData != null) {
                merged.putAll(activityInfo.metaData);
            }
        } catch (Throwable t) {
            System.err.println("Nitron: activity meta-data unavailable: " + t);
        }
        return merged;
    }

`;
    java = java.replace(helperAnchor, helper + helperAnchor);

    // Both read sites: readMetaData() and setupSplashScreen().
    const readAnchor = '            Bundle meta = appInfo.metaData;';
    const occurrences = java.split(readAnchor).length - 1;
    if (occurrences !== 2) {
      throw new Error(
        `MainActivity.java: expected 2 meta-data read sites, found ${occurrences}; ` +
        'refusing to patch an unknown template.'
      );
    }
    java = java.split(readAnchor).join('            Bundle meta = forgeRuntimeMetaData(appInfo);');

    fs.writeFileSync(activityPath, java, 'utf8');
    console.log('MainActivity.java: runtime meta-data now merged from <application> + <activity>.');
  }
}

console.log('OK: Nitron runtime configuration (externalLinks, allowedHosts, backButton, splash) will now be honoured.');
