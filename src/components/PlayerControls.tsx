import { formatClock } from '../lib/bahamut';

type PlayerControlsProps = {
  visible: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  isFullscreen: boolean;
  isSettingsOpen: boolean;
  transportLabel: string;
  episodeLabel: string;
  offsetLabel: string;
  onTogglePlay: () => void;
  onSeek: (nextTime: number) => void;
  onSkip: (deltaSeconds: number) => void;
  onSetVolume: (nextVolume: number) => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onToggleSettings: () => void;
};

function clampProgressTime(currentTime: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(duration, currentTime));
}

export default function PlayerControls({
  visible,
  isPlaying,
  currentTime,
  duration,
  volume,
  isMuted,
  isFullscreen,
  isSettingsOpen,
  transportLabel,
  episodeLabel,
  offsetLabel,
  onTogglePlay,
  onSeek,
  onSkip,
  onSetVolume,
  onToggleMute,
  onToggleFullscreen,
  onToggleSettings,
}: PlayerControlsProps) {
  const safeCurrentTime = clampProgressTime(currentTime, duration);
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safeVolume = Math.max(0, Math.min(1, volume));
  const progressPercent = safeDuration > 0 ? (safeCurrentTime / safeDuration) * 100 : 0;

  return (
    <div className={`player-chrome${visible ? '' : ' player-chrome--hidden'}`}>
      <div className="player-chrome__top">
        <span className="player-chrome__badge">{transportLabel}</span>
        <span className="player-chrome__badge">{episodeLabel}</span>
        <span className="player-chrome__badge">{offsetLabel}</span>
      </div>

      <div className="player-controls">
        <div className="player-controls__timeline">
          <div
            className="player-controls__timeline-fill"
            style={{ width: `${progressPercent}%` }}
          />
          <input
            className="player-controls__timeline-input"
            type="range"
            min="0"
            max={safeDuration || 0}
            step="0.1"
            value={safeCurrentTime}
            onChange={(event) => onSeek(Number(event.target.value))}
          />
        </div>

        <div className="player-controls__row">
          <div className="player-controls__group">
            <button
              type="button"
              className="player-controls__button player-controls__button--primary"
              onClick={onTogglePlay}
            >
              {isPlaying ? '暂停' : '播放'}
            </button>
            <button
              type="button"
              className="player-controls__button"
              onClick={() => onSkip(-10)}
            >
              -10s
            </button>
            <button
              type="button"
              className="player-controls__button"
              onClick={() => onSkip(10)}
            >
              +10s
            </button>
            <span className="player-controls__time">
              {formatClock(safeCurrentTime)} / {formatClock(safeDuration)}
            </span>
          </div>

          <div className="player-controls__group player-controls__group--right">
            <button
              type="button"
              className={`player-controls__button${isSettingsOpen ? ' is-active' : ''}`}
              onClick={onToggleSettings}
            >
              {'\u5f39\u5e55'}
            </button>
            <button
              type="button"
              className="player-controls__button"
              onClick={onToggleMute}
            >
              {isMuted || safeVolume === 0 ? '静音' : '音量'}
            </button>
            <input
              className="player-controls__volume"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={isMuted ? 0 : safeVolume}
              onChange={(event) => onSetVolume(Number(event.target.value))}
            />
            <button
              type="button"
              className="player-controls__button"
              onClick={onToggleFullscreen}
            >
              {isFullscreen ? '退出全屏' : '全屏'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
