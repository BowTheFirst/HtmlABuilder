'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { nanoid } = require('nanoid');
const multer = require('multer');
const AdmZip = require('adm-zip');

const app = express();
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const BUILDS_DIR = path.join(ROOT, 'builds');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(BUILDS_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { files: 250, fileSize: 100 * 1024 * 1024 },
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  // Required for efficient threaded WebAssembly inference in supported browsers.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'HtmlABuilder.html')));

const jobs = new Map();
const MAX_LOG_LINES = 1200;

function cleanAppName(value) {
  const name = String(value || 'My App').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 48);
  return name || 'My App';
}

function slugify(value) {
  return cleanAppName(value).normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'my-app';
}

function validPackageName(value) {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(value) && value.length <= 180;
}

function safeRelativePath(input) {
  const normalized = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.some(part => part === '..' || part.includes('\0'))) {
    throw new Error(`Unsafe file path: ${input}`);
  }
  return parts.join(path.sep);
}

function addLog(job, message) {
  const lines = String(message).replace(/\r/g, '').split('\n').filter(Boolean);
  for (const line of lines) {
    job.logs.push(line);
    if (job.logs.length > MAX_LOG_LINES) job.logs.shift();
    if (job.stream) job.stream.write(`data: ${JSON.stringify(line)}\n\n`);
  }
}

