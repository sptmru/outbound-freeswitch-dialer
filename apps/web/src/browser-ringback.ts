const RINGBACK_SAMPLE_RATE = 8_000;
const RINGBACK_CYCLE_SECONDS = 3;
const RINGBACK_MAX_DURATION_MS = 30_000;
const RINGBACK_VOLUME = 0.14;
const RINGBACK_FADE_SECONDS = 0.01;

type Timer = ReturnType<typeof setTimeout>;

type SinkSelectableAudio = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

interface BrowserRingbackDependencies {
  appendAudio?: (audio: HTMLAudioElement) => void;
  clearTimer?: (timer: Timer) => void;
  createAudio?: () => HTMLAudioElement;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  setTimer?: (callback: () => void, delayMilliseconds: number) => Timer;
}

export interface BrowserRingbackController {
  start: (outputDeviceId?: string) => void;
  stop: () => void;
}

interface ActiveRingback {
  audio: HTMLAudioElement;
  objectUrl: string;
  timer: Timer;
}

export function createBrowserRingbackController(
  dependencies: BrowserRingbackDependencies = {}
): BrowserRingbackController {
  const appendAudio =
    dependencies.appendAudio ??
    ((audio: HTMLAudioElement) => {
      document.body.appendChild(audio);
    });
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  const createAudio = dependencies.createAudio ?? (() => document.createElement("audio"));
  const createObjectUrl = dependencies.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectUrl = dependencies.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const setTimer = dependencies.setTimer ?? setTimeout;
  let active: ActiveRingback | null = null;

  const stop = () => {
    const current = active;
    if (!current) {
      return;
    }
    active = null;
    clearTimer(current.timer);
    current.audio.pause();
    current.audio.removeAttribute("src");
    current.audio.remove();
    revokeObjectUrl(current.objectUrl);
  };

  const start = (outputDeviceId = "") => {
    if (active || typeof document === "undefined" || typeof Blob === "undefined") {
      return;
    }

    const audio = createAudio();
    const objectUrl = createObjectUrl(createRingbackWaveBlob());
    audio.autoplay = true;
    audio.loop = true;
    audio.preload = "auto";
    audio.src = objectUrl;
    audio.style.display = "none";
    appendAudio(audio);

    const timer = setTimer(stop, RINGBACK_MAX_DURATION_MS);
    const current = { audio, objectUrl, timer };
    active = current;

    const sinkAudio = audio as SinkSelectableAudio;
    if (outputDeviceId && sinkAudio.setSinkId) {
      void sinkAudio.setSinkId(outputDeviceId).catch(() => undefined);
    }

    void Promise.resolve(audio.play()).catch(() => {
      if (active === current) {
        stop();
      }
    });
  };

  return { start, stop };
}

export function createRingbackWaveBlob(): Blob {
  const sampleCount = RINGBACK_SAMPLE_RATE * RINGBACK_CYCLE_SECONDS;
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RINGBACK_SAMPLE_RATE, true);
  view.setUint32(28, RINGBACK_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / RINGBACK_SAMPLE_RATE;
    const cyclePosition = time % RINGBACK_CYCLE_SECONDS;
    const envelope = ringbackEnvelope(cyclePosition);
    const sample =
      envelope *
      RINGBACK_VOLUME *
      (Math.sin(2 * Math.PI * 400 * time) + Math.sin(2 * Math.PI * 450 * time)) *
      0.5;
    view.setInt16(44 + index * 2, Math.round(sample * 32_767), true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function ringbackEnvelope(cyclePosition: number): number {
  if (cyclePosition < 0.4) {
    return fadedSegmentEnvelope(cyclePosition, 0.4);
  }
  if (cyclePosition >= 0.6 && cyclePosition < 1) {
    return fadedSegmentEnvelope(cyclePosition - 0.6, 0.4);
  }
  return 0;
}

function fadedSegmentEnvelope(position: number, duration: number): number {
  return Math.min(1, position / RINGBACK_FADE_SECONDS, (duration - position) / RINGBACK_FADE_SECONDS);
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
