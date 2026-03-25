import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import DanmakuOverlay from './components/DanmakuOverlay';
import PlayerControls from './components/PlayerControls';
import './App.css';
import * as OpenCC from 'opencc-js';
import {
  buildDanmakuExport,
  formatClock,
  normalizeDanmaku,
  parseBahamutVideoSn,
  type BahamutAnimeEpisode,
  type BahamutAnimeEpisodeGroup,
  type BahamutAnimeSearchResult,
  type BahamutAnimeSeriesDetail,
  type BahamutDanmuResponse,
  type DanmakuItem,
  type DanmuGeo,
} from './lib/bahamut';
import type { OverlaySettings } from './lib/danmaku-layout';

const SETTINGS_KEY = 'bahamut-danmaku-local-player/settings';
const HOLD_DELAY_MS = 220;
const TAP_SEEK_SECONDS = 5;
const REWIND_INTERVAL_MS = 100;
const REWIND_STEP_SECONDS = 0.2;
const OFFSET_LIMIT_SECONDS = 60;
const FULLSCREEN_IDLE_MS = 2200;
const VIDEO_FILE_EXTENSION = /\.(mp4|m4v|mkv|avi|mov|wmv|webm|mpeg|mpg|ts|m2ts|flv)$/i;
const NAME_COLLATOR = new Intl.Collator('zh-Hans', {
  numeric: true,
  sensitivity: 'base',
});
const DEFAULT_DANMAKU_GEOS: DanmuGeo[] = ['TW', 'HK'];

type PlayerSettings = OverlaySettings & { geos: DanmuGeo[]; convertToSimplified: boolean };
type HoldDirection = 'forward' | 'backward';
type TransportMode = 'normal' | 'fast-forward' | 'rewind';
type SourceMode = 'search' | 'manual';
type LeftStep = 'video' | 'source';

type LocalVideoItem = {
  id: string;
  key: string;
  file: File;
  url: string;
  inferredEpisodeNumber: number | null;
};

type MappedLocalVideo = LocalVideoItem & {
  matchedEpisode: BahamutAnimeEpisode | null;
};

const DEFAULT_SETTINGS: PlayerSettings = {
  opacity: 88,
  sizeScale: 1,
  speedMultiplier: 1,
  timeOffsetSeconds: 0,
  showRolling: true,
  showTop: true,
  showBottom: true,
  convertToSimplified: false,
  geos: DEFAULT_DANMAKU_GEOS,
};

const tradToSimplifiedConverter = OpenCC.Converter({ from: 'tw', to: 'cn' });
const hkToSimplifiedConverter = OpenCC.Converter({ from: 'hk', to: 'cn' });

function readFiniteNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundOffset(value: number) {
  return Math.round(value * 10) / 10;
}

function clampOffset(value: number) {
  return Math.max(-OFFSET_LIMIT_SECONDS, Math.min(OFFSET_LIMIT_SECONDS, roundOffset(value)));
}

function normalizeGeos(value: unknown): DanmuGeo[] {
  if (!Array.isArray(value)) {
    return DEFAULT_SETTINGS.geos;
  }

  const normalized: DanmuGeo[] = [];

  for (const item of value) {
    if ((item === 'TW' || item === 'HK') && !normalized.includes(item)) {
      normalized.push(item);
    }
  }

  return normalized.length > 0 ? normalized : DEFAULT_SETTINGS.geos;
}

function formatOffsetLabel(seconds: number) {
  const safeValue = clampOffset(seconds);

  if (Math.abs(safeValue) < 0.05) {
    return '0.0s';
  }

  return `${safeValue > 0 ? '+' : ''}${safeValue.toFixed(1)}s`;
}

