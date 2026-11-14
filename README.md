# Forge Studio – native Android system bars, theme bridge, icon crop, and permissions

Deploy `index.js`, `HtmlABuilder.html`, `package.json`, `Dockerfile`, and the complete `scripts/` directory together. **Rebuild and redeploy the Docker image** before generating a new APK. Restarting only the Node server is not enough because the native Nitron template is compiled into the Docker image. Existing installed APKs do not change; generate and install a fresh APK.

## Patches included

- **Android system bars:** the “Show Android system bars” setting controls both the top status bar and bottom navigation bar. The Docker build patches Nitron's actual `MainActivity.java` with a trusted `Nitron.setSystemBarsVisible(boolean)` native bridge. Hidden mode uses Android immersive-sticky behavior, allowing a temporary edge-swipe reveal. The Activity reapplies the selected state in `onResume()` and `onWindowFocusChanged()`. This does not depend on casting a generic plugin `Context` to `Activity`.
- **System-bar JavaScript flow:** the generated startup shim calls the native MainActivity bridge. The system-bar function is explicitly shared with the permission-startup script, avoiding a separate-IIFE scope error that could otherwise stop startup work.
- **System theme bridge:** keeps the Android system theme available through `window.ForgeAndroidTheme` and the `forge:system-theme` event. The host Activity selects a matching light/dark theme before creating WebView, and the HTML injection adds the standard `color-scheme` metadata.
- **Launcher icon sharpness:** Nitron now generates legacy launcher icons at their normal 48dp density sizes and adaptive foregrounds at the full Android 108dp layer sizes (108/162/216/324/432px). The artwork remains inset to 72dp, preserving the crop scale while preventing Android launchers from enlarging an undersized foreground bitmap. Both custom and fallback icons use the corrected sizing. The 512×512 Forge crop export and preview/export alignment check are retained.
- **Permissions:** retains the existing native Permission plugin for runtime permission requests. System-bar control itself no longer relies on that plugin.

## Docker build behavior

The Dockerfile pins the plugin-capable Nitron 3.2.0 source and applies these patches before compiling Nitron's CLI and Android template:

1. `scripts/patch-nitron-theme.js`
2. `scripts/patch-nitron-system-bars.js`
3. `scripts/patch-nitron-icon.js` (108dp adaptive foreground sizing)

After `node scripts/prepare-template.js`, the Docker build checks that the rebuilt `template/base.apk` contains the native system-bar bridge. A missing patch causes the image build to fail rather than silently producing an APK without the feature.

## Verification

Run `npm run check` to syntax-check the Node server. The system-bar patch script can be syntax-checked with `node --check scripts/patch-nitron-system-bars.js`. The full Docker build compiles the patched Java template and verifies its DEX. A physical-device test is still required to confirm behavior on the target Android version and navigation mode.

After deploying the rebuilt image, create a new APK with **Show Android system bars** unchecked. Install that new APK and confirm both bars are hidden on launch, briefly appear on an edge swipe, and hide again. Check the enabled setting too; it should show both bars.


## Launcher icon quality fix

Android adaptive icons use a 108dp foreground layer. Nitron previously wrote its adaptive foreground into the same 48dp density-sized bitmap dimensions used for legacy launcher icons (48/72/96/144/192px). On high-density devices, Android had to enlarge that undersized foreground, which could make the installed icon look soft. The icon patch now generates 108dp foreground canvases at 108/162/216/324/432px, while retaining 48/72/96/144/192px legacy assets. The artwork remains at 72dp inside the adaptive canvas so the established crop scale is preserved. The Docker build verifies the patch is bundled into Nitron before producing APKs.
