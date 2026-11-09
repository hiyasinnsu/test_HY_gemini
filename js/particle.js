/**
 * particle.js
 * 弾幕シューティング用パーティクルエフェクト（依存なし / ES Modules / Canvas 2D）。
 *
 * 使い方:
 *   const particles = new ParticleManager(800);
 *   particles.createExplosion(x, y, 24, '#ffcc66', 420);
 *
 *   // ゲームループ
 *   particles.update(dt);   // dt は秒（最大 0.05 秒にクランプ）
 *   particles.render(ctx);  // 加算合成で描画し、呼び出し前の context 状態に戻す
 *
 * 速度の単位は px/秒。createExplosion の speedMax のみ、30 以下を
 * 60fps 基準の px/フレームとみなして自動変換する（既存コードとの接続用）。
 *
 * パーティクルは起動時に固定数生成してプールし、生成/破棄時に新しい
 * オブジェクトを作らない。プール枯渇時は新規生成を諦めるだけで GC は走らない。
 */

const TAU = Math.PI * 2;

const TYPE_DOT = 0;
const TYPE_SPARK = 1;
const TYPE_RING = 2;
const TYPE_STAR = 3;
const TYPE_SHARD = 4;
const TYPE_ABSORB = 5;
const TYPE_AURA = 6;
const TYPE_CONVERGE = 7;

const DEFAULT_MAX_PARTICLES = 800;
const MAX_SPRITE_CACHE = 48;
const GLOW_SPRITE_SIZE = 64;

const random = (min, max) => min + Math.random() * (max - min);

const easeOutCubic = (t) => 1 - (1 - t) * (1 - t) * (1 - t);

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function normalizeSpeed(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // 小さい値は旧来の px/フレーム指定と解釈する。
  return n <= 30 ? n * 60 : n;
}

function colorOf(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * 1 個のパーティクル。外部からは読み取り専用のデータとして扱い、
 * 生成は ParticleManager の create* メソッド経由で行う。
 */
export class Particle {
  constructor() {
    this.type = TYPE_DOT;
    this.active = false;

    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;

    this.startX = 0;
    this.startY = 0;
    this.targetX = 0;
    this.targetY = 0;
    this.arc = 0;

    this.life = 1;
    this.maxLife = 1;
    this.delay = 0;

    this.size = 2;
    this.radius = 0;
    this.radius0 = 0;
    this.radius1 = 0;

    this.drag = 0;
    this.gravity = 0;
    this.accel = 0;

    this.rotation = 0;
    this.spin = 0;

    this.fadeIn = 0.1;
    this.color = '#ffffff';

    this._slot = -1;
    this._index = -1;
  }

  /** プールから取り出すたびに全フィールドを既定値へ戻す。 */
  reset() {
    this.type = TYPE_DOT;

    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;

    this.startX = 0;
    this.startY = 0;
    this.targetX = 0;
    this.targetY = 0;
    this.arc = 0;

    this.life = 1;
    this.maxLife = 1;
    this.delay = 0;

    this.size = 2;
    this.radius = 0;
    this.radius0 = 0;
    this.radius1 = 0;

    this.drag = 0;
    this.gravity = 0;
    this.accel = 0;

    this.rotation = 0;
    this.spin = 0;

    this.fadeIn = 0.1;
    this.color = '#ffffff';
  }

  /**
   * @param {number} dt 秒
   * @returns {boolean} 生存しているか
   */
  update(dt) {
    if (this.delay > 0) {
      this.delay -= dt;
      if (this.delay > 0) return true;
      this.delay = 0;
    }

    this.life -= dt;
    if (this.life <= 0) return false;

    const t = 1 - this.life / this.maxLife;

    switch (this.type) {
      case TYPE_RING: {
        this.radius = this.radius0 + (this.radius1 - this.radius0) * easeOutCubic(t);
        break;
      }
      case TYPE_AURA: {
        this.radius = this.radius0 + (this.radius1 - this.radius0) * t;
        this.rotation += this.spin * dt;
        break;
      }
      case TYPE_ABSORB: {
        // ゆっくり動き出して加速しながら対象へ吸い込まれる。
        const e = t * t;
        const dx = this.targetX - this.startX;
        const dy = this.targetY - this.startY;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const curve = Math.sin(Math.PI * t) * this.arc;
        this.x = this.startX + dx * e - (dy / dist) * curve;
        this.y = this.startY + dy * e + (dx / dist) * curve;
        break;
      }
      case TYPE_CONVERGE: {
        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < 64) {
          this.life = 0;
          return false;
        }
        const inv = 1 / Math.sqrt(dist2);
        this.vx += dx * inv * this.accel * dt;
        this.vy += dy * inv * this.accel * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        break;
      }
      default: {
        if (this.drag > 0) {
          const damp = Math.max(0, 1 - this.drag * dt);
          this.vx *= damp;
          this.vy *= damp;
        }
        this.vy += this.gravity * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        if (this.spin !== 0) this.rotation += this.spin * dt;
        break;
      }
    }

    return true;
  }
}

