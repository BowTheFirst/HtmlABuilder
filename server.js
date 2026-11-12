const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { nanoid } = require('nanoid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'HtmlABuilder.html'));
});

const jobs = {};

// Endpoint to start a build
app.post('/api/jobs', (req, res) => {
  const id = nanoid(10);
  jobs[id] = { status: 'building' };
  res.json({ id });

  const workDir = path.join(__dirname, 'builds', id);
  fs.mkdirSync(workDir, { recursive: true });

  // 1. Save the user's HTML
  fs.writeFileSync(path.join(workDir, 'index.html'), req.body.html);

  // 2. Create the Nitron config
  const nitronConfig = {
    name: "MyApp",
    packageId: "com.example.myapp",
    version: "1.0.0",
    entry: "index.html"
  };
  fs.writeFileSync(path.join(workDir, 'nitron.config.json'), JSON.stringify(nitronConfig, null, 2));

  // 3. Run the build command
  execFile('npx', ['nitron', 'build'], { cwd: workDir }, (buildErr, stdout, stderr) => {
    if (buildErr) {
      jobs[id] = { status: 'error', message: stderr || buildErr.message };
      return;
    }

    const apkPath = path.join(workDir, 'dist', 'app.apk');
    if (fs.existsSync(apkPath)) {
      jobs[id] = { status: 'done', apk_url: `/api/jobs/${id}/apk` };
    } else {
      jobs[id] = { status: 'error', message: 'APK not found in dist/ folder' };
    }
  });
});

// Endpoint to check build status
app.get('/api/jobs/:id', (req, res) => {
  const j = jobs[req.params.id];
  if (!j) {
    return res.status(404).json({ status: 'not_found' });
  }
  res.json(j);
});

// Endpoint to download the APK
app.get('/api/jobs/:id/apk', (req, res) => {
  const apkPath = path.join(__dirname, 'builds', req.params.id, 'dist', 'app.apk');
  if (!fs.existsSync(apkPath)) {
    return res.status(404).send('APK not ready');
  }
  res.download(apkPath, 'app.apk');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});(__dirname, 'builds', req.params.id, 'dist', 'app.apk');
  if (!fs.existsSync(apkPath)) return res.status(404).send('APK not ready');
  res.download(apkPath, 'app.apk');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));