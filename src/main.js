const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  clipboard,
  shell,
  powerSaveBlocker,
  dialog,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const CFG = require('./config');

const APP_VERSION = require('../package.json').version;
const APP_BRAND = CFG.APP_BRAND;
const DISPATCHER_LIST = Array.isArray(CFG.DISPATCHER_URLS) ? CFG.DISPATCHER_URLS : [CFG.DISPATCHER_URLS];
const DETAIL_LOG_MAX = 200;
const EVENT_MAX = 12;

let win = null;
let tray = null;
let isQuitting = false;
let running = false;
let preventSleep = false;
let sleepBlockerId = null;
let currentStatus = { state: 'stopped', message: '未启动' };

let machineId = '';
let deviceSecret = '';
let clockSkewMs = 0;
let localSocksPort = CFG.LOCAL_SOCKS_HINT || 1080;
let currentDispatcherUrl = DISPATCHER_LIST[0] || 'http://127.0.0.1:8422';

let tunnelAssignment = null;
let tunnelChild = null;
let tunnelRetryTimer = null;
let tunnelRestarts = 0;
let tunnelStopFlag = false;
let lastFrpcError = '';

let socksChild = null;
let socksRetryTimer = null;
let socksRestarts = 0;
let socksStopFlag = false;

let hbTimer = null;
let statusPollTimer = null;
let progressStartAt = 0;
let lastReverseOk = false;
let assistCount = 0;
let shareEnabled = true;
let currentNetworkInfo = { ip: '', location: '', isp: '', updatedAt: 0 };
let updateDownloaded = false;

const eventBuf = [];
const detailLog = [];

function resourcesRoot() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
}

function pickBin(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const perPlatform = path.join(resourcesRoot(), 'bin', `${process.platform}-${process.arch}`, exe);
  if (fs.existsSync(perPlatform)) return perPlatform;
  return path.join(resourcesRoot(), 'bin', exe);
}

