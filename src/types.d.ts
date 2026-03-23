import type {
  BahamutAnimeSearchResult,
  BahamutAnimeSeriesDetail,
  BahamutDanmuResponse,
  DanmuGeo,
} from './lib/bahamut';

declare global {
  interface Window {
    desktopApi: {
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
