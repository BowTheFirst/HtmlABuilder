const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const execFile = require('child_process').execFile;
const nanoid = require('nanoid').nanoid;
const multer = require('multer');
const AdmZip = require('adm-zip');

const app = express();
const upload = multer({ dest: 'uploads/' }); // Temp folder for incoming files

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'HtmlABuilder.html'));
});

const jobs = {};

// The upload.array('files') handles multiple files (folders or zip)
app.post('/api/jobs', upload.array('files'), function(req, res) {
  const id = nanoid(10);
  const appName = req.body.appName || 'MyApp';
  const packageName = req.body.packageName || 'com.example.myapp';
  
  jobs[id] = { status: 'building' };
  res.json({ id: id });

  const workDir = path.join(__dirname, 'builds', id);
  fs.mkdirSync(workDir, { recursive: true });

  const uploadedFiles = req.files || [];

  // 1. Handle ZIP file or regular files
  if (uploadedFiles.length === 1 && uploadedFiles[0].originalname.endsWith('.zip')) {
    try {
      const zip = new AdmZip(uploadedFiles[0].path);
      zip.extractAllTo(workDir, true);
    } catch (e) {
      jobs[id] = { status: 'error', message: 'Failed to extract ZIP' };
      return;
    }
  } else {
    // Handle individual files (folder upload)
    uploadedFiles.forEach(file => {
      if (file.originalname === 'icon.png') return; // Skip icon
      // file.originalname might include folder paths (webkitRelativePath)
      const targetPath = path.join(workDir, file.originalname);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(file.path, targetPath);
    });
  }

  // 2. Handle Custom Icon
  const iconFile = uploadedFiles.find(f => f.originalname === 'icon.png');
  const assetsDir = path.join(workDir, 'assets');
  if (iconFile) {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.copyFileSync(iconFile.path, path.join(assetsDir, 'icon.png'));
  }

  // 3. Write Nitron Config
  const configData = {
    name: appName,
    packageId: packageName,
    version: "1.0.0",
    entry: "index.html",
    icon: "assets/icon.png" // Nitron will look here if provided
  };
  fs.writeFileSync(path.join(workDir, 'nitron.config.json'), JSON.stringify(configData, null, 2));

  // 4. Build
  execFile('nitron', ['build'], { cwd: workDir }, function(buildErr, stdout, stderr) {
    // Clean up uploaded temp files
    uploadedFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch(e){} });

    if (buildErr) {
      jobs[id] = { status: 'error', message: stderr || buildErr.message };
      return;
    }

    const apkPath = path.join(workDir, 'dist', 'app.apk');
    if (fs.existsSync(apkPath)) {
      jobs[id] = { status: 'done', apk_url: '/api/jobs/' + id + '/apk' };
    } else {
      jobs[id] = { status: 'error', message: 'APK not found in dist/' };
    }
  });
});

app.get('/api/jobs/:id', function(req, res) {
  const job = jobs[req.params.id];
  if (!job) { res.status(404).json({ status: 'not_found' }); return; }
  res.json(job);
});

app.get('/api/jobs/:id/apk', function(req, res) {
  const apkPath = path.join(__dirname, 'builds', req.params.id, 'dist', 'app.apk');
  if (!fs.existsSync(apkPath)) { res.status(404).send('Not ready'); return; }
  res.download(apkPath, 'app.apk');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Server running on port ' + PORT); });