function redactLog(input) {
  let text = String(input || '');
  text = text.replace(/\x1B\[[0-9;]*m/g, '');
  for (const base of DISPATCHER_LIST) {
    try {
      const host = new URL(base).hostname;
      if (host) text = text.replaceAll(host, '****');
    } catch {}
  }
  text = text.replace(/\b[0-9a-f]{64}\b/gi, '[SECRET]');
  text = text.replace(/\b((?!127\.)\d{1,3}\.(?:\d{1,3}\.){2}\d{1,3})\b/g, '[IP]');
  text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[ID]');
  if (machineId) text = text.replaceAll(machineId, `${machineId.slice(0, 8)}...`);
  return text;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setStatus(state, message = '') {
  currentStatus = { state, message };
  send('status', { state, message, running });
  refreshTrayMenu();
  refreshDockMenu();
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    logDetail('update', '正在检查更新');
    send('update', { state: 'checking' });
  });
  autoUpdater.on('update-not-available', (info) => {
    logDetail('update', `当前已是最新版本 ${info?.version || APP_VERSION}`);
    send('update', { state: 'not-available', version: info?.version || APP_VERSION });
  });
  autoUpdater.on('update-available', (info) => {
    updateDownloaded = false;
    logDetail('update', `发现新版本 ${info.version}`);
    send('update-available', {
      version: info.version,
      currentVersion: APP_VERSION,
      notes: info.releaseNotes || '',
    });
    send('update', { state: 'available', version: info.version });
  });
  autoUpdater.on('download-progress', (progress) => {
    send('update', {
      state: 'downloading',
      percent: Math.round(progress.percent || 0),
      transferred: progress.transferred,
      total: progress.total,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    logDetail('update', `新版本 ${info.version} 已下载`);
    send('update', { state: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (error) => {
    if (isMissingUpdateFeed(error)) {
      logDetail('update', '暂未找到可用更新，已跳过自动更新检查');
      send('update', { state: 'not-available', version: APP_VERSION });
      return;
    }
    const message = formatUpdateError(error);
    logDetail('update', message);
    send('update', { state: 'error', message });
  });

  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 3000);
  } else {
    logDetail('update', '开发模式跳过自动更新检查');
  }
}

function formatUpdateError(error) {
  const message = error?.message || String(error);
  return message.split('\n')[0].slice(0, 240);
}

function isMissingUpdateFeed(error) {
  const message = error?.message || String(error);
  return /Unable to find latest version|Cannot parse releases feed|HttpError:\s*(404|406)/i.test(message);
}

function pushEvent(level, text) {
  const item = { ts: Date.now(), level, text };
  eventBuf.unshift(item);
  if (eventBuf.length > EVENT_MAX) eventBuf.length = EVENT_MAX;
  send('events', eventBuf);
  logDetail('event', `[${level}] ${text}`);
}

function logDetail(source, text) {
  const item = { ts: Date.now(), source, text: redactLog(text).replace(/\s+$/, '') };
  if (!item.text) return;
  detailLog.push(item);
  if (detailLog.length > DETAIL_LOG_MAX) detailLog.shift();
  send('detailLog', item);
  console.log(`[${source}]`, item.text);
}

function sendProgress(stage, tag) {
  if (stage === 1) progressStartAt = Date.now();
  const labels = ['', '分配编号', '建立连接', '验证连接', '就绪'];
  send('progress', {
    stage,
    percent: stage * 25,
    label: labels[stage] || '',
    elapsed_ms: progressStartAt ? Date.now() - progressStartAt : 0,
    tag,
  });
}

function deriveHardwareId() {
  try {
    if (process.platform === 'darwin') {
      const raw = execSync('ioreg -rd1 -c IOPlatformExpertDevice', { timeout: 2000 }).toString();
      const match = raw.match(/IOPlatformUUID"\s*=\s*"([0-9A-F-]+)"/i);
      if (match) return match[1].toLowerCase();
    }
    if (process.platform === 'linux') {
      try {
        const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
        if (id) return id;
      } catch {}
    }
    if (process.platform === 'win32') {
      const raw = execSync('wmic csproduct get UUID /value', { timeout: 2500 }).toString();
      const match = raw.match(/UUID=([0-9A-F-]+)/i);
      if (match && !match[1].startsWith('00000000')) return match[1].toLowerCase();
    }
  } catch {}
  return null;
}

function loadMachineId() {
  const file = path.join(app.getPath('userData'), 'machine_id');
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-zA-Z0-9-]{8,64}$/.test(value)) return value;
  } catch {}
  const id = deriveHardwareId() || crypto.randomUUID();
  try {
    fs.writeFileSync(file, id, { mode: 0o600 });
  } catch (error) {
    logDetail('machine', `保存 machine_id 失败: ${error.message}`);
  }
  return id;
}

function loadDeviceSecret() {
  try {
    const value = fs.readFileSync(path.join(app.getPath('userData'), 'device_secret'), 'utf8').trim();
    return /^[0-9a-f]{64}$/i.test(value) ? value : '';
  } catch {
    return '';
  }
}

function saveDeviceSecret(secret) {
  if (!/^[0-9a-f]{64}$/i.test(secret)) return;
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'device_secret'), secret, { mode: 0o600 });
  } catch (error) {
    logDetail('secret', `保存 device_secret 失败: ${error.message}`);
  }
}

function clearDeviceSecret() {
  deviceSecret = '';
  try {
    fs.rmSync(path.join(app.getPath('userData'), 'device_secret'), { force: true });
  } catch {}
}

