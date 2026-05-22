const fs = require('fs');
const path = require('path');
const { Arch } = require('builder-util');

function resourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`;
    return path.join(context.appOutDir, appName, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

function platformArchDirs(context) {
  const arch = Arch[context.arch] || String(context.arch);
  if (context.electronPlatformName === 'darwin' && arch === 'universal') {
    return ['darwin-x64', 'darwin-arm64'];
  }
  return [`${context.electronPlatformName}-${arch}`];
}

exports.default = async function afterPack(context) {
  const outBinRoot = path.join(resourcesDir(context), 'bin');
  fs.rmSync(outBinRoot, { recursive: true, force: true });

  for (const dir of platformArchDirs(context)) {
    const from = path.join(context.packager.projectDir, 'bin', dir);
    if (!fs.existsSync(from)) {
      throw new Error(`Missing tunnel binaries for ${dir}: ${from}`);
    }

    const to = path.join(outBinRoot, dir);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
};
