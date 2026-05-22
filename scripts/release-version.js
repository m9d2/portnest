#!/usr/bin/env node

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

run('npm', ['version', version]);
run('git', ['push', '--follow-tags']);
