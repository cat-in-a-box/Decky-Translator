const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');
const PY_MODULES_DIR = path.join(PROJECT_ROOT, 'py_modules');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Python standalone build (Linux x86_64 for Steam Deck)
// We fetch the latest 3.11.x release dynamically
const PYTHON_STANDALONE_REPO = 'indygreg/python-build-standalone';
const PYTHON_DIR = path.join(BIN_DIR, 'python311');
const PYTHON_TARBALL = 'python-3.11.tar.gz';

// RapidOCR ONNX models from HuggingFace
const RAPIDOCR_MODELS_DIR = path.join(BIN_DIR, 'rapidocr', 'models');
const RAPIDOCR_MODELS = [
  {
    name: 'ch_PP-OCRv4_det_infer.onnx',
    url: 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx',
    description: 'Text detection model (~4.7MB)'
  },
  {
    name: 'ch_PP-OCRv4_rec_infer.onnx',
    url: 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx',
    description: 'Text recognition model (~10.9MB)'
  },
  {
    name: 'ch_ppocr_mobile_v2.0_cls_infer.onnx',
    url: 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv3/ch_ppocr_mobile_v2.0_cls_train.onnx',
    description: 'Text classification model (~0.6MB)'
  }
];

// Python packages for RapidOCR (always install latest versions)
// Note: numpy must stay <2.0.0 due to onnxruntime compatibility
const RAPIDOCR_PACKAGES = [
  'rapidocr-onnxruntime',
  'onnxruntime',
  'opencv-python-headless',
  'numpy<2.0.0',
  'Pillow',
  'pyclipper',
  'shapely'
];

// ============================================================================
// PLATFORM DETECTION
// ============================================================================

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

