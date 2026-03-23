import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { DanmakuItem } from '../lib/bahamut';
import {
  buildDanmakuLayout,
  getActiveDanmaku,
  type OverlaySettings,
} from '../lib/danmaku-layout';

type DanmakuOverlayProps = {
  comments: DanmakuItem[];
  settings: OverlaySettings;
  videoRef: RefObject<HTMLVideoElement | null>;
};

export default function DanmakuOverlay({
  comments,
  settings,
  videoRef,
}: DanmakuOverlayProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    const stage = stageRef.current;

    if (!stage) {
      return undefined;
    }

    const updateBounds = () => {
      setBounds({
        width: stage.clientWidth,
        height: stage.clientHeight,
      });
    };

    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(stage);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      return undefined;
    }

    let frameId = 0;

    const sync = () => {
      setCurrentTime(video.currentTime || 0);

      if (!video.paused && !video.ended) {
        frameId = requestAnimationFrame(sync);
      }
    };

    const handlePlay = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(sync);
    };

    const handlePause = () => {
      cancelAnimationFrame(frameId);
      setCurrentTime(video.currentTime || 0);
    };

    const handleTimeLike = () => {
      setCurrentTime(video.currentTime || 0);
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('seeking', handleTimeLike);
    video.addEventListener('seeked', handleTimeLike);
    video.addEventListener('timeupdate', handleTimeLike);
    video.addEventListener('loadedmetadata', handleTimeLike);
    video.addEventListener('ended', handlePause);

    handleTimeLike();

    return () => {
      cancelAnimationFrame(frameId);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('seeking', handleTimeLike);
      video.removeEventListener('seeked', handleTimeLike);
      video.removeEventListener('timeupdate', handleTimeLike);
      video.removeEventListener('loadedmetadata', handleTimeLike);
      video.removeEventListener('ended', handlePause);
    };
  }, [videoRef]);

  const layout = useMemo(
    () => buildDanmakuLayout(comments, bounds, settings),
    [
      comments,
      bounds,
      settings.opacity,
      settings.sizeScale,
      settings.speedMultiplier,
      settings.timeOffsetSeconds,
      settings.showRolling,
      settings.showTop,
      settings.showBottom,
    ],
  );

  const activeDanmaku = useMemo(
    () => getActiveDanmaku(layout.entries, bounds, currentTime, layout.longestDuration),
    [bounds, currentTime, layout.entries, layout.longestDuration],
  );

  return (
    <div
      ref={stageRef}
      className="danmaku-stage"
    >
      {activeDanmaku.map((item) => (
        <div
          key={item.id}
          className={`danmaku-item danmaku-item--${item.mode}`}
          style={{
            opacity: settings.opacity / 100,
            color: item.color,
            fontSize: `${item.fontSize}px`,
            top: 0,
            left: item.mode === 'rolling' ? 0 : '50%',
            transform:
              item.mode === 'rolling'
                ? `translate3d(${item.x}px, ${item.y}px, 0)`
                : `translate3d(-50%, ${item.y}px, 0)`,
          }}
          title={`SN ${item.sn}`}
        >
          {item.text}
        </div>
      ))}
    </div>
  );
}
