const fs = require('fs');
const path = require('path');

const config = {
  DISPATCHER_URLS: process.env.DISPATCHER_URLS || 'http://127.0.0.1:8422',
  CLIENT_SECRET: process.env.CLIENT_SECRET || '',
  APP_BRAND: process.env.APP_BRAND || 'portnest',
  LOCAL_SOCKS_HINT: Number(process.env.LOCAL_SOCKS_HINT || 1080),
};

fs.writeFileSync(
  path.join(__dirname, '..', 'runtime-config.json'),
  `${JSON.stringify(config, null, 2)}\n`,
  { mode: 0o600 },
);

console.log(`runtime-config.json written for ${config.DISPATCHER_URLS}`);
