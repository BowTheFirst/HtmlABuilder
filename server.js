const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { nanoid } = require('nanoid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static files
app.use(express.static(__dirname));

// Serve the UI at the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'HtmlABuilder.html'));
});

const jobs = {}; // id -> { status, apkPath, message }

app.post('/api/jobs', (req, res) => {
  const id = nanoid(10);
  jobs[id] = { status: 'building' };
  res.json({ id });

  // Create a unique working directory for this build
  const workDir = path.join(__dirname, 'builds', id);
  fs.mkdirSync(workDir, { recursive: true });
  
  // 1. Write the user's HTML to the folder
  fs.writeFileSync(path.join(workDir, 'index.html'), req.body.html);

  // 2. Initialize Nitron (creates config) then build
  // We run 'init' first to ensure the config exists, then 'build'
  const initProcess = execFile('npx', ['nitron', 'init', '--preset', 'vanilla'], { cwd: workDir }, (initErr) => {
    if (initErr) {
      jobs[id] = { status: 'error', message: 'Init failed: ' + initErr.message };
      return;
    }

    // 3. Run the actual build
    execFile('npx', ['nitron', 'build'], { cwd: workDir }, (buildErr, stdout, stderr) => {
      if (buildErr) {
        // This is where Render will fail if Java is missing
        jobs[id] = { status: 'error', message: stderr || buildErr.message };
        return;
      }

      // 4. Locate the generated APK
      // Nitron outputs to dist/app.apk by default
      const apkPath = path.join(workDir, 'dist', 'app.apk');
      
      if (fs.existsSync(apkPath)) {
        jobs[id] = { status: 'done', apk_url: `/api/jobs/${id}/apk` };
      } else {
        jobs[id] = { status: 'error', message: 'Build finished but APK not found in dist/' };
      }
    });
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ status: 'not_found' });
  res.json(j);
});

app.get('/api/jobs/:id/apk', (req, res) => {
  const apkPath = path.join(__dirname, 'builds', req.params.id, 'dist', 'app.apk');
  if (!fs.existsSync(apkPath)) return res.status(404).send('APK not ready');
  res.download(apkPath, 'app.apk');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));