const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const execFileAsync = promisify(execFile);
const nanoid = require('nanoid').nanoid;
const multer = require('multer');
const AdmZip = require('adm-zip');

const app = express();
const uploadDir = path.join(os.tmpdir(), 'forge-studio-uploads');
const buildsRoot = path.join(__dirname, 'builds');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 100 * 1024 * 1024, files: 300 } });
const MAX_ZIP_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 3000;
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'HtmlABuilder.html')));

const jobs = Object.create(null);
const logStreams = Object.create(null);
const releaseAlias = 'release';
const allowedPermissions = new Set([
 'INTERNET','ACCESS_NETWORK_STATE','ACCESS_WIFI_STATE','CHANGE_WIFI_STATE','VIBRATE','WAKE_LOCK',
 'MODIFY_AUDIO_SETTINGS',
 'CAMERA','RECORD_AUDIO','READ_MEDIA_IMAGES','READ_MEDIA_VIDEO','READ_MEDIA_AUDIO','READ_MEDIA_VISUAL_USER_SELECTED','READ_EXTERNAL_STORAGE','WRITE_EXTERNAL_STORAGE','ACCESS_MEDIA_LOCATION',
 'ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION','ACCESS_BACKGROUND_LOCATION','POST_NOTIFICATIONS','SCHEDULE_EXACT_ALARM','RECEIVE_BOOT_COMPLETED',
 'READ_CONTACTS','WRITE_CONTACTS','GET_ACCOUNTS','READ_CALENDAR','WRITE_CALENDAR','READ_PHONE_STATE','CALL_PHONE','ANSWER_PHONE_CALLS','READ_PHONE_NUMBERS',
 'BLUETOOTH_SCAN','BLUETOOTH_CONNECT','BLUETOOTH_ADVERTISE','NEARBY_WIFI_DEVICES','NFC','ACTIVITY_RECOGNITION','BODY_SENSORS',
 'SEND_SMS','RECEIVE_SMS','READ_SMS','RECEIVE_MMS','SYSTEM_ALERT_WINDOW','REQUEST_IGNORE_BATTERY_OPTIMIZATIONS','REQUEST_INSTALL_PACKAGES','MANAGE_EXTERNAL_STORAGE',
 'WRITE_SETTINGS','ACCESS_NOTIFICATION_POLICY','PACKAGE_USAGE_STATS','USE_EXACT_ALARM','USE_FULL_SCREEN_INTENT',
 'FOREGROUND_SERVICE','FOREGROUND_SERVICE_MICROPHONE','FOREGROUND_SERVICE_CAMERA','FOREGROUND_SERVICE_LOCATION','FOREGROUND_SERVICE_DATA_SYNC',
 'FOREGROUND_SERVICE_CONNECTED_DEVICE','FOREGROUND_SERVICE_HEALTH','FOREGROUND_SERVICE_MEDIA_PLAYBACK','FOREGROUND_SERVICE_REMOTE_MESSAGING',
 'FOREGROUND_SERVICE_SPECIAL_USE','BODY_SENSORS_BACKGROUND','UWB_RANGING','READ_BASIC_PHONE_STATE','READ_CALL_LOG','WRITE_CALL_LOG',
 'PROCESS_OUTGOING_CALLS','MANAGE_OWN_CALLS','REQUEST_DELETE_PACKAGES','HIGH_SAMPLING_RATE_SENSORS','ACCESS_LOCATION_EXTRA_COMMANDS',
 'CHANGE_NETWORK_STATE','BLUETOOTH','BLUETOOTH_ADMIN'
]);
function redactSecrets(value) {
  return String(value)
    .replace(/(-{1,2}(?:storepass|keypass)(?::[a-z]+)?(?:\s+|=))(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
    .replace(/((?:NITRON|FORGE)_KEY_PASSWORD\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]');
}
function sendLog(id, msg) {
  const line = redactSecrets(msg);
  const job = jobs[id];
  if (job) {
    job.logs = job.logs || [];
    job.logs.push(line);
    if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  }
  const stream = logStreams[id];
  if (stream && !stream.writableEnded) stream.write(`data: ${JSON.stringify(line)}\n\n`);
}
function relayBuildOutput(id, state, chunk) {
  state.pending += chunk.toString();
  const lines = state.pending.split(/\r\n|\n|\r/);
  state.pending = lines.pop() || '';
  for (const line of lines) sendLog(id, line);
}
function flushBuildOutput(id, state) {
  if (state.pending) sendLog(id, state.pending);
  state.pending = '';
}
function safeRelativePath(name) {
  const normalized = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const clean = path.posix.normalize(normalized);
  if (!clean || clean === '.' || clean.startsWith('../') || clean.includes('/../')) throw new Error('Unsafe project file path');
  return clean;
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function cleanUploads(files) { (files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch (_) {} }); }
function parseHttpsUrl(value, label) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch (_) { throw new Error(`${label} must be a valid HTTPS URL.`); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
    throw new Error(`${label} must use HTTPS without embedded credentials or a custom port.`);
  }
  return parsed;
}
function isPublicIpv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}
async function resolvePublicIpv4(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  if (family === 4) {
    if (!isPublicIpv4(host)) throw new Error('ZIP URL host must resolve to a public IPv4 address.');
    return { address: host, family: 4 };
  }
  if (family === 6) throw new Error('ZIP URL host must resolve to a public IPv4 address.');
  let records;
  try { records = await dns.lookup(host, { all: true, verbatim: true }); } catch (_) { throw new Error('Could not resolve the ZIP URL host.'); }
  const result = records.find(record => record.family === 4 && isPublicIpv4(record.address));
  if (!result) throw new Error('ZIP URL host must resolve to a public IPv4 address.');
  return result;
}
async function downloadPublicZip(rawUrl, destination, redirects = 0) {
  if (redirects > 4) throw new Error('ZIP URL redirected too many times.');
  const url = parseHttpsUrl(rawUrl, 'ZIP URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const address = await resolvePublicIpv4(host);
  return new Promise((resolve, reject) => {
    const requestOptions = {
      headers: { Accept: 'application/zip, application/octet-stream;q=0.9, */*;q=0.1', 'User-Agent': 'Forge-Studio-Builder/1.0' },
      lookup: (_hostname, options, callback) => {
        if (options && options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      }
    };
    if (!net.isIP(host)) requestOptions.servername = host;
    const request = https.get(url, requestOptions, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location) return reject(new Error('ZIP URL redirect did not include a destination.'));
        let nextUrl;
        try { nextUrl = new URL(location, url).toString(); } catch (_) { return reject(new Error('ZIP URL returned an invalid redirect.')); }
        downloadPublicZip(nextUrl, destination, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`ZIP URL returned HTTP ${status}.`));
      }
      const contentLength = Number(response.headers['content-length'] || 0);
      if (contentLength > MAX_ZIP_DOWNLOAD_BYTES) {
        response.resume();
        return reject(new Error('ZIP download exceeds the 100 MB limit.'));
      }
      let downloadedBytes = 0;
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          downloadedBytes += chunk.length;
          if (downloadedBytes > MAX_ZIP_DOWNLOAD_BYTES) callback(new Error('ZIP download exceeds the 100 MB limit.'));
          else callback(null, chunk);
        }
      });
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      pipeline(response, limiter, output).then(() => {
        if (!downloadedBytes) {
          try { fs.unlinkSync(destination); } catch (_) {}
          return reject(new Error('ZIP download was empty.'));
        }
        resolve({ originalname: 'remote-project.zip', path: destination, size: downloadedBytes });
      }).catch(error => {
        try { fs.unlinkSync(destination); } catch (_) {}
        reject(error.message.includes('100 MB') ? error : new Error('Could not download the project ZIP.'));
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('ZIP download timed out.')));
    request.on('error', () => reject(new Error('Could not download the project ZIP. Check that the URL is reachable over HTTPS.')));
  });
}
function extractZipSafely(zipPath, destination) {
  let entries;
  try { entries = new AdmZip(zipPath).getEntries(); } catch (_) { throw new Error('The supplied URL or upload is not a valid ZIP archive.'); }
  if (!entries.length || entries.length > MAX_ZIP_ENTRIES) throw new Error(`ZIP archives must contain between 1 and ${MAX_ZIP_ENTRIES} entries.`);
  const root = path.resolve(destination);
  let expandedBytes = 0;
  const seen = new Set();
  const archive = new AdmZip(zipPath);
  for (const entry of archive.getEntries()) {
    const rawName = String(entry.entryName || '').replace(/\\/g, '/');
    const parts = rawName.split('/');
    if (!rawName || rawName.startsWith('/') || /^[a-zA-Z]:/.test(rawName) || rawName.includes('\0') || parts.includes('..')) {
      throw new Error('ZIP contains an unsafe file path.');
    }
    const normalized = path.posix.normalize(rawName);
    if (normalized === '.') continue;
    const target = path.resolve(root, ...normalized.split('/'));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('ZIP contains an unsafe file path.');
    if (seen.has(target)) throw new Error('ZIP contains duplicate file paths.');
    seen.add(target);
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    const declaredSize = Number(entry.header && entry.header.size) || 0;
    if (declaredSize > MAX_ZIP_UNPACKED_BYTES || expandedBytes + declaredSize > MAX_ZIP_UNPACKED_BYTES) {
      throw new Error('ZIP expands beyond the 256 MB unpacked size limit.');
    }
    const data = entry.getData();
    if (!data || data.length > MAX_ZIP_UNPACKED_BYTES || expandedBytes + data.length > MAX_ZIP_UNPACKED_BYTES) {
      throw new Error('ZIP expands beyond the 256 MB unpacked size limit.');
    }
    expandedBytes += data.length;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}
function promoteSingleZipRoot(directory) {
  if (fs.existsSync(path.join(directory, 'index.html'))) return;
  const topLevel = fs.readdirSync(directory, { withFileTypes: true });
  const projectRoots = topLevel.filter(entry => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, 'index.html')));
  if (projectRoots.length !== 1) return;
  const nestedRoot = path.join(directory, projectRoots[0].name);
  for (const name of fs.readdirSync(nestedRoot)) {
    const source = path.join(nestedRoot, name);
    const target = path.join(directory, name);
    if (fs.existsSync(target)) throw new Error('ZIP project root contains conflicting file paths.');
    fs.renameSync(source, target);
  }
  fs.rmdirSync(nestedRoot);
}
function buildConfig(req) {
  let requested = [];
  try { requested = JSON.parse(req.body.permissions || '[]'); } catch (_) { throw new Error('Invalid permissions list'); }
  if (!Array.isArray(requested)) throw new Error('Invalid permissions list');
  const unknownPermissions = requested.filter(p => typeof p !== 'string' || !allowedPermissions.has(p));
  if (unknownPermissions.length) throw new Error(`Unsupported permission selection: ${unknownPermissions.join(', ')}. Refresh Forge Studio and select a supported permission.`);
  if (requested.includes('SCHEDULE_EXACT_ALARM') && requested.includes('USE_EXACT_ALARM')) throw new Error('Choose either Exact alarms or Use exact alarms, not both.');
  const permissionSet = new Set(['INTERNET', ...requested]);
  const permissionNotes = [];
  const autoAddedPermissions = new Set();
  const addDependency = (permission, reason) => {
    if (!permissionSet.has(permission)) {
      permissionSet.add(permission);
      autoAddedPermissions.add(permission);
      permissionNotes.push(`${permission} added automatically: ${reason}`);
    }
  };
  // MODIFY_AUDIO_SETTINGS is required for WebView getUserMedia() to access the microphone.
  // Without it, Android returns NotReadableError even when RECORD_AUDIO is granted.
  if (permissionSet.has('RECORD_AUDIO')) {
    addDependency('MODIFY_AUDIO_SETTINGS', 'required for WebView microphone capture');
  }
  if (permissionSet.has('ACCESS_BACKGROUND_LOCATION') && !permissionSet.has('ACCESS_COARSE_LOCATION') && !permissionSet.has('ACCESS_FINE_LOCATION')) {
    addDependency('ACCESS_COARSE_LOCATION', 'background location requires foreground location access first');
  }
  if (permissionSet.has('READ_MEDIA_VISUAL_USER_SELECTED') && !permissionSet.has('READ_MEDIA_IMAGES') && !permissionSet.has('READ_MEDIA_VIDEO')) {
    addDependency('READ_MEDIA_IMAGES', 'selected-photo access must accompany image access');
  }
  if (permissionSet.has('BODY_SENSORS_BACKGROUND')) addDependency('BODY_SENSORS', 'background sensor access requires foreground body-sensor permission');
  if (['READ_MEDIA_IMAGES','READ_MEDIA_VIDEO','READ_MEDIA_AUDIO'].some(p => permissionSet.has(p))) {
    addDependency('READ_EXTERNAL_STORAGE', 'legacy media access is used on Android 12L and earlier');
  }
  if (['BLUETOOTH_SCAN','BLUETOOTH_CONNECT','BLUETOOTH_ADVERTISE'].some(p => permissionSet.has(p))) {
    addDependency('BLUETOOTH', 'backwards compatibility for Android 11 and earlier');
    addDependency('BLUETOOTH_ADMIN', 'backwards compatibility for Android 11 and earlier');
  }
  if (permissionSet.has('BLUETOOTH_SCAN')) addDependency('ACCESS_FINE_LOCATION', 'Bluetooth scanning requires location permission on Android 11 and earlier');
  if (permissionSet.has('NEARBY_WIFI_DEVICES')) addDependency('ACCESS_FINE_LOCATION', 'nearby Wi-Fi discovery on Android 12L and earlier uses location permission');
  const permissions = [...permissionSet];
  const version = String(req.body.version || '1.0.0');
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Version must use semantic format such as 1.0.0');
  const orientation = ['portrait','landscape','auto'].includes(req.body.orientation) ? req.body.orientation : 'portrait';
  return { name: String(req.body.appName || 'My App').slice(0, 48), packageId: String(req.body.packageName || 'com.forgeapps.myapp'), version, entry: 'index.html', icon: './icon.png', statusBar: req.body.statusBar !== 'false', orientation, permissions, _permissionNotes: permissionNotes, _autoAddedPermissions: [...autoAddedPermissions], network: { cleartext: false }, webview: { backButton: 'history' } };
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
  const sourceMode = String(req.body.sourceMode || 'files');
  if (!['files','live_url','zip_url'].includes(sourceMode)) { cleanUploads(req.files); return res.status(400).json({ message: 'Choose uploaded files, a live website URL, or a project ZIP URL.' }); }
  let sourceUrl = null;
  try {
    if (sourceMode === 'live_url') sourceUrl = parseHttpsUrl(req.body.liveUrl, 'Website URL');
    if (sourceMode === 'zip_url') sourceUrl = parseHttpsUrl(req.body.zipUrl, 'Project ZIP URL');
  } catch (error) {
    cleanUploads(req.files);
    return res.status(400).json({ message: error.message });
  }
  const target = req.body.target === 'aab' ? 'aab' : 'apk';
  const release = req.body.release === 'true' || target === 'aab';
  const password = String(req.body.keystorePassword || '');
  const incomingFiles = req.files || [];
  const uploadedKey = incomingFiles.find(f => f.originalname === 'nitron-release.keystore');
  if (release && (!uploadedKey || password.length < 8)) { cleanUploads(incomingFiles); return res.status(400).json({ message: 'Select your release keystore and enter its password before making a signed release build.' }); }
  if (release) {
    const env = { ...process.env, FORGE_KEY_PASSWORD: password };
    try {
      await execFileAsync('keytool', ['-list','-keystore',uploadedKey.path,'-alias',releaseAlias,'-storepass:env','FORGE_KEY_PASSWORD'], { timeout: 15000, windowsHide: true, env });
    } catch (_) {
      cleanUploads(incomingFiles);
      return res.status(400).json({ message: `The keystore password is incorrect or the key entry alias must be "${releaseAlias}". Generate a new release key or use the existing key pair with this alias.` });
    }
  }
  jobs[id] = { status: 'building', target, logs: [] };
  res.json({ id });

  const workDir = path.join(buildsRoot, id);
  let uploadedFiles = incomingFiles;
  try {
    fs.mkdirSync(workDir, { recursive: true });
    if (sourceMode === 'zip_url') {
      const downloadedZip = await downloadPublicZip(sourceUrl.href, path.join(uploadDir, `project-${id}.zip`));
      uploadedFiles = [...incomingFiles, downloadedZip];
      sendLog(id, `Project ZIP downloaded (${formatBytes(downloadedZip.size)}).`);
    }
    if (sourceMode === 'live_url') {
      const allowedHost = sourceUrl.hostname.replace(/^\[|\]$/g, '');
      config.webview = { ...config.webview, externalLinks: 'browser', allowedHosts: [allowedHost] };
      const redirectUrl = JSON.stringify(sourceUrl.href).replace(/</g, '\\u003c');
      const escapedHref = sourceUrl.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const escapedTitle = config.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const wrapper = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedTitle}</title></head><body><p>Opening website…</p><p><a href="${escapedHref}">Continue to website</a></p><script>window.location.replace(${redirectUrl});</script></body></html>`;
      fs.writeFileSync(path.join(workDir, 'index.html'), wrapper);
      sendLog(id, 'Live website mode: the app opens the selected HTTPS website and requires an internet connection.');
    } else {
      const zipFile = uploadedFiles.find(f => f.originalname.toLowerCase().endsWith('.zip'));
      if (zipFile) {
        extractZipSafely(zipFile.path, workDir);
        promoteSingleZipRoot(workDir);
      }
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
    if (!fs.existsSync(path.join(workDir, 'index.html'))) throw new Error('No index.html found. Ensure the project files or ZIP contain index.html at the project root.');
    const pluginDir = path.join(workDir, 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    const permissionPlugin = `package com.forge.permission;

import android.app.AlarmManager;
import android.app.AppOpsManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.PermissionInfo;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.os.Process;
import android.provider.Settings;
import com.nicron.webview.NitronMethod;
import com.nicron.webview.NitronPlugin;
import com.nicron.webview.PluginCall;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class PermissionPlugin extends NitronPlugin {
    private final java.util.Map<Integer, PluginCall> pendingCalls = new java.util.HashMap<>();
    private final java.util.Map<Integer, JSONArray> accumulatedGranted = new java.util.HashMap<>();
    private final java.util.Map<Integer, JSONArray> accumulatedDenied = new java.util.HashMap<>();
    private static final int STARTUP_REQUEST_CODE = 73;
    private static final int MICROPHONE_REQUEST_CODE = 74;
    private static final int BACKGROUND_LOCATION_REQUEST_CODE = 75;
    private static final int SINGLE_REQUEST_CODE = 76;

    private String packageName() { return getContext().getPackageName(); }

    @NitronMethod
    public void getSystemTheme(PluginCall call) throws Exception {
        int mode = getContext().getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        boolean dark = mode == Configuration.UI_MODE_NIGHT_YES;
        JSONObject result = new JSONObject();
        result.put("theme", dark ? "dark" : "light");
        result.put("isDark", dark);
        result.put("uiMode", mode);
        result.put("source", "android-configuration");
        call.resolve(result);
    }
    private boolean isAutoAdded(String permission) { return __AUTO_ADDED_PERMISSION_LIST__.contains(permission); }
    private boolean declared(String permission) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(packageName(), PackageManager.GET_PERMISSIONS);
            if (info.requestedPermissions == null) return false;
            for (String item : info.requestedPermissions) if (permission.equals(item)) return true;
        } catch (Exception ignored) {}
        return false;
    }

    private boolean isRuntimePermission(String p) {
        if (Build.VERSION.SDK_INT < 23) return false;
        try {
            PermissionInfo info = getContext().getPackageManager().getPermissionInfo(p, 0);
            if ((info.protectionLevel & PermissionInfo.PROTECTION_DANGEROUS) != 0) return true;
        } catch (Exception ignored) {}
        return isKnownRuntimePermission(p);
    }

    private boolean isKnownRuntimePermission(String p) {
        return p.equals("android.permission.CAMERA") || p.equals("android.permission.RECORD_AUDIO")
            || p.equals("android.permission.ACCESS_FINE_LOCATION") || p.equals("android.permission.ACCESS_COARSE_LOCATION")
            || p.equals("android.permission.ACCESS_BACKGROUND_LOCATION")
            || p.equals("android.permission.READ_CONTACTS") || p.equals("android.permission.WRITE_CONTACTS")
            || p.equals("android.permission.GET_ACCOUNTS") || p.equals("android.permission.READ_CALENDAR")
            || p.equals("android.permission.WRITE_CALENDAR") || p.equals("android.permission.READ_PHONE_STATE")
            || p.equals("android.permission.CALL_PHONE") || p.equals("android.permission.ANSWER_PHONE_CALLS")
            || p.equals("android.permission.READ_PHONE_NUMBERS") || p.equals("android.permission.SEND_SMS")
            || p.equals("android.permission.RECEIVE_SMS") || p.equals("android.permission.READ_SMS")
            || p.equals("android.permission.RECEIVE_MMS") || p.equals("android.permission.ACTIVITY_RECOGNITION")
            || p.equals("android.permission.BODY_SENSORS") || p.equals("android.permission.BODY_SENSORS_BACKGROUND")
            || p.equals("android.permission.POST_NOTIFICATIONS") || p.equals("android.permission.READ_MEDIA_IMAGES")
            || p.equals("android.permission.READ_MEDIA_VIDEO") || p.equals("android.permission.READ_MEDIA_AUDIO")
            || p.equals("android.permission.READ_MEDIA_VISUAL_USER_SELECTED") || p.equals("android.permission.READ_EXTERNAL_STORAGE")
            || p.equals("android.permission.WRITE_EXTERNAL_STORAGE") || p.equals("android.permission.ACCESS_MEDIA_LOCATION")
            || p.equals("android.permission.BLUETOOTH_SCAN") || p.equals("android.permission.BLUETOOTH_CONNECT")
            || p.equals("android.permission.BLUETOOTH_ADVERTISE") || p.equals("android.permission.NEARBY_WIFI_DEVICES")
            || p.equals("android.permission.UWB_RANGING") || p.equals("android.permission.READ_CALL_LOG")
            || p.equals("android.permission.WRITE_CALL_LOG") || p.equals("android.permission.PROCESS_OUTGOING_CALLS");
    }

    private boolean applicable(String p) {
        int sdk = Build.VERSION.SDK_INT;
        if (p.equals("android.permission.ACCESS_FINE_LOCATION") && isAutoAdded(p)) {
            boolean bluetoothNeedsLocation = declared("android.permission.BLUETOOTH_SCAN") && sdk < 31;
            boolean wifiNeedsLocation = declared("android.permission.NEARBY_WIFI_DEVICES") && sdk < 33;
            if (!bluetoothNeedsLocation && !wifiNeedsLocation) return false;
        }
        if (p.endsWith("POST_NOTIFICATIONS")) return sdk >= 33;
        if (p.endsWith("READ_MEDIA_IMAGES") || p.endsWith("READ_MEDIA_VIDEO") || p.endsWith("READ_MEDIA_AUDIO")) return sdk >= 33;
        if (p.endsWith("READ_MEDIA_VISUAL_USER_SELECTED")) return sdk >= 34;
        if (p.endsWith("BLUETOOTH_SCAN") || p.endsWith("BLUETOOTH_CONNECT") || p.endsWith("BLUETOOTH_ADVERTISE")) return sdk >= 31;
        if (p.endsWith("NEARBY_WIFI_DEVICES")) return sdk >= 33;
        if (p.endsWith("ACTIVITY_RECOGNITION")) return sdk >= 29;
        if (p.endsWith("ACCESS_BACKGROUND_LOCATION")) return sdk >= 29;
        if (p.endsWith("ACCESS_MEDIA_LOCATION")) return sdk >= 29;
        if (p.endsWith("READ_PHONE_NUMBERS") || p.endsWith("ANSWER_PHONE_CALLS")) return sdk >= 26;
        if (p.endsWith("READ_EXTERNAL_STORAGE")) return sdk <= 32;
        if (p.endsWith("WRITE_EXTERNAL_STORAGE")) return sdk <= 28;
        if (p.endsWith("BODY_SENSORS_BACKGROUND")) return sdk >= 33;
        if (p.endsWith("UWB_RANGING")) return sdk >= 31;
        return true;
    }

    private boolean isSpecial(String p) {
        return p.equals("android.permission.SYSTEM_ALERT_WINDOW")
            || p.equals("android.permission.MANAGE_EXTERNAL_STORAGE")
            || p.equals("android.permission.SCHEDULE_EXACT_ALARM")
            || p.equals("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS")
            || p.equals("android.permission.REQUEST_INSTALL_PACKAGES")
            || p.equals("android.permission.WRITE_SETTINGS")
            || p.equals("android.permission.ACCESS_NOTIFICATION_POLICY")
            || p.equals("android.permission.USE_FULL_SCREEN_INTENT")
            || p.equals("android.permission.PACKAGE_USAGE_STATS")
            || p.equals("android.permission.ACCESS_BACKGROUND_LOCATION") && Build.VERSION.SDK_INT >= 30;
    }

    private boolean isRestricted(String p) {
        return p.equals("android.permission.READ_SMS") || p.equals("android.permission.SEND_SMS")
            || p.equals("android.permission.RECEIVE_SMS") || p.equals("android.permission.RECEIVE_MMS")
            || p.equals("android.permission.READ_CALL_LOG") || p.equals("android.permission.WRITE_CALL_LOG")
            || p.equals("android.permission.PROCESS_OUTGOING_CALLS") || p.equals("android.permission.BODY_SENSORS_BACKGROUND")
            || p.equals("android.permission.USE_EXACT_ALARM");
    }

    private boolean specialGranted(String p) {
        Context c = getContext();
        if (p.equals("android.permission.SYSTEM_ALERT_WINDOW")) return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(c);
        if (p.equals("android.permission.MANAGE_EXTERNAL_STORAGE")) return Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager();
        if (p.equals("android.permission.SCHEDULE_EXACT_ALARM")) {
            if (Build.VERSION.SDK_INT < 31) return true;
            AlarmManager am = (AlarmManager)c.getSystemService(Context.ALARM_SERVICE);
            return am != null && am.canScheduleExactAlarms();
        }
        if (p.equals("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS")) {
            if (Build.VERSION.SDK_INT < 23) return true;
            PowerManager pm = (PowerManager)c.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(packageName());
        }
        if (p.equals("android.permission.REQUEST_INSTALL_PACKAGES")) return Build.VERSION.SDK_INT < 26 || c.getPackageManager().canRequestPackageInstalls();
        if (p.equals("android.permission.WRITE_SETTINGS")) return Build.VERSION.SDK_INT < 23 || Settings.System.canWrite(c);
        if (p.equals("android.permission.ACCESS_NOTIFICATION_POLICY")) {
            if (Build.VERSION.SDK_INT < 23) return true;
            NotificationManager nm = (NotificationManager)c.getSystemService(Context.NOTIFICATION_SERVICE);
            return nm != null && nm.isNotificationPolicyAccessGranted();
        }
        if (p.equals("android.permission.USE_FULL_SCREEN_INTENT")) {
            if (Build.VERSION.SDK_INT < 34) return true;
            NotificationManager nm = (NotificationManager)c.getSystemService(Context.NOTIFICATION_SERVICE);
            return nm != null && nm.canUseFullScreenIntent();
        }
        if (p.equals("android.permission.PACKAGE_USAGE_STATS")) {
            AppOpsManager ops = (AppOpsManager)c.getSystemService(Context.APP_OPS_SERVICE);
            if (ops == null) return false;
            try { return ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), packageName()) == AppOpsManager.MODE_ALLOWED; }
            catch (Exception ignored) { return false; }
        }
        if (p.equals("android.permission.ACCESS_BACKGROUND_LOCATION") && Build.VERSION.SDK_INT >= 30) return hasPermission(p);
        return hasPermission(p);
    }

    private String settingsAction(String p) {
        if (p.equals("android.permission.SYSTEM_ALERT_WINDOW")) return Settings.ACTION_MANAGE_OVERLAY_PERMISSION;
        if (p.equals("android.permission.MANAGE_EXTERNAL_STORAGE") && Build.VERSION.SDK_INT >= 30) return Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION;
        if (p.equals("android.permission.SCHEDULE_EXACT_ALARM") && Build.VERSION.SDK_INT >= 31) return Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM;
        if (p.equals("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS") && Build.VERSION.SDK_INT >= 23) return Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS;
        if (p.equals("android.permission.REQUEST_INSTALL_PACKAGES") && Build.VERSION.SDK_INT >= 26) return Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES;
        if (p.equals("android.permission.WRITE_SETTINGS") && Build.VERSION.SDK_INT >= 23) return Settings.ACTION_MANAGE_WRITE_SETTINGS;
        if (p.equals("android.permission.ACCESS_NOTIFICATION_POLICY") && Build.VERSION.SDK_INT >= 23) return Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS;
        if (p.equals("android.permission.USE_FULL_SCREEN_INTENT") && Build.VERSION.SDK_INT >= 34) return Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT;
        if (p.equals("android.permission.PACKAGE_USAGE_STATS")) return Settings.ACTION_USAGE_ACCESS_SETTINGS;
        return Settings.ACTION_APPLICATION_DETAILS_SETTINGS;
    }

    private String statusOf(String p) {
        if (!declared(p)) return "not_declared";
        if (!applicable(p)) return "not_applicable";
        if (isSpecial(p)) return specialGranted(p) ? "granted" : "requires_settings";
        if (hasPermission(p)) return "granted";
        if (isRestricted(p)) return "restricted";
        return "denied";
    }

    private List<String> declaredPermissions() throws Exception {
        List<String> result = new ArrayList<>();
        PackageInfo info = getContext().getPackageManager().getPackageInfo(packageName(), PackageManager.GET_PERMISSIONS);
        if (info.requestedPermissions != null) for (String p : info.requestedPermissions) result.add(p);
        return result;
    }

    private void resolveEmpty(PluginCall call, boolean granted) throws Exception {
        JSONObject result = new JSONObject(); result.put("granted", granted); result.put("allGranted", granted);
        result.put("grantedPermissions", new JSONArray()); result.put("deniedPermissions", new JSONArray());
        result.put("requiresSettings", new JSONArray()); call.resolve(result);
    }

    private void beginRequest(PluginCall call, String[] permissions, int requestCode) throws Exception {
        if (permissions.length == 0) { resolveEmpty(call, true); return; }
        synchronized (pendingCalls) {
            if (!pendingCalls.isEmpty()) { call.reject("Another Android permission request is already in progress. Try again in a moment."); return; }
            pendingCalls.put(requestCode, call);
            accumulatedGranted.put(requestCode, new JSONArray());
            accumulatedDenied.put(requestCode, new JSONArray());
        }
        runOnUiThread(() -> requestPermissions(permissions, requestCode));
    }

    private boolean foregroundLocationGranted() {
        return hasPermission("android.permission.ACCESS_FINE_LOCATION") || hasPermission("android.permission.ACCESS_COARSE_LOCATION");
    }

    @NitronMethod
    public void requestStartupPermissions(PluginCall call) throws Exception {
        List<String> missing = new ArrayList<>();
        for (String p : declaredPermissions()) {
            if (!isRuntimePermission(p) || !applicable(p) || isSpecial(p) || isRestricted(p) || p.equals("android.permission.ACCESS_BACKGROUND_LOCATION")) continue;
            if (!hasPermission(p)) missing.add(p);
        }
        if (!declared("android.permission.READ_MEDIA_IMAGES") && !declared("android.permission.READ_MEDIA_VIDEO")) missing.remove("android.permission.READ_MEDIA_VISUAL_USER_SELECTED");
        if (missing.isEmpty() && Build.VERSION.SDK_INT == 29 && declared("android.permission.ACCESS_BACKGROUND_LOCATION")
            && foregroundLocationGranted() && !hasPermission("android.permission.ACCESS_BACKGROUND_LOCATION")) {
            beginRequest(call, new String[]{"android.permission.ACCESS_BACKGROUND_LOCATION"}, BACKGROUND_LOCATION_REQUEST_CODE);
        } else {
            beginRequest(call, missing.toArray(new String[0]), STARTUP_REQUEST_CODE);
        }
    }

    @NitronMethod
    public void requestMicrophonePermission(PluginCall call) throws Exception {
        String p = "android.permission.RECORD_AUDIO";
        if (!declared(p)) { call.reject("Microphone permission was not selected in Forge Studio. Add RECORD_AUDIO and rebuild the APK."); return; }
        if (hasPermission(p)) { JSONObject r = new JSONObject(); r.put("granted", true); r.put("allGranted", true); r.put("permission", p); call.resolve(r); return; }
        beginRequest(call, new String[]{p}, MICROPHONE_REQUEST_CODE);
    }

    @NitronMethod
    public void requestRuntimePermission(PluginCall call) throws Exception {
        String shortName = call.getString("permission", "");
        String p = shortName.startsWith("android.permission.") ? shortName : "android.permission." + shortName;
        if (!declared(p)) { call.reject("This permission is not selected in the Forge Studio build: " + shortName); return; }
        if (isRestricted(p)) { call.reject("Android or app-distribution policy restricts this permission. The app installer or store eligibility may control whether it can be granted."); return; }
        if (!isRuntimePermission(p) || isSpecial(p)) { call.reject("This permission does not use the standard Android runtime dialog. Check its special-access status and use openPermissionSettings()."); return; }
        if (!applicable(p)) { JSONObject r = new JSONObject(); r.put("granted", false); r.put("status", "not_applicable"); r.put("permission", p); call.resolve(r); return; }
        if (p.equals("android.permission.ACCESS_BACKGROUND_LOCATION") && Build.VERSION.SDK_INT >= 30) { call.reject("Android requires background location to be enabled separately in App info settings after foreground location is granted."); return; }
        if (p.equals("android.permission.ACCESS_BACKGROUND_LOCATION") && !foregroundLocationGranted()) { call.reject("Grant approximate or precise location first, then request background location."); return; }
        if (hasPermission(p)) { JSONObject r = new JSONObject(); r.put("granted", true); r.put("status", "granted"); r.put("permission", p); call.resolve(r); return; }
        beginRequest(call, new String[]{p}, SINGLE_REQUEST_CODE);
    }

    @NitronMethod
    public void getPermissionStatuses(PluginCall call) throws Exception {
        JSONObject statuses = new JSONObject(); JSONArray needsSettings = new JSONArray(); JSONArray denied = new JSONArray(); JSONArray restricted = new JSONArray();
        for (String p : declaredPermissions()) {
            if (!p.startsWith("android.permission.")) continue;
            String shortName = p.substring("android.permission.".length());
            String status = statusOf(p); statuses.put(shortName, status);
            if ("requires_settings".equals(status)) needsSettings.put(shortName);
            if ("denied".equals(status)) denied.put(shortName);
            if ("restricted".equals(status)) restricted.put(shortName);
        }
        JSONObject result = new JSONObject(); result.put("statuses", statuses); result.put("requiresSettings", needsSettings);
        result.put("denied", denied); result.put("restricted", restricted); result.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(result);
    }

    @NitronMethod
    public void openPermissionSettings(PluginCall call) throws Exception {
        String shortName = call.getString("permission", "");
        String p = shortName.startsWith("android.permission.") ? shortName : "android.permission." + shortName;
        if (!declared(p)) { call.reject("This permission was not selected in the Forge Studio build."); return; }
        if (!isSpecial(p)) { call.reject("This permission does not require a special Settings screen."); return; }
        String action = settingsAction(p);
        Intent intent = new Intent(action);
        if (!p.equals("android.permission.ACCESS_NOTIFICATION_POLICY") && !p.equals("android.permission.PACKAGE_USAGE_STATS")) {
            intent.setData(Uri.parse("package:" + packageName()));
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { getContext().startActivity(intent); }
        catch (Exception first) {
            Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + packageName()));
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(fallback);
        }
        JSONObject result = new JSONObject(); result.put("opened", true); result.put("permission", shortName); result.put("action", action); call.resolve(result);
    }

    @NitronMethod
    public void openAppSettings(PluginCall call) throws Exception {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + packageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        JSONObject result = new JSONObject(); result.put("opened", true); call.resolve(result);
    }

    @Override
    protected void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != STARTUP_REQUEST_CODE && requestCode != MICROPHONE_REQUEST_CODE && requestCode != BACKGROUND_LOCATION_REQUEST_CODE && requestCode != SINGLE_REQUEST_CODE) return;
        PluginCall call;
        synchronized (pendingCalls) { call = pendingCalls.get(requestCode); }
        if (call == null) return;
        try {
            JSONArray granted = accumulatedGranted.get(requestCode); JSONArray denied = accumulatedDenied.get(requestCode);
            if (granted == null) granted = new JSONArray(); if (denied == null) denied = new JSONArray();
            for (int i = 0; i < permissions.length; i++) {
                boolean ok = i < grantResults.length && grantResults[i] == PackageManager.PERMISSION_GRANTED;
                if (ok) granted.put(permissions[i]); else denied.put(permissions[i]);
            }
            if (requestCode == STARTUP_REQUEST_CODE && Build.VERSION.SDK_INT == 29
                && declared("android.permission.ACCESS_BACKGROUND_LOCATION") && foregroundLocationGranted()
                && !hasPermission("android.permission.ACCESS_BACKGROUND_LOCATION")) {
                synchronized (pendingCalls) {
                    pendingCalls.remove(STARTUP_REQUEST_CODE); pendingCalls.put(BACKGROUND_LOCATION_REQUEST_CODE, call);
                    accumulatedGranted.remove(STARTUP_REQUEST_CODE); accumulatedDenied.remove(STARTUP_REQUEST_CODE);
                    accumulatedGranted.put(BACKGROUND_LOCATION_REQUEST_CODE, granted); accumulatedDenied.put(BACKGROUND_LOCATION_REQUEST_CODE, denied);
                }
                runOnUiThread(() -> requestPermissions(new String[]{"android.permission.ACCESS_BACKGROUND_LOCATION"}, BACKGROUND_LOCATION_REQUEST_CODE));
                return;
            }
            JSONArray needsSettings = new JSONArray();
            if (declared("android.permission.ACCESS_BACKGROUND_LOCATION") && Build.VERSION.SDK_INT >= 30 && foregroundLocationGranted() && !hasPermission("android.permission.ACCESS_BACKGROUND_LOCATION")) needsSettings.put("ACCESS_BACKGROUND_LOCATION");
            JSONObject result = new JSONObject(); result.put("grantedPermissions", granted); result.put("deniedPermissions", denied);
            result.put("allGranted", denied.length() == 0 && needsSettings.length() == 0); result.put("requiresSettings", needsSettings);
            if (requestCode == MICROPHONE_REQUEST_CODE) { result.put("granted", hasPermission("android.permission.RECORD_AUDIO")); result.put("permission", "android.permission.RECORD_AUDIO"); }
            if (requestCode == SINGLE_REQUEST_CODE) { result.put("granted", permissions.length > 0 && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED); result.put("permission", permissions.length > 0 ? permissions[0] : ""); }
            synchronized (pendingCalls) { pendingCalls.remove(requestCode); accumulatedGranted.remove(requestCode); accumulatedDenied.remove(requestCode); }
            call.resolve(result);
        } catch (Exception e) {
            synchronized (pendingCalls) { pendingCalls.remove(requestCode); accumulatedGranted.remove(requestCode); accumulatedDenied.remove(requestCode); }
            call.reject(e.getMessage());
        }
    }
}`;
    const autoAddedPermissions = config._autoAddedPermissions || [];
    const autoAddedJava = `java.util.Arrays.asList(${autoAddedPermissions.map(p => JSON.stringify('android.permission.' + p)).join(',')})`;
    fs.writeFileSync(path.join(pluginDir, 'PermissionPlugin.java'), permissionPlugin.replace('__AUTO_ADDED_PERMISSION_LIST__', autoAddedJava));
    config.plugins = [...(config.plugins || []), './plugins/PermissionPlugin.java'];
    config.onPluginError = 'error';
    sendLog(id, 'Native plugin source registered: ./plugins/PermissionPlugin.java (onPluginError=error).');
    sendLog(id, `Plugin config: ${JSON.stringify(config.plugins)}`);
    const appEntry = path.join(workDir, 'index.html');
    let appHtml = fs.readFileSync(appEntry, 'utf8');
    const mediaThemeExpression = "value==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):value";
    const nativeThemeExpression = "value==='system'?((window.ForgeAndroidTheme&&window.ForgeAndroidTheme.current)|| (matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')):value";
    if (appHtml.includes(mediaThemeExpression)) appHtml = appHtml.replace(mediaThemeExpression, nativeThemeExpression);
    const startupPermissionScript = `<script id="forge-android-webview-mic-shim">(function(){
      // Some Nitron templates omit WebChromeClient.onPermissionRequest handling.
      // This shim ensures a getUserMedia({audio:true}) call triggers the native
      // RECORD_AUDIO prompt when the plugin bridge is present, matching HTML2APK.
      function bridge(){return (window.Nitron&&window.Nitron.plugins)?window.Nitron:((window.NitronRuntime&&window.NitronRuntime.plugins)?window.NitronRuntime:window.Nitron);}
      function permApi(){var b=bridge();return b&&b.plugins&&b.plugins.Permission;}
      var origGUM=null;
      if(navigator.mediaDevices&&typeof navigator.mediaDevices.getUserMedia==='function'){
        origGUM=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia=function(constraints){
          var wantsAudio=!!(constraints&&constraints.audio);
          if(!wantsAudio)return origGUM(constraints);
          var p=permApi();
          if(!p||typeof p.requestMicrophonePermission!=='function'){
            // No plugin bridge — let getUserMedia try anyway. If the template
            // already handles onPermissionRequest, this succeeds silently.
            return origGUM(constraints);
          }
          return p.requestMicrophonePermission().then(function(result){
            if(result&&result.granted===false){
              var err=new Error('Microphone permission was denied.');err.name='NotAllowedError';throw err;
            }
            return origGUM(constraints);
          },function(err){
            // Native bridge errored; fall back so getUserMedia gets a chance.
            console.warn('[Forge] native mic request failed, falling back:',err);
            return origGUM(constraints);
          });
        };
      }
    })();</script><script id="forge-android-permission-startup">(function(){
      var permissionNames={SYSTEM_ALERT_WINDOW:'Display over other apps',MANAGE_EXTERNAL_STORAGE:'Manage all files',SCHEDULE_EXACT_ALARM:'Exact alarms',USE_EXACT_ALARM:'Exact alarms',REQUEST_IGNORE_BATTERY_OPTIMIZATIONS:'Battery optimization exemption',REQUEST_INSTALL_PACKAGES:'Install unknown apps',WRITE_SETTINGS:'Modify system settings',ACCESS_NOTIFICATION_POLICY:'Do Not Disturb access',PACKAGE_USAGE_STATS:'Usage access',ACCESS_BACKGROUND_LOCATION:'Background location'};
      function bridge(){return (window.Nitron&&window.Nitron.plugins)?window.Nitron:((window.NitronRuntime&&window.NitronRuntime.plugins)?window.NitronRuntime:window.Nitron);}
      function api(){var b=bridge();return b&&b.plugins&&b.plugins.Permission;}
      function dispatch(name,detail){try{window.dispatchEvent(new CustomEvent(name,{detail:detail}));}catch(e){}}
      function showSettingsHelp(items,denied,restricted){
        items=items||[];denied=denied||[];restricted=restricted||[];
        var oldPanel=document.getElementById('forge-permission-help');if(oldPanel)oldPanel.remove();
        if(!items.length&&!denied.length&&!restricted.length)return;
        var panel=document.createElement('div');panel.id='forge-permission-help';
        panel.style.cssText='position:fixed;z-index:2147483647;inset:auto 14px 14px 14px;max-width:560px;margin:0 auto;padding:18px;border-radius:18px;background:#171923;color:#fff;box-shadow:0 12px 48px #0008;font:14px/1.45 system-ui,sans-serif;max-height:70vh;overflow:auto';
        var heading=document.createElement('div');heading.textContent='Permission setup';heading.style.cssText='font-weight:700;font-size:17px;margin-bottom:6px';panel.appendChild(heading);
        var intro=document.createElement('p');intro.textContent='Some access is controlled separately by Android. Review only the permissions your app genuinely needs.';intro.style.cssText='margin:0 0 12px;color:#c7cad5';panel.appendChild(intro);
        function addRow(item,kind){var row=document.createElement('div');row.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid #ffffff22';var label=document.createElement('span');label.textContent=(permissionNames[item]||item.replace(/_/g,' ').toLowerCase())+(kind==='restricted'?' · restricted by Android/policy':'');row.appendChild(label);if(kind==='settings'||kind==='denied'){var btn=document.createElement('button');btn.type='button';btn.textContent=kind==='settings'?'Open settings':'App settings';btn.style.cssText='border:0;border-radius:10px;padding:9px 12px;background:#d8c5ff;color:#211936;font-weight:650';btn.addEventListener('click',function(){var p=api();if(!p)return;var task=kind==='settings'&&p.openPermissionSettings?p.openPermissionSettings({permission:item}):(p.openAppSettings?p.openAppSettings():Promise.reject(new Error('App settings action unavailable')));task.then(function(){dispatch('forge:permission-settings-opened',{permission:item});}).catch(function(e){dispatch('forge:permissions-error',{message:e.message});});});row.appendChild(btn);}panel.appendChild(row);}
        items.forEach(function(item){addRow(item,'settings');});denied.forEach(function(item){addRow(item,'denied');});restricted.forEach(function(item){addRow(item,'restricted');});
        var close=document.createElement('button');close.type='button';close.textContent='Not now';close.style.cssText='margin-top:12px;border:1px solid #ffffff55;border-radius:10px;padding:9px 14px;background:transparent;color:#fff';close.addEventListener('click',function(){panel.remove();});panel.appendChild(close);document.body.appendChild(panel);
      }
      function refresh(){var p=api();if(!p||!p.getPermissionStatuses)return Promise.resolve(null);return p.getPermissionStatuses().then(function(result){dispatch('forge:permissions-status',result);if(result)showSettingsHelp(result.requiresSettings,result.denied,result.restricted);return result;}).catch(function(error){dispatch('forge:permissions-error',{message:error&&error.message||String(error)});return null;});}
      function refreshSystemTheme(){var p=api();if(!p||!p.getSystemTheme)return Promise.resolve(null);return p.getSystemTheme().then(function(result){
        var theme=result&&result.theme==='dark'?'dark':'light';
        window.ForgeAndroidTheme=window.ForgeAndroidTheme||{};window.ForgeAndroidTheme.current=theme;window.ForgeAndroidTheme.source='android';
        dispatch('forge:system-theme',{theme:theme,isDark:theme==='dark'});
        try{if(localStorage.getItem('Written Magic.theme')==='system'&&typeof window.applyTheme==='function')window.applyTheme('system');}catch(e){}
        return result;
      }).catch(function(error){dispatch('forge:system-theme-error',{message:error&&error.message||String(error)});return null;});}
      function start(){var p=api();if(!p||!p.requestStartupPermissions){if(window.Nitron||window.NitronRuntime){var message='Forge native Permission plugin is missing. Rebuild this APK using the updated Forge Studio server.';console.warn('[Forge]',message);dispatch('forge:permissions-error',{message:message});dispatch('forge:permissions-manual-required',{permissions:['RECORD_AUDIO','CAMERA'],message:'Microphone and camera access must be enabled manually in Android Settings. Open Settings → Apps → this app → Permissions.'});}return;} p.requestStartupPermissions().then(function(result){dispatch('forge:permissions-result',result);return refresh();}).catch(function(error){console.warn('[Forge] Android permission request failed:',error&&error.message||error);dispatch('forge:permissions-error',{message:error&&error.message||String(error)});refresh();});}
      function boot(){start();refreshSystemTheme();}
      if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
      document.addEventListener('visibilitychange',function(){if(!document.hidden){refresh();refreshSystemTheme();}});
      window.addEventListener('focus',function(){refresh();refreshSystemTheme();});
      window.ForgeAndroidPermissions={refresh:refresh,request:function(permission){var p=api();if(!p)return Promise.reject(new Error('Forge Android permission bridge is unavailable'));return p.requestRuntimePermission({permission:permission});},openSettings:function(permission){var p=api();if(!p)return Promise.reject(new Error('Forge Android permission bridge is unavailable'));return p.openPermissionSettings({permission:permission});}};
    })();</script>`;
    if (!appHtml.includes('forge-android-permission-startup')) {
      const bodyCloseIndex = appHtml.toLowerCase().lastIndexOf('</body>');
      if (bodyCloseIndex >= 0) {
        appHtml = appHtml.slice(0, bodyCloseIndex) + startupPermissionScript + appHtml.slice(bodyCloseIndex);
      } else {
        appHtml += startupPermissionScript;
      }
      fs.writeFileSync(appEntry, appHtml);
    }
    const permissionNotes = config._permissionNotes || [];
    delete config._permissionNotes;
    delete config._autoAddedPermissions;
    permissionNotes.forEach(note => sendLog(id, note));
    fs.writeFileSync(path.join(workDir, 'nitron.config.json'), JSON.stringify(config, null, 2));
    const args = ['build'];
    if (target === 'aab') args.push('--target', 'aab');
    if (release) {
      fs.copyFileSync(uploadedKey.path, path.join(workDir, 'nitron-release.keystore'));
      args.push('--release');
    }
    sendLog(id, `Starting ${target.toUpperCase()} build…`);
    sendLog(id, `Permissions declared: ${config.permissions.length} (runtime prompts handled by native Permission plugin).`);
    sendLog(id, 'Plugin packaging is mandatory: build will be rejected unless Nitron embeds the plugin DEX and assets/nitron-plugins.json.');
    const env = { ...process.env };
    if (release) env.NITRON_KEYSTORE_PASSWORD = password;
    const child = require('child_process').spawn('nitron', args, { cwd: workDir, env, windowsHide: true });
    const stdoutState = { pending: '' };
    const stderrState = { pending: '' };
    child.stdout.on('data', data => relayBuildOutput(id, stdoutState, data));
    child.stderr.on('data', data => relayBuildOutput(id, stderrState, data));
    child.on('error', error => {
      flushBuildOutput(id, stdoutState);
      flushBuildOutput(id, stderrState);
      finish(error);
    });
    child.on('close', code => {
      flushBuildOutput(id, stdoutState);
      flushBuildOutput(id, stderrState);
      finish(code === 0 ? null : new Error(`Build failed with exit code ${code}`));
    });
    let finished = false;
    function finish(error) {
      if (finished) return; finished = true;
      cleanUploads(uploadedFiles);
      try { fs.unlinkSync(path.join(workDir, 'nitron-release.keystore')); } catch (_) {}
      const extension = target === 'aab' ? 'aab' : 'apk';
      const artifact = path.join(workDir, 'dist', `app.${extension}`);
      if (!error && fs.existsSync(artifact)) {
        try {
          const archive = new AdmZip(artifact);
          const names = archive.getEntries().map(entry => entry.entryName.replace(/^\//, ''));
          const hasPluginRegistry = names.some(n => n === 'assets/nitron-plugins.json' || n === 'base/assets/nitron-plugins.json');
          const dexPattern = target === 'aab' ? /^base\/dex\/classes(?:[2-9]|[1-9][0-9]+)\.dex$/ : /^classes(?:[2-9]|[1-9][0-9]+)\.dex$/;
          const dexEntry = names.find(name => dexPattern.test(name)) || (hasPluginRegistry ? names.find(n => n.endsWith('classes.dex')) : null);
          const pluginManifest = names.find(name => target === 'aab' ? name === 'base/assets/nitron-plugins.json' : name === 'assets/nitron-plugins.json');
          if (dexEntry && pluginManifest) {
            const manifestEntry = archive.getEntry(pluginManifest);
            const manifestText = manifestEntry ? manifestEntry.getData().toString('utf8') : '';
            if (manifestText.includes('Permission')) {
              sendLog(id, `✓ Native plugin verified in artifact: ${dexEntry} + ${pluginManifest}.`);
            } else {
              throw new Error('The plugin registry does not list PermissionPlugin.');
            }
          } else {
            throw new Error(`Native permission plugin is missing (DEX=${dexEntry || 'missing'}, registry=${pluginManifest || 'missing'}). Use the plugin-enabled Nitron build; this APK cannot show runtime permission prompts.`);
          }
        } catch (verifyError) {
          error = new Error(`Permission plugin verification failed: ${verifyError.message}`);
          sendLog(id, `BUILD_ERROR: ${error.message}`);
        }
      }
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
    cleanUploads(uploadedFiles);
    try { fs.unlinkSync(path.join(workDir, 'nitron-release.keystore')); } catch (_) {}
    jobs[id] = { status: 'error', target, error: error.message };
    sendLog(id, `BUILD_ERROR: ${error.message}`);
    if (logStreams[id] && !logStreams[id].writableEnded) logStreams[id].end();
    delete logStreams[id];
  }
});
app.get('/api/logs/:id', (req, res) => {
  const id = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
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
  const ext = job.target === 'aab' ? 'aab' : 'apk'; const artifact = path.join(buildsRoot, req.params.id, 'dist', `app.${ext}`);
  if (!fs.existsSync(artifact)) return res.status(404).send('Artifact not found');
  res.download(artifact, `forge-app.${ext}`);
});
app.get('/api/jobs/:id/apk', (req, res) => res.redirect(302, `/api/jobs/${encodeURIComponent(req.params.id)}/artifact`));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Forge Studio build server listening on ${PORT}`));