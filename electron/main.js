const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  fetchBahamutSeriesDetail,
  parseSearchResults,
} = require('./bahamut-catalog');

const API_ROOT = 'https://api.gamer.com.tw';
const SUPPORTED_GEOS = new Set(['TW', 'HK']);

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

  const response = await fetch(`${API_ROOT}/anime/v1/danmu.php?${params.toString()}`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      Referer: `https://ani.gamer.com.tw/animeVideo.php?sn=${videoSn}`,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) {
    throw new Error(`Bahamut API returned ${response.status}`);
  }

  return response.json();
}

async function searchBahamutAnime(keyword) {
  const body = `keyword=${encodeURIComponent(keyword)}`;
  const response = await fetch('https://ani.gamer.com.tw/search.php', {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: 'https://ani.gamer.com.tw',
      Referer: 'https://ani.gamer.com.tw/search.php',
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

  return fetchBahamutSeriesDetail(animeSn);
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

app.whenReady().then(() => {
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