function requestJsonOnce(method, urlString, body, secret, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === 'https:' ? https : http;
    const bodyText = body ? JSON.stringify(body) : '';
    const timestamp = Date.now() + clockSkewMs;
    const sig = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}\n${method}\n${url.pathname}\n${bodyText}`)
      .digest('hex');

    const req = mod.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'content-type': 'application/json',
        'x-timestamp': String(timestamp),
        'x-sig': sig,
        ...(bodyText ? { 'content-length': Buffer.byteLength(bodyText) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => {
        const dateHeader = res.headers.date;
        if (dateHeader) {
          const drift = new Date(dateHeader).getTime() - Date.now();
          if (Math.abs(drift) > 30000) clockSkewMs = drift;
        }
        let parsed = {};
        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          parsed = { raw };
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const error = new Error(`HTTP ${res.statusCode}: ${parsed.error || parsed.detail || raw}`);
          error.status = res.statusCode;
          error.detail = parsed.detail;
          reject(error);
        }
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

function publicJson(urlString, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: { accept: 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          resolve(raw ? JSON.parse(raw) : {});
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

async function refreshNetworkInfo(force = false) {
  if (!force && currentNetworkInfo.updatedAt && Date.now() - currentNetworkInfo.updatedAt < 5 * 60_000) {
    return currentNetworkInfo;
  }
  const providers = [
    async () => {
      const r = await publicJson('http://ip-api.com/json/?lang=zh-CN&fields=status,message,query,country,regionName,city,isp,org');
      if (r.status !== 'success') throw new Error(r.message || 'ip-api failed');
      return {
        ip: r.query || '',
        location: formatChineseLocation(r.regionName, r.city),
        isp: normalizeISP(r.isp || r.org || ''),
        updatedAt: Date.now(),
      };
    },
    async () => {
      const r = await publicJson('https://ipinfo.io/json');
      return {
        ip: r.ip || '',
        location: formatChineseLocation(r.region, r.city),
        isp: normalizeISP(r.org || ''),
        updatedAt: Date.now(),
      };
    },
  ];
  let lastError = null;
  for (const provider of providers) {
    try {
      const info = await provider();
      if (info.ip) {
        currentNetworkInfo = info;
        send('networkInfo', info);
        return info;
      }
    } catch (error) {
      lastError = error;
    }
  }
  logDetail('network', `公网 IP 查询失败: ${lastError?.message || 'unknown'}`);
  return currentNetworkInfo;
}

function formatChineseLocation(region, city) {
  const parts = [region, city]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (parts.length >= 2 && parts[0] === parts[1]) return parts[0];
  return parts.join(' ');
}

function normalizeISP(value) {
  let text = String(value || '').trim();
  text = text.replace(/^AS\d+\s+/i, '');
  const lower = text.toLowerCase();
  if (/china telecom|chinanet|ctcc|电信/i.test(text)) return '中国电信';
  if (/china unicom|unicom|cucc|联通/i.test(text)) return '中国联通';
  if (/china mobile|cmcc|移动/i.test(text)) return '中国移动';
  if (/cernet|教育网/i.test(text)) return '中国教育网';
  if (/tencent|腾讯/i.test(text)) return '腾讯云';
  if (/aliyun|alibaba|阿里/i.test(text)) return '阿里云';
  if (/huawei|华为/i.test(text)) return '华为云';
  if (/amazon|aws/i.test(text)) return 'AWS';
  if (/google/i.test(text)) return 'Google';
  if (/microsoft|azure/i.test(text)) return 'Azure';
  if (lower.includes('limited') || lower.includes('ltd')) {
    text = text.replace(/\b(limited|ltd\.?|inc\.?|co\.?)\b/gi, '').replace(/\s+/g, ' ').trim();
  }
  return text;
}

async function httpJson(method, pathOrUrl, body, timeoutMs = 8000, deviceScoped = false) {
  const secret = deviceScoped ? (deviceSecret || CFG.CLIENT_SECRET) : CFG.CLIENT_SECRET;
  if (!secret) throw new Error('缺少 CLIENT_SECRET，请配置 runtime-config.json');

  const targets = /^https?:\/\//.test(pathOrUrl)
    ? [pathOrUrl]
    : DISPATCHER_LIST.map((base) => base.replace(/\/$/, '') + pathOrUrl);
  const errors = [];
  for (const target of targets) {
    try {
      const result = await requestJsonOnce(method, target, body, secret, timeoutMs);
      try {
        currentDispatcherUrl = new URL(target).origin;
      } catch {}
      return result;
    } catch (error) {
      errors.push(`${target}: ${error.message}`);
      if (deviceScoped && error.status === 403) clearDeviceSecret();
      logDetail('http', `${method} ${redactLog(target)} 失败: ${error.message}`);
    }
  }
  const combined = errors.join(' ');
  if (/ENOTFOUND|getaddrinfo|dns/i.test(combined)) throw new Error('DNS 解析失败，请检查网络');
  if (/timeout|ETIMEDOUT/i.test(combined)) throw new Error('调度中心连接超时');
  if (/ECONNREFUSED/i.test(combined)) throw new Error('调度中心拒绝连接');
  throw new Error('无法连接到调度中心');
}

async function ensureLocalPort() {
  for (let port = localSocksPort; port < localSocksPort + 20; port++) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    if (free) {
      if (port !== localSocksPort) {
        pushEvent('info', `端口 ${localSocksPort} 被占用，已切到 ${port}`);
        localSocksPort = port;
      }
      return port;
    }
  }
  throw new Error(`无可用本地端口（${localSocksPort}-${localSocksPort + 19}）`);
}

function backoffDelay(count) {
  return [3000, 6000, 12000, 30000, 60000][Math.min(count, 4)];
}

function scheduleTunnelRestart(delayMs) {
  if (!running || tunnelStopFlag) return;
  clearTimeout(tunnelRetryTimer);
  tunnelRetryTimer = setTimeout(() => {
    tunnelRetryTimer = null;
    startTunnel();
  }, delayMs);
}

function scheduleSocksRestart(delayMs) {
  if (!running || socksStopFlag) return;
  clearTimeout(socksRetryTimer);
  socksRetryTimer = setTimeout(() => {
    socksRetryTimer = null;
    startLocalSocks();
  }, delayMs);
}

async function startLocalSocks() {
  if (socksChild || !running) return;
  try {
    await ensureLocalPort();
  } catch (error) {
    pushEvent('error', error.message);
    return;
  }

  const gostBin = pickBin('gost');
  if (!fs.existsSync(gostBin)) {
    pushEvent('error', `缺少 gost: ${gostBin}`);
    return;
  }

  const user = tunnelAssignment?.proxy_user;
  const pass = tunnelAssignment?.proxy_pass;
  const listen = user && pass
    ? `socks5://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@127.0.0.1:${localSocksPort}`
    : `socks5://127.0.0.1:${localSocksPort}`;
  logDetail('socks5', `spawn gost -L socks5://${user ? `${user}:***@` : ''}127.0.0.1:${localSocksPort}`);

  const child = spawn(gostBin, ['-L', listen], { stdio: ['ignore', 'pipe', 'pipe'] });
  socksChild = child;
  child.stdout.on('data', (data) => logDetail('socks5', data.toString().trimEnd()));
  child.stderr.on('data', (data) => logDetail('socks5', data.toString().trimEnd()));
  child.on('error', (error) => {
    logDetail('socks5', `启动失败: ${error.message}`);
    socksChild = null;
    socksRestarts++;
    scheduleSocksRestart(backoffDelay(socksRestarts - 1));
  });
  child.on('exit', (code) => {
    logDetail('socks5', `exit code=${code}`);
    socksChild = null;
    if (running && !socksStopFlag) {
      socksRestarts++;
      scheduleSocksRestart(backoffDelay(socksRestarts - 1));
    }
  });
  setTimeout(() => {
    if (socksChild === child) socksRestarts = 0;
  }, 30000);
}

