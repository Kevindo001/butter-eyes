// Downloads the MediaPipe FaceLandmarker model (with blendshapes) into ./models once.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'models', 'face_landmarker.task');
const URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
if (fs.existsSync(out) && fs.statSync(out).size > 1e6) { console.log('[model] present'); process.exit(0); }
fs.mkdirSync(path.dirname(out), { recursive: true });
const r = await fetch(URL);
if (!r.ok) { console.error('[model] download failed', r.status); process.exit(1); }
fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
console.log('[model] saved', out);
