# Forge Studio – Android system bars, theme bridge, icon crop, and permissions

Deploy `index.js`, `HtmlABuilder.html`, `package.json`, and `Dockerfile` together, then rebuild and redeploy the server image before generating new APKs. Existing installed APKs do not receive these changes; build and install a fresh APK.

## Patches included

- **Android system bars:** the visibility toggle controls both the status bar and bottom navigation bar. The native Permission plugin applies immersive-sticky mode when hidden; users can temporarily reveal the bars with an edge swipe. The setting is reapplied when the app regains focus or returns to the foreground. The plugin reports a clear error if the Android Activity cannot be reached.
- **System theme bridge:** removes the app-specific `Written Magic.theme` check. The native Android configuration is exposed through `window.ForgeAndroidTheme`, `forge:system-theme`, `data-forge-system-theme`, and `color-scheme`. JavaScript frameworks that read `matchMedia('(prefers-color-scheme: dark)')` receive change events when Android's theme changes. CSS-only `@media (prefers-color-scheme: ...)` rules still depend on the WebView's own native color-scheme behavior; apps should use the event/attribute or set a DayNight host theme for guaranteed CSS media-query behavior.
- **Launcher icon crop:** dragging now applies pointer deltas instead of recalculating an absolute position, removing the jump/snap behavior. Preview movement is normalized to a 200×200 coordinate space so it remains aligned at responsive preview sizes and with the 512×512 PNG export.
- **Permissions:** retains the existing Nitron native permission plugin and startup permission flow.

## Build and verification

Run `npm run check` to syntax-check the Node server. The Dockerfile builds the pinned Nitron 3.2.0 source with native-plugin support. A successful server syntax check does not prove a device APK build; compile the native plugin in the Docker build and install a fresh APK on a physical Android device to verify status/navigation-bar behavior, theme switching, and icon positioning.


## Android system theme compatibility patch

The Docker build patches the pinned Nitron `template-src/base/MainActivity.java`
before rebuilding `template/base.apk`. The native Activity selects a platform
Material light or dark theme from Android's current `uiMode` before creating the
WebView. This sets the host theme's `isLightTheme` attribute correctly, which is
what Android WebView uses to evaluate `prefers-color-scheme`. The HTML injection
also adds `<meta name="color-scheme" content="dark light">` before the app's scripts
so WebView's default web-theme darkening strategy can honor CSS media queries.

The previous Forge-only exact-string rewrite of one WrittenMagic theme expression
has been removed. Theme behavior is now driven by the native Android theme and
standard WebView behavior, not by matching one application's minified JavaScript.

The Docker image must be rebuilt and redeployed for the Nitron base APK patch to
take effect. Existing APKs are unchanged. A syntax check does not substitute for
installing and testing a newly built APK while toggling Android's system theme.
