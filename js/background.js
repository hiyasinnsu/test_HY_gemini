/**
 * background.js - サイバー空間・星雲・グリッド多重スクロール背景
 */

export class Background {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.time = 0;

    // 多層星屑
    this.stars = [];
    const starCount = 120;
    for (let i = 0; i < starCount; i++) {
      this.stars.push({
        x: Math.random() * width,
        y: Math.random() * height,
        speed: 0.5 + Math.random() * 2.5,
        size: Math.random() < 0.2 ? 2.5 : (Math.random() < 0.6 ? 1.5 : 0.8),
        color: Math.random() < 0.3 ? '#38bdf8' : (Math.random() < 0.5 ? '#c084fc' : '#ffffff'),
        alpha: 0.3 + Math.random() * 0.7
      });
    }

    // サイバーグリッド遠近パース
    this.gridY = 0;
    this.gridSpeed = 1.8;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  update(dt, speedMultiplier = 1.0) {
    this.time += dt;

    // 星の更新
    const actualSpeed = dt * 60 * speedMultiplier;
    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i];
      s.y += s.speed * actualSpeed;
      if (s.y > this.height) {
        s.y = 0;
        s.x = Math.random() * this.width;
      }
    }

    // グリッドスクロール
    this.gridY = (this.gridY + this.gridSpeed * actualSpeed) % 40;
  }

  draw(ctx) {
    const { width, height } = this;

    // 宇宙空間・サイバーグラデーション背景
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#020617');
    grad.addColorStop(0.5, '#0b132b');
    grad.addColorStop(1, '#050510');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // ネオングリッドライン（背景の奥）
    ctx.save();
    ctx.strokeStyle = 'rgba(30, 58, 138, 0.25)';
    ctx.lineWidth = 1;

    // 縦グリッドライン
    const gridCols = 12;
    const colStep = width / gridCols;
    for (let i = 0; i <= gridCols; i++) {
      const x = i * colStep;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // 横グリッドライン（スクロール）
    const rowStep = 40;
    for (let y = this.gridY; y <= height; y += rowStep) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    ctx.restore();

    // 遠景のサイバーデジタルパルス波
    ctx.save();
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const waveY = (height * 0.7 + Math.sin(this.time * 1.5) * 40) % height;
    ctx.moveTo(0, waveY);
    for (let x = 0; x <= width; x += 20) {
      ctx.lineTo(x, waveY + Math.sin(x * 0.03 + this.time * 2) * 15);
    }
    ctx.stroke();
    ctx.restore();

    // 星・粒子
    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i];
      ctx.save();
      ctx.globalAlpha = s.alpha * (0.8 + 0.2 * Math.sin(this.time * 3 + i));
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x, s.y, s.size, s.size * (s.speed > 2 ? 1.8 : 1));
      ctx.restore();
    }
  }
}
