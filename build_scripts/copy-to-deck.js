// Simple script to copy built plugin zip to Steam Deck via SCP
// Requires: .deck file with host, user, password

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from 'node-scp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

function getConfig() {

  const configPath = path.join(projectRoot, '.deck');

  if (!fs.existsSync(configPath)) {
    console.error('Missing .deck config file');
    process.exit(1);
  }

  const config = {};
  for (const line of fs.readFileSync(configPath, 'utf8').split('\n')) {
    const [key, value] = line.split('=').map(s => s.trim());
    if (key && value) config[key.toLowerCase()] = value;
  }

  if (!config.password) {
    console.error('No password in .deck file');
    process.exit(1);
  }

  return { host: config.host || 'steamdeck', user: config.user || 'deck', password: config.password };
}

// Find the plugin zip in out/ directory
function findZip() {
  const outDir = path.join(projectRoot, 'out');
  if (!fs.existsSync(outDir)) return null;

  const zip = fs.readdirSync(outDir).find(f => f.endsWith('.zip'));
  return zip ? path.join(outDir, zip) : null;
}

// Main
async function main() {
  const zipPath = findZip();
  if (!zipPath) {
    console.error('No zip in out/ directory');
    process.exit(1);
  }

  const config = getConfig();
  const destPath = `/home/${config.user}/${path.basename(zipPath)}`;

  console.log(`Copying ${path.basename(zipPath)} to ${config.host}:${destPath}`);

  const client = await Client({ host: config.host, username: config.user, password: config.password });
  await client.uploadFile(zipPath, destPath);
  client.close();

  console.log('Done!');
}

main().catch(err => { console.error(err.message); process.exit(1); });
