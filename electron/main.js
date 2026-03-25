const { app, BrowserWindow, dialog, ipcMain, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ProxyAgent, fetch: undiciFetch } = require('undici');
const {
  fetchBahamutSeriesDetail,
  parseSearchResults,
} = require('./bahamut-catalog');

const API_ROOT = 'https://api.gamer.com.tw';
const ANI_ROOT = 'https://ani.gamer.com.tw';
const PROXY_SETTINGS_FILE = 'proxy-settings.json';
const SUPPORTED_GEOS = new Set(['TW', 'HK']);

let currentProxySettings = createDefaultProxySettings();
const proxyAgentCache = new Map();

function createDefaultProxySettings() {
  return {
    mode: 'system',
    proxyRules: '',
    proxyBypassRules: '',
  };
}

function getProxySettingsPath() {
  return path.join(app.getPath('userData'), PROXY_SETTINGS_FILE);
}

function normalizeProxySettings() {
  return createDefaultProxySettings();
}

async function readStoredProxySettings() {
  try {
    const rawValue = await fs.readFile(getProxySettingsPath(), 'utf8');
    return normalizeProxySettings(JSON.parse(rawValue));
  } catch {
    return createDefaultProxySettings();
  }
}

async function writeStoredProxySettings(settings) {
  await fs.writeFile(getProxySettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function getNetworkSession() {
  return session.defaultSession;
}

function parseResolvedProxy(text) {
  const first = String(text || '')
    .split(';')
    .map((item) => item.trim())
    .find(Boolean);

  if (!first || first.toUpperCase() === 'DIRECT') {
    return null;
  }

  const match = first.match(/^(PROXY|HTTPS|SOCKS5|SOCKS4|SOCKS)\s+(.+)$/i);

  if (!match) {
    return null;
  }

  const scheme = match[1].toUpperCase();
  const target = match[2].trim();

  if (scheme === 'PROXY' || scheme === 'HTTPS') {
    return `http://${target}`;
  }

  if (scheme === 'SOCKS' || scheme === 'SOCKS5') {
    return `socks5://${target}`;
  }

  if (scheme === 'SOCKS4') {
    return `socks4://${target}`;
  }

  return null;
}

function getProxyDispatcher(proxyUrl) {
  if (!proxyUrl) {
    return undefined;
  }

  if (!proxyAgentCache.has(proxyUrl)) {
    proxyAgentCache.set(proxyUrl, new ProxyAgent(proxyUrl));
  }

  return proxyAgentCache.get(proxyUrl);
}

function buildElectronProxyConfig() {
  return {
    mode: 'system',
  };
}

async function resolveCurrentProxy() {
  const activeSession = getNetworkSession();
  const [aniProxy, apiProxy] = await Promise.all([
    activeSession.resolveProxy(`${ANI_ROOT}/`),
    activeSession.resolveProxy(`${API_ROOT}/anime/v1/danmu.php?videoSn=30418&geo=TW`),
  ]);

  return `ani=${aniProxy || 'DIRECT'} | api=${apiProxy || 'DIRECT'}`;
}

async function applyProxySettings(settings) {
  const normalized = normalizeProxySettings(settings);
  const proxyConfig = buildElectronProxyConfig();
  const activeSession = getNetworkSession();

  await activeSession.setProxy(proxyConfig);
  await activeSession.forceReloadProxyConfig();

  currentProxySettings = normalized;

  return {
    settings: normalized,
    resolvedProxy: await resolveCurrentProxy(),
  };
}

async function fetchWithSession(url, options = {}) {
  return getNetworkSession().fetch(url, options);
}

async function fetchWithResolvedProxy(url, options = {}) {
  const resolvedProxy = await getNetworkSession().resolveProxy(url);
  const proxyUrl = parseResolvedProxy(resolvedProxy);
  const dispatcher = getProxyDispatcher(proxyUrl);

  try {
    return await undiciFetch(url, {
      ...options,
      dispatcher,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    const hostname = new URL(url).hostname;
    throw new Error(`通过系统代理请求 ${hostname} 失败：${reason}`);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1280,
    minHeight: 820,
    backgroundColor: '#0d1414',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

async function fetchBahamutDanmaku(videoSn, geos) {
  const params = new URLSearchParams({
    videoSn: String(videoSn),
    geo: geos.join(','),
  });

  const response = await fetchWithResolvedProxy(
    `${API_ROOT}/anime/v1/danmu.php?${params.toString()}`,
    {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      Origin: ANI_ROOT,
      Referer: `${ANI_ROOT}/animeVideo.php?sn=${videoSn}`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    },
    },
  );

  if (!response.ok) {
    throw new Error(`Bahamut API returned ${response.status}`);
  }

  return response.json();
}

async function searchBahamutAnime(keyword) {
  const body = `keyword=${encodeURIComponent(keyword)}`;
  const response = await fetchWithSession(`${ANI_ROOT}/search.php`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: ANI_ROOT,
      Referer: `${ANI_ROOT}/search.php`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Bahamut search returned ${response.status}`);
  }

  const html = await response.text();
  return parseSearchResults(html);
}

ipcMain.handle('danmu:fetch', async (_event, payload) => {
  const videoSn = Number(payload?.videoSn);

  if (!Number.isInteger(videoSn) || videoSn <= 0) {
    throw new Error('Invalid videoSn.');
  }

  const requestedGeos = Array.isArray(payload?.geos) ? payload.geos : [];
  const geos = requestedGeos.filter((geo) => SUPPORTED_GEOS.has(geo));

  if (geos.length === 0) {
    throw new Error('At least one geo source is required.');
  }

  return fetchBahamutDanmaku(videoSn, geos);
});

ipcMain.handle('catalog:search', async (_event, payload) => {
  const keyword = typeof payload?.keyword === 'string' ? payload.keyword.trim() : '';

  if (!keyword) {
    return [];
  }

  return searchBahamutAnime(keyword);
});

ipcMain.handle('catalog:series-detail', async (_event, payload) => {
  const animeSn = Number(payload?.animeSn);

  if (!Number.isInteger(animeSn) || animeSn <= 0) {
    throw new Error('Invalid animeSn.');
  }

  return fetchBahamutSeriesDetail(animeSn, (url, options) => fetchWithSession(url, options));
});

ipcMain.handle('proxy:get-config', async () => {
  if (!currentProxySettings) {
    currentProxySettings = await readStoredProxySettings();
  }

  return {
    settings: currentProxySettings,
    resolvedProxy: await resolveCurrentProxy(),
  };
});

ipcMain.handle('proxy:set-config', async (_event, payload) => {
  const result = await applyProxySettings(payload);
  await writeStoredProxySettings(result.settings);
  return result;
});

ipcMain.handle('danmu:save-json', async (_event, payload) => {
  const defaultFileName =
    typeof payload?.defaultFileName === 'string' && payload.defaultFileName.trim()
      ? payload.defaultFileName.trim()
      : 'bahamut-danmaku.json';

  if (typeof payload?.content !== 'string' || payload.content.length === 0) {
    throw new Error('No JSON content to save.');
  }

  const result = await dialog.showSaveDialog({
    defaultPath: defaultFileName,
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return {
      canceled: true,
    };
  }

  await fs.writeFile(result.filePath, payload.content, 'utf8');

  return {
    canceled: false,
    filePath: result.filePath,
  };
});

app.whenReady().then(async () => {
  currentProxySettings = await readStoredProxySettings();

  try {
    await applyProxySettings(currentProxySettings);
  } catch {
    const fallbackSettings = createDefaultProxySettings();
    currentProxySettings = fallbackSettings;
    await applyProxySettings(fallbackSettings);
    await writeStoredProxySettings(fallbackSettings);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
