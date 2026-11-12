const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const app = express();
app.use(express.json());

app.post('/api/build', (req, res) => {
  fs.writeFileSync('/tmp/proj/app/src/main/assets/index.html', req.body.html);
  execSync('cd /tmp/proj && ./gradlew assembleDebug');
  res.sendFile('/tmp/proj/app/build/outputs/apk/debug/app-debug.apk');
});
app.listen(3000);