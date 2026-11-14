// Webcam -> MediaPipe FaceLandmarker (468 landmarks + iris + 52 blendshapes) -> compact frame
// { face, blinkL, blinkR, feat:[bsX, bsY, irisX, irisY], featEye:{L,R}, landmarks }
import { FaceLandmarker, FilesetResolver } from '../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';

const EYE_L = { a: 33, b: 133, top: 159, bot: 145, iris: 468 };   // image-left eye
const EYE_R = { a: 362, b: 263, top: 386, bot: 374, iris: 473 };  // image-right eye

export class FaceTracker {
  constructor(video) {
    this.video = video;
    this.listeners = new Set();
    this.fps = 0;
    this.running = false;
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks('../node_modules/@mediapipe/tasks-vision/wasm');
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: '../models/face_landmarker.task', delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
      this.delegate = 'GPU';
    } catch (e) {
      console.warn('GPU delegate failed, using CPU', e);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU'));
      this.delegate = 'CPU';
    }
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
        try {
          frame = this.process(this.landmarker.detectForVideo(v, now));
        } catch (e) {
          console.error(e);
          frame = { face: false };
        }
        n++;
        if (now - t0 > 1000) { this.fps = (n * 1000) / (now - t0); n = 0; t0 = now; }
        for (const fn of this.listeners) fn(frame, now);
      }
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop);
      else requestAnimationFrame(loop);
    };
    loop();
  }

  stop() { this.running = false; }

  process(res) {
    if (!res.faceLandmarks?.length || !res.faceBlendshapes?.length) return { face: false };
    const bs = {};
    for (const c of res.faceBlendshapes[0].categories) bs[c.categoryName] = c.score;
    const P = res.faceLandmarks[0];
    const ar = (this.video.videoWidth || 16) / (this.video.videoHeight || 9);
    const pt = (i) => [P[i].x * ar, P[i].y];
    const iris = (e) => {
      const A = pt(e.a), B = pt(e.b), I = pt(e.iris);
      const vx = B[0] - A[0], vy = B[1] - A[1];
      const w = Math.hypot(vx, vy) + 1e-9;
      const ex = [vx / w, vy / w], ey = [-ex[1], ex[0]];
      const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
      const dx = I[0] - mx, dy = I[1] - my;
      // sign so that +x means "toward the user's right" for both eyes (image is not mirrored)
      return [-(dx * ex[0] + dy * ex[1]) / w, (dx * ey[0] + dy * ey[1]) / w];
    };
    // blendshapes are named from the user's point of view
    const hL = bs.eyeLookInLeft - bs.eyeLookOutLeft;    // + = user looks to their right
    const hR = bs.eyeLookOutRight - bs.eyeLookInRight;
    const vL = bs.eyeLookUpLeft - bs.eyeLookDownLeft;   // + = up
    const vR = bs.eyeLookUpRight - bs.eyeLookDownRight;
    const iL = iris(EYE_R); // image-right eye is the user's left eye
    const iR = iris(EYE_L);
    const featEye = { L: [hL, vL, iL[0], -iL[1]], R: [hR, vR, iR[0], -iR[1]] };
    const feat = featEye.L.map((x, i) => (x + featEye.R[i]) / 2);
    return { face: true, blinkL: bs.eyeBlinkLeft, blinkR: bs.eyeBlinkRight, feat, featEye, landmarks: P };
  }
}
