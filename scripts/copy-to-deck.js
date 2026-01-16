const fs = require('fs');
const path = require('path');
const { Client } = require('node-scp');

function loadDeckConfig() {
  const projectRoot = path.join(__dirname, '..');
  const configPath = path.join(projectRoot, '.deck');

  const config = {
    host: process.env.DECK_HOST || 'steamdeck',
    user: process.env.DECK_USER || 'deck',
    password: null,
    port: 22
  };

  // Try to load .deck config file
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').trim();

        if (key.trim().toLowerCase() === 'host') config.host = value;
        if (key.trim().toLowerCase() === 'user') config.user = value;
        if (key.trim().toLowerCase() === 'password') config.password = value;
        if (key.trim().toLowerCase() === 'port') config.port = parseInt(value, 10);
      }

      console.log('Loaded config from .deck file');
    } catch (err) {
      console.warn('Could not read .deck file, using defaults');
    }
  }

  return config;
}

async function copyToDeck() {
  const projectRoot = path.join(__dirname, '..');
  const zipName = 'decky-translator.zip';
  const zipPath = path.join(projectRoot, zipName);

  // Check if zip file exists
  if (!fs.existsSync(zipPath)) {
    console.error(`Error: ${zipName} not found. Run "npm run build:zip" first.`);
    process.exit(1);
  }

  // Load config
  const config = loadDeckConfig();

  if (!config.password) {
    console.error('Error: No password configured.');
    console.error('Create a .deck file with your Steam Deck credentials:');
    console.error('  host=steamdeck');
    console.error('  user=deck');
    console.error('  password=your_password');
    process.exit(1);
  }

  // Get file creation time (or modification time as fallback)
  const stats = fs.statSync(zipPath);
  const timestamp = stats.birthtime || stats.mtime;

  // Format timestamp as YYYYMMDD-HHmmss
  const dateStr = timestamp.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);

  const destFileName = `decky-translator-${dateStr}.zip`;
  const destPath = `/home/deck/${destFileName}`;

  console.log(`Copying ${zipName} to Steam Deck...`);
  console.log(`   Source: ${zipPath}`);
  console.log(`   Destination: ${config.user}@${config.host}:${destPath}`);
  console.log(`   Timestamp: ${dateStr}\n`);

  try {
    const client = await Client({
      host: config.host,
      port: config.port,
      username: config.user,
      password: config.password,
    });

    await client.uploadFile(zipPath, destPath);
    client.close();

    console.log(`\nSuccessfully copied to ${destPath}`);
  } catch (error) {
    console.error('\nFailed to copy to Steam Deck.');
    console.error(`   Error: ${error.message}`);
    console.error('   Make sure:');
    console.error('   - SSH is enabled on your Steam Deck');
    console.error(`   - You can reach your Deck at ${config.host}`);
    console.error('   - The password in .deck file is correct');
    process.exit(1);
  }
}

copyToDeck();
