FORGE STUDIO v5 — UPDATE NOTES

FILES
- HtmlABuilder.html: updated tablet-first builder interface.
- index.js: updated Express build server. Replace the existing index.js too; the new Android controls require this server update.

WHAT CHANGED
- The builder stays inside the available viewport. The page itself does not scroll; the active setup panel, build activity and saved-project list have their own contained scrolling areas.
- Added an Android setup stage with 45 selectable permission entries across network, camera/microphone/media, location/notifications, contacts/calendar/phone, Bluetooth/nearby devices, sensors and advanced access.
- Permissions are written into nitron.config.json for the Android build. INTERNET remains included automatically.
- Added app version and orientation settings.
- Added APK and Google Play AAB targets. AAB automatically requires a signed release build.
- Added release-key creation. The server generates a JKS keystore in a temporary location and streams it to the browser; it does not keep a shared signing key. Select the downloaded keystore file and enter its password when making a signed build. The uploaded key is cleaned up with the other temporary build uploads.
- Successfully built projects are automatically saved in the browser's local IndexedDB library; the existing My projects tab can reopen them with their settings and source files.
- Fixed launcher icon upload naming so the backend places it at the path configured in Nitron.

DEPLOYMENT
1. Replace BOTH existing files with HtmlABuilder.html and index.js from this update.
2. Keep your existing package.json / dependencies. No new npm dependency was added by this update.
3. Ensure Node.js 20+, Java 17+ (a full JDK), and the existing Nitron CLI are installed and available to the server. `keytool` must be on PATH.
4. Deploy the updated server over HTTPS. Release-key passwords and keystore files are sent to the build server for the duration of key creation/building; do not use this feature over plain HTTP.
5. Ensure the server has persistent build storage if you need build artifacts to survive redeploys. Keystore files are intentionally not retained on the server; keep your own secure backup.

SIGNING / GOOGLE PLAY
- Create a release key once and securely back up the downloaded .keystore file. Do not create a replacement key for an app already published with the old key.
- For each release, select that same keystore and enter its password.
- Choose APK for device testing, or AAB for Google Play Console upload. AAB requires the full JDK and release signing.
- Increase the version for every update. Keep the same package identifier and signing key for updates to an existing app.
- Google Play may restrict certain sensitive permissions (for example SMS, call-related, all-files and package-install permissions). Selecting a permission only declares it in the Android app; it does not guarantee Play approval or automatically make app code request/grant it at runtime. The app must implement the appropriate Android/Nitron permission request flow when it actually uses a protected feature.

SAVED PROJECTS
The My projects library remains local to the browser/device (IndexedDB), not cloud-synced. Successful builds are now auto-saved. Keep a separate copy of source files; clearing browser storage can remove the local project library.

IMPORTANT
This update changes both the frontend and backend. Replacing only the HTML file will show the new controls but will not apply permissions, AAB targets or release signing. The backend must be redeployed with the matching index.js.
