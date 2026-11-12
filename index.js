const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const nanoid = require('nanoid').nanoid;
const multer = require('multer');
const AdmZip = require('adm-zip');

const app = express();
const upload = multer({ dest: 'uploads/', limits: { fileSize: 100 * 1024 * 1024, files: 300 } });
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'HtmlABuilder.html')));

const jobs = Object.create(null);
const logStreams = Object.create(null);
const releaseAlias = 'forge-release';
const allowedPermissions = new Set([
 'INTERNET','ACCESS_NETWORK_STATE','ACCESS_WIFI_STATE','CHANGE_WIFI_STATE','VIBRATE','WAKE_LOCK',
 'CAMERA','RECORD_AUDIO','READ_MEDIA_IMAGES','READ_MEDIA_VIDEO','READ_MEDIA_AUDIO','READ_MEDIA_VISUAL_USER_SELECTED','READ_EXTERNAL_STORAGE','WRITE_EXTERNAL_STORAGE','ACCESS_MEDIA_LOCATION',
 'ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION','ACCESS_BACKGROUND_LOCATION','POST_NOTIFICATIONS','SCHEDULE_EXACT_ALARM','RECEIVE_BOOT_COMPLETED',
 'READ_CONTACTS','WRITE_CONTACTS','GET_ACCOUNTS','READ_CALENDAR','WRITE_CALENDAR','READ_PHONE_STATE','CALL_PHONE','ANSWER_PHONE_CALLS','READ_PHONE_NUMBERS',
 'BLUETOOTH_SCAN','BLUETOOTH_CONNECT','BLUETOOTH_ADVERTISE','NEARBY_WIFI_DEVICES','NFC','ACTIVITY_RECOGNITION','BODY_SENSORS',
 'SEND_SMS','RECEIVE_SMS','READ_SMS','RECEIVE_MMS','SYSTEM_ALERT_WINDOW','REQUEST_IGNORE_BATTERY_OPTIMIZATIONS','REQUEST_INSTALL_PACKAGES','MANAGE_EXTERNAL_STORAGE'
]);
function sendLog(id, msg) {
  const stream = logStreams[id];
  if (stream && !stream.writableEnded) stream.write(`data: ${JSON.stringify(String(msg))}\n\n`);
}
function safeRelativePath(name) {
  const normalized = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const clean = path.posix.normalize(normalized);
  if (!clean || clean === '.' || clean.startsWith('../') || clean.includes('/../')) throw new Error('Unsafe project file path');
  return clean;
}
function cleanUploads(files) { (files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} }); }
function buildConfig(req) {
  let requested = [];
  try { requested = JSON.parse(req.body.permissions || '[]'); } catch (_) { throw new Error('Invalid permissions list'); }
  if (!Array.isArray(requested)) throw new Error('Invalid permissions list');
  const permissions = [...new Set(['INTERNET', ...requested.filter(p => allowedPermissions.has(p))])];
  const version = String(req.body.version || '1.0.0');
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Version must use semantic format such as 1.0.0');
  const orientation = ['portrait','landscape','auto'].includes(req.body.orientation) ? req.body.orientation : 'portrait';
  return { name: String(req.body.appName || 'My App').slice(0, 48), packageId: String(req.body.packageName || 'com.forgeapps.myapp'), version, entry: 'index.html', icon: './icon.png', statusBar: req.body.statusBar !== 'false', orientation, permissions, network: { cleartext: false }, webview: { backButton: 'history' } };
}

app.post('/api/keystore/create', async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ message: 'Use at least 8 characters for the release-key password.' });
  const tempKey = path.join(os.tmpdir(), `forge-${nanoid(14)}.keystore`);
  try {
    const env = { ...process.env, FORGE_KEY_PASSWORD: password };
    await execFileAsync('keytool', ['-genkeypair','-v','-keystore',tempKey,'-storetype','JKS','-alias',releaseAlias,'-keyalg','RSA','-keysize','2048','-validity','10000','-dname','CN=Forge Studio Release,O=Forge Studio,C=TT','-storepass:env','FORGE_KEY_PASSWORD','-keypass:env','FORGE_KEY_PASSWORD','-noprompt'], { timeout: 30000, windowsHide: true, env });
    res.download(tempKey, 'forge-release.keystore', () => { try { fs.unlinkSync(tempKey); } catch (_) {} });
  } catch (error) {
    try { fs.unlinkSync(tempKey); } catch (_) {}
    res.status(500).json({ message: error.message || 'keytool could not create the release key. Ensure a full JDK is installed.' });
  }
});

