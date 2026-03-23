export type DanmuGeo = 'TW' | 'HK';

export type RawBahamutDanmu = {
  text: string;
  color: string;
  size: 0 | 1 | 2;
  position: 0 | 1 | 2;
  time: number;
  sn: number;
  userid: string;
};

export type BahamutDanmuResponse = {
  data?: {
    danmu?: RawBahamutDanmu[];
    totalCount?: number;
  };
  error?: {
    code?: number;
    message?: string;
  };
};

export type DanmakuItem = {
  sn: number;
  text: string;
  color: string;
  size: 0 | 1 | 2;
  position: 0 | 1 | 2;
  time: number;
  userId: string;
};

export type BahamutAnimeSearchResult = {
  animeSn: number;
  title: string;
  yearLabel: string;
  episodeCount: number;
  viewText: string;
  coverUrl: string;
  editionTags: string[];
};

export type BahamutAnimeEpisode = {
  videoSn: number;
  label: string;
  order: number;
  groupLabel: string;
};

export type BahamutAnimeEpisodeGroup = {
  label: string;
  episodes: BahamutAnimeEpisode[];
};

export type BahamutAnimeSeriesDetail = {
  animeSn: number;
  title: string;
  coverUrl: string;
  currentVideoSn: number | null;
  primaryEpisodeCount: number;
  totalSelectableCount: number;
  groups: BahamutAnimeEpisodeGroup[];
};

export const GEO_OPTIONS: Array<{ value: DanmuGeo; label: string; note: string }> = [
  { value: 'TW', label: '台湾源', note: '默认可用来源之一' },
  { value: 'HK', label: '香港源', note: '可与台湾源合并抓取' },
];

export const POSITION_LABELS: Record<DanmakuItem['position'], string> = {
  0: '滚动',
  1: '顶部',
  2: '底部',
};

export function parseBahamutVideoSn(input: string): number | null {
  const value = input.trim();

  if (!value) {
    return null;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const match = value.match(/[?&]sn=(\d+)/i);

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

export function normalizeDanmaku(input: RawBahamutDanmu[]): DanmakuItem[] {
  return [...input]
    .filter((item) => typeof item.text === 'string')
    .map((item) => ({
      sn: item.sn,
      text: item.text.replace(/\s+/g, ' ').trim() || '(空白弹幕)',
      color: item.color || '#FFFFFF',
      size: item.size ?? 1,
      position: item.position ?? 0,
      // Bahamut returns danmaku time in deciseconds.
      time: Math.max(0, (item.time ?? 0) / 10),
      userId: item.userid || 'unknown',
    }))
    .sort((left, right) => left.time - right.time || left.sn - right.sn);
}

export function formatClock(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  }

  return [minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export function buildDanmakuExport(args: {
  videoSn: number;
  geos: DanmuGeo[];
  totalCount: number;
  sourceInput: string;
  comments: DanmakuItem[];
}) {
  return JSON.stringify(
    {
      source: 'Bahamut Anime',
      fetchedAt: new Date().toISOString(),
      interface: 'https://api.gamer.com.tw/anime/v1/danmu.php',
      videoSn: args.videoSn,
      geos: args.geos,
      totalCount: args.totalCount,
      sourceInput: args.sourceInput,
      comments: args.comments,
    },
    null,
    2,
  );
}
