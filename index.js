const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const execFile = require('child_process').execFile;
const nanoid = require('nanoid').nanoid;

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'HtmlABuilder.html'));
});

const jobs = {};

app.post('/api/jobs', function(req, res) {
  const id = nanoid(10);
  jobs[id] = { status: 'building' };
  
  res.json({ id: id });

  const workDir = path.join(__dirname, 'builds', id);
  fs.mkdirSync(workDir, { recursive: true });
  
  fs.writeFileSync(path.join(workDir, 'index.html'), req.body.html);

  const configData = {
    name: "MyApp",
    packageId: "com.example.myapp",
    version: "1.0.0",
    entry: "index.html"
  };
  
  fs.writeFileSync(path.join(workDir, 'nitron.config.json'), JSON.stringify(configData, null, 2));

  execFile('nitron', ['build'], { cwd: workDir }, function(buildErr, stdout, stderr) {
    if (buildErr) {
      jobs[id] = { status: 'error', message: stderr || buildErr.message };
      return;
    }

    const apkPath = path.join(workDir, 'dist', 'app.apk');
    
    if (fs.existsSync(apkPath)) {
      jobs[id] = { status: 'done', apk_url: '/api/jobs/' + id + '/apk' };
    } else {
      jobs[id] = { status: 'error', message: 'APK not found in dist/ folder' };
    }
  });
});

app.get('/api/jobs/:id', function(req, res) {
  const job = jobs[req.params.id];
  
  if (!job) {
    res.status(404).json({ status: 'not_found' });
    return;
  }
  
  res.json(job);
});

app.get('/api/jobs/:id/apk', function(req, res) {
  const apkPath = path.join(__dirname, 'builds', req.params.id, 'dist', 'app.apk');
  
  if (!fs.existsSync(apkPath)) {
    res.status(404).send('APK not ready');
    return;
  }
  
  res.download(apkPath, 'app.apk');
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});