/**
 * パーティクルの生成・更新・描画を管理する。
 * 最大数は固定プールで、同時に存在できる数もこの値が上限。
 */
export class ParticleManager {
  /**
   * @param {number} [maxParticles=800] 同時に存在できる最大数
   * @param {{additive?: boolean}} [options] additive=false で通常合成
   */
  constructor(maxParticles = DEFAULT_MAX_PARTICLES, options = {}) {
    const max = clampInt(maxParticles, 100, 2000, DEFAULT_MAX_PARTICLES);

    this.maxParticles = max;
    this.additive = options.additive !== false;

    this._pool = new Array(max);
    for (let i = 0; i < max; i++) {
      const p = new Particle();
      p._index = i;
      this._pool[i] = p;
    }

    // 空きインデックスのスタック。生成/破棄で push/pop するだけ。
    this._free = new Int32Array(max);
    this._freeCount = max;
    for (let i = 0; i < max; i++) this._free[i] = i;

    // 生存中の参照。削除は末尾要素の swap で行い、splice しない。
    this._active = new Array(max).fill(null);
    this._activeCount = 0;

    this._glowCache = new Map();
    this._canCreateSprite =
      typeof document !== 'undefined' && typeof document.createElement === 'function';
  }

  /** 生存中のパーティクル数。 */
  get activeCount() {
    return this._activeCount;
  }

  /** activeCount の別名。 */
  get count() {
    return this._activeCount;
  }

  /**
   * 全パーティクルを更新する。dt は秒。
   * @param {number} dt
   */
  update(dt) {
    const step = Math.min(Math.max(Number(dt) || 0, 0), 0.05);
    if (step <= 0) return;

    // 後ろから走査すると、末尾 swap で詰めた要素を二重更新しない。
    for (let i = this._activeCount - 1; i >= 0; i--) {
      const p = this._active[i];
      if (!p.update(step)) this._release(p);
    }
  }

  /**
   * Canvas 2D コンテキストへ描画する。加算合成は呼び出し後に復元される。
   * @param {CanvasRenderingContext2D} ctx
   */
  render(ctx) {
    if (!ctx || this._activeCount === 0) return;

    ctx.save();
    if (this.additive) ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < this._activeCount; i++) {
      const p = this._active[i];
      if (p.delay > 0) continue;
      this._drawParticle(ctx, p);
    }