function frpcConfigPath() {
  return path.join(app.getPath('userData'), 'frpc.toml');
}

function nextFrpcProxyName() {
  return `portnest-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function writeFrpcConfig(assignment, proxyName) {
  const config = [
    `serverAddr = "${assignment.server_ip}"`,
    `serverPort = ${assignment.server_port}`,
    `auth.method = "token"`,
    `auth.token = "${assignment.tunnel_psk}"`,
    `transport.tls.enable = true`,
    `transport.tls.disableCustomTLSFirstByte = true`,
    `transport.tls.serverName = "${assignment.tls_server_name || 'frp'}"`,
    `transport.tcpMux = true`,
    `transport.poolCount = 5`,
    `transport.heartbeatInterval = 15`,
    `transport.heartbeatTimeout = 60`,
    `loginFailExit = false`,
    `log.level = "info"`,
    '',
    '[[proxies]]',
    `name = "${proxyName}"`,
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${localSocksPort}`,
    `remotePort = ${assignment.remote_port}`,
    '',
  ].join('\n');
  const file = frpcConfigPath();
  fs.writeFileSync(file, config, { mode: 0o600 });
  return file;
}

async function registerWithDispatcher() {
  setStatus('connecting', '正在分配编号');
  sendProgress(1, 'register');
  logDetail('reg', `POST /register via ${redactLog(currentDispatcherUrl)}`);
  const assignment = await httpJson('POST', '/register', {
    machine_id: machineId,
    app_version: APP_VERSION,
    app_brand: APP_BRAND,
    os_platform: process.platform,
    os_arch: process.arch,
    hostname: os.hostname(),
  }, 10000);

  if (assignment.device_secret && /^[0-9a-f]{64}$/i.test(assignment.device_secret)) {
    deviceSecret = assignment.device_secret;
    saveDeviceSecret(assignment.device_secret);
  }
  assistCount = Number(assignment.assist_count || assistCount || 0);
  shareEnabled = assignment.share_enabled !== false;

  send('config', {
    code: assignment.code || '',
    gatewayHost: assignment.gateway_host || assignment.server_ip || '',
    gatewayPort: assignment.gateway_port || 1080,
    local_socks_port: localSocksPort,
    machineId: machineId,
    server: assignment.server_ip && assignment.server_port ? `${assignment.server_ip}:${assignment.server_port}` : '',
    verified_recent: !!assignment.verified_recent,
  });
  send('metrics', { assistCount, shareEnabled });
  refreshDockMenu();
  pushEvent('info', assignment.code ? `出口编号已就绪 (${assignment.code})` : '编号已分配');
  sendProgress(2, 'register_done');
  return assignment;
}

