'use strict';
// Download only the assets named in the versioned manifest and verify before replacement.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'public/release.json'), 'utf8'));
  for (const asset of manifest.assets) {
    if (!['JBRemote.exe', 'JBRemote.apk'].includes(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid manifest');
    const url = new URL(asset.url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/ANONIMUS-B/anydesk-desplegado/releases/download/')) throw new Error('Invalid asset URL');
    const destination = path.join(__dirname, 'public', asset.name);
    const current = fs.existsSync(destination) ? crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex') : null;
    if (current === asset.sha256) { console.log(`${asset.name}: verified`); continue; }
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const temporary = `${destination}.download`;
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: 'wx' }));
      const digest = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(temporary)) digest.update(chunk);
      if (digest.digest('hex') !== asset.sha256 || fs.statSync(temporary).size !== asset.bytes) throw new Error('Artifact checksum/size mismatch');
      fs.renameSync(temporary, destination);
      console.log(`${asset.name}: installed and verified`);
    } catch (error) { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); throw error; }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
