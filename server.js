const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { nanoid } = require('nanoid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve static files (CSS, JS, images) from the current directory
app.use(express.static(__dirname)); 

// 👇 ADD THIS LINE: Serve your specific HTML file at the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'HtmlABuilder.html'));
});

const jobs = {}; // id -> { status, apkPath, message }

app.post('/api/jobs', (req, res) => {
  const id = nanoid(10);
  jobs[id] = { status: 'building' };
  res.json({ id });

  // Do the build in the background
  const work = path.join(__dirname, 'builds', id);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'index.html'), req.body.html);

  // Example using nitron (adjust to its real CLI):
  execFile('npx', ['nitron', 'build', '--input', work, '--out', work], { cwd: __dirname },
    (err, stdout, stderr) => {
      if (err) {
        jobs[id] = { status: 'error', message: stderr || err.message };
        return;
      }
      const apk = path.join(work, 'app.apk');
      jobs[id] = { status: 'done', apk_url: `/api/jobs/${id}/apk` };
    });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ status: 'not_found' });
  res.json(j);
});

app.get('/api/jobs/:id/apk', (req, res) => {
  const apk = path.join(__dirname, 'builds', req.params.id, 'app.apk');
  if (!fs.existsSync(apk)) return res.status(404).send('Not ready');
  res.download(apk, 'app.apk');
});

app.listen(process.env.PORT || 3000, () =>
  console.log('http://localhost:' + (process.env.PORT || 3000)));