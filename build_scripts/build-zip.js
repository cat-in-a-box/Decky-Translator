const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Helper function to recursively copy directories
function copyRecursive(src, dest) {
  const stat = fs.statSync(src);

  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      const srcPath = path.join(src, entry);
      const destPath = path.join(dest, entry);
      copyRecursive(srcPath, destPath);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// Helper function to clean up temp directory
function cleanupTemp(tempDir) {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function buildZip() {
  const projectRoot = path.join(__dirname, '..');
  const tempBuildDir = path.join(projectRoot, 'temp-build');

  try {
    console.log('📦 Starting zip build process...\n');

    // Read plugin.json to get plugin name
    console.log('📄 Reading plugin.json...');
    const pluginJsonPath = path.join(projectRoot, 'plugin.json');
    const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
    const pluginName = 'decky-translator';

    console.log(`   Plugin name: ${pluginJson.name}`);
    console.log(`   Folder name: ${pluginName}\n`);

    // Clean up any existing temp directory
    cleanupTemp(tempBuildDir);

    // Create temp build directory structure
    console.log('📁 Creating temporary build directory...');
    const pluginDir = path.join(tempBuildDir, pluginName);
    fs.mkdirSync(pluginDir, { recursive: true });
    console.log(`   Created: ${pluginDir}\n`);

    // Copy required files
    console.log('📋 Copying files...');
    const filesToCopy = [
      'plugin.json',
      'main.py',
      'LICENSE',
      'README.md',
      'package.json'
    ];

    for (const file of filesToCopy) {
      const srcPath = path.join(projectRoot, file);
      const destPath = path.join(pluginDir, file);

      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`   ✓ ${file}`);
      } else {
        console.warn(`   ⚠ Warning: ${file} not found, skipping`);
      }
    }

    // Copy all .pyi files
    console.log('\n📋 Copying .pyi files...');
    const pyiFiles = fs.readdirSync(projectRoot).filter(file => file.endsWith('.pyi'));
    for (const file of pyiFiles) {
      const srcPath = path.join(projectRoot, file);
      const destPath = path.join(pluginDir, file);
      fs.copyFileSync(srcPath, destPath);
      console.log(`   ✓ ${file}`);
    }

    // Copy dist directory
    console.log('\n📂 Copying dist/ directory...');
    const distSrc = path.join(projectRoot, 'dist');
    const distDest = path.join(pluginDir, 'dist');

    if (fs.existsSync(distSrc)) {
      copyRecursive(distSrc, distDest);
      console.log('   ✓ dist/ directory copied');
    } else {
      console.error('   ✗ Error: dist/ directory not found. Run "npm run build" first.');
      cleanupTemp(tempBuildDir);
      process.exit(1);
    }

    // Handle bin directory (copy if exists, create empty if not)
    console.log('\n📂 Handling bin/ directory...');
    const binSrc = path.join(projectRoot, 'bin');
    const binDest = path.join(pluginDir, 'bin');

    if (fs.existsSync(binSrc)) {
      copyRecursive(binSrc, binDest);
      console.log('   ✓ bin/ directory copied');

      // Check for RapidOCR models
      const rapidocrModelsPath = path.join(binDest, 'rapidocr', 'models');
      if (fs.existsSync(rapidocrModelsPath)) {
        const modelFiles = fs.readdirSync(rapidocrModelsPath).filter(f => f.endsWith('.onnx'));
        console.log(`   ✓ RapidOCR: ${modelFiles.length} ONNX models found`);
      } else {
        console.log('   ⚠ RapidOCR models not found - run "npm run download:all" to download');
      }
    } else {
      fs.mkdirSync(binDest);
      console.log('   ✓ bin/ directory created (empty)');
    }

    // Handle py_modules directory (copy if exists, create empty if not)
    console.log('\n📂 Handling py_modules/ directory...');
    const pyModulesSrc = path.join(projectRoot, 'py_modules');
    const pyModulesDest = path.join(pluginDir, 'py_modules');

    if (fs.existsSync(pyModulesSrc)) {
      copyRecursive(pyModulesSrc, pyModulesDest);
      console.log('   ✓ py_modules/ directory copied');

      // Fix ELF executable stack issue in onnxruntime .so files
      console.log('\n🔧 Fixing ELF executable stack flags...');
      const fixElfScript = path.join(projectRoot, 'build_scripts', 'fix-elf-execstack.py');
      const onnxruntimeDir = path.join(pyModulesDest, 'onnxruntime');

      if (fs.existsSync(fixElfScript) && fs.existsSync(onnxruntimeDir)) {
        try {
          execSync(`python "${fixElfScript}" "${onnxruntimeDir}"`, {
            cwd: projectRoot,
            stdio: 'inherit'
          });
          console.log('   ✓ ELF files fixed');
        } catch (error) {
          console.log('   ⚠ Could not fix ELF files (may need to run fix script on Steam Deck)');
        }
      } else {
        console.log('   ⚠ Skipping ELF fix (onnxruntime not found or script missing)');
      }
    } else {
      fs.mkdirSync(pyModulesDest);
      console.log('   ✓ py_modules/ directory created (empty)');
    }

    // Copy providers directory (Python provider modules)
    console.log('\n📂 Copying providers/ directory...');
    const providersSrc = path.join(projectRoot, 'providers');
    const providersDest = path.join(pluginDir, 'providers');

    if (fs.existsSync(providersSrc)) {
      copyRecursive(providersSrc, providersDest);
      console.log('   ✓ providers/ directory copied');
    } else {
      console.error('   ✗ Error: providers/ directory not found.');
      cleanupTemp(tempBuildDir);
      process.exit(1);
    }

    // Create zip file using bestzip
    console.log('\n🗜️  Creating zip archive...');
    const zipName = `${pluginName}.zip`;
    const zipPath = path.join(projectRoot, zipName);

    // Remove existing zip if it exists
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
      console.log(`   Removed existing ${zipName}`);
    }

    // Run bestzip from temp-build directory to create zip with proper structure
    try {
      execSync(`npx bestzip "${zipPath}" "${pluginName}"`, {
        cwd: tempBuildDir,
        stdio: 'inherit'
      });
      console.log(`   ✓ Created ${zipName}\n`);
    } catch (error) {
      console.error('   ✗ Error creating zip file');
      throw error;
    }

    // Clean up temp directory
    console.log('🧹 Cleaning up...');
    cleanupTemp(tempBuildDir);
    console.log('   ✓ Temporary files removed\n');

    console.log(`✅ Build complete! Output: ${zipName}`);
    console.log(`📦 Archive location: ${zipPath}\n`);

  } catch (error) {
    console.error('\n❌ Build failed:', error.message);
    cleanupTemp(tempBuildDir);
    process.exit(1);
  }
}

buildZip();