function diagnoseFrpcError(line) {
  const lower = line.toLowerCase();
  if (lower.includes('eof') || lower.includes('connection reset')) return '连接被中断，可能有代理或防火墙干扰';
  if (lower.includes('timeout')) return '连接远端超时，请检查网络';
  if (lower.includes('authentication')) return '隧道认证失败，正在重新注册';
  if (lower.includes('tls') || lower.includes('certificate')) return 'TLS 握手失败，请检查中间代理';
  return `连接失败：${line.slice(0, 80)}`;
}

async function reportNodeError(component, exitCode, errorText) {
  try {
    await httpJson('POST', '/node/report-error', {
      machine_id: machineId,
      component,
      exit_code: exitCode,
      error_msg: errorText,
    }, 5000, true);
  } catch {}
}

async function startTunnel() {
  if (!running || tunnelChild) return;
  if (!tunnelAssignment) {
    try {
      tunnelAssignment = await registerWithDispatcher();
    } catch (error) {
      pushEvent('error', '暂时无法接入服务，稍后自动重试');
      setStatus('reconnecting', error.message);
      logDetail('reg', `register 失败: ${error.message}`);
      scheduleTunnelRestart(backoffDelay(tunnelRestarts++));
      return;
    }
  }

  await startLocalSocks();

  const frpcBin = pickBin('frpc');
  if (!fs.existsSync(frpcBin)) {
    pushEvent('error', `缺少 frpc: ${frpcBin}`);
    return;
  }

  const proxyName = nextFrpcProxyName();
  const cfgPath = writeFrpcConfig(tunnelAssignment, proxyName);
  logDetail('tunnel', `spawn frpc -> ${tunnelAssignment.server_ip}:${tunnelAssignment.server_port} remote=${tunnelAssignment.remote_port} proxy=${proxyName}`);
  setStatus('connecting', '正在建立连接');

  const child = spawn(frpcBin, ['-c', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnelChild = child;
  let proxyReady = false;
  let loginSuccess = false;
  const connectTimer = setTimeout(() => {
    if (!proxyReady && tunnelChild === child) {
      pushEvent('warn', '连接超时，正在重试');
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }, 45000);

  const onLog = (data) => {
    const line = redactLog(data.toString().trimEnd());
    if (!line) return;
    logDetail('frpc', line);
    if (/login to server success/i.test(line)) {
      loginSuccess = true;
      lastFrpcError = '';
      tunnelRestarts = 0;
      sendProgress(3, 'tunnel_up');
      setStatus('connecting', '即将就绪');
    }
    if (!proxyReady && /start proxy success/i.test(line)) {
      proxyReady = true;
      clearTimeout(connectTimer);
      sendProgress(4, 'ready');
      setStatus('connected', '服务运行中');
      pushEvent('ok', '已就绪 · 服务运行中');
      send('probeStatus', { state: tunnelAssignment.verified_recent ? 'ok' : 'pending', startedAt: Date.now() });
      startStatusPoll();
    }
    if (/authentication failed|auth.*invalid/i.test(line)) {
      tunnelAssignment = null;
      pushEvent('warn', '隧道配置失效，正在重新接入');
      try {
        child.kill('SIGTERM');
      } catch {}
      return;
    }
    if (/proxy .*already exists|proxy name.*already/i.test(line)) {
      lastFrpcError = line.slice(0, 200);
      pushEvent('warn', '隧道名称冲突，正在重试');
      try {
        child.kill('SIGTERM');
      } catch {}
      return;
    }
    if (/connect to server error|failed|error/i.test(line)) {
      if (!loginSuccess) lastFrpcError = line.slice(0, 200);
      pushEvent('warn', diagnoseFrpcError(line));
    }
  };

  child.stdout.on('data', onLog);
  child.stderr.on('data', onLog);
  child.on('error', (error) => {
    clearTimeout(connectTimer);
    logDetail('frpc', `启动失败: ${error.message}`);
    tunnelChild = null;
    scheduleTunnelRestart(backoffDelay(tunnelRestarts++));
  });
  child.on('exit', (code) => {
    clearTimeout(connectTimer);
    logDetail('frpc', `exit code=${code}`);
    tunnelChild = null;
    stopStatusPoll();
    if (running && !tunnelStopFlag && code !== 0 && lastFrpcError) {
      reportNodeError('frpc', code, lastFrpcError);
    }
    if (running && !tunnelStopFlag) {
      const delay = backoffDelay(tunnelRestarts++);
      if (tunnelRestarts % 9 === 0) tunnelAssignment = null;
      setStatus('reconnecting', `${Math.ceil(delay / 1000)}s 后重试`);
      scheduleTunnelRestart(delay);
    }
  });
}

function startStatusPoll() {
  stopStatusPoll();
  const tick = async () => {
    if (!running || !tunnelAssignment) return;
    try {
      const result = await httpJson('GET', `/status?mid=${encodeURIComponent(machineId)}`, null, 6000, true);
      const probe = result.last_probe;
      if (!probe || probe.age_ms > 120000) return;
      if (probe.ok) {
        if (!lastReverseOk) send('probeStatus', { state: 'ok' });
        lastReverseOk = true;
      } else {
        lastReverseOk = false;
        send('probeStatus', { state: 'failed' });
      }
    } catch (error) {
      logDetail('status', error.message);
    }
  };
  tick();
  statusPollTimer = setInterval(tick, 20000);
}

function stopStatusPoll() {
  if (statusPollTimer) clearInterval(statusPollTimer);
  statusPollTimer = null;
  lastReverseOk = false;
}

async function heartbeat() {
  if (!running) return;
  try {
    const result = await httpJson('POST', '/heartbeat', { machine_id: machineId }, 5000, true);
    assistCount = Number(result.assist_count || assistCount || 0);
    if (typeof result.share_enabled === 'boolean') shareEnabled = result.share_enabled;
    send('metrics', { assistCount, shareEnabled });
  } catch (error) {
    logDetail('heartbeat', error.message);
    if (error.status === 404 || /not registered/i.test(error.message)) {
      tunnelAssignment = null;
      if (tunnelChild) tunnelChild.kill('SIGTERM');
    }
  }
}

async function start() {
  if (running) return { ok: true };
  running = true;
  tunnelStopFlag = false;
  socksStopFlag = false;
  tunnelRestarts = 0;
  socksRestarts = 0;
  setStatus('connecting', '正在连接服务');
  send('probeStatus', { state: 'pending' });
  refreshNetworkInfo(true).catch(() => {});
  await startTunnel();
  clearInterval(hbTimer);
  hbTimer = setInterval(heartbeat, 5 * 60 * 1000);
  setTimeout(heartbeat, 3000);
  return { ok: true };
}

async function stop() {
  running = false;
  tunnelStopFlag = true;
  socksStopFlag = true;
  clearTimeout(tunnelRetryTimer);
  clearTimeout(socksRetryTimer);
  clearInterval(hbTimer);
  hbTimer = null;
  stopStatusPoll();
  if (machineId) {
    httpJson('POST', '/node/offline', { machine_id: machineId }, 3000, true).catch(() => {});
  }
  if (tunnelChild) {
    try { tunnelChild.kill('SIGTERM'); } catch {}
    tunnelChild = null;
  }
  if (socksChild) {
    try { socksChild.kill('SIGTERM'); } catch {}
    socksChild = null;
  }
  setStatus('stopped', '已停止');
  send('probeStatus', { state: 'idle' });
  return { ok: true };
}

function probeBin(bin, args, regex) {
  return new Promise((resolve) => {
    if (!fs.existsSync(bin)) {
      resolve({ ok: false, error: `missing: ${bin}` });
      return;
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ ok: false, error: 'timeout' });
    }, 4000);
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && regex.test(output), output: output.trim(), code });
    });
  });
}

