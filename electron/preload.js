const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  searchAnime(keyword) {
    return ipcRenderer.invoke('catalog:search', { keyword });
  },
  fetchAnimeSeries(animeSn) {
    return ipcRenderer.invoke('catalog:series-detail', { animeSn });
  },
  fetchDanmu(videoSn, geos) {
    return ipcRenderer.invoke('danmu:fetch', { videoSn, geos });
  },
  saveDanmakuJson(defaultFileName, content) {
    return ipcRenderer.invoke('danmu:save-json', { defaultFileName, content });
  },
});
