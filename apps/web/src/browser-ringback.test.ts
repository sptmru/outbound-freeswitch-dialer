import { describe, expect, it, vi } from "vitest";
import { createBrowserRingbackController, createRingbackWaveBlob } from "./browser-ringback";

describe("browser ringback", () => {
  it("creates a valid looping WAV tone", async () => {
    const bytes = new Uint8Array(await readBlob(createRingbackWaveBlob()));
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WAVE");
    expect(bytes.byteLength).toBeGreaterThan(44);
  });

  it("plays through the selected output and cleans up idempotently", () => {
    const audio = fakeAudio();
    const appendAudio = vi.fn();
    const clearTimer = vi.fn();
    const createObjectUrl = vi.fn().mockReturnValue("blob:ringback");
    const revokeObjectUrl = vi.fn();
    const setTimer = vi.fn().mockReturnValue(123);
    const controller = createBrowserRingbackController({
      appendAudio,
      clearTimer,
      createAudio: () => audio,
      createObjectUrl,
      revokeObjectUrl,
      setTimer
    });

    controller.start("speaker-2");
    controller.start("speaker-3");

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(audio.loop).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.setSinkId).toHaveBeenCalledWith("speaker-2");
    expect(appendAudio).toHaveBeenCalledWith(audio);

    controller.stop();
    controller.stop();

    expect(clearTimer).toHaveBeenCalledWith(123);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio.remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:ringback");
  });

  it("stops when the browser rejects playback", async () => {
    const audio = fakeAudio();
    audio.play.mockRejectedValue(new Error("blocked"));
    const revokeObjectUrl = vi.fn();
    const controller = createBrowserRingbackController({
      appendAudio: () => undefined,
      clearTimer: () => undefined,
      createAudio: () => audio,
      createObjectUrl: () => "blob:ringback",
      revokeObjectUrl,
      setTimer: () => 123 as unknown as ReturnType<typeof setTimeout>
    });

    controller.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:ringback");
  });
});

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as ArrayBuffer), { once: true });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

function fakeAudio() {
  return {
    autoplay: false,
    loop: false,
    pause: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
    preload: "",
    remove: vi.fn(),
    removeAttribute: vi.fn(),
    setSinkId: vi.fn().mockResolvedValue(undefined),
    src: "",
    style: { display: "" }
  } as unknown as HTMLAudioElement & {
    pause: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    removeAttribute: ReturnType<typeof vi.fn>;
    setSinkId: ReturnType<typeof vi.fn>;
  };
}
