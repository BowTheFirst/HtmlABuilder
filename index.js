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
  const line = String(msg);
  const job = jobs[id];
  if (job) {
    job.logs = job.logs || [];
    job.logs.push(line);
    if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  }
  const stream = logStreams[id];
  if (stream && !stream.writableEnded) stream.write(`data: ${JSON.stringify(line)}\n\n`);
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
  jobs[id] = { status: 'building', target, logs: [] };
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
    if (iconFile) {
      if (!iconFile.size || iconFile.size < 16) throw new Error('The uploaded launcher icon is empty or invalid. Re-select the image and try again.');
      fs.copyFileSync(iconFile.path, path.join(workDir, 'icon.png'));
    }
    const packagedIcon = path.join(workDir, 'icon.png');
    if (fs.existsSync(packagedIcon) && fs.statSync(packagedIcon).size >= 16) {
      config.icon = './icon.png';
      sendLog(id, `Launcher icon: custom PNG received (${fs.statSync(packagedIcon).size} bytes).`);
    } else {
      delete config.icon;
      sendLog(id, 'Launcher icon: no custom icon received; Nitron will use its default icon.');
    }
    if (!fs.existsSync(path.join(workDir, 'index.html'))) throw new Error('No index.html found. Add one HTML file or a project folder containing index.html.');
    // Android manifest declarations do not trigger runtime dialogs by themselves.
    // This native plugin requests the dangerous permissions declared for this app on first launch.
    const pluginDir = path.join(workDir, 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    const permissionPlugin = `package com.forge.permission;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import com.nicron.webview.NitronMethod;
import com.nicron.webview.NitronPlugin;
import com.nicron.webview.PluginCall;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class PermissionPlugin extends NitronPlugin {
    private PluginCall pendingCall;
    private static final int REQUEST_CODE = 73;

    private boolean isRuntimePermission(String p) {
        return p.equals("android.permission.CAMERA") || p.equals("android.permission.RECORD_AUDIO")
            || p.equals("android.permission.ACCESS_FINE_LOCATION") || p.equals("android.permission.ACCESS_COARSE_LOCATION")
            || p.equals("android.permission.READ_CONTACTS") || p.equals("android.permission.WRITE_CONTACTS")
            || p.equals("android.permission.GET_ACCOUNTS") || p.equals("android.permission.READ_CALENDAR")
            || p.equals("android.permission.WRITE_CALENDAR") || p.equals("android.permission.READ_PHONE_STATE")
            || p.equals("android.permission.CALL_PHONE") || p.equals("android.permission.ANSWER_PHONE_CALLS")
            || p.equals("android.permission.READ_PHONE_NUMBERS") || p.equals("android.permission.SEND_SMS")
            || p.equals("android.permission.RECEIVE_SMS") || p.equals("android.permission.READ_SMS")
            || p.equals("android.permission.RECEIVE_MMS") || p.equals("android.permission.ACTIVITY_RECOGNITION")
            || p.equals("android.permission.BODY_SENSORS") || p.equals("android.permission.POST_NOTIFICATIONS")
            || p.equals("android.permission.READ_MEDIA_IMAGES") || p.equals("android.permission.READ_MEDIA_VIDEO")
            || p.equals("android.permission.READ_MEDIA_AUDIO") || p.equals("android.permission.READ_MEDIA_VISUAL_USER_SELECTED")
            || p.equals("android.permission.BLUETOOTH_SCAN") || p.equals("android.permission.BLUETOOTH_CONNECT")
            || p.equals("android.permission.BLUETOOTH_ADVERTISE") || p.equals("android.permission.NEARBY_WIFI_DEVICES");
    }

    @NitronMethod
    public void requestStartupPermissions(PluginCall call) throws Exception {
        PackageManager pm = getContext().getPackageManager();
        PackageInfo info = pm.getPackageInfo(getContext().getPackageName(), PackageManager.GET_PERMISSIONS);
        List<String> missing = new ArrayList<>();
        if (info.requestedPermissions != null) {
            for (String p : info.requestedPermissions) {
                if (!isRuntimePermission(p) || hasPermission(p)) continue;
                if (p.equals("android.permission.POST_NOTIFICATIONS") && Build.VERSION.SDK_INT < 33) continue;
                if ((p.startsWith("android.permission.READ_MEDIA_") ) && Build.VERSION.SDK_INT < 33) continue;
                if (p.startsWith("android.permission.BLUETOOTH_") && Build.VERSION.SDK_INT < 31) continue;
                missing.add(p);
            }
        }
        if (missing.isEmpty()) {
            JSONObject result = new JSONObject(); result.put("requested", 0); result.put("allGranted", true);
            call.resolve(result); return;
        }
        if (pendingCall != null) { call.reject("A permission request is already in progress."); return; }
        pendingCall = call;
        String[] request = missing.toArray(new String[0]);
        runOnUiThread(() -> requestPermissions(request, REQUEST_CODE));
    }

    @Override
    protected void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQUEST_CODE || pendingCall == null) return;
        try {
            JSONObject result = new JSONObject(); JSONArray granted = new JSONArray(); JSONArray denied = new JSONArray();
            for (int i = 0; i < permissions.length; i++) {
                boolean ok = i < grantResults.length && grantResults[i] == PackageManager.PERMISSION_GRANTED;
                (ok ? granted : denied).put(permissions[i]);
            }
            result.put("granted", granted); result.put("denied", denied); result.put("allGranted", denied.length() == 0);
            pendingCall.resolve(result);
        } catch (Exception e) { pendingCall.reject(e.getMessage()); }
        finally { pendingCall = null; }
    }
}`;
    fs.writeFileSync(path.join(pluginDir, 'PermissionPlugin.java'), permissionPlugin);
    config.plugins = [...(config.plugins || []), './plugins/PermissionPlugin.java'];
    // Ask Android for the permissions this app actually declares, once the app page starts.
    const appEntry = path.join(workDir, 'index.html');
    let appHtml = fs.readFileSync(appEntry, 'utf8');
    const startupPermissionScript = `<script id="forge-android-permission-startup">(function(){
      function requestDeclaredPermissions(){
        var bridge = window.Nitron || window.NitronRuntime;
        var api = bridge && bridge.plugins && bridge.plugins.Permission;
        if (!api || typeof api.requestStartupPermissions !== 'function') return;
        api.requestStartupPermissions().then(function(result){
          window.dispatchEvent(new CustomEvent('forge:permissions-result',{detail:result}));
        }).catch(function(error){
          console.warn('[Forge] Android permission request failed:', error && error.message || error);
          window.dispatchEvent(new CustomEvent('forge:permissions-error',{detail:{message:error && error.message || String(error)}}));
        });
      }
      if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',requestDeclaredPermissions,{once:true});
      else requestDeclaredPermissions();
    })();</script>`;
    if (!appHtml.includes('forge-android-permission-startup')) {
      // The source app can contain the literal text `</body>` inside a JavaScript
      // template string (for example, a print-preview HTML template). Insert only
      // before the final document closing tag, not the first textual occurrence.
      const bodyCloseIndex = appHtml.toLowerCase().lastIndexOf('</body>');
      if (bodyCloseIndex >= 0) {
        appHtml = appHtml.slice(0, bodyCloseIndex) + startupPermissionScript + appHtml.slice(bodyCloseIndex);
      } else {
        appHtml += startupPermissionScript;
      }
      fs.writeFileSync(appEntry, appHtml);
    }
    fs.writeFileSync(path.join(workDir, 'nitron.config.json'), JSON.stringify(config, null, 2));
    const args = ['build'];
    if (target === 'aab') args.push('--target', 'aab');
    if (release) {
      fs.copyFileSync(uploadedKey.path, path.join(workDir, 'nitron-release.keystore'));
      args.push('--release');
    }
    sendLog(id, `Starting ${target.toUpperCase()} build…`);
    sendLog(id, `Permissions declared: ${config.permissions.length} (runtime prompts handled by native Permission plugin).`);
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
        const tail = (jobs[id].logs || []).slice(-35).join('\n');
        const reason = error?.message || `${extension.toUpperCase()} not found in dist/`;
        jobs[id] = { status: 'error', target, error: reason, diagnostic: tail, logs: jobs[id].logs || [] };
        sendLog(id, `BUILD_ERROR: ${reason}`);
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
  // Replay lines emitted before the browser finished opening EventSource.
  const job = jobs[id];
  if (!job) { res.write(`data: ${JSON.stringify('Unknown build job')}\n\n`); res.end(); return; }
  for (const line of (job.logs || [])) res.write(`data: ${JSON.stringify(line)}\n\n`);
  if (job.status === 'done') { res.write(`data: ${JSON.stringify('BUILD_COMPLETE')}\n\n`); res.end(); return; }
  if (job.status === 'error') { res.write(`data: ${JSON.stringify(`BUILD_ERROR: ${job.error || 'Build failed'}`)}\n\n`); res.end(); return; }
  logStreams[id] = res;
  req.on('close', () => { if (logStreams[id] === res) delete logStreams[id]; });
});
app.get('/api/jobs/:id', (req, res) => { const job = jobs[req.params.id]; if (!job) return res.status(404).json({ status: 'not_found' }); res.json({ ...job, logs: undefined }); });
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
