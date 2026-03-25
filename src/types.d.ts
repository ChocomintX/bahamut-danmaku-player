import type {
  BahamutAnimeSearchResult,
  BahamutAnimeSeriesDetail,
  BahamutDanmuResponse,
  DanmuGeo,
} from './lib/bahamut';

type ProxyMode = 'system';

type ProxySettings = {
  mode: ProxyMode;
  proxyRules: string;
  proxyBypassRules: string;
};

declare global {
  interface Window {
    desktopApi: {
      getProxyConfig: () => Promise<{
        settings: ProxySettings;
        resolvedProxy: string;
      }>;
      setProxyConfig: (settings: ProxySettings) => Promise<{
        settings: ProxySettings;
        resolvedProxy: string;
      }>;
      searchAnime: (keyword: string) => Promise<BahamutAnimeSearchResult[]>;
      fetchAnimeSeries: (animeSn: number) => Promise<BahamutAnimeSeriesDetail>;
      fetchDanmu: (videoSn: number, geos: DanmuGeo[]) => Promise<BahamutDanmuResponse>;
      saveDanmakuJson: (
        defaultFileName: string,
        content: string,
      ) => Promise<{ canceled: boolean; filePath?: string }>;
    };
  }
}

export {};