app.post('/api/jobs', upload.array('files'), async (req, res) => {
  const id = nanoid(10);
  let config;
  try { config = buildConfig(req); if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(config.packageId)) throw new Error('Invalid Android package identifier.'); } catch (error) { cleanUploads(req.files); return res.status(400).json({ message: error.message }); }
  const target = req.body.target === 'aab' ? 'aab' : 'apk';
  const release = req.body.release === 'true' || target === 'aab';
  const password = String(req.body.keystorePassword || '');
  const incomingFiles = req.files || [];
  const uploadedKey = incomingFiles.find(f => f.originalname === 'nitron-release.keystore');
  if (release && (!uploadedKey || password.length < 8)) { cleanUploads(incomingFiles); return res.status(400).json({ message: 'Select your release keystore and enter its password before making a signed release build.' }); }
  jobs[id] = { status: 'building', target };
  res.json({ id });

  const workDir = path.join(__dirname, 'builds', id);
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const uploadedFiles = incomingFiles;
    const zipFile = uploadedFiles.find(f => f.originalname.toLowerCase().endsWith('.zip'));
    if (zipFile) {
      const zip = new AdmZip(zipFile.path);
      zip.extractAllTo(workDir, true);
    }
    {
      const htmlFiles = uploadedFiles.filter(f => f.originalname.toLowerCase().endsWith('.html'));
      for (const file of uploadedFiles) {
        if (file.originalname.toLowerCase().endsWith('.zip')) continue;
        const rel = safeRelativePath(file.originalname);
        if (rel === 'icon.png' || rel === 'nitron-release.keystore') continue;
        const finalName = htmlFiles.length === 1 && rel.toLowerCase().endsWith('.html') ? 'index.html' : rel;
        const targetPath = path.join(workDir, finalName);
        if (!targetPath.startsWith(workDir + path.sep)) throw new Error('Unsafe project file path');
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(file.path, targetPath);
      }
    }
    const iconFile = uploadedFiles.find(f => f.originalname === 'icon.png' || f.originalname.endsWith('/icon.png'));
    if (iconFile) fs.copyFileSync(iconFile.path, path.join(workDir, 'icon.png'));
    if (fs.existsSync(path.join(workDir, 'icon.png'))) config.icon = './icon.png'; else delete config.icon;
    if (!fs.existsSync(path.join(workDir, 'index.html'))) throw new Error('No index.html found. Add one HTML file or a project folder containing index.html.');
    fs.writeFileSync(path.join(workDir, 'nitron.config.json'), JSON.stringify(config, null, 2));
    const args = ['build'];
    if (target === 'aab') args.push('--target', 'aab');
    if (release) {
      fs.copyFileSync(uploadedKey.path, path.join(workDir, 'nitron-release.keystore'));
      args.push('--release');
    }
    sendLog(id, `Starting ${target.toUpperCase()} build…`);
    sendLog(id, `Permissions: ${config.permissions.length} selected`);
    const env = { ...process.env };
    if (release) env.NITRON_KEYSTORE_PASSWORD = password;
    const child = require('child_process').spawn('nitron', args, { cwd: workDir, env, windowsHide: true });
    child.stdout.on('data', data => sendLog(id, data.toString().trimEnd()));
    child.stderr.on('data', data => sendLog(id, data.toString().trimEnd()));
    child.on('error', error => finish(error));
    child.on('close', code => finish(code === 0 ? null : new Error(`Build failed with exit code ${code}`)));
    let finished = false;
    function finish(error) {
      if (finished) return; finished = true;
      cleanUploads(uploadedFiles);
      const extension = target === 'aab' ? 'aab' : 'apk';
      const artifact = path.join(workDir, 'dist', `app.${extension}`);
      if (!error && fs.existsSync(artifact)) {
        jobs[id] = { status: 'done', target, downloadUrl: `/api/jobs/${id}/artifact`, fileName: `app.${extension}` };
        sendLog(id, 'BUILD_COMPLETE');
      } else {
        jobs[id] = { status: 'error', target, error: error?.message || `${extension.toUpperCase()} not found in dist/` };
        sendLog(id, `BUILD_ERROR: ${jobs[id].error}`);
      }
      if (logStreams[id] && !logStreams[id].writableEnded) logStreams[id].end();
      delete logStreams[id];
    }
  } catch (error) {
    cleanUploads(req.files);
    jobs[id] = { status: 'error', target, error: error.message };
    sendLog(id, `BUILD_ERROR: ${error.message}`);
    if (logStreams[id] && !logStreams[id].writableEnded) logStreams[id].end();
    delete logStreams[id];
  }
});
app.get('/api/logs/:id', (req, res) => {
  const id = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
  logStreams[id] = res;
  req.on('close', () => { if (logStreams[id] === res) delete logStreams[id]; });
});
app.get('/api/jobs/:id', (req, res) => { const job = jobs[req.params.id]; if (!job) return res.status(404).json({ status: 'not_found' }); res.json(job); });
app.get('/api/jobs/:id/artifact', (req, res) => {
  const job = jobs[req.params.id]; if (!job || job.status !== 'done') return res.status(404).send('Artifact not ready');
  const ext = job.target === 'aab' ? 'aab' : 'apk'; const artifact = path.join(__dirname, 'builds', req.params.id, 'dist', `app.${ext}`);
  if (!fs.existsSync(artifact)) return res.status(404).send('Artifact not found');
  res.download(artifact, `forge-app.${ext}`);
});
// Backwards-compatible APK route for older clients.
app.get('/api/jobs/:id/apk', (req, res) => res.redirect(302, `/api/jobs/${encodeURIComponent(req.params.id)}/artifact`));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Forge Studio build server listening on ${PORT}`));
