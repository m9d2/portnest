#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');
const { syncVersion } = require('./sync-version');

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
if (!rawVersion) {
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
const version = syncVersion(rawVersion, root);

run('npm', ['install', '--package-lock-only', '--ignore-scripts']);
run('cargo', ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--format-version', '1', '--no-deps'], { stdio: 'ignore' });
run('git', ['add', 'package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json']);
run('git', ['commit', '-m', `release: v${version}`]);
run('git', ['tag', `v${version}`]);
run('git', ['push', '--follow-tags']);