async function selfCheck() {
  const [dispatcher, gost, frpc] = await Promise.allSettled([
    httpJson('GET', '/health', null, 6000),
    probeBin(pickBin('gost'), ['-V'], /gost/i),
    probeBin(pickBin('frpc'), ['-v'], /\d+\.\d+\.\d+/),
  ]);
  return {
    dispatcher: dispatcher.status === 'fulfilled'
      ? { ok: true }
      : { ok: false, error: dispatcher.reason.message },
    gost: gost.status === 'fulfilled' ? gost.value : { ok: false, error: gost.reason.message },
    frpc: frpc.status === 'fulfilled' ? frpc.value : { ok: false, error: frpc.reason.message },
    local_socks_port: localSocksPort,
  };
}

async function buildDiagnostic() {
  return {
    app: { version: APP_VERSION, brand: APP_BRAND, platform: process.platform, arch: process.arch },
    dispatcher_list: DISPATCHER_LIST.map(redactLog),
    machine_id: machineId ? `${machineId.slice(0, 8)}...` : '',
    running,
    assignment: tunnelAssignment ? {
      server_ip: redactLog(tunnelAssignment.server_ip),
      server_port: tunnelAssignment.server_port,
      remote_port: tunnelAssignment.remote_port,
      gateway_host: redactLog(tunnelAssignment.gateway_host || ''),
      gateway_port: tunnelAssignment.gateway_port,
    } : null,
    self_check: await selfCheck(),
    recent_events: eventBuf,
    recent_logs: detailLog.slice(-80),
  };
}

