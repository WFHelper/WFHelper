// Persistent screen-capture stream for Linux. Holds one getDisplayMedia stream
// so the Wayland portal prompts once; main drives it via executeJavaScript:
//   __startCapture()  -> void (idempotent, needs a user gesture)
//   __captureState()  -> "idle" | "starting" | "live" | "dead"
//   __grabFrame()     -> Promise<string|null>  (PNG data URL at native size)

(function () {
  "use strict";

  const video = document.getElementById("v");
  const canvas = document.createElement("canvas");
  let state = "idle";
  let stream = null;

  function markDead() {
    state = "dead";
    stream = null;
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        // Low frame rate keeps compositor/CPU cost negligible; grabs always
        // read the most recent frame.
        video: { frameRate: { ideal: 10, max: 15 } },
      });
      const track = stream.getVideoTracks()[0];
      if (!track) {
        markDead();
        return;
      }
      // User ended the share (compositor indicator) or the source went away.
      track.addEventListener("ended", markDead);
      video.srcObject = stream;
      await video.play();
      state = "live";
    } catch {
      // Portal declined / cancelled / unsupported.
      markDead();
    }
  }

  window.__startCapture = function () {
    if (state !== "idle" && state !== "dead") return;
    state = "starting";
    void start();
  };

  window.__captureState = function () {
    return state;
  };

  window.__grabFrame = async function () {
    if (state !== "live" || !video.videoWidth || !video.videoHeight) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL("image/png");
  };
})();
