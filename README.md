# Forge Studio — HTML to APK

A small web workspace that packages HTML projects into Android APKs with Nitron.

## Run locally

Requirements: Node.js 20+, Java 17+, and the Nitron CLI.

```bash
npm install
npm install -g nitron
npm start
```

Open `http://localhost:3000`.

## Deploy with Docker / Render

Use the included `Dockerfile`. The container installs Node.js, Java 17, and Nitron, then starts the Express build server on port `3000`.

## Project input

- Upload a single HTML file, a group of project files, a selected folder, or one ZIP archive.
- Keep relative paths for CSS, JavaScript, fonts, and images inside the project.
- A single HTML file is normalized to `index.html`. For a multi-page project, include a root `index.html` or a clearly named `index.html` inside the project folder.
- A custom icon is exported as a 512 × 512 PNG. Transparency is preserved.

## Background removal

Background removal runs in the browser using the pinned `@imgly/background-removal` 1.7.0 ESM build. The first use downloads its quantized AI model from the IMG.LY asset CDN; subsequent runs can use the browser cache. The server also sends the cross-origin isolation headers recommended for threaded WebAssembly performance. The Google Fonts stylesheet is requested with CORS so it remains compatible with those headers. The selected image itself is processed locally in the browser and is not uploaded to the build server unless it is chosen as the launcher icon.

## Build behavior

- The Android display name and package ID are written into `nitron.config.json` for every build.
- The server resolves the real HTML entry path instead of assuming every uploaded ZIP contains a root `index.html`.
- Build logs are buffered so early messages are not lost if the browser connects after the build starts.
- The downloaded APK uses the app name as its filename; Nitron's internal output remains `dist/app.apk`.

Build artifacts are stored in the server's `builds/` directory. On hosts with ephemeral storage, artifacts are not guaranteed to survive a redeploy or instance replacement; download completed APKs promptly or attach persistent storage.