function getState() {
  return {
    running,
    machineId,
    localSocksPort,
    assistCount,
    shareEnabled,
    hasClientSecret: !!CFG.CLIENT_SECRET,
    dispatcher: currentDispatcherUrl,
    networkInfo: currentNetworkInfo,
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 700,
    minWidth: 380,
    minHeight: 620,
    title: 'PortNest',
    backgroundColor: '#1c1c1e',
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
      pushEvent('info', '窗口已隐藏，可从状态栏恢复');
    }
  });
}

function trayIcon() {
  const candidates = [
    path.join(__dirname, 'renderer', 'statusbar-icon.png'),
    path.join(__dirname, 'renderer', 'icon.png'),
    path.join(resourcesRoot(), 'src', 'renderer', 'statusbar-icon.png'),
    path.join(resourcesRoot(), 'src', 'renderer', 'icon.png'),
    path.join(resourcesRoot(), 'icon.png'),
  ];
  const iconPath = candidates.find((item) => fs.existsSync(item));
  if (!iconPath) return nativeImage.createEmpty();
  const image = nativeImage.createFromPath(iconPath);
  const size = process.platform === 'darwin' ? 18 : 20;
  return image.resize({ width: size, height: size });
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 PortNest', click: () => { win?.show(); win?.focus(); } },
    { label: running ? '停止服务' : '启动服务', click: () => (running ? stop() : start()) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        stop().finally(() => app.quit());
      },
    },
  ]));
}

