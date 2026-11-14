# Forge Studio – Android system bars, theme bridge, icon crop, and permissions

Deploy `index.js`, `HtmlABuilder.html`, `package.json`, and `Dockerfile` together, then rebuild and redeploy the server image before generating new APKs. Existing installed APKs do not receive these changes; build and install a fresh APK.

## Patches included

- **Android system bars:** the existing visibility toggle now controls both the status bar and the bottom navigation bar. Hiding them uses Android immersive-sticky mode; users can temporarily reveal system navigation with the normal Android edge swipe. The native plugin reports a clear error if the Android Activity cannot be reached.
- **System theme bridge:** removes the app-specific `Written Magic.theme` check. The native Android configuration is exposed through `window.ForgeAndroidTheme`, `forge:system-theme`, `data-forge-system-theme`, and `color-scheme`. JavaScript frameworks that read `matchMedia('(prefers-color-scheme: dark)')` receive change events when Android's theme changes. CSS-only `@media (prefers-color-scheme: ...)` rules still depend on the WebView's own native color-scheme behavior; apps should use the event/attribute or set a DayNight host theme for guaranteed CSS media-query behavior.
- **Launcher icon crop:** dragging now applies pointer deltas instead of recalculating an absolute position, removing the jump/snap behavior. Preview movement is normalized to a 200×200 coordinate space so it remains aligned at responsive preview sizes and with the 512×512 PNG export.
- **Permissions:** retains the existing Nitron native permission plugin and startup permission flow.

## Build and verification

Run `npm run check` to syntax-check the Node server. The Dockerfile builds the pinned Nitron 3.2.0 source with native-plugin support. A successful server syntax check does not prove a device APK build; compile the native plugin in the Docker build and install a fresh APK on a physical Android device to verify status/navigation-bar behavior, theme switching, and icon positioning.
