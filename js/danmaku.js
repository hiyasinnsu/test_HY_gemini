/**
 * danmaku.js — 軽量・高パフォーマンス弾幕エンジン（Canvas 2D / ES Modules）
 *
 * 設計方針:
 * - 弾は EnemyBullet / PlayerBullet の2クラス + オブジェクトプールで管理し、
 *   生成・破棄によるGCスパイク（スマホのコマ落ち原因）を避ける。
 * - 描画は「形状 × カラー」ごとの発光スプライトを初回だけ生成し、実行時は
 *   drawImage 1回で済ませる。shadowBlur は使わない（スマホGPU負荷が高いため）。
 *   グローは放射グラデーション + 2重円/リングを事前レンダリングして表現する。
 * - 更新は配列の swap-remove 方式。毎フレームの配列再生成（filter等）は行わない。
 *
 * 座標系: プレイフィールド座標（ピクセル、論理解像度 480x720 を既定とする）。
 * angle はラジアンで 0 = +X、Math.PI/2 = 下方向。
 *
 * 使用例:
 *   import { BulletManager } from './danmaku.js';
 *
 *   const bullets = new BulletManager({ width: 480, height: 720, maxBullets: 4000 });
 *   bullets.prewarm(1200, 120);
 *
 *   bullets.createRing(boss.x, boss.y, 32, 140, 'neonPink', 'orb');
 *   bullets.createAimedN(boss.x, boss.y, player.x, player.y, 5, 220, 0.25, 'neonCyan', 'needle');
 *
 *   // 毎フレーム
 *   bullets.update(dt);
 *   const hit = bullets.checkPlayerCollision(player.x, player.y, 2);
 *   if (hit) { // 被弾処理 }
 *   bullets.draw(ctx);
 *
 *   // ボム
 *   const items = bullets.clearBullets(true); // 敵弾を消し、{x, y} のアイテム座標を得る
 *
 * パターン生成メソッドは「実際に生成できた弾数」を返す。maxBullets に達した場合は
 * 打ち切られるため、返り値が引数の count より小さくなることがある。
 */

const TAU = Math.PI * 2;

/** 利用可能な弾形状 */
export const BULLET_SHAPES = Object.freeze(['orb', 'needle', 'medium', 'large']);

/** ネオンカラーパレット（代表色）。任意のCSS色（#rrggbb / rgb()）も指定可能。 */
export const PALETTE = Object.freeze({
  neonCyan: '#38e8ff',
  neonPink: '#ff4fd8',
  neonYellow: '#ffe23d',
  neonGreen: '#4dff88',
  neonOrange: '#ff9a2e',
  neonPurple: '#b463ff',
  white: '#ffffff',
});

/* ------------------------------------------------------------------------- *
 * 形状メタデータ
 * ------------------------------------------------------------------------- */

const SHAPE_DEFS = [
  { code: 0, name: 'orb', drawRadius: 6.5, hitbox: 2.6, graze: 13, spriteW: 28, spriteH: 28, rotated: false },
  { code: 1, name: 'needle', drawRadius: 6, hitbox: 2.2, graze: 12, spriteW: 32, spriteH: 16, rotated: true },
  { code: 2, name: 'medium', drawRadius: 11, hitbox: 6, graze: 19, spriteW: 42, spriteH: 42, rotated: false },
  { code: 3, name: 'large', drawRadius: 17, hitbox: 9.5, graze: 26, spriteW: 58, spriteH: 58, rotated: false },
];
const SHAPE_COUNT = SHAPE_DEFS.length;
const SHAPE_BY_NAME = Object.create(null);
for (let i = 0; i < SHAPE_DEFS.length; i++) SHAPE_BY_NAME[SHAPE_DEFS[i].name] = SHAPE_DEFS[i];

/* ------------------------------------------------------------------------- *
 * カラー管理（パレット + 任意CSS色）
 * ------------------------------------------------------------------------- */

const COLOR_ENTRIES = [];
const COLOR_INDEX = Object.create(null);

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/** '#rgb' / '#rgba' / '#rrggbb' / '#rrggbbaa' / 'rgb()' / 'rgba()' を [r,g,b] にする */
function parseColorToRgb(css) {
  if (typeof css !== 'string') return null;
  const s = css.trim();
  if (s.charCodeAt(0) === 35 /* '#' */) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex.charAt(0) + hex.charAt(0), 16);
      const g = parseInt(hex.charAt(1) + hex.charAt(1), 16);
      const b = parseInt(hex.charAt(2) + hex.charAt(2), 16);
      return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
    }
    return null;
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
  if (m) return [clamp255(+m[1]), clamp255(+m[2]), clamp255(+m[3])];
  return null;
}

function rgbToCss(rgb) {
  return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
}

function lighten(rgb, amount) {
  return [
    Math.round(rgb[0] + (255 - rgb[0]) * amount),
    Math.round(rgb[1] + (255 - rgb[1]) * amount),
    Math.round(rgb[2] + (255 - rgb[2]) * amount),
  ];
}

function registerColor(name, main) {
  const rgb = parseColorToRgb(main) || [255, 255, 255];
  const index = COLOR_ENTRIES.length;
  COLOR_ENTRIES.push({ name, main, core: rgbToCss(lighten(rgb, 0.62)), rgb });
  COLOR_INDEX[name] = index;
  return index;
}

for (const name in PALETTE) registerColor(name, PALETTE[name]);

