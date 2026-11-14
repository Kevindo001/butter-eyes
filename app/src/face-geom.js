// Pure geometry on MediaPipe face landmarks (normalized x,y; ar = video width / height).
// The image is NOT mirrored, so the image-left eye is the user's RIGHT eye.
const EYE_IMG_LEFT = { a: 33, b: 133, top: [159, 158, 160], bot: [145, 153, 144] };   // user's right eye
const EYE_IMG_RIGHT = { a: 362, b: 263, top: [386, 385, 387], bot: [374, 380, 373] }; // user's left eye

const pt = (P, i, ar) => [P[i].x * ar, P[i].y];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// lid ratio: average eyelid gap at three points / eye width. Independent of eye size and distance.
function lidRatio(P, e, ar) {
  const w = dist(pt(P, e.a, ar), pt(P, e.b, ar)) + 1e-9;
  let gap = 0;
  for (let k = 0; k < 3; k++) gap += dist(pt(P, e.top[k], ar), pt(P, e.bot[k], ar));
  return gap / 3 / w;
}

export function eyeReadings(P, ar) {
  return { L: lidRatio(P, EYE_IMG_RIGHT, ar), R: lidRatio(P, EYE_IMG_LEFT, ar) };
}

export function eyeWidthPx(P, videoW) {
  const a = Math.hypot(P[33].x - P[133].x, P[33].y - P[133].y) * videoW;
  const b = Math.hypot(P[362].x - P[263].x, P[362].y - P[263].y) * videoW;
  return (a + b) / 2;
}

export function faceBox(P) {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const p of P) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0), x0, y0, x1, y1 };
}

// eye region box (pixels) for the glare check
export function eyeBox(P, which, vw, vh) {
  const e = which === 'L' ? EYE_IMG_RIGHT : EYE_IMG_LEFT;
  const xs = [e.a, e.b, ...e.top, ...e.bot].map((i) => P[i].x * vw);
  const ys = [e.a, e.b, ...e.top, ...e.bot].map((i) => P[i].y * vh);
  const w = Math.max(...xs) - Math.min(...xs);
  return { x: Math.min(...xs) - w * 0.25, y: Math.min(...ys) - w * 0.35, w: w * 1.5, h: w * 0.9 };
}

// A rough "who is this" signature: proportions of the face that don't change with distance.
// Used only to re-find the user after they leave the frame; position continuity does the rest.
export function signature(P, ar) {
  const d = (i, j) => dist(pt(P, i, ar), pt(P, j, ar));
  const mid = (i, j) => { const a = pt(P, i, ar), b = pt(P, j, ar); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
  const w = d(234, 454) + 1e-9, h = d(10, 152) + 1e-9;
  return [
    d(133, 362) / w,                         // inner eye spacing
    d(33, 263) / w,                          // outer eye span
    d(61, 291) / w,                          // mouth width
    d(168, 1) / h,                           // nose length
    dist(mid(33, 263), mid(61, 291)) / h,    // eyes to mouth
    d(1, 152) / h,                           // nose tip to chin
    w / h,                                   // face shape
  ];
}
