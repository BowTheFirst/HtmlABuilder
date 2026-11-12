Forge Studio – Runtime Permission Fix

Replace index.js on your Render/GitHub deployment with the updated file in this package. HtmlABuilder.html is included unchanged because the fix is in the generated Android app's native permission bridge and startup script.

What this changes:
- Keeps the selected permissions in nitron.config.json (Android manifest declarations).
- Adds a Nitron native Permission plugin to each generated app.
- On app startup, the generated app asks Android for any declared dangerous/runtime permissions that have not already been granted.
- The request is based on the permissions actually declared in that build's Android package manifest, so it covers selected runtime permissions rather than only microphone/camera.
- Returns granted/denied results to the page as the `forge:permissions-result` event, and errors as `forge:permissions-error`.

Important Android behavior:
- Declaring a permission in the manifest does not show a dialog. Runtime permissions need a native requestPermissions call.
- Normal/install-time permissions are granted automatically and do not show a prompt.
- Special permissions (for example overlay access, all-files access, exact alarms, or battery-optimization exemptions) require their own Settings screens and are not part of the ordinary runtime permission dialog. This patch does not pretend those can be granted by a standard dialog.
- Android can suppress repeat dialogs after repeated denials; users may need to enable a permission in Android Settings.
- The app requests declared runtime permissions on startup as requested. For production UX, Android recommends requesting sensitive permissions in context and explaining why they are needed.

Build requirements:
- Nitron native plugins require a full JDK (the provided Dockerfile installs OpenJDK 17 JDK).
- Build a fresh APK after deploying this server update. Existing installed APKs do not gain the new native permission plugin; uninstall/reinstall or install the new build.
- Verify on a device: a selected RECORD_AUDIO permission should cause Android's microphone permission dialog on first launch if it has not already been granted.