function statusLabel() {
  const map = {
    stopped: '未启动',
    connecting: '连接中',
    reconnecting: '重连中',
    connected: '运行中',
    error: '异常',
  };
  const text = map[currentStatus.state] || currentStatus.state || '未知';
  return currentStatus.message ? `${text} · ${currentStatus.message}` : text;
}

function dockMenuTemplate() {
  const code = tunnelAssignment?.code || '';
  const gatewayHost = tunnelAssignment?.gateway_host || tunnelAssignment?.server_ip || '';
  const gatewayPort = tunnelAssignment?.gateway_port || 1080;
  return [
    { label: `状态：${statusLabel()}`, enabled: false },
    { label: `出口编号：${code || '未分配'}`, enabled: false },
    { label: `本地 SOCKS5：127.0.0.1:${localSocksPort}`, enabled: false },
    { label: `网关：${gatewayHost ? `${gatewayHost}:${gatewayPort}` : '未分配'}`, enabled: false },
    { type: 'separator' },
    { label: '显示 PortNest', click: () => { win?.show(); win?.focus(); } },
    { label: running ? '停止服务' : '启动服务', click: () => (running ? stop() : start()) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        stop().finally(() => app.quit());
      },
    },
  ];
}

function refreshDockMenu() {
  if (process.platform !== 'darwin' || !app.dock) return;
  app.dock.setMenu(Menu.buildFromTemplate(dockMenuTemplate()));
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('PortNest');
  refreshTrayMenu();
  refreshDockMenu();
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else {
      win.show();
      win.focus();
    }
  });
}

function registerIpc() {
  ipcMain.handle('start', () => start());
  ipcMain.handle('stop', () => stop());
  ipcMain.handle('copy', (_event, text) => clipboard.writeText(String(text || '')));
  ipcMain.handle('getState', () => getState());
  ipcMain.handle('getEvents', () => eventBuf);
  ipcMain.handle('getDetailLog', () => detailLog.slice());
  ipcMain.handle('getNetworkInfo', () => refreshNetworkInfo(true));
  ipcMain.handle('runSelfCheck', () => selfCheck());
  ipcMain.handle('buildDiagnostic', () => buildDiagnostic());
  ipcMain.handle('toggleShare', async (_event, enabled) => {
    const result = await httpJson('POST', '/node/share', { machine_id: machineId, enabled: !!enabled }, 6000, true);
    shareEnabled = !!enabled;
    send('metrics', { assistCount, shareEnabled });
    return result;
  });
  ipcMain.handle('getEarnings', () => httpJson('GET', `/node/earnings?mid=${encodeURIComponent(machineId)}`, null, 6000, true));
  ipcMain.handle('checkForUpdates', () => autoUpdater.checkForUpdates());
  ipcMain.handle('downloadUpdate', () => autoUpdater.downloadUpdate());
  ipcMain.handle('installUpdate', async () => {
    if (!updateDownloaded) return { ok: false, error: 'update not downloaded' };
    isQuitting = true;
    await stop();
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });
  ipcMain.handle('openExternal', (_event, target) => {
    const url = String(target || '');
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  machineId = loadMachineId();
  deviceSecret = loadDeviceSecret();
  registerIpc();
  createWindow();
  createTray();
  setStatus('stopped', CFG.CLIENT_SECRET ? '未启动' : '缺少 CLIENT_SECRET');
  setupAutoUpdater();
  refreshNetworkInfo(true).catch(() => {});
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {});

app.on('activate', () => {
  if (!win) createWindow();
  win.show();
});

process.on('uncaughtException', (error) => {
  logDetail('fatal', error.stack || error.message);
  dialog.showErrorBox('PortNest 错误', error.message);
});

process.on('unhandledRejection', (error) => {
  logDetail('fatal', error?.stack || error?.message || String(error));
});
