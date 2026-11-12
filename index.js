const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const execFile = require('child_process').execFile;
const nanoid = require('nanoid').nanoid;
const multer = require('multer');
const AdmZip = require('adm-zip');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'HtmlABuilder.html'));
});

const jobs = {};
const logStreams = {}; // Holds active SSE connections

// Endpoint to start the build
app.post('/api/jobs', upload.array('files'), function(req, res) {
  const id = nanoid(10);
  const appName = req.body.appName || 'MyApp';
  const packageName = req.body.packageName || 'com.example.myapp';
  
  jobs[id] = { status: 'building' };
  res.json({ id: id });

  const workDir = path.join(__dirname, 'builds', id);
  fs.mkdirSync(workDir, { recursive: true });

  const uploadedFiles = req.files || [];

  if (uploadedFiles.length === 1 && uploadedFiles[0].originalname.endsWith('.zip')) {
    try {
      const zip = new AdmZip(uploadedFiles[0].path);
      zip.extractAllTo(workDir, true);
    } catch (e) {
      jobs[id] = { status: 'error', message: 'Failed to extract ZIP' };
      return;
    }
  } else {
    uploadedFiles.forEach(file => {
      if (file.originalname === 'icon.png') return; 
      
      let fileName = file.originalname;
      const htmlFiles = uploadedFiles.filter(f => f.originalname.endsWith('.html'));
      if (htmlFiles.length === 1 && fileName.endsWith('.html')) {
        fileName = 'index.html';
      }

      const targetPath = path.join(workDir, fileName);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(file.path, targetPath);
    });
  }

  const iconFile = uploadedFiles.find(f => f.originalname === 'icon.png');
  const assetsDir = path.join(workDir, 'assets');
  if (iconFile) {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.copyFileSync(iconFile.path, path.join(assetsDir, 'icon.png'));
  }

  const configData = {
    name: appName,
    packageId: packageName,
    version: "1.0.0",
    entry: "index.html",
    icon: "assets/icon.png"
  };
  fs.writeFileSync(path.join(workDir, 'nitron.config.json'), JSON.stringify(configData, null, 2));

  // Helper to send log lines to the frontend
  function sendLog(msg) {
    if (logStreams[id]) {
      // Replace newlines so the frontend can display them as separate HTML lines
      const safeMsg = msg.replace(/\n/g, '<br>');
      logStreams[id].write(`data: ${safeMsg}\n\n`);
    }
  }

  sendLog("Starting Nitron build process...");
  sendLog("Working directory: " + workDir);

  const child = execFile('nitron', ['build'], { cwd: workDir });

  // Stream standard output
  child.stdout.on('data', (data) => {
    sendLog(data.toString());
  });

  // Stream standard error (usually where build logs go)
  child.stderr.on('data', (data) => {
    sendLog(data.toString());
  });

  child.on('close', (code) => {
    // Clean up uploaded temporary files
    uploadedFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch(e){} });

    if (code === 0) {
      const apkPath = path.join(workDir, 'dist', 'app.apk');
      if (fs.existsSync(apkPath)) {
        jobs[id] = { status: 'done', apk_url: '/api/jobs/' + id + '/apk' };
        sendLog("DONE"); // Signal frontend to show the download button
      } else {
        jobs[id] = { status: 'error', message: 'APK not found in dist/' };
        sendLog("ERROR");
      }
    } else {
      jobs[id] = { status: 'error', message: 'Build failed with code ' + code };
      sendLog("ERROR");
    }
    
    // Close the SSE stream
    if (logStreams[id]) {
      logStreams[id].end();
      delete logStreams[id];
    }
  });
});

// SSE Endpoint to stream logs
app.get('/api/logs/:id', function(req, res) {
  const id = req.params.id;
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); 

  logStreams[id] = res;

  req.on('close', () => {
    if (logStreams[id]) {
      logStreams[id].end();
      delete logStreams[id];
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