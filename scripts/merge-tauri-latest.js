#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const [rootArg, tag, repo] = process.argv.slice(2);
if (!rootArg || !tag || !repo) {
  console.error('Usage: node scripts/merge-tauri-latest.js <dist-dir> <tag> <owner/repo>');
  process.exit(1);
}

const root = path.resolve(rootArg);
const releaseBase = `https://github.com/${repo}/releases/download/${tag}`;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return [full];
  });
}

function platformFromName(file) {
  const name = path.basename(file);
  if (name.includes('aarch64-apple-darwin')) return 'darwin-aarch64';
  if (name.includes('x86_64-apple-darwin')) return 'darwin-x86_64';
  if (name.includes('x86_64-pc-windows-msvc')) return 'windows-x86_64';
  throw new Error(`Cannot infer updater platform from ${name}`);
}

const assets = walk(root).filter((file) => file.endsWith('.app.tar.gz') || file.endsWith('.exe'));
if (!assets.length) {
  throw new Error('No updater assets found.');
}

const merged = {
  version: tag.replace(/^v/, ''),
  notes: '',
  pub_date: new Date().toISOString(),
  platforms: {},
};

for (const file of assets) {
  const platform = platformFromName(file);
  const signatureFile = `${file}.sig`;
  if (!fs.existsSync(signatureFile)) {
    throw new Error(`Missing updater signature for ${file}`);
  }
  const assetName = path.basename(file);
  merged.platforms[platform] = {
    signature: fs.readFileSync(signatureFile, 'utf8').trim(),
    url: `${releaseBase}/${assetName}`,
  };
}

fs.writeFileSync(path.join(root, 'latest.json'), `${JSON.stringify(merged, null, 2)}\n`);