/** カラー名 or CSS色 → 内部カラーインデックス（未知の色は白にフォールバック） */
function colorIndexOf(color) {
  const key = typeof color === 'string' && color.length > 0 ? color : 'white';
  const known = COLOR_INDEX[key];
  if (known !== undefined) return known;
  const rgb = parseColorToRgb(key);
  if (!rgb) return COLOR_INDEX.white;
  const index = COLOR_ENTRIES.length;
  COLOR_ENTRIES.push({ name: key, main: key, core: rgbToCss(lighten(rgb, 0.62)), rgb });
  COLOR_INDEX[key] = index;
  return index;
}

/* ------------------------------------------------------------------------- *
 * スプライト生成・描画
 * ------------------------------------------------------------------------- */

/** 高DPIでもぼやけないようスプライトを2倍解像度で作る（メモリは数十KB/枚） */
const SPRITE_RES = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
const SPRITE_CACHE = [];

function createCanvas2D(logicalW, logicalH) {
  const w = Math.max(1, Math.ceil(logicalW * SPRITE_RES));
  const h = Math.max(1, Math.ceil(logicalH * SPRITE_RES));
  let canvas = null;
  if (typeof OffscreenCanvas === 'function') {
    try {
      canvas = new OffscreenCanvas(w, h);
    } catch (e) {
      canvas = null;
    }
  }
  if (!canvas && typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
  }
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.scale(SPRITE_RES, SPRITE_RES);
  return { canvas, ctx };
}

/** 円形弾（orb / medium / large）のグラデーション発光スプライト */
function buildRoundSprite(def, col) {
  const size = def.spriteW;
  const made = createCanvas2D(size, size);
  if (!made) return null;
  const ctx = made.ctx;
  const c = size * 0.5;
  const coreR = def.drawRadius;
  const glowR = c;
  const r = col.rgb[0];
  const g = col.rgb[1];
  const b = col.rgb[2];

  // 外周グロー（shadowBlurの代わりに事前レンダリングした放射グラデーション）
  let grad = ctx.createRadialGradient(c, c, 0, c, c, glowR);
  grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',0.95)');
  grad.addColorStop(0.3, 'rgba(' + r + ',' + g + ',' + b + ',0.5)');
  grad.addColorStop(0.62, 'rgba(' + r + ',' + g + ',' + b + ',0.14)');
  grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(c, c, glowR, 0, TAU);
  ctx.fill();

  // 本体（中心が明るい球体）
  grad = ctx.createRadialGradient(c - coreR * 0.25, c - coreR * 0.25, coreR * 0.1, c, c, coreR);
  grad.addColorStop(0, col.core);
  grad.addColorStop(0.55, col.main);
  grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0.85)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(c, c, coreR, 0, TAU);
  ctx.fill();

  // 2重円の縁取り
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = Math.max(1, coreR * 0.14);
  ctx.beginPath();
  ctx.arc(c, c, coreR * 0.94, 0, TAU);
  ctx.stroke();

  // 中玉・大玉は外周リングでもう一段の発光感を出す
  if (def.code >= 2) {
    ctx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.7)';
    ctx.lineWidth = Math.max(1, coreR * 0.09);
    ctx.beginPath();
    ctx.arc(c, c, coreR * 1.3, 0, TAU);
    ctx.stroke();
  }

  // ハイライト
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.arc(c - coreR * 0.28, c - coreR * 0.28, coreR * 0.3, 0, TAU);
  ctx.fill();

  return made.canvas;
}

/** 針・米粒弾のスプライト（+X方向を向く）。描画時に弾の進行方向へ回転させる。 */
function buildNeedleSprite(def, col) {
  const made = createCanvas2D(def.spriteW, def.spriteH);
  if (!made) return null;
  const ctx = made.ctx;
  const w = def.spriteW;
  const h = def.spriteH;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const halfLen = def.drawRadius * 1.9;
  const halfThick = def.drawRadius * 0.52;
  const r = col.rgb[0];
  const g = col.rgb[1];
  const b = col.rgb[2];

  // 細長いグロー
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, 0.45);
  let grad = ctx.createRadialGradient(0, 0, 0, 0, 0, cx);
  grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',0.9)');
  grad.addColorStop(0.45, 'rgba(' + r + ',' + g + ',' + b + ',0.4)');
  grad.addColorStop(0.8, 'rgba(' + r + ',' + g + ',' + b + ',0.1)');
  grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, cx, 0, TAU);
  ctx.fill();
  ctx.restore();

  // 米粒状の本体
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, halfThick / halfLen);
  grad = ctx.createRadialGradient(0, 0, 0, 0, 0, halfLen);
  grad.addColorStop(0, col.core);
  grad.addColorStop(0.5, col.main);
  grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0.9)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, halfLen, 0, TAU);
  ctx.fill();

  // 中心の白い筋
  ctx.scale(1, 0.42);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(0, 0, halfLen * 0.82, 0, TAU);
  ctx.fill();
  ctx.restore();

  return made.canvas;
}

function getSprite(colorIndex, shapeCode) {
  const key = colorIndex * SHAPE_COUNT + shapeCode;
  let sprite = SPRITE_CACHE[key];
  if (sprite === undefined) {
    const def = SHAPE_DEFS[shapeCode] || SHAPE_DEFS[0];
    const col = COLOR_ENTRIES[colorIndex] || COLOR_ENTRIES[0];
    sprite = def.rotated ? buildNeedleSprite(def, col) : buildRoundSprite(def, col);
    SPRITE_CACHE[key] = sprite; // 生成不可（Canvasなし）の場合は null を保持して再試行しない
  }
  return sprite;
}

