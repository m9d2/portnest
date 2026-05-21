const fs = require('fs');
const path = require('path');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function readDotEnv(file) {
  try {
    const out = {};
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function normalizeBrand(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(text) ? text : 'local';
}

const runtime = readJson(path.join(__dirname, '..', 'runtime-config.json'));
const localEnv = readDotEnv(path.join(__dirname, '..', '.env.local'));
const get = (key) => process.env[key] || runtime[key] || localEnv[key] || '';

module.exports = {
  DISPATCHER_URLS: get('DISPATCHER_URLS')
    ? get('DISPATCHER_URLS').split(',').map((item) => item.trim()).filter(Boolean)
    : ['http://127.0.0.1:8422'],
  CLIENT_SECRET: get('CLIENT_SECRET') || get('SERVICE_TOKEN'),
  APP_BRAND: normalizeBrand(get('APP_BRAND') || get('UPDATE_CHANNEL')),
  LOCAL_SOCKS_HINT: Number(get('LOCAL_SOCKS_HINT')) || 1080,
};
