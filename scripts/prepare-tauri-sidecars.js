const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const targetDir = path.join(root, 'src-tauri', 'binaries');
const binaries = [
  ['bin/darwin-arm64/frpc', 'frpc-aarch64-apple-darwin'],
  ['bin/darwin-arm64/gost', 'gost-aarch64-apple-darwin'],
  ['bin/darwin-x64/frpc', 'frpc-x86_64-apple-darwin'],
  ['bin/darwin-x64/gost', 'gost-x86_64-apple-darwin'],
  ['bin/win32-x64/frpc.exe', 'frpc-x86_64-pc-windows-msvc.exe'],
  ['bin/win32-x64/gost.exe', 'gost-x86_64-pc-windows-msvc.exe'],
];

fs.mkdirSync(targetDir, { recursive: true });

let copied = 0;
for (const [fromRelative, toName] of binaries) {
  const from = path.join(root, fromRelative);
  const to = path.join(targetDir, toName);
  if (!fs.existsSync(from)) {
    throw new Error(`Missing sidecar binary: ${fromRelative}`);
  }
  const unchanged = fs.existsSync(to) && fs.readFileSync(from).equals(fs.readFileSync(to));
  if (!unchanged) {
    fs.copyFileSync(from, to);
    copied++;
  }
  if (process.platform !== 'win32' && !to.endsWith('.exe')) {
    const executable = (fs.statSync(to).mode & 0o111) !== 0;
    if (!executable) fs.chmodSync(to, 0o755);
  }
}

console.log(`Prepared ${binaries.length} Tauri sidecar binaries (${copied} updated).`);
