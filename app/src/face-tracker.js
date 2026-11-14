// Webcam -> MediaPipe FaceLandmarker (up to 3 faces) -> lock onto the user -> per-frame readings
// frame = { face, raw:{b:{L,R}, r:{L,R}}, eyePx, glare, multiple, lock, landmarks, sig }
import { FaceLandmarker, FilesetResolver } from '../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';
import { eyeReadings, eyeWidthPx, faceBox, eyeBox, signature } from './face-geom.js';
import { FaceLock } from './face-lock.js';

export class FaceTracker {
  constructor(video) {
    this.video = video;
    this.listeners = new Set();
    this.fps = 0;
    this.running = false;
    this.lock = new FaceLock();
    this.glare = 0;
    this.n = 0;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 48; this.canvas.height = 28;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks('../node_modules/@mediapipe/tasks-vision/wasm');
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: '../models/face_landmarker.task', delegate },
      runningMode: 'VIDEO',
      numFaces: 3,
      outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try { this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU')); this.delegate = 'GPU'; }
    catch (e) { console.warn('GPU delegate failed, using CPU', e); this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU')); this.delegate = 'CPU'; }
  }

  async startCamera(deviceId) {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  onFrame(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  start() {
    if (this.running) return;
    this.running = true;
    let last = -1, n = 0, t0 = performance.now();
    const loop = () => {
      if (!this.running) return;
      const v = this.video;
      if (v.readyState >= 2 && v.currentTime !== last) {
        last = v.currentTime;
        const now = performance.now();
        let frame;
        try { frame = this.process(this.landmarker.detectForVideo(v, now), now); }
        catch (e) { console.error(e); frame = { face: false, multiple: false, lock: 'searching' }; }
        n++;
        if (now - t0 > 1000) { this.fps = (n * 1000) / (now - t0); n = 0; t0 = now; }
        for (const fn of this.listeners) fn(frame, now);
      }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop); else requestAnimationFrame(loop);
    };
    loop();
  }

  stop() { this.running = false; }

  // really turn the webcam off (the camera light goes out); listeners get one last "no face" frame
  stopCamera() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.video.srcObject = null;
    const now = performance.now();
    for (const fn of this.listeners) fn({ face: false, multiple: false, lock: 'searching', cameraOff: true }, now);
  }
  get cameraOn() { return !!this.stream; }

  process(res, t) {
    const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720, ar = vw / vh;
    const all = res.faceLandmarks || [];
    const faces = all.map((P) => ({ ...faceBox(P), sig: signature(P, ar) }));
    this.lastFaces = faces; // for debugging / tests
    const lk = this.lock.update(faces, t);
    if (lk.index === null || !res.faceBlendshapes?.[lk.index]) return { face: false, multiple: lk.multiple, lock: lk.status, faces: faces.length };
    const P = all[lk.index];
    const bs = {};
    for (const c of res.faceBlendshapes[lk.index].categories) bs[c.categoryName] = c.score;
    const r = eyeReadings(P, ar);
    // glare on glasses: share of near-white pixels around the eyes, checked every 6th frame
    if (++this.n % 6 === 0) {
      try {
        let bright = 0, total = 0;
        for (const e of ['L', 'R']) {
          const b = eyeBox(P, e, vw, vh);
          this.ctx.drawImage(this.video, b.x, b.y, b.w, b.h, 0, 0, 48, 28);
          const d = this.ctx.getImageData(0, 0, 48, 28).data;
          for (let i = 0; i < d.length; i += 4) { total++; if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > 245) bright++; }
        }
        this.glare = 0.7 * this.glare + 0.3 * (bright / total);
      } catch {}
    }
    return {
      face: true,
      raw: { b: { L: bs.eyeBlinkLeft, R: bs.eyeBlinkRight }, r, brow: (bs.browInnerUp + bs.browOuterUpLeft + bs.browOuterUpRight) / 3,
        // sideways eye direction (sign and scale are learned in calibration from the circle)
        gaze: ((bs.eyeLookOutLeft + bs.eyeLookInRight) - (bs.eyeLookInLeft + bs.eyeLookOutRight)) / 2,
        // head turn: where the nose tip sits between the two sides of the face (0 = straight at the camera)
        yaw: (P[1].x - (P[234].x + P[454].x) / 2) / Math.max(1e-6, Math.abs(P[454].x - P[234].x)) },
      // readings shown on the Dev tab (frown / squint experiments); not used for control yet
      dev: { browDown: (bs.browDownLeft + bs.browDownRight) / 2, eyeSquint: (bs.eyeSquintLeft + bs.eyeSquintRight) / 2,
        cheekSquint: (bs.cheekSquintLeft + bs.cheekSquintRight) / 2, noseSneer: (bs.noseSneerLeft + bs.noseSneerRight) / 2,
        browUp: (bs.browInnerUp + bs.browOuterUpLeft + bs.browOuterUpRight) / 3, blink: (bs.eyeBlinkLeft + bs.eyeBlinkRight) / 2 },
      eyePx: eyeWidthPx(P, vw),
      glare: this.glare,
      multiple: lk.multiple,
      lock: lk.status,
      faces: faces.length,
      sig: faces[lk.index].sig,
      landmarks: P,
    };
  }
}