// Check if WSL is available on Windows
function checkWslAvailable() {
  if (!isWindows) return false;
  try {
    execSync('wsl --status', { stdio: 'pipe' });
    return true;
  } catch {
    try {
      // Fallback check - try to run a simple command
      execSync('wsl echo ok', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
}

// Convert Windows path to WSL path
function toWslPath(windowsPath) {
  // Convert backslashes to forward slashes
  let wslPath = windowsPath.replace(/\\/g, '/');
  // Convert drive letter (e.g., D:/ -> /mnt/d/)
  wslPath = wslPath.replace(/^([A-Za-z]):/, (_, letter) => `/mnt/${letter.toLowerCase()}`);
  return wslPath;
}

// Run a command in WSL
function runInWsl(command, options = {}) {
  const wslCommand = `wsl bash -c "${command.replace(/"/g, '\\"')}"`;
  return execSync(wslCommand, { ...options, shell: true });
}

// Check if pip is available in WSL
function checkWslPip() {
  if (!isWindows) return null;
  const pipCommands = ['pip3', 'pip', 'python3 -m pip'];
  for (const cmd of pipCommands) {
    try {
      runInWsl(`${cmd} --version`, { stdio: 'pipe' });
      return cmd;
    } catch {
      continue;
    }
  }
  return null;
}

const hasWsl = isWindows ? checkWslAvailable() : false;
const wslPipCommand = hasWsl ? checkWslPip() : null;
const canRunLinuxCommands = isLinux || hasWsl;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    const request = (urlString) => {
      const protocol = urlString.startsWith('https') ? https : http;

      protocol.get(urlString, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          request(redirectUrl);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;

        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (totalSize) {
            const percent = Math.round((downloadedSize / totalSize) * 100);
            const sizeMB = (downloadedSize / 1024 / 1024).toFixed(1);
            const totalMB = (totalSize / 1024 / 1024).toFixed(1);
            process.stdout.write(`\r   Progress: ${percent}% (${sizeMB}/${totalMB} MB)`);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log(' - Done');
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    };

    request(url);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    protocol.get(url, { headers: { 'User-Agent': 'Node.js' } }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        fetchJson(response.headers.location).then(resolve).catch(reject);
        return;
      }

      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// STEP 1: RAPIDOCR ONNX MODELS
// ============================================================================

async function downloadRapidOCRModels() {
  console.log('\n' + '='.repeat(60));
  console.log('STEP 1: RapidOCR ONNX Models');
  console.log('='.repeat(60));

  ensureDir(RAPIDOCR_MODELS_DIR);

  for (const model of RAPIDOCR_MODELS) {
    const destPath = path.join(RAPIDOCR_MODELS_DIR, model.name);

    if (fs.existsSync(destPath)) {
      const size = (fs.statSync(destPath).size / 1024 / 1024).toFixed(1);
      console.log(`   ${model.name} - Already exists (${size} MB)`);
      continue;
    }

    console.log(`   Downloading ${model.name}`);
    console.log(`   ${model.description}`);

    try {
      await downloadFile(model.url, destPath);
    } catch (e) {
      console.error(`   Failed to download ${model.name}: ${e.message}`);
      return false;
    }
  }

  console.log('   RapidOCR models complete!');
  return true;
}

// ============================================================================
// STEP 2: PYTHON 3.11 STANDALONE
// ============================================================================

async function findLatestPython311Release() {
  /**
   * Find the latest Python 3.11.x release from python-build-standalone.
   * Returns { version, date, url } or null if not found.
   */
  try {
    console.log('   Fetching latest Python 3.11.x release...');
    const releases = await fetchJson(`https://api.github.com/repos/${PYTHON_STANDALONE_REPO}/releases?per_page=50`);

    // Find the latest release that contains a 3.11.x build
    for (const release of releases) {
      const tagName = release.tag_name; // e.g., "20240415"

      // Look for 3.11.x asset
      for (const asset of release.assets || []) {
        const match = asset.name.match(/cpython-3\.11\.(\d+)\+(\d+)-x86_64-unknown-linux-gnu-install_only\.tar\.gz/);
        if (match) {
          const version = `3.11.${match[1]}`;
          const date = match[2];
          return {
            version,
            date,
            url: asset.browser_download_url
          };
        }
      }
    }
    return null;
  } catch (e) {
    console.log(`   Could not fetch releases: ${e.message}`);
    return null;
  }
}

async function downloadPython() {
  console.log('\n' + '='.repeat(60));
  console.log('STEP 2: Python 3.11 Standalone (Linux x86_64)');
  console.log('='.repeat(60));

  ensureDir(PYTHON_DIR);

  const tarballPath = path.join(PYTHON_DIR, PYTHON_TARBALL);

  if (fs.existsSync(tarballPath)) {
    const size = (fs.statSync(tarballPath).size / 1024 / 1024).toFixed(1);
    console.log(`   ${PYTHON_TARBALL} - Already exists (${size} MB)`);
    return true;
  }

  // Find latest 3.11.x release
  const pythonRelease = await findLatestPython311Release();

  if (!pythonRelease) {
    // Fallback to known working version
    console.log('   Could not find latest release, using fallback version...');
    const fallbackUrl = 'https://github.com/indygreg/python-build-standalone/releases/download/20240415/cpython-3.11.9+20240415-x86_64-unknown-linux-gnu-install_only.tar.gz';
    try {
      await downloadFile(fallbackUrl, tarballPath);
      console.log('   Python 3.11.9 (fallback) download complete!');
      return true;
    } catch (e) {
      console.error(`   Failed to download Python: ${e.message}`);
      return false;
    }
  }

  console.log(`   Found Python ${pythonRelease.version} (build ${pythonRelease.date})`);
  console.log('   Source: python-build-standalone');

  try {
    await downloadFile(pythonRelease.url, tarballPath);
    console.log('   Python download complete!');
    return true;
  } catch (e) {
    console.error(`   Failed to download Python: ${e.message}`);
    return false;
  }
}

// ============================================================================
// STEP 3: PY_MODULES (RapidOCR Python Dependencies)
// ============================================================================

async function installPyModules() {
  console.log('\n' + '='.repeat(60));
  console.log('STEP 3: Python Packages (py_modules)');
  console.log('='.repeat(60));

  // Check if already installed
  const onnxPath = path.join(PY_MODULES_DIR, 'onnxruntime');
  const rapidocrPath = path.join(PY_MODULES_DIR, 'rapidocr_onnxruntime');

  if (fs.existsSync(onnxPath) && fs.existsSync(rapidocrPath)) {
    console.log('   py_modules already installed, skipping.');
    return true;
  }

  if (!canRunLinuxCommands) {
    console.log('   Cannot install py_modules (no Linux/WSL available).');
    console.log('   Install WSL or run on Linux.');
    return false;
  }

  // Check pip availability
  if (hasWsl && !wslPipCommand) {
    console.log('   pip not found in WSL!');
    console.log('   Install it with: wsl sudo apt update && wsl sudo apt install python3-pip');
    return false;
  }

  ensureDir(PY_MODULES_DIR);

  const pyModulesPath = hasWsl ? toWslPath(PY_MODULES_DIR) : PY_MODULES_DIR;
  const packages = RAPIDOCR_PACKAGES.map(p => `'${p}'`).join(' ');

  // pip install command with Python 3.11 targeting for Steam Deck
  // --upgrade ensures we always get the latest versions
  const pipCmd = hasWsl ? wslPipCommand : 'pip';
  const platformFlags = '--python-version 3.11 --only-binary=:all: --platform manylinux2014_x86_64 --upgrade';
  const installCommand = `${pipCmd} install --target="${pyModulesPath}" ${platformFlags} ${packages}`;

  console.log('   Installing packages for Python 3.11 / Linux x86_64...');
  console.log('   Using: ' + pipCmd + (hasWsl ? ' (via WSL)' : ''));

  try {
    if (hasWsl) {
      runInWsl(installCommand, { stdio: 'inherit' });
    } else {
      execSync(installCommand, { stdio: 'inherit', cwd: PROJECT_ROOT });
    }

    console.log('   py_modules installed successfully!');
    return true;
  } catch (e) {
    console.error(`   Failed to install py_modules: ${e.message}`);
    if (hasWsl) {
      console.log('   Make sure pip is installed in WSL:');
      console.log('     wsl sudo apt update && wsl sudo apt install python3-pip');
    }
    return false;
  }
}

// ============================================================================
// SUMMARY
// ============================================================================

function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('DOWNLOAD SUMMARY');
  console.log('='.repeat(60));

  const modelsOk = fs.existsSync(path.join(RAPIDOCR_MODELS_DIR, 'ch_PP-OCRv4_det_infer.onnx'));
  const pythonOk = fs.existsSync(path.join(PYTHON_DIR, PYTHON_TARBALL));
  const pyModulesOk = fs.existsSync(path.join(PY_MODULES_DIR, 'onnxruntime'));

  const status = (ok) => ok ? 'OK' : 'MISSING';

  console.log('');
  console.log('   RAPIDOCR:');
  console.log(`     ONNX Models:   ${status(modelsOk).padEnd(10)} ${RAPIDOCR_MODELS_DIR}`);
  console.log(`     Python 3.11:   ${status(pythonOk).padEnd(10)} ${PYTHON_DIR}`);
  console.log(`     py_modules:    ${status(pyModulesOk).padEnd(10)} ${PY_MODULES_DIR}`);

  const allOk = modelsOk && pythonOk && pyModulesOk;

  if (allOk) {
    console.log('\n   All dependencies ready!');
    console.log('   Run: npm run build:zip');
  } else {
    console.log('\n   Some dependencies are missing.');
    if (!canRunLinuxCommands) {
      console.log('   Tip: Install WSL to complete Linux-only steps on Windows.');
    }
  }

  console.log('\n' + '='.repeat(60));
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log('DECKY TRANSLATOR - DEPENDENCY DOWNLOADER');
  console.log('Downloads everything needed for RapidOCR');
  console.log('='.repeat(60));

  console.log('\n   Platform: ' + process.platform);
  if (isWindows) {
    if (hasWsl) {
      console.log('   WSL detected - will use for Linux-only operations');
    } else {
      console.log('   WSL not found - some steps will be skipped');
    }
  }

  const results = {
    rapidocrModels: await downloadRapidOCRModels(),
    python: await downloadPython(),
    pyModules: await installPyModules()
  };

  printSummary(results);
}

main().catch(console.error);