    ctx.restore();
  }

  /** render の別名。 */
  draw(ctx) {
    this.render(ctx);
  }

  /** 全パーティクルを消去してプールへ戻す。 */
  clear() {
    while (this._activeCount > 0) {
      this._release(this._active[this._activeCount - 1]);
    }
  }

  /** プールとスプライトキャッシュを破棄する。 */
  destroy() {
    this.clear();
    this._glowCache.clear();
  }

  // --- 生成 API ---------------------------------------------------------

  /**
   * 敵・弾の爆発。全方位へ飛散する光点、火花、破片と中心フラッシュ。
   * @param {number} x
   * @param {number} y
   * @param {number} [count=20]
   * @param {string} [color='#ffc46b']
   * @param {number} [speedMax=380] px/秒（30 以下なら px/フレーム扱い）
   * @returns {number} 実際に生成できた数
   */
  createExplosion(x, y, count = 20, color = '#ffc46b', speedMax = 380) {
    const total = clampInt(count, 1, 160, 20);
    const tint = colorOf(color, '#ffc46b');
    const maxSpeed = normalizeSpeed(speedMax, 380);
    const minSpeed = maxSpeed * 0.2;

    let created = 0;

    for (let i = 0; i < total; i++) {
      const angle = Math.random() * TAU;
      const speed = random(minSpeed, maxSpeed);
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const life = random(0.35, 0.75);
      const roll = Math.random();

      if (roll < 0.5) {
        if (this._spawnDot(x, y, vx, vy, life, random(1.2, 3), tint, 2.8, 0)) created++;
      } else if (roll < 0.8) {
        if (this._spawnSpark(x, y, vx, vy, random(0.2, 0.45), random(1, 2), tint, 0)) created++;
      } else {
        if (this._spawnShard(x, y, vx * 0.8, vy * 0.8, random(0.4, 0.8), random(1.5, 3), tint)) created++;
      }
    }

    if (this._spawnFlash(x, y, random(10, 16), tint, 0.16)) created++;

    return created;
  }

  /**
   * 着弾地点から放射状に散る小さな火花。
   * @param {number} x
   * @param {number} y
   * @param {number} [count=8]
   * @param {string} [color='#ffe6a6']
   * @returns {number}
   */
  createSpark(x, y, count = 8, color = '#ffe6a6') {
    const total = clampInt(count, 1, 80, 8);
    const tint = colorOf(color, '#ffe6a6');

    let created = 0;
    for (let i = 0; i < total; i++) {
      const angle = Math.random() * TAU;
      const speed = random(60, 300);
      if (
        this._spawnSpark(
          x,
          y,
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
          random(0.12, 0.28),
          random(0.8, 1.8),
          tint,
          0
        )
      ) {
        created++;
      }
    }
    return created;
  }

  /**
   * グレイズ（かすり）時のきらめき。十字の星と小さな飛沫。
   * @param {number} x
   * @param {number} y
   * @param {string} [color='#bff8ff']
   * @returns {number}
   */
  createGrazeSpark(x, y, color = '#bff8ff') {
    const tint = colorOf(color, '#bff8ff');

    let created = 0;

    for (let i = 0; i < 5; i++) {
      const angle = Math.random() * TAU;
      const speed = random(40, 140);
      if (
        this._spawnStar(
          x + random(-3, 3),
          y + random(-3, 3),
          Math.cos(angle) * speed,
          Math.sin(angle) * speed,
          random(0.22, 0.4),
          random(2.2, 3.6),
          i % 2 === 0 ? '#ffffff' : tint
        )
      ) {
        created++;
      }
    }

    for (let i = 0; i < 2; i++) {
      const angle = Math.random() * TAU;
      const speed = random(120, 240);
      if (
        this._spawnSpark(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, 0.16, 1, tint, 0)
      ) {
        created++;
      }
    }

    if (this._spawnRing(x, y, 4, 26, 0.22, 1.2, tint, 0)) created++;

    return created;
  }

  /**
   * 自機後方の推進ジェット。毎フレーム呼び出す想定。
   * @param {number} x
   * @param {number} y
   * @param {number} [angle=Math.PI/2] 噴射方向（0=右, PI/2=下）
   * @returns {number}
   */
  createThruster(x, y, angle = Math.PI * 0.5) {
    const baseAngle = Number.isFinite(angle) ? angle : Math.PI * 0.5;

    let created = 0;
    for (let i = 0; i < 2; i++) {
      const a = baseAngle + random(-0.28, 0.28);
      const speed = random(90, 240);
      const life = random(0.12, 0.26);
      const tint = i === 0 ? '#ffd36b' : '#ff8a3d';
      if (
        this._spawnDot(
          x + random(-2, 2),
          y + random(-2, 2),
          Math.cos(a) * speed,
          Math.sin(a) * speed,
          life,
          random(1.2, 2.4),
          tint,
          3.5,
          0,
          0.05
        )
      ) {
        created++;
      }
    }
    return created;
  }

  /**
   * ボム発動時の衝撃波リングと飛散パーティクル。
   * @param {number} x
   * @param {number} y
   * @param {number} [radius=300] 衝撃波の最大半径(px)
   * @returns {number}
   */
  createBombWave(x, y, radius = 300) {
    const r = clampInt(radius, 40, 1200, 300);

    let created = 0;

    if (this._spawnRing(x, y, r * 0.04, r, 0.55, Math.max(6, r * 0.05), '#bfe6ff', 0)) created++;
    if (this._spawnRing(x, y, r * 0.03, r * 0.82, 0.42, Math.max(3, r * 0.025), '#7fb8ff', 0.07)) {
      created++;
    }
    if (this._spawnFlash(x, y, Math.max(14, r * 0.08), '#eaf7ff', 0.2)) created++;

    const count = Math.min(70, Math.max(18, Math.round(r / 7)));
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TAU;
      const speed = random(r * 0.9, r * 2.2);
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const tint = i % 3 === 0 ? '#ffffff' : '#bfe6ff';
      const ok =
        i % 2 === 0
          ? this._spawnDot(x, y, vx, vy, random(0.3, 0.7), random(1, 2.6), tint, 1.6, 0)
          : this._spawnSpark(x, y, vx, vy, random(0.25, 0.55), random(1, 2), tint, 0);
      if (ok) created++;
    }

    return created;
  }

  /**
   * アイテム吸収時の軌跡。アイテム位置から自機位置へ吸い込まれる光。
   * @param {number} x
   * @param {number} y
   * @param {number} targetX
   * @param {number} targetY
   * @returns {number}
   */
  createItemAbsorb(x, y, targetX, targetY) {
    const p = this._acquire();
    if (!p) return 0;

    const dx = targetX - x;
    const dy = targetY - y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

    p.type = TYPE_ABSORB;
    p.x = x;
    p.y = y;
    p.startX = x;
    p.startY = y;
    p.targetX = targetX;
    p.targetY = targetY;
    p.maxLife = Math.min(0.55, 0.28 + dist / 1400);
    p.life = p.maxLife;
    p.size = 2.2;
    p.arc = random(-1, 1) * Math.min(30, dist * 0.12);
    p.color = '#ffe98a';
    p.fadeIn = 0.05;

    return 1;
  }

  /**
   * ボスのスペル発動時の魔方陣と収束オーラ。
   * @param {number} x
   * @param {number} y
   * @param {number} [radius=120]
   * @param {string} [color='#b388ff']
   * @returns {number}
   */
  createBossAura(x, y, radius = 120, color = '#b388ff') {
    const r = clampInt(radius, 30, 600, 120);
    const tint = colorOf(color, '#b388ff');

    let created = 0;

    if (this._spawnAura(x, y, r * 1.25, r * 0.85, 1.25, tint)) created++;

    const count = Math.min(40, Math.max(16, Math.round(r / 5)));
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * TAU;
      const startR = r * random(1.1, 1.65);
      const sx = x + Math.cos(angle) * startR;
      const sy = y + Math.sin(angle) * startR;

      // 中心方向 + 接線方向で軽く渦を巻く。
      const dirX = (x - sx) / startR;
      const dirY = (y - sy) / startR;
      const tangent = random(-0.6, 0.6);
      const speed = r * random(1.2, 2);
      const vx = (dirX - dirY * tangent) * speed;
      const vy = (dirY + dirX * tangent) * speed;

      if (
        this._spawnConverge(
          sx,
          sy,
          vx,
          vy,
          x,
          y,
          random(0.35, 0.55),
          r * random(2.5, 4),
          i % 3 === 0 ? '#ffffff' : tint
        )
      ) {
        created++;
      }
    }

    if (this._spawnRing(x, y, r * 0.2, r * 1.1, 0.35, Math.max(2, r * 0.02), tint, 0.15)) {
      created++;
    }

    return created;
  }

  // --- 内部: プール管理 --------------------------------------------------

  _acquire() {
    if (this._freeCount === 0) return null;

    const index = this._free[--this._freeCount];
    const p = this._pool[index];

    p.reset();
    p.active = true;
    p._slot = this._activeCount;
    this._active[this._activeCount++] = p;

    return p;
  }

  _release(p) {
    const slot = p._slot;
    const last = this._active[--this._activeCount];

    if (last !== p) {
      this._active[slot] = last;
      last._slot = slot;
    }
    this._active[this._activeCount] = null;

    p.active = false;
    p._slot = -1;
    this._free[this._freeCount++] = p._index;
  }

  // --- 内部: 生成 -------------------------------------------------------

  _spawnDot(x, y, vx, vy, life, size, color, drag = 0, gravity = 0, fadeIn = 0.1) {
    const p = this._acquire();
    if (!p) return null;

    p.type = TYPE_DOT;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.maxLife = life;
    p.life = life;
    p.size = size;
    p.color = color;
    p.drag = drag;
    p.gravity = gravity;
    p.fadeIn = fadeIn;

    return p;
  }

  _spawnFlash(x, y, size, color, life) {
    return this._spawnDot(x, y, 0, 0, life, size, color, 0, 0, 0.02);
  }

  _spawnSpark(x, y, vx, vy, life, size, color, gravity = 0) {
    const p = this._acquire();
    if (!p) return null;

    p.type = TYPE_SPARK;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.maxLife = life;
    p.life = life;
    p.size = size;
    p.color = color;
    p.drag = 1.5;
    p.gravity = gravity;
    p.fadeIn = 0.05;

    return p;
  }

  _spawnShard(x, y, vx, vy, life, size, color) {
    const p = this._acquire();
    if (!p) return null;

    p.type = TYPE_SHARD;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.maxLife = life;
    p.life = life;
    p.size = size;
    p.color = color;
    p.drag = 1.2;
    p.gravity = 720;
    p.rotation = Math.random() * TAU;
    p.spin = random(-12, 12);
    p.fadeIn = 0.05;

    return p;
  }

  _spawnStar(x, y, vx, vy, life, size, color) {
    const p = this._acquire();
    if (!p) return null;

    p.type = TYPE_STAR;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.maxLife = life;
    p.life = life;
    p.size = size;
    p.color = color;
    p.drag = 2.5;
    p.rotation = Math.random() * TAU;
    p.spin = random(-9, 9);
    p.fadeIn = 0.2;

    return p;
  }

  _spawnRing(x, y, radius0, radius1, life, width, color, delay = 0) {
    const p = this._acquire();
    if (!p) return null;

    p.type = TYPE_RING;
    p.x = x;
    p.y = y;
    p.radius0 = radius0;
    p.radius1 = radius1;
    p.radius = radius0;
    p.maxLife = life;
    p.life = life;
    p.size = width;
    p.color = color;
    p.fadeIn = 0.05;
    p.delay = delay;

    return p;
  }

  _spawnAura(x, y, radius0, radius1, life, color) {
    const p = this._acquire();
    if (!p) return null;

    p.type = TYPE_AURA;
    p.x = x;
    p.y = y;
    p.radius0 = radius0;
    p.radius1 = radius1;
    p.radius = radius0;
    p.maxLife = life;
    p.life = life;
    p.rotation = Math.random() * TAU;
    p.spin = random(0.5, 0.9);
    p.color = color;
    p.fadeIn = 0.1;

    return p;
  }

  _spawnConverge(x, y, vx, vy, targetX, targetY, life, accel, color) {
    const p = this._acquire();
    if (!p) return null;

    p.type = TYPE_CONVERGE;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.targetX = targetX;
    p.targetY = targetY;
    p.maxLife = life;
    p.life = life;
    p.size = random(1.2, 2);
    p.accel = accel;
    p.color = color;
    p.fadeIn = 0.1;

    return p;
  }

  // --- 内部: 描画 -------------------------------------------------------

  _alphaOf(p) {
    const t = p.maxLife > 0 ? 1 - p.life / p.maxLife : 1;

    let alpha = 1;
    if (p.fadeIn > 0 && t < p.fadeIn) alpha = t / p.fadeIn;

    const fadeOut = 0.35;
    if (t > 1 - fadeOut) alpha *= (1 - t) / fadeOut;

    return alpha > 0 ? alpha : 0;
  }

  _drawParticle(ctx, p) {
    const t = p.maxLife > 0 ? 1 - p.life / p.maxLife : 1;
    const alpha = this._alphaOf(p);

    switch (p.type) {
      case TYPE_DOT: {
        const radius = Math.max(0.4, p.size * (1 - t * 0.45));
        this._drawGlow(ctx, p.x, p.y, radius, p.color, alpha * 0.9);
        break;
      }
      case TYPE_SPARK: {
        const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
        const len = Math.min(30, Math.max(3, speed * 0.045));
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(0.6, p.size * (1 - t * 0.5));
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - (p.vx / speed) * len, p.y - (p.vy / speed) * len);
        ctx.stroke();
        break;
      }
      case TYPE_RING: {
        const width = Math.max(0.8, p.size * (1 - t));
        ctx.strokeStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.5, p.radius), 0, TAU);

        ctx.globalAlpha = alpha * 0.28;
        ctx.lineWidth = Math.max(2, width * 3.2);
        ctx.stroke();

        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        ctx.stroke();
        break;
      }
      case TYPE_STAR: {
        const r = Math.max(1, p.size * (1 - t * 0.5));
        const cos = Math.cos(p.rotation);
        const sin = Math.sin(p.rotation);

        ctx.globalAlpha = alpha;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(p.x - cos * r, p.y - sin * r);
        ctx.lineTo(p.x + cos * r, p.y + sin * r);
        ctx.moveTo(p.x - sin * r * 0.6, p.y + cos * r * 0.6);
        ctx.lineTo(p.x + sin * r * 0.6, p.y - cos * r * 0.6);
        ctx.stroke();
        break;
      }
      case TYPE_SHARD: {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size, -p.size * 0.45, p.size * 2, p.size * 0.9);
        ctx.restore();
        break;
      }
      case TYPE_ABSORB: {
        const dx = p.targetX - p.startX;
        const dy = p.targetY - p.startY;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const tail = 14 * (1 - t * 0.5);

        ctx.globalAlpha = alpha * 0.8;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - (dx / dist) * tail, p.y - (dy / dist) * tail);
        ctx.stroke();

        this._drawGlow(ctx, p.x, p.y, p.size, p.color, alpha);
        break;
      }
      case TYPE_AURA: {
        this._drawAura(ctx, p, alpha);
        break;
      }
      case TYPE_CONVERGE: {
        const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
        const len = Math.min(36, Math.max(6, speed * 0.045));

        ctx.globalAlpha = alpha;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(0.8, p.size * (1 - t * 0.4));
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - (p.vx / speed) * len, p.y - (p.vy / speed) * len);
        ctx.stroke();
        break;
      }
      default:
        break;
    }
  }

  _drawAura(ctx, p, alpha) {
    const r = Math.max(4, p.radius);
    const rot = p.rotation;
    const lineWidth = Math.max(1.2, r * 0.015);

    ctx.save();
    ctx.translate(p.x, p.y);

    const sprite = this._getGlowSprite(p.color);
    if (sprite) {
      const d = r * 2.6;
      ctx.globalAlpha = alpha * 0.2;
      ctx.drawImage(sprite, -d * 0.5, -d * 0.5, d, d);
    }

    ctx.globalAlpha = alpha;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = lineWidth;

    // 外周と内周
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, r * 0.82, 0, TAU);
    ctx.stroke();

    // 放射状の目盛り
    ctx.beginPath();
    for (let i = 0; i < 12; i++) {
      const a = rot + (i * TAU) / 12;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.moveTo(cos * r * 0.82, sin * r * 0.82);
      ctx.lineTo(cos * r, sin * r);
    }
    ctx.stroke();

    // 逆回転する二重三角（六芒星）
    const inner = r * 0.55;
    ctx.beginPath();
    for (let tri = 0; tri < 2; tri++) {
      for (let i = 0; i < 3; i++) {
        const a = -rot * 0.7 + tri * Math.PI + (i * TAU) / 3;
        const px = Math.cos(a) * inner;
        const py = Math.sin(a) * inner;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    ctx.stroke();

    // 外周を回るルーン風の光点
    ctx.fillStyle = p.color;
    for (let i = 0; i < 8; i++) {
      const a = -rot * 0.5 + (i * TAU) / 8;
      ctx.globalAlpha = alpha * 0.85;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.91, Math.sin(a) * r * 0.91, Math.max(1, r * 0.015), 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  _drawGlow(ctx, x, y, radius, color, alpha) {
    const sprite = this._getGlowSprite(color);

    if (sprite) {
      const d = radius * 6;
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, x - d * 0.5, y - d * 0.5, d, d);
      return;
    }

    // Canvas が使えない環境（テスト等）向けの簡易描画。
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();
  }

  _getGlowSprite(color) {
    if (!this._canCreateSprite) return null;
    if (this._glowCache.has(color)) return this._glowCache.get(color);

    if (this._glowCache.size >= MAX_SPRITE_CACHE) this._glowCache.clear();

    const canvas = document.createElement('canvas');
    canvas.width = GLOW_SPRITE_SIZE;
    canvas.height = GLOW_SPRITE_SIZE;

    const g = canvas.getContext('2d');
    if (!g) {
      this._canCreateSprite = false;
      return null;
    }

    try {
      const half = GLOW_SPRITE_SIZE / 2;
      const gradient = g.createRadialGradient(half, half, 0, half, half, half);
      gradient.addColorStop(0, color);
      gradient.addColorStop(0.32, color);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gradient;
      g.fillRect(0, 0, GLOW_SPRITE_SIZE, GLOW_SPRITE_SIZE);
    } catch {
      this._glowCache.set(color, null);
      return null;
    }

    this._glowCache.set(color, canvas);
    return canvas;
  }
}