function clampMediaTime(video: HTMLVideoElement, nextTime: number) {
  if (Number.isFinite(video.duration)) {
    return Math.min(video.duration, Math.max(0, nextTime));
  }

  return Math.max(0, nextTime);
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

function readStoredSettings(): PlayerSettings {
  const rawValue = window.localStorage.getItem(SETTINGS_KEY);

  if (!rawValue) {
    return DEFAULT_SETTINGS;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<PlayerSettings>;

    return {
      opacity: readFiniteNumber(parsed.opacity, DEFAULT_SETTINGS.opacity),
      sizeScale: readFiniteNumber(parsed.sizeScale, DEFAULT_SETTINGS.sizeScale),
      speedMultiplier: readFiniteNumber(
        parsed.speedMultiplier,
        DEFAULT_SETTINGS.speedMultiplier,
      ),
      timeOffsetSeconds: clampOffset(
        readFiniteNumber(parsed.timeOffsetSeconds, DEFAULT_SETTINGS.timeOffsetSeconds),
      ),
      showRolling: parsed.showRolling ?? DEFAULT_SETTINGS.showRolling,
      showTop: parsed.showTop ?? DEFAULT_SETTINGS.showTop,
      showBottom: parsed.showBottom ?? DEFAULT_SETTINGS.showBottom,
      convertToSimplified:
        parsed.convertToSimplified ?? DEFAULT_SETTINGS.convertToSimplified,
      geos: normalizeGeos(parsed.geos),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function formatFileSize(bytes: number) {
  const mb = bytes / 1024 / 1024;

  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }

  return `${mb.toFixed(1)} MB`;
}

function extractEpisodeNumber(text: string) {
  const normalized = text.replace(/\.[^.]+$/, '');
  const directPatterns = [
    /第\s*0*(\d{1,3})(?:\s*[話话集回])/i,
    /\b(?:ep?|episode)[\s._-]*0*(\d{1,3})\b/i,
  ];

  for (const pattern of directPatterns) {
    const match = normalized.match(pattern);

    if (match) {
      return Number(match[1]);
    }
  }

  const fallbackCandidates = [...normalized.matchAll(/\b0*(\d{1,3})\b/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value > 0 && value < 200);

  return fallbackCandidates.length > 0 ? fallbackCandidates[fallbackCandidates.length - 1] : null;
}

function compareLocalVideos(left: LocalVideoItem, right: LocalVideoItem) {
  if (left.inferredEpisodeNumber !== null && right.inferredEpisodeNumber !== null) {
    if (left.inferredEpisodeNumber !== right.inferredEpisodeNumber) {
      return left.inferredEpisodeNumber - right.inferredEpisodeNumber;
    }
  } else if (left.inferredEpisodeNumber !== null) {
    return -1;
  } else if (right.inferredEpisodeNumber !== null) {
    return 1;
  }

  return NAME_COLLATOR.compare(left.file.name, right.file.name);
}

function mapVideosToEpisodes(
  videos: LocalVideoItem[],
  group: BahamutAnimeEpisodeGroup | null,
): MappedLocalVideo[] {
  if (!group || group.episodes.length === 0) {
    return videos.map((video) => ({
      ...video,
      matchedEpisode: null,
    }));
  }

  const episodeByNumber = new Map<number, BahamutAnimeEpisode>();

  for (const episode of group.episodes) {
    const episodeNumber = extractEpisodeNumber(episode.label);

    if (episodeNumber !== null && !episodeByNumber.has(episodeNumber)) {
      episodeByNumber.set(episodeNumber, episode);
    }
  }

  const assignedEpisodeSns = new Set<number>();
  const directMatches = new Map<string, BahamutAnimeEpisode>();

  for (const video of videos) {
    if (video.inferredEpisodeNumber === null) {
      continue;
    }

    const matchedEpisode = episodeByNumber.get(video.inferredEpisodeNumber);

    if (matchedEpisode && !assignedEpisodeSns.has(matchedEpisode.videoSn)) {
      directMatches.set(video.id, matchedEpisode);
      assignedEpisodeSns.add(matchedEpisode.videoSn);
    }
  }

  const remainingEpisodes = group.episodes.filter((episode) => !assignedEpisodeSns.has(episode.videoSn));
  let fallbackIndex = 0;

  return videos.map((video) => {
    const directMatched = directMatches.get(video.id) ?? null;

    if (directMatched) {
      return {
        ...video,
        matchedEpisode: directMatched,
      };
    }

    if (video.inferredEpisodeNumber === null && fallbackIndex < remainingEpisodes.length) {
      const fallbackEpisode = remainingEpisodes[fallbackIndex];
      fallbackIndex += 1;

      return {
        ...video,
        matchedEpisode: fallbackEpisode,
      };
    }

    return {
      ...video,
      matchedEpisode: null,
    };
  });
}

function isVideoFile(file: File) {
  return file.type.startsWith('video/') || VIDEO_FILE_EXTENSION.test(file.name);
}

function buildLocalVideoItem(file: File): LocalVideoItem {
  const key = `${file.name}:${file.size}:${file.lastModified}`;

  return {
    id: `${key}:${Math.random().toString(36).slice(2, 10)}`,
    key,
    file,
    url: URL.createObjectURL(file),
    inferredEpisodeNumber: extractEpisodeNumber(file.name),
  };
}

function describeEpisodeMatch(item: MappedLocalVideo, activeGroup: BahamutAnimeEpisodeGroup | null) {
  if (item.matchedEpisode) {
    return `${item.matchedEpisode.groupLabel} 第 ${item.matchedEpisode.label} 集`;
  }

  if (item.inferredEpisodeNumber !== null) {
    return activeGroup
      ? `文件名推测第 ${item.inferredEpisodeNumber} 集，当前分组未匹配`
      : `文件名推测第 ${item.inferredEpisodeNumber} 集`;
  }

  return activeGroup ? '未能从文件名匹配当前分组' : '等待选择番剧后自动匹配';
}

function findEpisodeBySn(series: BahamutAnimeSeriesDetail | null, videoSn: number | null) {
  if (!series || !videoSn) {
    return null;
  }

  for (const group of series.groups) {
    const episode = group.episodes.find((item) => item.videoSn === videoSn);

    if (episode) {
      return episode;
    }
  }

  return null;
}

function convertDanmakuTextToSimplified(text: string) {
  return hkToSimplifiedConverter(tradToSimplifiedConverter(text));
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const playerStageRef = useRef<HTMLDivElement | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const heldDirectionRef = useRef<HoldDirection | null>(null);
  const rewindIntervalRef = useRef<number | null>(null);
  const fullscreenChromeTimerRef = useRef<number | null>(null);
  const stageClickTimerRef = useRef<number | null>(null);
  const playbackRateBeforeHoldRef = useRef(1);
  const wasPausedBeforeHoldRef = useRef(true);
  const transportModeRef = useRef<TransportMode>('normal');
  const previousLocalVideosRef = useRef<LocalVideoItem[]>([]);

  const [searchKeyword, setSearchKeyword] = useState('');
  const [searchResults, setSearchResults] = useState<BahamutAnimeSearchResult[]>([]);
  const [selectedSearchResult, setSelectedSearchResult] = useState<BahamutAnimeSearchResult | null>(
    null,
  );
  const [leftStep, setLeftStep] = useState<LeftStep>('video');
  const [sourceMode, setSourceMode] = useState<SourceMode>('search');
  const [selectedSeries, setSelectedSeries] = useState<BahamutAnimeSeriesDetail | null>(null);
  const [selectedGroupIndex, setSelectedGroupIndex] = useState(0);
  const [selectedEpisodeSn, setSelectedEpisodeSn] = useState<number | null>(null);
  const [sourceInput, setSourceInput] = useState('');
  const [videoSn, setVideoSn] = useState<number | null>(null);
  const [comments, setComments] = useState<DanmakuItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [statusText, setStatusText] = useState(
    '先导入一个或多个本地视频，再搜索番剧或输入动画疯视频 SN。',
  );
  const [errorText, setErrorText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingSeries, setIsLoadingSeries] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [settings, setSettings] = useState<PlayerSettings>(() => readStoredSettings());
  const [offsetInput, setOffsetInput] = useState(() =>
    DEFAULT_SETTINGS.timeOffsetSeconds.toFixed(1),
  );
  const [localVideos, setLocalVideos] = useState<LocalVideoItem[]>([]);
  const [activeLocalVideoId, setActiveLocalVideoId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showFullscreenChrome, setShowFullscreenChrome] = useState(true);
  const [transportMode, setTransportMode] = useState<TransportMode>('normal');
  const [playerCurrentTime, setPlayerCurrentTime] = useState(0);
  const [playerDuration, setPlayerDuration] = useState(0);
  const [playerVolume, setPlayerVolume] = useState(1);
  const [playerMuted, setPlayerMuted] = useState(false);
  const [playerPlaying, setPlayerPlaying] = useState(false);
  const [showPlayerSettings, setShowPlayerSettings] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    setOffsetInput(settings.timeOffsetSeconds.toFixed(1));
  }, [settings.timeOffsetSeconds]);

  useEffect(() => {
    const previousItems = previousLocalVideosRef.current;
    const currentIds = new Set(localVideos.map((item) => item.id));

    for (const item of previousItems) {
      if (!currentIds.has(item.id)) {
        URL.revokeObjectURL(item.url);
      }
    }

    previousLocalVideosRef.current = localVideos;
  }, [localVideos]);

  useEffect(() => {
    return () => {
      clearStageClickTimer();

      for (const item of previousLocalVideosRef.current) {
        URL.revokeObjectURL(item.url);
      }
    };
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === playerStageRef.current);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    handleFullscreenChange();

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!isFullscreen) {
      clearFullscreenChromeTimer();
      setShowFullscreenChrome(true);
      return undefined;
    }

    revealFullscreenChrome();

    return () => {
      clearFullscreenChromeTimer();
    };
  }, [isFullscreen, activeLocalVideoId]);

  const activeEpisodeGroup = selectedSeries?.groups[selectedGroupIndex] ?? null;
  const sortedLocalVideos = useMemo(
    () => [...localVideos].sort(compareLocalVideos),
    [localVideos],
  );
  const mappedLocalVideos = useMemo(
    () => mapVideosToEpisodes(sortedLocalVideos, activeEpisodeGroup),
    [sortedLocalVideos, activeEpisodeGroup],
  );

  useEffect(() => {
    if (mappedLocalVideos.length === 0) {
      if (activeLocalVideoId !== null) {
        setActiveLocalVideoId(null);
      }
      return;
    }

    if (!activeLocalVideoId || !mappedLocalVideos.some((item) => item.id === activeLocalVideoId)) {
      setActiveLocalVideoId(mappedLocalVideos[0].id);
    }
  }, [mappedLocalVideos, activeLocalVideoId]);

  const activeLocalVideo =
    mappedLocalVideos.find((item) => item.id === activeLocalVideoId) ?? mappedLocalVideos[0] ?? null;
  const displayComments = useMemo(
    () =>
      settings.convertToSimplified
        ? comments.map((item) => ({
            ...item,
            text: convertDanmakuTextToSimplified(item.text),
          }))
        : comments,
    [comments, settings.convertToSimplified],
  );
  const maxCommentTime = comments.at(-1)?.time ?? 0;
  const selectedEpisode = findEpisodeBySn(selectedSeries, selectedEpisodeSn);
  const matchedVideoCount = mappedLocalVideos.filter((item) => item.matchedEpisode).length;

  const modeCounts = useMemo(
    () =>
      comments.reduce<Record<DanmakuItem['position'], number>>(
        (result, item) => {
          result[item.position] += 1;
          return result;
        },
        { 0: 0, 1: 0, 2: 0 },
      ),
    [comments],
  );

  const transportLabel =
    transportMode === 'fast-forward'
      ? '2x 快进中'
      : transportMode === 'rewind'
        ? '2x 倒退中'
        : '弹幕同步播放';

  function setTransportState(mode: TransportMode) {
    transportModeRef.current = mode;
    setTransportMode(mode);
  }

  function clearHoldTimer() {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }

  function clearRewindInterval() {
    if (rewindIntervalRef.current !== null) {
      window.clearInterval(rewindIntervalRef.current);
      rewindIntervalRef.current = null;
    }
  }

  function clearFullscreenChromeTimer() {
    if (fullscreenChromeTimerRef.current !== null) {
      window.clearTimeout(fullscreenChromeTimerRef.current);
      fullscreenChromeTimerRef.current = null;
    }
  }

  function clearStageClickTimer() {
    if (stageClickTimerRef.current !== null) {
      window.clearTimeout(stageClickTimerRef.current);
      stageClickTimerRef.current = null;
    }
  }

  function revealFullscreenChrome() {
    setShowFullscreenChrome(true);

    if (!isFullscreen) {
      clearFullscreenChromeTimer();
      return;
    }

    clearFullscreenChromeTimer();
    fullscreenChromeTimerRef.current = window.setTimeout(() => {
      setShowFullscreenChrome(false);
    }, FULLSCREEN_IDLE_MS);
  }

  function seekVideoBy(deltaSeconds: number) {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    video.currentTime = clampMediaTime(video, video.currentTime + deltaSeconds);
  }

  function seekVideoTo(nextTime: number) {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    video.currentTime = clampMediaTime(video, nextTime);
  }

  function togglePlayback() {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    if (video.paused) {
      void video.play().catch(() => {});
      return;
    }

    video.pause();
  }

  function setVideoVolume(nextVolume: number) {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    const safeVolume = Math.max(0, Math.min(1, nextVolume));
    video.volume = safeVolume;
    video.muted = safeVolume === 0;
  }

  function toggleMute() {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    video.muted = !video.muted;

    if (!video.muted && video.volume === 0) {
      video.volume = 0.7;
    }
  }

  function startHeldTransport(direction: HoldDirection) {
    const video = videoRef.current;

    if (!video) {
      return;
    }

    playbackRateBeforeHoldRef.current = video.playbackRate || 1;
    wasPausedBeforeHoldRef.current = video.paused;

    if (direction === 'forward') {
      clearRewindInterval();
      setTransportState('fast-forward');
      video.playbackRate = 2;

      if (video.paused && !video.ended) {
        void video.play().catch(() => {});
      }

      return;
    }

    if (!video.paused) {
      video.pause();
    }

    video.playbackRate = playbackRateBeforeHoldRef.current;
    clearRewindInterval();
    setTransportState('rewind');

    rewindIntervalRef.current = window.setInterval(() => {
      const currentVideo = videoRef.current;

      if (!currentVideo) {
        return;
      }

      currentVideo.currentTime = clampMediaTime(
        currentVideo,
        currentVideo.currentTime - REWIND_STEP_SECONDS,
      );
    }, REWIND_INTERVAL_MS);
  }

  function stopHeldTransport() {
    clearHoldTimer();

    const video = videoRef.current;
    const mode = transportModeRef.current;

    if (mode === 'fast-forward' && video) {
      video.playbackRate = playbackRateBeforeHoldRef.current;

      if (wasPausedBeforeHoldRef.current) {
        video.pause();
      }
    }

    if (mode === 'rewind') {
      clearRewindInterval();

      if (video) {
        video.playbackRate = playbackRateBeforeHoldRef.current;

        if (!wasPausedBeforeHoldRef.current && !video.ended) {
          void video.play().catch(() => {});
        }
      }
    }

    heldDirectionRef.current = null;
    setTransportState('normal');
  }

  function queueHeldTransport(direction: HoldDirection) {
    clearHoldTimer();
    heldDirectionRef.current = direction;

    holdTimerRef.current = window.setTimeout(() => {
      if (heldDirectionRef.current === direction) {
        startHeldTransport(direction);
      }
    }, HOLD_DELAY_MS);
  }

  async function toggleFullscreen() {
    const playerStage = playerStageRef.current;

    if (!playerStage) {
      return;
    }

    try {
      if (document.fullscreenElement === playerStage) {
        await document.exitFullscreen();
        return;
      }

      if (document.fullscreenElement && document.fullscreenElement !== playerStage) {
        await document.exitFullscreen();
      }

      await playerStage.requestFullscreen();
      setErrorText('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '切换全屏失败。';
      setErrorText(message);
    }
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }

      if (event.code === 'Space' || event.key.toLowerCase() === 'k') {
        if (videoRef.current) {
          event.preventDefault();
          togglePlayback();
        }
        return;
      }

      if (event.key.toLowerCase() === 'm') {
        if (videoRef.current) {
          event.preventDefault();
          toggleMute();
        }
        return;
      }

      if (event.key.toLowerCase() === 'f') {
        if (playerStageRef.current) {
          event.preventDefault();
          void toggleFullscreen();
        }
        return;
      }

      const direction =
        event.key === 'ArrowRight'
          ? 'forward'
          : event.key === 'ArrowLeft'
            ? 'backward'
            : null;

      if (!direction || !videoRef.current) {
        return;
      }

      event.preventDefault();

      if (heldDirectionRef.current === direction) {
        return;
      }

      stopHeldTransport();
      queueHeldTransport(direction);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const direction =
        event.key === 'ArrowRight'
          ? 'forward'
          : event.key === 'ArrowLeft'
            ? 'backward'
            : null;

      if (!direction || heldDirectionRef.current !== direction) {
        return;
      }

      event.preventDefault();
      clearHoldTimer();

      if (transportModeRef.current === 'normal') {
        heldDirectionRef.current = null;
        seekVideoBy(direction === 'forward' ? TAP_SEEK_SECONDS : -TAP_SEEK_SECONDS);
        return;
      }

      stopHeldTransport();
    };

    const handleBlur = () => {
      stopHeldTransport();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopHeldTransport();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopHeldTransport();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return undefined;
    }

    const handleStopped = () => {
      stopHeldTransport();
    };

    video.addEventListener('ended', handleStopped);
    video.addEventListener('emptied', handleStopped);

    return () => {
      video.removeEventListener('ended', handleStopped);
      video.removeEventListener('emptied', handleStopped);
      stopHeldTransport();
    };
  }, [activeLocalVideo?.url]);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      setPlayerCurrentTime(0);
      setPlayerDuration(0);
      setPlayerPlaying(false);
      return undefined;
    }

    const syncState = () => {
      setPlayerCurrentTime(video.currentTime || 0);
      setPlayerDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setPlayerVolume(video.volume);
      setPlayerMuted(video.muted);
      setPlayerPlaying(!video.paused && !video.ended);
    };

    video.addEventListener('play', syncState);
    video.addEventListener('pause', syncState);
    video.addEventListener('timeupdate', syncState);
    video.addEventListener('seeking', syncState);
    video.addEventListener('seeked', syncState);
    video.addEventListener('durationchange', syncState);
    video.addEventListener('loadedmetadata', syncState);
    video.addEventListener('volumechange', syncState);
    video.addEventListener('ended', syncState);

    syncState();

    return () => {
      video.removeEventListener('play', syncState);
      video.removeEventListener('pause', syncState);
      video.removeEventListener('timeupdate', syncState);
      video.removeEventListener('seeking', syncState);
      video.removeEventListener('seeked', syncState);
      video.removeEventListener('durationchange', syncState);
      video.removeEventListener('loadedmetadata', syncState);
      video.removeEventListener('volumechange', syncState);
      video.removeEventListener('ended', syncState);
    };
  }, [activeLocalVideo?.url]);

  useEffect(() => {
    if (!activeEpisodeGroup || activeEpisodeGroup.episodes.length === 0) {
      return;
    }

    if (activeEpisodeGroup.episodes.some((episode) => episode.videoSn === selectedEpisodeSn)) {
      return;
    }

    const firstEpisode = activeEpisodeGroup.episodes[0];
    setSelectedEpisodeSn(firstEpisode.videoSn);
    setSourceInput(String(firstEpisode.videoSn));
  }, [activeEpisodeGroup, selectedEpisodeSn]);

  async function loadDanmakuForSn(sn: number) {
    setIsLoading(true);
    setErrorText('');
    setSourceInput(String(sn));
    setSelectedEpisodeSn(sn);
    setStatusText(`正在抓取 SN ${sn} 的弹幕...`);

    try {
      const response = (await window.desktopApi.fetchDanmu(
        sn,
        DEFAULT_DANMAKU_GEOS,
      )) as BahamutDanmuResponse;

      if (response.error) {
        throw new Error(response.error.message || '动画疯接口返回了错误。');
      }

      const rawDanmu = response.data?.danmu ?? [];
      const normalized = normalizeDanmaku(rawDanmu);

      setVideoSn(sn);
      setComments(normalized);
      setTotalCount(response.data?.totalCount ?? normalized.length);
      setStatusText(
        normalized.length > 0
          ? `已加载 ${normalized.length} 条弹幕，覆盖到 ${formatClock(normalized[normalized.length - 1].time)}。`
          : '接口返回了空弹幕列表。',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '抓取弹幕失败。';
      setErrorText(message);
      setStatusText('当前没有加载到新的弹幕数据。');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSearchAnime() {
    const keyword = searchKeyword.trim();

    if (!keyword) {
      setErrorText('请输入想搜索的番剧名称。');
      return;
    }

    setIsSearching(true);
    setErrorText('');
    setStatusText(`正在搜索《${keyword}》...`);

    try {
      const results = await window.desktopApi.searchAnime(keyword);

      setSearchResults(results);
      setSelectedSearchResult(null);
      setSelectedSeries(null);
      setSelectedGroupIndex(0);
      setSelectedEpisodeSn(null);

      setStatusText(
        results.length > 0 ? `找到了 ${results.length} 个可选结果。` : `没有搜到《${keyword}》的可播作品。`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '搜索番剧失败。';
      setErrorText(message);
      setStatusText('当前没有新的搜索结果。');
    } finally {
      setIsSearching(false);
    }
  }

  async function handleSelectSearchResult(result: BahamutAnimeSearchResult) {
    setSelectedSearchResult(result);
    setIsLoadingSeries(true);
    setErrorText('');
    setStatusText(`正在读取《${result.title}》的剧集列表...`);

    try {
      const detail = await window.desktopApi.fetchAnimeSeries(result.animeSn);
      const firstGroup = detail.groups[0] ?? null;
      const firstEpisode = firstGroup?.episodes[0] ?? null;

      setSelectedSeries(detail);
      setSelectedGroupIndex(0);
      setSelectedEpisodeSn(firstEpisode?.videoSn ?? null);

      if (firstEpisode) {
        setSourceInput(String(firstEpisode.videoSn));
      }

      setStatusText(
        `已选中《${result.title}》，搜索页显示共 ${result.episodeCount} 集，可选 ${detail.totalSelectableCount} 个条目。`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取剧集列表失败。';
      setErrorText(message);
      setStatusText('当前没有读取到新的剧集列表。');
    } finally {
      setIsLoadingSeries(false);
    }
  }

  async function loadDanmakuFromSourceInput() {
    const sn = parseBahamutVideoSn(sourceInput);

    if (!sn) {
      setErrorText(
        '请输入有效的动画疯视频 SN，或像 https://ani.gamer.com.tw/animeVideo.php?sn=30418 这样的链接。',
      );
      return;
    }

    await loadDanmakuForSn(sn);
  }

  async function exportDanmaku() {
    if (!videoSn || comments.length === 0) {
      setErrorText('先加载弹幕后再导出。');
      return;
    }

    const defaultFileName = `bahamut-danmaku-${videoSn}.json`;
    const content = buildDanmakuExport({
      videoSn,
      geos: DEFAULT_DANMAKU_GEOS,
      totalCount,
      sourceInput,
      comments,
    });

    try {
      const result = await window.desktopApi.saveDanmakuJson(defaultFileName, content);

      if (result.canceled) {
        setStatusText('已取消导出。');
        return;
      }

      setStatusText(`弹幕 JSON 已导出到 ${result.filePath}。`);
      setErrorText('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出失败。';
      setErrorText(message);
    }
  }

  function appendLocalVideos(files: File[]) {
    const validFiles = files.filter(isVideoFile);
    const skippedCount = files.length - validFiles.length;

    if (validFiles.length === 0) {
      setErrorText('没有检测到可用的视频文件。');
      return;
    }

    setLocalVideos((current) => {
      const existingKeys = new Set(current.map((item) => item.key));
      const nextItems = validFiles
        .map(buildLocalVideoItem)
        .filter((item) => !existingKeys.has(item.key));

      if (nextItems.length === 0) {
        setStatusText('这些本地视频已经在列表里了。');
        return current;
      }

      setStatusText(`已加入 ${nextItems.length} 个本地视频，可在右侧按集切换。`);
      setErrorText(skippedCount > 0 ? `已忽略 ${skippedCount} 个非视频文件。` : '');
      setLeftStep('source');
      if (current.length === 0) {
        setShowPlaylist(false);
      }

      return [...current, ...nextItems];
    });
  }

  function clearLocalVideos() {
    setLocalVideos([]);
    setActiveLocalVideoId(null);
    setStatusText('已清空本地多集清单。');
    setErrorText('');
    setLeftStep('video');
    setShowPlaylist(false);
  }

  function handleVideoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFiles = event.target.files ? Array.from(event.target.files) : [];

    if (nextFiles.length > 0) {
      appendLocalVideos(nextFiles);
    }

    event.target.value = '';
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);

    const droppedFiles = Array.from(event.dataTransfer.files ?? []);

    if (droppedFiles.length > 0) {
      appendLocalVideos(droppedFiles);
    }
  }

  function commitTimeOffset(nextValue: number) {
    setSettings((current) => ({
      ...current,
      timeOffsetSeconds: clampOffset(nextValue),
    }));
  }

  function adjustTimeOffset(delta: number) {
    setSettings((current) => ({
      ...current,
      timeOffsetSeconds: clampOffset(current.timeOffsetSeconds + delta),
    }));
  }

  function handleOffsetInputBlur() {
    const parsed = Number(offsetInput);

    if (!Number.isFinite(parsed)) {
      setOffsetInput(settings.timeOffsetSeconds.toFixed(1));
      return;
    }

    commitTimeOffset(parsed);
  }

  function handleOffsetInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    }
  }

  function handleSearchInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleSearchAnime();
    }
  }

  async function handleEpisodeClick(episode: BahamutAnimeEpisode) {
    setSelectedEpisodeSn(episode.videoSn);
    setSourceInput(String(episode.videoSn));

    const matchedVideo = mappedLocalVideos.find(
      (item) => item.matchedEpisode?.videoSn === episode.videoSn,
    );

    if (matchedVideo) {
      setActiveLocalVideoId(matchedVideo.id);
    }

    await loadDanmakuForSn(episode.videoSn);
  }

  async function handlePlaylistItemClick(item: MappedLocalVideo) {
    setActiveLocalVideoId(item.id);
    setErrorText('');

    if (!item.matchedEpisode) {
      setStatusText(`已切换本地视频：${item.file.name}`);
      return;
    }

    setSelectedEpisodeSn(item.matchedEpisode.videoSn);
    setSourceInput(String(item.matchedEpisode.videoSn));
    await loadDanmakuForSn(item.matchedEpisode.videoSn);
  }

  function handleResetSelectedSearchResult() {
    setSelectedSearchResult(null);
    setSelectedSeries(null);
    setSelectedGroupIndex(0);
    setSelectedEpisodeSn(null);
  }

  function handlePlayerStageClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (!activeLocalVideo) {
      return;
    }

    const target = event.target;

    if (
      target instanceof HTMLElement &&
      (
        target.closest('.player-controls') ||
        target.closest('.player-settings-drawer') ||
        target.closest('.player-chrome__top')
      )
    ) {
      return;
    }

    clearStageClickTimer();
    stageClickTimerRef.current = window.setTimeout(() => {
      togglePlayback();
      revealFullscreenChrome();
      stageClickTimerRef.current = null;
    }, 180);
  }

  function handlePlayerStageDoubleClick() {
    clearStageClickTimer();

    if (activeLocalVideo) {
      void toggleFullscreen();
    }
  }

  const seriesEpisodeCount =
    selectedSearchResult?.episodeCount ?? selectedSeries?.primaryEpisodeCount ?? 0;
  const hasLocalVideos = mappedLocalVideos.length > 0;
  const currentEpisodeLabel = selectedEpisode
    ? `${selectedEpisode.groupLabel} · 第 ${selectedEpisode.label} 集`
    : '尚未选择剧集';
  const playlistSummary = hasLocalVideos
    ? `已匹配 ${matchedVideoCount} / ${mappedLocalVideos.length}`
    : '还没有导入本地视频';
  const showSearchResultList = searchResults.length > 0 && !selectedSearchResult;

  return (
    <div className="app-shell">
      <div className="app-shell__glow app-shell__glow--left" />
      <div className="app-shell__glow app-shell__glow--right" />

      <main className="workspace">
        <section className="panel panel--controls">
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*,.mkv,.mp4,.avi,.mov,.wmv,.webm,.m4v,.ts,.m2ts,.mpg,.mpeg,.flv"
            multiple
            hidden
            onChange={handleVideoFileChange}
          />

          <div className="step-tabs">
            <button
              type="button"
              className={`step-tab${leftStep === 'video' ? ' is-active' : ''}`}
              onClick={() => setLeftStep('video')}
            >
              <span className="step-tab__index">1</span>
              <span className="step-tab__body">
                <strong>本地视频</strong>
                <small>{hasLocalVideos ? `已导入 ${mappedLocalVideos.length} 个文件` : '先拖入整季或多集视频'}</small>
              </span>
            </button>
            <button
              type="button"
              className={`step-tab${leftStep === 'source' ? ' is-active' : ''}`}
              onClick={() => setLeftStep('source')}
              disabled={!hasLocalVideos}
            >
              <span className="step-tab__index">2</span>
              <span className="step-tab__body">
                <strong>弹幕来源</strong>
                <small>{hasLocalVideos ? '搜索番剧或手动输入 SN' : '导入视频后解锁'}</small>
              </span>
            </button>
          </div>

          {leftStep === 'video' ? (
            <div className="panel__section panel__section--first">
              <div className="panel__heading">
                <h2>导入本地视频</h2>
                <span>{hasLocalVideos ? `共 ${mappedLocalVideos.length} 个文件` : '等待导入'}</span>
              </div>
              <div
                className={`dropzone${isDragging ? ' is-dragging' : ''}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                }}
                onDrop={handleDrop}
              >
                <p>{hasLocalVideos ? '可以继续追加更多视频文件' : '把整季或多集视频一次拖到这里'}</p>
                <span>
                  {selectedSeries
                    ? '选中番剧后会按当前分组自动尝试匹配集数'
                    : '导入完成后再切到下一步搜索番剧或手动输入 SN'}
                </span>
                <div className="action-row action-row--tight">
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    添加视频
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={clearLocalVideos}
                    disabled={!hasLocalVideos}
                  >
                    清空列表
                  </button>
                  {hasLocalVideos ? (
                    <button
                      type="button"
                      className="button button--primary"
                      onClick={() => setLeftStep('source')}
                    >
                      下一步
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : (
            <div className="panel__section panel__section--source">
              <div className="panel__heading">
                <h2>载入弹幕</h2>
                <span>默认同时抓取 TW / HK</span>
              </div>

              <div className="source-mode-tabs">
                <button
                  type="button"
                  className={`source-mode-tab${sourceMode === 'search' ? ' is-active' : ''}`}
                  onClick={() => setSourceMode('search')}
                >
                  搜索与选集
                </button>
                <button
                  type="button"
                  className={`source-mode-tab${sourceMode === 'manual' ? ' is-active' : ''}`}
                  onClick={() => setSourceMode('manual')}
                >
                  手动输入 SN
                </button>
              </div>

              {sourceMode === 'search' ? (
                <div className="source-panel-body source-panel-body--search">
                  <div className="search-inline">
                    <label className="field search-inline__field">
                      <span className="field__label">番剧名称</span>
                      <input
                        className="field__input"
                        value={searchKeyword}
                        onChange={(event) => setSearchKeyword(event.target.value)}
                        onKeyDown={handleSearchInputKeyDown}
                        placeholder="例如 进击的巨人、葬送的芙莉莲"
                      />
                    </label>
                    <button
                      type="button"
                      className="button button--primary search-inline__button"
                      onClick={() => void handleSearchAnime()}
                      disabled={isSearching}
                    >
                      {isSearching ? '搜索中...' : '搜索番剧'}
                    </button>
                  </div>

                  {selectedSearchResult ? (
                    <div className="series-summary-shell">
                      <div className="series-summary">
                        {selectedSearchResult.coverUrl ? (
                          <img
                            src={selectedSearchResult.coverUrl}
                            alt={selectedSearchResult.title}
                            className="series-summary__cover"
                          />
                        ) : null}
                        <div className="series-summary__body">
                          <strong>{selectedSearchResult.title}</strong>
                          <span>
                            搜索页显示共 {seriesEpisodeCount} 集
                            {selectedSearchResult.yearLabel
                              ? ` · ${selectedSearchResult.yearLabel}`
                              : ''}
                          </span>
                          <small>
                            {selectedSearchResult.editionTags.join(' / ') || '标准条目'}
                            {selectedSearchResult.viewText
                              ? ` · ${selectedSearchResult.viewText}`
                              : ''}
                          </small>
                        </div>
                      </div>
                      <div className="action-row action-row--compact">
                        <button
                          type="button"
                          className="button button--ghost button--compact"
                          onClick={handleResetSelectedSearchResult}
                        >
                          重新选择结果
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {selectedSeries ? (
                    <div className="episode-panel">
                      <div className="episode-panel__header">
                        <span>剧集分组</span>
                        <strong>{selectedSeries.totalSelectableCount} 个可选条目</strong>
                      </div>
                      <div className="group-chip-grid">
                        {selectedSeries.groups.map((group, index) => (
                          <button
                            key={group.label}
                            type="button"
                            className={`group-chip${index === selectedGroupIndex ? ' is-active' : ''}`}
                            onClick={() => setSelectedGroupIndex(index)}
                          >
                            {group.label} ({group.episodes.length})
                          </button>
                        ))}
                      </div>
                      {activeEpisodeGroup ? (
                        <>
                          <div className="episode-panel__subheader">
                            <span>当前分组</span>
                            <strong>
                              {activeEpisodeGroup.label} · {activeEpisodeGroup.episodes.length} 集
                            </strong>
                          </div>
                          <div className="episode-chip-grid">
                            {activeEpisodeGroup.episodes.map((episode) => (
                              <button
                                key={episode.videoSn}
                                type="button"
                                className={`episode-chip${
                                  selectedEpisodeSn === episode.videoSn ? ' is-active' : ''
                                }`}
                                onClick={() => void handleEpisodeClick(episode)}
                              >
                                {episode.label}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : null}
                    </div>
                  ) : null}

                  {showSearchResultList ? (
                    <div className="search-result-list">
                      {searchResults.map((result) => (
                        <button
                          key={result.animeSn}
                          type="button"
                          className="search-result-card"
                          onClick={() => void handleSelectSearchResult(result)}
                          disabled={isLoadingSeries}
                        >
                          {result.coverUrl ? (
                            <img
                              src={result.coverUrl}
                              alt={result.title}
                              className="search-result-card__cover"
                            />
                          ) : (
                            <div className="search-result-card__cover search-result-card__cover--empty">
                              动画
                            </div>
                          )}
                          <div className="search-result-card__body">
                            <strong>{result.title}</strong>
                            <span>
                              共 {result.episodeCount} 集
                              {result.yearLabel ? ` · ${result.yearLabel}` : ''}
                            </span>
                            <small>{result.editionTags.join(' / ') || '点此读取剧集列表'}</small>
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {!isSearching && searchResults.length === 0 ? (
                    <div className="search-result-empty">
                      搜索结果会显示在这里，点选后就能展开剧集列表。
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="source-panel-body">
                  <label className="field">
                    <span className="field__label">视频链接或视频 SN</span>
                    <input
                      className="field__input"
                      value={sourceInput}
                      onChange={(event) => setSourceInput(event.target.value)}
                      placeholder="例如 30418 或 https://ani.gamer.com.tw/animeVideo.php?sn=30418"
                    />
                  </label>
                </div>
              )}

              <div className="selection-strip">
                <span>当前选集</span>
                <strong>{currentEpisodeLabel}</strong>
              </div>
              <div className="action-row action-row--compact">
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void loadDanmakuFromSourceInput()}
                  disabled={isLoading || (!sourceInput && !selectedEpisode)}
                >
                  {isLoading ? '抓取中...' : sourceMode === 'search' ? '加载当前集弹幕' : '加载弹幕'}
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => void exportDanmaku()}
                  disabled={comments.length === 0 || !videoSn}
                >
                  导出 JSON
                </button>
              </div>
              {/*
              <div className="proxy-panel">
                <div className="proxy-panel__header">
                  <div>
                    <strong>系统代理</strong>
                    <span>搜索、剧集列表和弹幕请求都会跟随系统代理。适合 Clash、v2rayN 等已接管系统代理的场景。</span>
                  </div>
                  <small>{formatProxyModeLabel(proxySettings.mode)}</small>
                </div>
                <div className="proxy-panel__hint">
                  当前版本只保留系统代理模式，旧的手动代理和直连配置会被自动忽略。
                </div>
                <div className="action-row action-row--compact">
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => void loadProxyConfig()}
                    disabled={isApplyingProxy}
                  >
                    读取代理状态
                  </button>
                  <button
                    type="button"
                    className="button button--primary"
                    onClick={() => void applyProxyConfig()}
                    disabled={isApplyingProxy}
                  >
                    {isApplyingProxy ? '应用中...' : '重新应用系统代理'}
                  </button>
                </div>
                <div className="proxy-panel__status">
                  <span>代理解析</span>
                  <code>{proxyResolvedText || `未解析 · ${PROXY_TEST_TARGET}`}</code>
                </div>
              </div>
              */}
            </div>
          )}
        </section>

        <section className="player-column">
          <div className="panel panel--player">
            <div className="panel__heading panel__heading--player">
              <div>
                <h2>播放</h2>
                <span>本地视频与弹幕会在这里同步切换</span>
              </div>
              <div className="player-chip-row">
                <span className="player-chip">{selectedSeries ? selectedSeries.title : '未选择番剧'}</span>
                <span className="player-chip">{videoSn ? `SN ${videoSn}` : '未载入弹幕'}</span>
                <span className="player-chip">{activeLocalVideo ? '本地视频已就绪' : '等待本地视频'}</span>
                <span className={`player-chip${transportMode !== 'normal' ? ' is-active' : ''}`}>{transportLabel}</span>
              </div>
            </div>
            <div className={`player-status${errorText ? ' is-error' : ''}`}>
              <strong>{errorText ? '错误' : '状态'}</strong>
              <span>{errorText || statusText}</span>
            </div>
            <div
              ref={playerStageRef}
              className={`video-stage${isFullscreen && !showFullscreenChrome ? ' is-idle' : ''}`}
              onClick={handlePlayerStageClick}
              onDoubleClick={handlePlayerStageDoubleClick}
              onMouseMove={revealFullscreenChrome}
              onMouseDown={revealFullscreenChrome}
              onTouchStart={revealFullscreenChrome}
            >
              {activeLocalVideo ? (
                <>
                  <video
                    ref={videoRef}
                    className="video-stage__player"
                    src={activeLocalVideo.url}
                    disablePictureInPicture
                    playsInline
                    preload="metadata"
                  />
                  <DanmakuOverlay comments={displayComments} settings={settings} videoRef={videoRef} />
                  {showPlayerSettings ? (
                    <div
                      className={`player-settings-drawer${
                        !isFullscreen || showFullscreenChrome ? '' : ' player-settings-drawer--hidden'
                      }`}
                    >
                      <div className="player-settings-drawer__grid">
                        <div className="player-settings-drawer__stack">
                          <label className="slider-field">
                            <span>透明度</span>
                            <strong>{settings.opacity}%</strong>
                            <input
                              type="range"
                              min="10"
                              max="100"
                              step="1"
                              value={settings.opacity}
                              onChange={(event) =>
                                setSettings((current) => ({
                                  ...current,
                                  opacity: Number(event.target.value),
                                }))
                              }
                            />
                          </label>
                          <label className="slider-field">
                            <span>字号倍率</span>
                            <strong>{settings.sizeScale.toFixed(2)}x</strong>
                            <input
                              type="range"
                              min="0.7"
                              max="1.6"
                              step="0.05"
                              value={settings.sizeScale}
                              onChange={(event) =>
                                setSettings((current) => ({
                                  ...current,
                                  sizeScale: Number(event.target.value),
                                }))
                              }
                            />
                          </label>
                          <label className="slider-field">
                            <span>滚动速度</span>
                            <strong>{settings.speedMultiplier.toFixed(2)}x</strong>
                            <input
                              type="range"
                              min="0.6"
                              max="1.8"
                              step="0.05"
                              value={settings.speedMultiplier}
                              onChange={(event) =>
                                setSettings((current) => ({
                                  ...current,
                                  speedMultiplier: Number(event.target.value),
                                }))
                              }
                            />
                          </label>
                        </div>
                        <div className="player-settings-drawer__stack">
                          <div className="offset-panel">
                            <div className="offset-panel__header">
                              <span>弹幕时间偏移</span>
                              <strong>{formatOffsetLabel(settings.timeOffsetSeconds)}</strong>
                            </div>
                            <div className="offset-chip-grid">
                              <button
                                type="button"
                                className="button button--ghost button--compact"
                                onClick={() => adjustTimeOffset(-2)}
                              >
                                -2.0s
                              </button>
                              <button
                                type="button"
                                className="button button--ghost button--compact"
                                onClick={() => adjustTimeOffset(-0.5)}
                              >
                                -0.5s
                              </button>
                              <button
                                type="button"
                                className="button button--ghost button--compact"
                                onClick={() => commitTimeOffset(0)}
                              >
                                重置
                              </button>
                              <button
                                type="button"
                                className="button button--ghost button--compact"
                                onClick={() => adjustTimeOffset(0.5)}
                              >
                                +0.5s
                              </button>
                              <button
                                type="button"
                                className="button button--ghost button--compact"
                                onClick={() => adjustTimeOffset(2)}
                              >
                                +2.0s
                              </button>
                            </div>
                            <label className="field field--compact">
                              <span className="field__label">精确输入（秒）</span>
                              <input
                                className="field__input field__input--compact"
                                type="number"
                                min={-OFFSET_LIMIT_SECONDS}
                                max={OFFSET_LIMIT_SECONDS}
                                step="0.1"
                                value={offsetInput}
                                onChange={(event) => setOffsetInput(event.target.value)}
                                onBlur={handleOffsetInputBlur}
                                onKeyDown={handleOffsetInputKeyDown}
                              />
                            </label>
                          </div>
                          <div className="selection-strip selection-strip--feature">
                            <span>繁体弹幕转简体</span>
                            <button
                              type="button"
                              className={`toggle-chip${settings.convertToSimplified ? ' is-active' : ''}`}
                              onClick={() =>
                                setSettings((current) => ({
                                  ...current,
                                  convertToSimplified: !current.convertToSimplified,
                                }))
                              }
                            >
                              {settings.convertToSimplified ? '已开启' : '已关闭'}
                            </button>
                          </div>
                          <div className="toggle-grid">
                            <button
                              type="button"
                              className={`toggle-chip${settings.showRolling ? ' is-active' : ''}`}
                              onClick={() =>
                                setSettings((current) => ({
                                  ...current,
                                  showRolling: !current.showRolling,
                                }))
                              }
                            >
                              滚动
                            </button>
                            <button
                              type="button"
                              className={`toggle-chip${settings.showTop ? ' is-active' : ''}`}
                              onClick={() =>
                                setSettings((current) => ({
                                  ...current,
                                  showTop: !current.showTop,
                                }))
                              }
                            >
                              顶部
                            </button>
                            <button
                              type="button"
                              className={`toggle-chip${settings.showBottom ? ' is-active' : ''}`}
                              onClick={() =>
                                setSettings((current) => ({
                                  ...current,
                                  showBottom: !current.showBottom,
                                }))
                              }
                            >
                              底部
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}
                  <PlayerControls
                    visible={!isFullscreen || showFullscreenChrome}
                    isPlaying={playerPlaying}
                    currentTime={playerCurrentTime}
                    duration={playerDuration}
                    volume={playerVolume}
                    isMuted={playerMuted}
                    isFullscreen={isFullscreen}
                    isSettingsOpen={showPlayerSettings}
                    transportLabel={transportLabel}
                    episodeLabel={currentEpisodeLabel}
                    offsetLabel={`弹幕偏移 ${formatOffsetLabel(settings.timeOffsetSeconds)}`}
                    onTogglePlay={togglePlayback}
                    onSeek={seekVideoTo}
                    onSkip={seekVideoBy}
                    onSetVolume={setVideoVolume}
                    onToggleMute={toggleMute}
                    onToggleFullscreen={() => void toggleFullscreen()}
                    onToggleSettings={() => setShowPlayerSettings((current) => !current)}
                  />
                </>
              ) : (
                <div className="video-stage__placeholder">
                  <p>还没有本地视频</p>
                  <span>先导入视频，再切到左侧第二步搜索番剧或手动输入 SN。</span>
                </div>
              )}
            </div>
          </div>
          {hasLocalVideos ? (
            <div className={`panel panel--playlist${showPlaylist ? '' : ' is-collapsed'}`}>
              <div className="panel__heading panel__heading--playlist">
                <div>
                  <h2>本地清单</h2>
                  <span>{playlistSummary}</span>
                </div>
                <button
                  type="button"
                  className="button button--ghost button--compact"
                  onClick={() => setShowPlaylist((current) => !current)}
                >
                  {showPlaylist ? '收起' : '展开'}
                </button>
              </div>
              <div className="playlist-summary">
                <strong>{activeLocalVideo ? activeLocalVideo.file.name : '未选择本地视频'}</strong>
                <span>
                  {activeLocalVideo
                    ? describeEpisodeMatch(activeLocalVideo, activeEpisodeGroup)
                    : '导入后可在这里快速切换多集视频'}
                </span>
              </div>
              {showPlaylist ? (
                <div className="playlist-list">
                  {mappedLocalVideos.map((item) => {
                    const isActive = item.id === activeLocalVideoId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`playlist-row${isActive ? ' is-active' : ''}`}
                        onClick={() => void handlePlaylistItemClick(item)}
                      >
                        <div className="playlist-row__index">{item.inferredEpisodeNumber ?? '·'}</div>
                        <div className="playlist-row__body">
                          <strong>{item.file.name}</strong>
                          <span>{formatFileSize(item.file.size)}</span>
                        </div>
                        <div className="playlist-row__meta">
                          {describeEpisodeMatch(item, activeEpisodeGroup)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
