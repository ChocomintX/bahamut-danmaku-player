import type { DanmakuItem } from './bahamut';

export type OverlaySettings = {
  opacity: number;
  sizeScale: number;
  speedMultiplier: number;
  timeOffsetSeconds: number;
  showRolling: boolean;
  showTop: boolean;
  showBottom: boolean;
};

export type ContainerBounds = {
  width: number;
  height: number;
};

export type DanmakuLayoutItem = {
  id: string;
  sn: number;
  text: string;
  color: string;
  mode: 'rolling' | 'top' | 'bottom';
  fontSize: number;
  width: number;
  height: number;
  start: number;
  end: number;
  y: number;
  speed: number;
};

export type LayoutResult = {
  entries: DanmakuLayoutItem[];
  longestDuration: number;
};

const FONT_SIZE_MAP: Record<DanmakuItem['size'], number> = {
  0: 16,
  1: 24,
  2: 28,
};

const ROLLING_BASE_SPEED = 165;
const STATIC_DURATION = 4.2;
const LANE_GAP = 10;
const MIN_GAP = 36;

function estimateTextWidth(text: string, fontSize: number) {
  let widthUnits = 0;

  for (const char of text) {
    if (/[ -~]/.test(char)) {
      widthUnits += 0.62;
    } else {
      widthUnits += 1;
    }
  }

  return Math.ceil(widthUnits * fontSize + 24);
}

function pickLane(releaseTimes: number[], start: number) {
  const freeLane = releaseTimes.findIndex((releaseAt) => releaseAt <= start);

  if (freeLane >= 0) {
    return freeLane;
  }

  let minIndex = 0;

  for (let index = 1; index < releaseTimes.length; index += 1) {
    if (releaseTimes[index] < releaseTimes[minIndex]) {
      minIndex = index;
    }
  }

  return minIndex;
}

export function buildDanmakuLayout(
  comments: DanmakuItem[],
  bounds: ContainerBounds,
  settings: OverlaySettings,
): LayoutResult {
  if (bounds.width <= 0 || bounds.height <= 0 || comments.length === 0) {
    return {
      entries: [],
      longestDuration: 0,
    };
  }

  const laneHeight = Math.max(28, Math.round(34 * settings.sizeScale));
  const rollingAreaHeight = Math.max(laneHeight, Math.floor(bounds.height * 0.58));
  const topAreaHeight = Math.max(laneHeight, Math.floor(bounds.height * 0.18));
  const bottomAreaHeight = Math.max(laneHeight, Math.floor(bounds.height * 0.18));

  const rollingLaneCount = Math.max(1, Math.floor(rollingAreaHeight / (laneHeight + LANE_GAP)));
  const topLaneCount = Math.max(1, Math.floor(topAreaHeight / (laneHeight + LANE_GAP)));
  const bottomLaneCount = Math.max(1, Math.floor(bottomAreaHeight / (laneHeight + LANE_GAP)));

  const rollingRelease = new Array<number>(rollingLaneCount).fill(Number.NEGATIVE_INFINITY);
  const topRelease = new Array<number>(topLaneCount).fill(Number.NEGATIVE_INFINITY);
  const bottomRelease = new Array<number>(bottomLaneCount).fill(Number.NEGATIVE_INFINITY);

  const entries: DanmakuLayoutItem[] = [];
  let longestDuration = STATIC_DURATION;

  for (const comment of comments) {
    if (comment.position === 0 && !settings.showRolling) {
      continue;
    }

    if (comment.position === 1 && !settings.showTop) {
      continue;
    }

    if (comment.position === 2 && !settings.showBottom) {
      continue;
    }

    const fontSize = Math.max(12, Math.round(FONT_SIZE_MAP[comment.size] * settings.sizeScale));
    const width = estimateTextWidth(comment.text, fontSize);
    const height = fontSize + 10;
    const scheduledStart = comment.time + settings.timeOffsetSeconds;

    if (comment.position === 0) {
      const speed = ROLLING_BASE_SPEED * settings.speedMultiplier;
      const duration = (bounds.width + width) / speed;
      const lane = pickLane(rollingRelease, scheduledStart);
      const y = lane * (laneHeight + LANE_GAP);
      const releaseAfter = (width + MIN_GAP) / speed;

      rollingRelease[lane] = scheduledStart + releaseAfter;
      longestDuration = Math.max(longestDuration, duration);
      entries.push({
        id: `${comment.sn}-${comment.time}`,
        sn: comment.sn,
        text: comment.text,
        color: comment.color,
        mode: 'rolling',
        fontSize,
        width,
        height,
        start: scheduledStart,
        end: scheduledStart + duration,
        y,
        speed,
      });
      continue;
    }

    if (comment.position === 1) {
      const lane = pickLane(topRelease, scheduledStart);
      const y = lane * (laneHeight + LANE_GAP);
      topRelease[lane] = scheduledStart + STATIC_DURATION;
      entries.push({
        id: `${comment.sn}-${comment.time}`,
        sn: comment.sn,
        text: comment.text,
        color: comment.color,
        mode: 'top',
        fontSize,
        width,
        height,
        start: scheduledStart,
        end: scheduledStart + STATIC_DURATION,
        y,
        speed: 0,
      });
      continue;
    }

    const lane = pickLane(bottomRelease, scheduledStart);
    const bottomY = bounds.height - (lane + 1) * (laneHeight + LANE_GAP) - 12;
    bottomRelease[lane] = scheduledStart + STATIC_DURATION;
    entries.push({
      id: `${comment.sn}-${comment.time}`,
      sn: comment.sn,
      text: comment.text,
      color: comment.color,
      mode: 'bottom',
      fontSize,
      width,
      height,
      start: scheduledStart,
      end: scheduledStart + STATIC_DURATION,
      y: Math.max(0, bottomY),
      speed: 0,
    });
  }

  return {
    entries,
    longestDuration,
  };
}

function upperBound(entries: DanmakuLayoutItem[], currentTime: number) {
  let low = 0;
  let high = entries.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if (entries[mid].start <= currentTime) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

export function getActiveDanmaku(
  entries: DanmakuLayoutItem[],
  bounds: ContainerBounds,
  currentTime: number,
  longestDuration: number,
) {
  if (entries.length === 0 || bounds.width <= 0 || bounds.height <= 0) {
    return [];
  }

  const result: Array<
    DanmakuLayoutItem & {
      x: number;
    }
  > = [];

  const startIndex = upperBound(entries, currentTime);
  const minStart = currentTime - longestDuration - 0.1;

  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index];

    if (entry.start < minStart) {
      break;
    }

    if (currentTime >= entry.end) {
      continue;
    }

    if (entry.mode === 'rolling') {
      const elapsed = Math.max(0, currentTime - entry.start);
      const x = bounds.width - elapsed * entry.speed;

      if (x + entry.width < 0) {
        continue;
      }

      result.push({
        ...entry,
        x,
      });
      continue;
    }

    result.push({
      ...entry,
      x: Math.floor(bounds.width / 2),
    });
  }

  return result.reverse();
}
