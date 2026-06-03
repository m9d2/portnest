#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function normalizeVersion(rawVersion) {
  const version = rawVersion?.replace(/^v/, '');
  if (!version || !VERSION_PATTERN.test(version)) {
    throw new Error('Usage: node scripts/sync-version.js <version>');
  }
  return version;
}

function writeJsonVersion(file, nextVersion) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.version = nextVersion;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function writePackageLockVersion(file, nextVersion) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.version = nextVersion;
  if (data.packages?.['']) {
    data.packages[''].version = nextVersion;
  }
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function replaceRequired(content, pattern, replacement, file) {
  if (!pattern.test(content)) {
    throw new Error(`Failed to update version in ${file}`);
  }
  return content.replace(pattern, replacement);
}

function syncVersion(rawVersion, root = path.join(__dirname, '..')) {
  const version = normalizeVersion(rawVersion);
  const packageJsonPath = path.join(root, 'package.json');
  const packageLockPath = path.join(root, 'package-lock.json');
  const tauriConfigPath = path.join(root, 'src-tauri', 'tauri.conf.json');
  const cargoTomlPath = path.join(root, 'src-tauri', 'Cargo.toml');
  const cargoLockPath = path.join(root, 'src-tauri', 'Cargo.lock');

  writeJsonVersion(packageJsonPath, version);
  writePackageLockVersion(packageLockPath, version);
  writeJsonVersion(tauriConfigPath, version);

  const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
  fs.writeFileSync(
    cargoTomlPath,
    replaceRequired(cargoToml, /^version = ".+"$/m, `version = "${version}"`, cargoTomlPath),
  );

  const cargoLock = fs.readFileSync(cargoLockPath, 'utf8');
  fs.writeFileSync(
    cargoLockPath,
    replaceRequired(
      cargoLock,
      /(\[\[package\]\]\nname = "portnest"\nversion = ")[^"]+"/,
      `$1${version}"`,
      cargoLockPath,
    ),
  );

  return version;
}

if (require.main === module) {
  try {
    const version = syncVersion(process.argv[2]);
    console.log(`Synced PortNest version to ${version}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { normalizeVersion, syncVersion };