/** Canvas 2Dが使えない環境向けの簡易描画（見た目より安全性優先のフォールバック） */
function drawVectorBullet(ctx, bullet) {
  const col = COLOR_ENTRIES[bullet.colorIndex] || COLOR_ENTRIES[0];
  const r = bullet.drawRadius;
  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = col.main;
  ctx.beginPath();
  ctx.arc(bullet.x, bullet.y, r * 2, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = col.main;
  ctx.beginPath();
  ctx.arc(bullet.x, bullet.y, r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = col.core;
  ctx.beginPath();
  ctx.arc(bullet.x - r * 0.25, bullet.y - r * 0.25, r * 0.55, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function renderBullet(ctx, bullet) {
  const sprite = getSprite(bullet.colorIndex, bullet.shapeCode);
  if (!sprite) {
    drawVectorBullet(ctx, bullet);
    return;
  }
  const w = bullet.drawW;
  const h = bullet.drawH;
  if (bullet.rotated) {
    ctx.save();
    ctx.translate(bullet.x, bullet.y);
    ctx.rotate(bullet.angle);
    ctx.drawImage(sprite, -w * 0.5, -h * 0.5, w, h);
    ctx.restore();
  } else {
    ctx.drawImage(sprite, bullet.x - w * 0.5, bullet.y - h * 0.5, w, h);
  }
}

/* ------------------------------------------------------------------------- *
 * Bullet クラス
 * ------------------------------------------------------------------------- */

export class Bullet {
  constructor() {
    this.isEnemy = true;
    this.active = false;

    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.angle = 0;
    this.speed = 0;
    this.curve = 0;
    this.accel = 0;

    this.shape = 'orb';
    this.shapeCode = 0;
    this.rotated = false;
    this.drawRadius = 6.5;
    this.drawW = 28;
    this.drawH = 28;
    this.hitboxRadius = 2.6;
    this.radius = 2.6; // 衝突半径の互換エイリアス（game.js / player.js が参照する）
    this.grazeRadius = 13;
    this.grazed = false;
    this.grazedByPlayer = false;
    this.grazable = true;
    this.noGraze = false;
    this.dead = false;
    this.removed = false;
    this.convertedToItem = false;

    this.owner = 'enemy';
    this.friendly = false;
    this.hostile = true;
    this.type = 'orb';

    this.color = 'white';
    this.colorIndex = 0;
    this.damage = 1;
    this.life = 12;
    this.age = 0;
    this.tag = 0;

    this.isSine = false;
    this.sineAmp = 0;
    this.sineFreq = 0;
    this.sinePhase = 0;
    this.baseX = 0;
    this.baseY = 0;
    this.normX = 0;
    this.normY = 1;

    this.isOrbit = false;
    this.orbitCx = 0;
    this.orbitCy = 0;
    this.orbitRadius = 0;
    this.orbitAngle = 0;
    this.orbitSpeed = 0;
    this.orbitRadial = 0;
  }

  /**
   * プールから取り出した弾を設定で初期化する（毎回全フィールドを上書きする）。
   * vx / vy が指定された場合はそちらを優先し、angle / speed を逆算する。
   */
  init(cfg) {
    const shapeName = cfg.shape || (this.isEnemy ? 'orb' : 'needle');
    const def = SHAPE_BY_NAME[shapeName] || SHAPE_DEFS[0];
    const scale = cfg.scale > 0 ? cfg.scale : 1;
    const color = cfg.color || (this.isEnemy ? 'neonCyan' : 'white');

    let angle;
    let speed;
    if (cfg.vx !== undefined || cfg.vy !== undefined) {
      const vx = cfg.vx || 0;
      const vy = cfg.vy || 0;
      angle = Math.atan2(vy, vx);
      speed = Math.sqrt(vx * vx + vy * vy);
    } else {
      angle = cfg.angle || 0;
      speed = cfg.speed || 0;
    }

    this.shape = def.name;
    this.shapeCode = def.code;
    this.rotated = def.rotated;
    this.color = color;
    this.colorIndex = colorIndexOf(color);

    // 見た目の半径。drawRadius で直接、scale で形状比率のまま拡縮できる。
    const drawRadius = cfg.drawRadius > 0 ? cfg.drawRadius : def.drawRadius * scale;
    const visualScale = drawRadius / def.drawRadius;
    this.drawRadius = drawRadius;
    this.drawW = def.spriteW * visualScale;
    this.drawH = def.spriteH * visualScale;

    // 当たり半径。ゲーム側の慣習に合わせて cfg.radius は「衝突半径」として扱う
    // （enemy.js の bulletSpec / player.js の弾specが radius を衝突半径として渡す）。
    // 省略時は形状ごとの既定値（自機弾は命中感を出すため多め）を使う。
    const collisionRadius = cfg.hitboxRadius > 0
      ? cfg.hitboxRadius
      : cfg.radius > 0
        ? cfg.radius
        : this.isEnemy ? def.hitbox * visualScale : (def.hitbox + 2.2) * visualScale;
    this.hitboxRadius = collisionRadius;
    this.radius = collisionRadius;
    this.grazeRadius = cfg.grazeRadius > 0
      ? cfg.grazeRadius
      : this.isEnemy ? def.graze * visualScale : 0;
    this.grazable = this.isEnemy && cfg.grazable !== false;
    this.noGraze = !this.grazable;
    this.grazed = !this.isEnemy; // 自機弾はグレイズ対象外
    this.grazedByPlayer = false;
    this.dead = false;
    this.removed = false;
    this.convertedToItem = false;

    this.owner = cfg.owner !== undefined ? cfg.owner : (this.isEnemy ? 'enemy' : 'player');
    this.friendly = cfg.friendly !== undefined ? cfg.friendly === true : !this.isEnemy;
    this.hostile = cfg.hostile !== undefined ? cfg.hostile === true : this.isEnemy;
    this.type = cfg.type !== undefined ? cfg.type : def.name;

    this.damage = cfg.damage > 0 ? cfg.damage : 1;
    this.life = cfg.life > 0 ? cfg.life : (this.isEnemy ? 12 : 2.4);
    this.age = 0;
    this.tag = cfg.tag !== undefined ? cfg.tag : 0;

    this.angle = angle;
    this.speed = speed;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.curve = cfg.curve || 0;
    this.accel = cfg.accel || 0;

    // サイン波ゆらぎ
    const amp = cfg.sineAmp || 0;
    this.sineAmp = amp;
    this.isSine = amp !== 0;
    if (this.isSine) {
      this.sineFreq = cfg.sineFreq || 0;
      this.sinePhase = cfg.sinePhase || 0;
      this.baseX = cfg.x || 0;
      this.baseY = cfg.y || 0;
      this.normX = -Math.sin(angle);
      this.normY = Math.cos(angle);
    } else {
      this.sineFreq = 0;
      this.sinePhase = 0;
    }

    // 周回（回転十字など）。軌道運動中は curve / accel は無視される。
    this.isOrbit = cfg.orbit === true;
    if (this.isOrbit) {
      const cx = cfg.orbitCx !== undefined ? cfg.orbitCx : (cfg.x || 0);
      const cy = cfg.orbitCy !== undefined ? cfg.orbitCy : (cfg.y || 0);
      this.orbitCx = cx;
      this.orbitCy = cy;
      this.orbitRadius = cfg.orbitRadius || 0;
      this.orbitAngle = cfg.orbitAngle !== undefined ? cfg.orbitAngle : angle;
      this.orbitSpeed = cfg.orbitSpeed || 0;
      this.orbitRadial = cfg.orbitRadial !== undefined ? cfg.orbitRadial : speed;
      this.x = cx + Math.cos(this.orbitAngle) * this.orbitRadius;
      this.y = cy + Math.sin(this.orbitAngle) * this.orbitRadius;
      this.angle = this.orbitAngle + (this.orbitRadial < 0 ? -Math.PI * 0.5 : Math.PI * 0.5);
      this.speed = this.orbitRadial;
      this.vx = Math.cos(this.angle) * this.speed;
      this.vy = Math.sin(this.angle) * this.speed;
    } else {
      this.x = cfg.x || 0;
      this.y = cfg.y || 0;
      this.orbitCx = 0;
      this.orbitCy = 0;
      this.orbitRadius = 0;
      this.orbitAngle = 0;
      this.orbitSpeed = 0;
      this.orbitRadial = 0;
    }
  }

  /** @returns {boolean} false になった弾はマネージャがプールへ戻す */
  update(dt) {
    this.age += dt;
    if (this.age >= this.life) return false;

    if (this.isOrbit) {
      this.orbitRadius += this.orbitRadial * dt;
      this.orbitAngle += this.orbitSpeed * dt;
      this.x = this.orbitCx + Math.cos(this.orbitAngle) * this.orbitRadius;
      this.y = this.orbitCy + Math.sin(this.orbitAngle) * this.orbitRadius;
      this.angle = this.orbitAngle + (this.orbitRadial < 0 ? -Math.PI * 0.5 : Math.PI * 0.5);
      return true;
    }

    if (this.curve !== 0 || this.accel !== 0) {
      if (this.curve !== 0) this.angle += this.curve * dt;
      if (this.accel !== 0) this.speed = Math.max(0, this.speed + this.accel * dt);
      this.vx = Math.cos(this.angle) * this.speed;
      this.vy = Math.sin(this.angle) * this.speed;
    }

    if (this.isSine) {
      this.baseX += this.vx * dt;
      this.baseY += this.vy * dt;
      this.sinePhase += this.sineFreq * TAU * dt;
      const offset = Math.sin(this.sinePhase) * this.sineAmp;
      this.x = this.baseX + this.normX * offset;
      this.y = this.baseY + this.normY * offset;
      return true;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    return true;
  }

  draw(ctx) {
    renderBullet(ctx, this);
  }

  /** 次回 update で消滅させる（ゲーム側の dead フラグ慣習にも対応） */
  kill() {
    this.dead = true;
    this.active = false;
    this.age = this.life;
  }
}

export class EnemyBullet extends Bullet {
  constructor() {
    super();
    this.isEnemy = true;
    this.grazed = false;
  }
}

export class PlayerBullet extends Bullet {
  constructor() {
    super();
    this.isEnemy = false;
    this.grazed = true;
    this.grazeRadius = 0;
    this.life = 2.4;
  }
}

/* ------------------------------------------------------------------------- *
 * パターン生成時のオプション上書きキー
 * ------------------------------------------------------------------------- */

const OPTION_KEYS = [
  'curve', 'accel', 'radius', 'drawRadius', 'scale', 'hitboxRadius', 'grazeRadius',
  'life', 'damage', 'tag', 'sineAmp', 'sineFreq', 'sinePhase',
];

function applyOptions(cfg, opts) {
  if (!opts) return;
  for (let i = 0; i < OPTION_KEYS.length; i++) {
    const key = OPTION_KEYS[i];
    const value = opts[key];
    if (value !== undefined) cfg[key] = value;
  }
}

/* ------------------------------------------------------------------------- *
 * BulletManager
 * ------------------------------------------------------------------------- */

export class BulletManager {
  /**
   * @param {number|object} [options] 横幅、または設定オブジェクト
   * @param {number} [height] options が数値のときの画面高さ
   */
  constructor(options = {}, height) {
    if (typeof options === 'number') options = { width: options, height };
    const opt = options || {};

    /** プレイフィールドの幅・高さ（論理解像度 480x720 を既定とする） */
    this.width = opt.width || 480;
    this.height = opt.height || 720;
    /** 画面外とみなす余白。グローや画面端スポーンを考慮して広めに取る */
    this.margin = opt.margin !== undefined ? opt.margin : 64;
    /** 敵弾 + 自機弾の同時存在上限 */
    this.maxBullets = opt.maxBullets || 4000;
    /** 1フレームの最大dt（タブ復帰時のワープ・すり抜け防止） */
    this.maxDt = opt.maxDt || 0.05;
    /** true にすると 'lighter' 合成で発光を強調する（端末負荷はやや上がる） */
    this.additive = opt.additive === true;

    /** 敵弾（イテレーション用配列。弾オブジェクトを直接参照できる） */
    this.enemyBullets = [];
    /** 自機弾 */
    this.playerBullets = [];

    this.time = 0;
    this.grazeCount = 0;
    /** 直近の checkPlayerCollision で新規発生したグレイズ数 */
    this.lastGraze = 0;

    /** @type {((bullet: Bullet) => void)|null} */
    this.onGraze = null;
    /** @type {((bullet: Bullet, toItems: boolean, fromBomb: boolean) => void)|null} */
    this.onBulletCleared = null;

    this._enemyPool = [];
    this._playerPool = [];

    // パターン生成のたびにオブジェクトを確保しないための使い回し設定
    this._cfg = {
      x: 0, y: 0, angle: 0, speed: 0, color: 'white', shape: 'orb',
      curve: 0, accel: 0, radius: 0, drawRadius: 0, scale: 1, hitboxRadius: 0, grazeRadius: 0,
      life: 0, damage: 1, tag: 0,
      sineAmp: 0, sineFreq: 1, sinePhase: 0,
      orbit: false, orbitCx: 0, orbitCy: 0, orbitRadius: 0, orbitAngle: 0,
      orbitSpeed: 0, orbitRadial: 0,
    };
  }

  /** 画面サイズを更新する（リサイズ・レスポンシブ対応） */
  setBounds(width, height, margin = this.margin) {
    this.width = width;
    this.height = height;
    this.margin = margin;
  }

  /** プールを事前確保して初弾時のGCスパイクを防ぐ */
  prewarm(enemyCount = 0, playerCount = 0) {
    for (let i = 0; i < enemyCount; i++) this._enemyPool.push(new EnemyBullet());
    for (let i = 0; i < playerCount; i++) this._playerPool.push(new PlayerBullet());
  }

  get count() {
    return this.enemyBullets.length + this.playerBullets.length;
  }

  get enemyCount() {
    return this.enemyBullets.length;
  }

  get playerCount() {
    return this.playerBullets.length;
  }

  /* --------------------------------------------------------------------- *
   * 生成
   * --------------------------------------------------------------------- */

  /**
   * 敵弾を1発生成する（低レベルAPI。通常はパターン生成メソッドを使う）。
   * @param {object} spec {x, y, angle, speed, または vx, vy, shape, color,
   *   radius（衝突半径）, drawRadius（見た目の半径）, hitboxRadius, grazeRadius,
   *   grazable, life, curve, accel, sineAmp, sineFreq, sinePhase, damage, tag,
   *   owner, type, friendly, hostile}
   * @returns {EnemyBullet|null} 上限到達時は null
   */
  spawnEnemy(spec) {
    return this._acquire(true, spec || {});
  }

  /** spawnEnemy の別名 */
  spawnEnemyBullet(spec) {
    return this._acquire(true, spec || {});
  }

  /**
   * 自機弾を1発生成する（低レベルAPI）。
   * @param {object} spec {x, y, vx, vy, damage, color, shape, life,
   *   radius（衝突半径）, drawRadius（見た目）, ...}
   *   vx/vy の代わりに angle + speed も使用可能。
   * @returns {PlayerBullet|null}
   */
  spawnPlayer(spec) {
    return this._acquire(false, spec || {});
  }

  /** spawnPlayer の別名 */
  spawnPlayerBullet(spec) {
    return this._acquire(false, spec || {});
  }

  /** spawnPlayerBullet の別名 */
  addPlayerBullet(spec) {
    return this._acquire(false, spec || {});
  }

  _acquire(enemy, cfg) {
    if (this.enemyBullets.length + this.playerBullets.length >= this.maxBullets) return null;
    const pool = enemy ? this._enemyPool : this._playerPool;
    const list = enemy ? this.enemyBullets : this.playerBullets;
    let bullet = pool.pop();
    if (bullet === undefined) bullet = enemy ? new EnemyBullet() : new PlayerBullet();
    bullet.active = true;
    bullet.init(cfg);
    list.push(bullet);
    return bullet;
  }

  /** パターン用の使い回し設定を初期状態に戻す */
  _beginCfg(x, y, angle, speed, color, shape) {
    const cfg = this._cfg;
    cfg.x = x;
    cfg.y = y;
    cfg.angle = angle;
    cfg.speed = speed;
    cfg.color = color;
    cfg.shape = shape;
    cfg.curve = 0;
    cfg.accel = 0;
    cfg.radius = 0;
    cfg.drawRadius = 0;
    cfg.scale = 1;
    cfg.hitboxRadius = 0;
    cfg.grazeRadius = 0;
    cfg.life = 0;
    cfg.damage = 1;
    cfg.tag = 0;
    cfg.sineAmp = 0;
    cfg.sineFreq = 1;
    cfg.sinePhase = 0;
    cfg.orbit = false;
    cfg.orbitCx = 0;
    cfg.orbitCy = 0;
    cfg.orbitRadius = 0;
    cfg.orbitAngle = 0;
    cfg.orbitSpeed = 0;
    cfg.orbitRadial = 0;
    return cfg;
  }

  /* --------------------------------------------------------------------- *
   * 弾幕パターン
   * --------------------------------------------------------------------- */

  /**
   * 全方位リング弾
   * @param {number} offsetAngle リングの開始角度（ラジアン）
   * @param {object} [opts] curve / radius（衝突半径）/ drawRadius（見た目）/ life などの上書き
   * @returns {number} 生成できた弾数
   */
  createRing(x, y, count, speed, color = 'neonCyan', shape = 'orb', offsetAngle = 0, opts = null) {
    const n = count | 0;
    if (n <= 0) return 0;
    const step = TAU / n;
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      const cfg = this._beginCfg(x, y, offsetAngle + i * step, speed, color, shape);
      applyOptions(cfg, opts);
      if (!this._acquire(true, cfg)) break;
      spawned++;
    }
    return spawned;
  }

  /**
   * 渦巻き弾。angle を中心に、弾を spread 間隔で扇状に並べる。
   * 呼び出し側で angle を毎回少し進めると渦を巻く。opts.curve で各弾を曲げることも可能。
   * @param {number} spread 隣り合う弾の角度間隔（ラジアン）
   * @returns {number} 生成できた弾数
   */
  createSpiral(x, y, count, speed, color = 'neonCyan', shape = 'orb', angle = 0, spread = 0.18, opts = null) {
    const n = count | 0;
    if (n <= 0) return 0;
    const center = (n - 1) * 0.5;
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      const cfg = this._beginCfg(x, y, angle + (i - center) * spread, speed, color, shape);
      applyOptions(cfg, opts);
      if (!this._acquire(true, cfg)) break;
      spawned++;
    }
    return spawned;
  }

  /**
   * 自機狙いの扇状弾（奇数なら中央の1発が正確に自機を狙い、偶数なら中央が空く）
   * @param {number} spreadAngle 扇の全開角（ラジアン）
   * @returns {number} 生成できた弾数
   */
  createAimedN(x, y, targetX, targetY, count, speed, spreadAngle = 0.18, color = 'neonCyan', shape = 'orb', opts = null) {
    const n = count | 0;
    if (n <= 0) return 0;
    const aim = Math.atan2(targetY - y, targetX - x);
    const step = n > 1 ? spreadAngle / (n - 1) : 0;
    const start = n > 1 ? aim - spreadAngle * 0.5 : aim;
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      const cfg = this._beginCfg(x, y, start + step * i, speed, color, shape);
      applyOptions(cfg, opts);
      if (!this._acquire(true, cfg)) break;
      spawned++;
    }
    return spawned;
  }

  /**
   * 幾何学花弁弾。花弁ごとに countPerPetal 発を扇状に配置し、
   * 花弁の中心ほど速く飛ばすことで花びらの輪郭を作る。
   * @param {number} rotation 花全体の回転（ラジアン）
   * @returns {number} 生成できた弾数
   */
  createFlower(x, y, petals, countPerPetal, speed, color = 'neonCyan', shape = 'orb', rotation = 0, opts = null) {
    const petalCount = petals | 0;
    const perPetal = countPerPetal | 0;
    if (petalCount <= 0 || perPetal <= 0) return 0;
    const petalStep = TAU / petalCount;
    const petalWidth = petalStep * 0.62;
    let spawned = 0;
    for (let p = 0; p < petalCount; p++) {
      const axis = rotation + p * petalStep;
      for (let k = 0; k < perPetal; k++) {
        const u = perPetal === 1 ? 0 : (k / (perPetal - 1)) * 2 - 1; // -1 .. 1
        const cfg = this._beginCfg(
          x, y,
          axis + u * petalWidth * 0.5,
          speed * (1 - 0.22 * u * u),
          color, shape,
        );
        applyOptions(cfg, opts);
        if (!this._acquire(true, cfg)) return spawned;
        spawned++;
      }
    }
    return spawned;
  }

  /**
   * サイン波ゆらぎ弾を1発生成する。連射すると蛇行する弾列になる。
   * freq は 1秒あたりの振動数（Hz）。
   * @returns {number} 生成できた弾数（0 or 1）
   */
  createWave(x, y, angle, speed, freq, amp, color = 'neonCyan', shape = 'orb', opts = null) {
    const cfg = this._beginCfg(x, y, angle, speed, color, shape);
    cfg.sineAmp = amp;
    cfg.sineFreq = freq;
    applyOptions(cfg, opts);
    return this._acquire(true, cfg) ? 1 : 0;
  }

  /**
   * 画面上部からの弾幕カーテン。width いっぱいに count 発を等間隔で配置し、下向きに発射する。
   * @param {object} [opts] opts.y でスポーンY座標を変更可能（既定 -24）
   * @returns {number} 生成できた弾数
   */
  createCurtain(width, count, speed, color = 'neonCyan', shape = 'orb', opts = null) {
    const n = count | 0;
    if (n <= 0) return 0;
    const step = width / n;
    const y = opts && typeof opts.y === 'number' ? opts.y : -24;
    let spawned = 0;
    for (let i = 0; i < n; i++) {
      const cfg = this._beginCfg(step * (i + 0.5), y, Math.PI * 0.5, speed, color, shape);
      applyOptions(cfg, opts);
      if (!this._acquire(true, cfg)) break;
      spawned++;
    }
    return spawned;
  }

  /**
   * 回転十字弾。arms 本の腕に countPerArm 発ずつ配置し、十字全体が rotSpeed で回転しながら
   * speed で外側へ広がる。
   * @param {number} rotSpeed 回転角速度（ラジアン/秒）
   * @param {string} [shape] 弾形状
   * @param {object} [opts] opts.radiusStep（腕の弾間隔, 既定24）, opts.rotation（初期回転）
   * @returns {number} 生成できた弾数
   */
  createCross(x, y, arms, countPerArm, speed, color = 'neonCyan', rotSpeed = 0.8, shape = 'orb', opts = null) {
    const armCount = arms | 0;
    const perArm = countPerArm | 0;
    if (armCount <= 0 || perArm <= 0) return 0;
    const armStep = TAU / armCount;
    const radiusStep = opts && opts.radiusStep > 0 ? opts.radiusStep : 24;
    const rotation = opts && typeof opts.rotation === 'number' ? opts.rotation : 0;
    let spawned = 0;
    for (let arm = 0; arm < armCount; arm++) {
      const base = rotation + arm * armStep;
      for (let k = 0; k < perArm; k++) {
        const cfg = this._beginCfg(x, y, base, speed, color, shape);
        cfg.orbit = true;
        cfg.orbitCx = x;
        cfg.orbitCy = y;
        cfg.orbitAngle = base;
        cfg.orbitRadius = (k + 1) * radiusStep;
        cfg.orbitSpeed = rotSpeed;
        cfg.orbitRadial = speed;
        applyOptions(cfg, opts);
        if (!this._acquire(true, cfg)) return spawned;
        spawned++;
      }
    }
    return spawned;
  }

  /* --------------------------------------------------------------------- *
   * 更新・描画
   * --------------------------------------------------------------------- */

  /**
   * 全弾を更新し、寿命切れ・画面外の弾をプールへ戻す。
   * @param {number} dt 経過秒（既定 1/60）
   */
  update(dt = 1 / 60) {
    if (!(dt > 0)) return;
    if (dt > this.maxDt) dt = this.maxDt;
    this.time += dt;
    this._updateList(this.enemyBullets, this._enemyPool, dt);
    this._updateList(this.playerBullets, this._playerPool, dt);
  }

  _updateList(list, pool, dt) {
    const minX = -this.margin;
    const minY = -this.margin;
    const maxX = this.width + this.margin;
    const maxY = this.height + this.margin;
    let i = 0;
    while (i < list.length) {
      const bullet = list[i];
      // ゲーム側が active=false / dead=true にした弾は次フレームで回収する
      if (bullet.active === false || bullet.dead === true || bullet.removed === true) {
        const last = list.pop();
        if (i < list.length) list[i] = last;
        bullet.active = false;
        pool.push(bullet);
        continue;
      }
      const alive = bullet.update(dt);
      if (!alive || bullet.active === false || bullet.dead === true || bullet.removed === true
        || bullet.x < minX || bullet.x > maxX || bullet.y < minY || bullet.y > maxY) {
        const last = list.pop();
        if (i < list.length) list[i] = last;
        bullet.active = false;
        pool.push(bullet);
        continue; // 入れ替えた弾を同じインデックスで再チェック
      }
      i++;
    }
  }

  /**
   * 弾を描画する。
   * @param {CanvasRenderingContext2D} ctx
   * @param {'all'|'player'|'enemy'} [layer] 描画レイヤー（既定 all）
   */
  draw(ctx, layer = 'all') {
    const drawPlayer = layer !== 'enemy';
    const drawEnemy = layer !== 'player';
    if (this.additive) {
      const prev = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter';
      if (drawPlayer) this._drawList(ctx, this.playerBullets);
      if (drawEnemy) this._drawList(ctx, this.enemyBullets);
      ctx.globalCompositeOperation = prev;
      return;
    }
    if (drawPlayer) this._drawList(ctx, this.playerBullets);
    if (drawEnemy) this._drawList(ctx, this.enemyBullets);
  }

  _drawList(ctx, list) {
    for (let i = 0; i < list.length; i++) {
      const bullet = list[i];
      // 消滅処理待ち（active=false / dead / removed）の弾は描画しない
      if (bullet.active === false || bullet.dead === true || bullet.removed === true) continue;
      bullet.draw(ctx);
    }
  }

  /* --------------------------------------------------------------------- *
   * 当たり判定
   * --------------------------------------------------------------------- */

  /**
   * 自機と敵弾の当たり判定 + グレイズ判定を1パスで行う。
   * グレイズは弾ごとに1回だけ（grazed フラグ）発生する。
   * 毎フレーム1回だけ呼ぶこと。
   *
   * @param {number} x 自機（当たり判定中心）X
   * @param {number} y 自機 Y
   * @param {number} [playerRadius] 自機の当たり半径
   * @param {boolean} [removeOnHit] true なら被弾した弾をその場で消す
   * @returns {EnemyBullet|null} 被弾した弾（なければ null）
   */
  checkPlayerCollision(x, y, playerRadius = 2, removeOnHit = false) {
    this.lastGraze = 0;
    const list = this.enemyBullets;
    let hit = null;
    for (let i = 0; i < list.length; i++) {
      const bullet = list[i];
      if (bullet.active === false || bullet.dead === true || bullet.removed === true) continue;
      const dx = bullet.x - x;
      const dy = bullet.y - y;
      const distSq = dx * dx + dy * dy;
      const hitRadius = bullet.hitboxRadius + playerRadius;
      if (distSq <= hitRadius * hitRadius) {
        hit = bullet;
        if (removeOnHit) this._removeAt(list, this._enemyPool, i);
        break;
      }
      if (!bullet.grazed && !bullet.grazedByPlayer && !bullet.noGraze) {
        const grazeRadius = bullet.grazeRadius;
        if (grazeRadius > 0 && distSq <= grazeRadius * grazeRadius) {
          bullet.grazed = true;
          bullet.grazedByPlayer = true;
          this.lastGraze++;
          if (this.onGraze) this.onGraze(bullet);
        }
      }
    }
    this.grazeCount += this.lastGraze;
    return hit;
  }

  /**
   * 自機弾と敵本体の当たり判定。命中した自機弾は消滅し、合計ダメージを返す。
   * @param {number} x 敵の中心X
   * @param {number} y 敵の中心Y
   * @param {number} [radius] 敵の当たり半径
   * @param {((bullet: PlayerBullet) => void)|null} [onHit] 命中時のコールバック（エフェクト用）
   * @returns {number} 与えた合計ダメージ
   */
  hitTestEnemy(x, y, radius = 8, onHit = null) {
    const list = this.playerBullets;
    const pool = this._playerPool;
    let damage = 0;
    let i = 0;
    while (i < list.length) {
      const bullet = list[i];
      if (bullet.active === false || bullet.dead === true || bullet.removed === true) {
        i++;
        continue;
      }
      const dx = bullet.x - x;
      const dy = bullet.y - y;
      const hitRadius = bullet.hitboxRadius + radius;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        damage += bullet.damage;
        const last = list.pop();
        if (i < list.length) list[i] = last;
        bullet.active = false;
        pool.push(bullet);
        if (onHit) onHit(bullet);
        continue;
      }
      i++;
    }
    return damage;
  }

  _removeAt(list, pool, index) {
    const bullet = list[index];
    const last = list.pop();
    if (index < list.length) list[index] = last;
    bullet.active = false;
    pool.push(bullet);
  }

  /* --------------------------------------------------------------------- *
   * ボム・リセット
   * --------------------------------------------------------------------- */

  /**
   * 敵弾を全消滅させる（ボム用）。
   * @param {boolean} [toScoreItems] true なら消滅位置をアイテム座標 {x, y} の配列で返す（既定 true）。
   *   onBulletCleared を設定しておけば、配列確保なしで自前のアイテムプールへ流せる。
   * @returns {Array<{x:number, y:number}>} アイテム座標（toScoreItems が false のときは空配列）
   */
  clearBullets(toScoreItems = true) {
    if (toScoreItems !== null && typeof toScoreItems === 'object') {
      return this.clearEnemyBullets(toScoreItems);
    }
    return this._clearEnemyBullets(toScoreItems !== false, false);
  }

  /**
   * 敵弾を全消滅させる（オプション形式）。プレイヤー/ボム側のインターフェース。
   * @param {{toItems?: boolean, fromBomb?: boolean}} [options]
   *   toItems: アイテム化するか（既定 true）
   *   fromBomb: ボムによる消滅か（onBulletCleared へ渡す）
   * @returns {Array<{x:number, y:number}>} アイテム座標（toItems=false なら空配列）
   */
  clearEnemyBullets(options = {}) {
    const opt = options || {};
    const toItems = opt.toItems !== false;
    return this._clearEnemyBullets(toItems, opt.fromBomb === true);
  }

  _clearEnemyBullets(toItems, fromBomb) {
    const list = this.enemyBullets;
    const pool = this._enemyPool;
    const items = toItems ? new Array(list.length) : [];
    const callback = this.onBulletCleared;
    for (let i = 0; i < list.length; i++) {
      const bullet = list[i];
      bullet.active = false;
      if (toItems) items[i] = { x: bullet.x, y: bullet.y };
      if (callback) callback(bullet, toItems, fromBomb);
      pool.push(bullet);
    }
    list.length = 0;
    return items;
  }

  /** 自機弾を全消滅させる */
  clearPlayerBullets() {
    const list = this.playerBullets;
    const pool = this._playerPool;
    for (let i = 0; i < list.length; i++) {
      list[i].active = false;
      pool.push(list[i]);
    }
    list.length = 0;
  }

  /** 敵弾・自機弾の両方を消す（ゲームオーバーやシーン切替用） */
  clearAll() {
    this._clearEnemyBullets(false, false);
    this.clearPlayerBullets();
  }

  /** clearAll の互換エイリアス（game.start() などが clear() を試すため） */
  clear() {
    this.clearAll();
  }

  /** 弾・スコア・タイマーを初期状態へ戻す（プールは保持する） */
  reset() {
    this.clearAll();
    this.time = 0;
    this.grazeCount = 0;
    this.lastGraze = 0;
  }
}
