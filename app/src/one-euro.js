// One Euro filter (Casiez et al. 2012): heavy smoothing when still, low lag when moving.
const alpha = (cutoff, dt) => {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
};

export class OneEuroVec {
  constructor(minCutoff = 1.0, beta = 0.05, dCutoff = 1.0) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() { this.x = null; this.dx = null; this.t = null; }
  filter(x, tMs) {
    const t = tMs / 1000;
    if (this.x === null) {
      this.x = x.slice(); this.dx = x.map(() => 0); this.t = t;
      return this.x.slice();
    }
    const dt = Math.max(t - this.t, 1e-3);
    const aD = alpha(this.dCutoff, dt);
    let speed = 0;
    for (let i = 0; i < x.length; i++) {
      const d = (x[i] - this.x[i]) / dt;
      this.dx[i] = aD * d + (1 - aD) * this.dx[i];
      speed += this.dx[i] * this.dx[i];
    }
    const a = alpha(this.minCutoff + this.beta * Math.sqrt(speed), dt);
    for (let i = 0; i < x.length; i++) this.x[i] = a * x[i] + (1 - a) * this.x[i];
    this.t = t;
    return this.x.slice();
  }
}