function extractZipSafely(zipPath, destination) {
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const relative = safeRelativePath(entry.entryName);
    const target = path.resolve(destination, relative);
    if (!target.startsWith(path.resolve(destination) + path.sep)) {
      throw new Error(`ZIP contains an unsafe path: ${entry.entryName}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
}

function findHtmlEntry(workDir) {
  const htmlFiles = [];
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.name === 'dist' || item.name === 'node_modules' || item.name.startsWith('.')) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (/\.html?$/i.test(item.name)) htmlFiles.push(full);
    }
  }
  walk(workDir);
  if (!htmlFiles.length) throw new Error('No HTML entry file was found. Upload an HTML file or a ZIP containing one.');

  const rootIndex = htmlFiles.find(file => path.dirname(file) === workDir && /^index\.html?$/i.test(path.basename(file)));
  if (rootIndex) {
    if (path.basename(rootIndex) !== 'index.html') fs.renameSync(rootIndex, path.join(workDir, 'index.html'));
    return 'index.html';
  }

  const preferred = htmlFiles.find(file => /^index\.html?$/i.test(path.basename(file))) || (htmlFiles.length === 1 ? htmlFiles[0] : null);
  if (!preferred) throw new Error('Multiple HTML files were found but no index.html. Add an index.html or upload a single-page project.');

  const relative = path.relative(workDir, preferred);
  if (htmlFiles.length === 1 && path.dirname(preferred) === workDir) {
    fs.renameSync(preferred, path.join(workDir, 'index.html'));
    return 'index.html';
  }
  return relative.split(path.sep).join('/');
}

function copyUploadedFiles(files, workDir) {
  const projectFiles = files.filter(file => file.originalname !== 'icon.png');
  const htmlFiles = projectFiles.filter(file => /\.html?$/i.test(file.originalname));
  const zipFiles = projectFiles.filter(file => /\.zip$/i.test(file.originalname));
  if (zipFiles.length) {
    if (zipFiles.length !== 1 || projectFiles.length !== 1) throw new Error('Upload one ZIP archive at a time.');
    extractZipSafely(zipFiles[0].path, workDir);
    return;
  }

  for (const file of projectFiles) {
    if (file.originalname === 'icon.png') continue;
    let relative = safeRelativePath(file.originalname);
    if (htmlFiles.length === 1 && path.dirname(relative) === '.') relative = 'index.html';
    const target = path.resolve(workDir, relative);
    if (!target.startsWith(path.resolve(workDir) + path.sep)) throw new Error('An uploaded file has an unsafe path.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file.path, target);
  }
}

function cleanupUploads(files) {
  for (const file of files || []) {
    try { fs.unlinkSync(file.path); } catch (_) { /* already removed */ }
  }
}

app.post('/api/jobs', upload.array('files'), (req, res) => {
  const files = req.files || [];
  let appName = cleanAppName(req.body.appName);
  const packageName = String(req.body.packageName || '').trim();

  if (!files.length) {
    cleanupUploads(files);
    return res.status(400).json({ message: 'Please select your project files first.' });
  }
  if (!validPackageName(packageName)) {
    cleanupUploads(files);
    return res.status(400).json({ message: 'Package name must look like com.example.myapp and use valid Android identifier segments.' });
  }

  const id = nanoid(12);
  const workDir = path.join(BUILDS_DIR, id);
  const job = { id, appName, packageName, status: 'preparing', logs: [], stream: null, apkPath: null, error: null };
  jobs.set(id, job);
  res.status(202).json({ id });

  setImmediate(async () => {
    try {
      fs.mkdirSync(workDir, { recursive: true });
      addLog(job, 'Preparing your project…');
      copyUploadedFiles(files, workDir);

      const entry = findHtmlEntry(workDir);
      addLog(job, `Entry file: ${entry}`);

      const iconFile = files.find(file => file.originalname === 'icon.png');
      if (iconFile) {
        const assetsDir = path.join(workDir, 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });
        fs.copyFileSync(iconFile.path, path.join(assetsDir, 'icon.png'));
        addLog(job, 'Custom launcher icon added.');
      }

      const configData = {
        name: appName,
        packageId: packageName,
        version: '1.0.0',
        entry,
        orientation: 'auto',
        statusBar: true,
        icon: iconFile ? './assets/icon.png' : undefined,
        webview: { backButton: 'history', clearCacheOnStart: false, externalLinks: 'browser' },
        splashScreen: { backgroundColor: '#11121a' },
      };
      Object.keys(configData).forEach(key => configData[key] === undefined && delete configData[key]);
      fs.writeFileSync(path.join(workDir, 'nitron.config.json'), JSON.stringify(configData, null, 2));
      fs.writeFileSync(path.join(workDir, '.htmlapk-build.json'), JSON.stringify({ appName, packageName, entry }, null, 2));

      job.status = 'building';
      addLog(job, `Building “${appName}”…`);
      const executable = process.env.NITRON_BIN || 'nitron';
      const child = spawn(executable, ['build'], { cwd: workDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      job.child = child;
      child.stdout.on('data', chunk => addLog(job, chunk.toString()));
      child.stderr.on('data', chunk => addLog(job, chunk.toString()));
      child.on('error', error => {
        job.status = 'error';
        job.error = error.message;
        addLog(job, `Build process could not start: ${error.message}`);
        if (job.stream) { job.stream.end(); job.stream = null; }
      });
      child.on('close', code => {
        const apkPath = path.join(workDir, 'dist', 'app.apk');
        if (code === 0 && fs.existsSync(apkPath)) {
          job.status = 'done';
          job.apkPath = apkPath;
          job.downloadName = `${slugify(appName)}.apk`;
          addLog(job, 'BUILD_COMPLETE');
        } else {
          job.status = 'error';
          job.error = code === 0 ? 'Nitron finished but no APK was found in dist/.' : `Nitron exited with code ${code}.`;
          addLog(job, `BUILD_ERROR: ${job.error}`);
        }
        if (job.stream) { job.stream.end(); job.stream = null; }
        delete job.child;
      });
    } catch (error) {
      job.status = 'error';
      job.error = error.message;
      addLog(job, `BUILD_ERROR: ${error.message}`);
      if (job.stream) { job.stream.end(); job.stream = null; }
    } finally {
      cleanupUploads(files);
    }
  });
});

app.get('/api/logs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  for (const line of job.logs) res.write(`data: ${JSON.stringify(line)}\n\n`);
  if (job.status === 'done' || job.status === 'error') return res.end();
  if (job.stream) job.stream.end();
  job.stream = res;
  req.on('close', () => { if (job.stream === res) job.stream = null; });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ status: 'not_found' });
  res.json({ id: job.id, status: job.status, appName: job.appName, packageName: job.packageName, error: job.error || null, downloadUrl: job.status === 'done' ? `/api/jobs/${job.id}/apk` : null });
});

app.get('/api/jobs/:id/apk', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.apkPath || !fs.existsSync(job.apkPath)) return res.status(404).send('APK is not ready.');
  res.download(job.apkPath, job.downloadName || 'app.apk');
});

app.use((error, _req, res, _next) => {
  const status = error instanceof multer.MulterError ? 400 : 500;
  res.status(status).json({ message: error.message || 'Unexpected server error.' });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`HTML → APK Studio listening on port ${PORT}`));
