#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function read(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
  return result.stdout.trim();
}

const rawVersion = process.argv[2];
const version = rawVersion?.replace(/^v/, '');

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: npm run release -- <version>');
  console.error('Example: npm run release -- 1.0.1');
  process.exit(1);
}

const dirty = read('git', ['status', '--porcelain']);
if (dirty) {
  console.error('Working tree is not clean. Commit or stash changes before publishing a release.');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const packageJsonPath = path.join(root, 'package.json');
const tauriConfigPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(root, 'src-tauri', 'Cargo.toml');

function writeJsonVersion(file, nextVersion) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.version = nextVersion;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

writeJsonVersion(packageJsonPath, version);
writeJsonVersion(tauriConfigPath, version);

const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
fs.writeFileSync(
  cargoTomlPath,
  cargoToml.replace(/^version = ".+"$/m, `version = "${version}"`),
);

run('npm', ['install', '--package-lock-only', '--ignore-scripts']);
run('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--format-version', '1', '--no-deps'], { stdio: 'ignore' });
run('git', ['add', 'package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json']);
run('git', ['commit', '-m', `release: v${version}`]);
run('git', ['tag', `v${version}`]);
run('git', ['push', '--follow-tags']);
