const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function copyToDeck() {
  const projectRoot = path.join(__dirname, '..');
  const zipName = 'decky-translator.zip';
  const zipPath = path.join(projectRoot, zipName);

  // Check if zip file exists
  if (!fs.existsSync(zipPath)) {
    console.error(`❌ Error: ${zipName} not found. Run "npm run build:zip" first.`);
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

  // Steam Deck host - can be overridden via DECK_HOST env var
  const deckHost = process.env.DECK_HOST || 'steamdeck';
  const deckUser = process.env.DECK_USER || 'deck';
  const destPath = `/home/deck/${destFileName}`;

  console.log(`📦 Copying ${zipName} to Steam Deck...`);
  console.log(`   Source: ${zipPath}`);
  console.log(`   Destination: ${deckUser}@${deckHost}:${destPath}`);
  console.log(`   Timestamp: ${dateStr}\n`);

  try {
    execSync(`scp "${zipPath}" ${deckUser}@${deckHost}:"${destPath}"`, {
      stdio: 'inherit'
    });
    console.log(`\n✅ Successfully copied to ${destPath}`);
  } catch (error) {
    console.error('\n❌ Failed to copy to Steam Deck.');
    console.error('   Make sure:');
    console.error('   - SSH is enabled on your Steam Deck');
    console.error('   - You can reach your Deck at "steamdeck" or set DECK_HOST env var');
    console.error('   - SSH keys are configured or you\'ll be prompted for password');
    process.exit(1);
  }
}

copyToDeck();
