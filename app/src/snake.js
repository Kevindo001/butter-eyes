// Slow, forgiving Snake: walls wrap, no instant reversal, ~3.5 moves/sec.
export class Snake {
  constructor(canvas, onScore, { cols = 21, rows = 14, tickMs = 280 } = {}) {
    Object.assign(this, { canvas, onScore, cols, rows, tickMs });
    this.ctx = canvas.getContext('2d');
    this.reset();
  }
  reset() {
    this.body = [[5, 7], [4, 7], [3, 7]];
    this.dir = 'right'; this.next = 'right';
    this.score = 0; this.dead = false; this.paused = false;
    this.food = this.place();
    this.onScore?.(0);
  }
  place() {
    let p;
    do { p = [Math.floor(Math.random() * this.cols), Math.floor(Math.random() * this.rows)]; }
    while (this.body.some(([x, y]) => x === p[0] && y === p[1]));
    return p;
  }
  turn(d) {
    const opp = { left: 'right', right: 'left', up: 'down', down: 'up' };
    if (d !== opp[this.dir]) this.next = d;
  }
  toggle() { if (this.dead) this.reset(); else this.paused = !this.paused; this.draw(); }
  start() { this.timer = setInterval(() => this.step(), this.tickMs); this.draw(); }
  stop() { clearInterval(this.timer); }
  step() {
    if (this.dead || this.paused) return;
    this.dir = this.next;
    const d = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[this.dir];
    const h = [(this.body[0][0] + d[0] + this.cols) % this.cols, (this.body[0][1] + d[1] + this.rows) % this.rows];
    if (this.body.some(([x, y]) => x === h[0] && y === h[1])) { this.dead = true; this.draw(); return; }
    this.body.unshift(h);
    if (h[0] === this.food[0] && h[1] === this.food[1]) { this.score++; this.onScore?.(this.score); this.food = this.place(); }
    else this.body.pop();
    this.draw();
  }
  draw() {
    const { ctx, canvas } = this, cw = canvas.width / this.cols, ch = canvas.height / this.rows;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'oklch(58% 0.17 35)';
    ctx.beginPath(); ctx.arc((this.food[0] + 0.5) * cw, (this.food[1] + 0.5) * ch, cw * 0.32, 0, 7); ctx.fill();
    this.body.forEach(([x, y], i) => { ctx.fillStyle = i ? 'oklch(64% 0.14 72)' : 'oklch(28% 0.02 55)'; ctx.beginPath(); ctx.rect(x * cw + 2, y * ch + 2, cw - 4, ch - 4); ctx.fill(); });
    if (this.dead || this.paused) {
      ctx.fillStyle = 'oklch(97% 0.012 85 / 0.88)'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'oklch(25% 0.02 55)'; ctx.font = '800 34px Atkinson, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(this.dead ? `Game over, score ${this.score}. Blink to play again` : 'Paused. Blink to keep going', canvas.width / 2, canvas.height / 2);
    }
  }
}
