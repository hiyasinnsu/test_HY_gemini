/**
 * enemy.js — 敵キャラクター / ボス / アイテムシステム
 * 弾幕シューティング用 ES Module。外部依存なし。
 *
 * 連携インターフェース (すべて duck-typing。無い場合は安全に無視):
 *   world.player               { x, y, alive?, hitRadius? }
 *   world.width / world.height 画面サイズ
 *   world.fireBullet(spec)     弾生成。無ければ world.bullets.spawn/add/fire、
 *                              world.danmaku.spawnEnemyBullet/fire/spawn を順に試す
 *   world.clearBullets()       フェーズ移行時の消弾。danmaku.clearBullets(true) /
 *                              danmaku.clearEnemyBullets も試す
 *   world.addScore(n)          スコア加算
 *   world.collectItem(type, item) / world.onCollect(type)  アイテム回収通知
 *   world.audio.playSE(name)   効果音 (enemy_shot / enemy_die / boss_hit /
 *                              boss_phase / boss_die / item / laser)。
 *                              無ければ playExplosion / playHit / playItem /
 *                              playWarning / playBossDefeat も検出する
 *   world.shake(amount)        画面揺れ
 *   world.spawnLaser(opts)     任意。無ければボスレーザーは弾列で表現
 */

const TAU = Math.PI * 2;

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
const lerp = (a, b, t) => a + (b - a) * t;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function easeInOutQuad(t) {
  const k = clamp(t, 0, 1);
  return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
}

function easeOutCubic(t) {
  const k = clamp(t, 0, 1);
  return 1 - Math.pow(1 - k, 3);
}

function angleTo(fromX, fromY, toX, toY) {
  return Math.atan2(toY - fromY, toX - fromX);
}

function hexAlpha(hex, alpha) {
  if (typeof hex !== 'string') return `rgba(160, 220, 255, ${alpha})`;
  let body = hex.replace('#', '');
  if (body.length === 3) {
    body = body
      .split('')
      .map((c) => c + c)
      .join('');
  }
  const value = parseInt(body, 16);
  if (Number.isNaN(value)) return `rgba(160, 220, 255, ${alpha})`;
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/* ------------------------------------------------------------------ *
 * 外部モジュール連携アダプタ
 * ------------------------------------------------------------------ */

/** 効果音名。audio.js 側の命名と差異があっても playSE 側で吸収する。 */
export const SE = Object.freeze({
  enemyShot: 'enemy_shot',
  enemyDie: 'enemy_die',
  enemyHit: 'enemy_hit',
  bossHit: 'boss_hit',
  bossPhase: 'boss_phase',
  bossDie: 'boss_die',
  laser: 'laser',
  item: 'item',
});

const warned = new Set();

function warnOnce(key, error) {
  if (warned.has(key)) return;
  warned.add(key);
  // 連携先APIの不整合でゲーム全体を止めない。初回のみ通知する。
  console.warn(`[enemy.js] ${key}`, error);
}

function callAudio(audio, name) {
  const method = audio[name];
  if (typeof method !== 'function') return false;
  try {
    method.call(audio);
    return true;
  } catch (error) {
    warnOnce(`audio.${name}`, error);
    return false;
  }
}

/**
 * 効果音を鳴らす。audio.playSE(name) → audio.play(name) を優先し、
 * 汎用APIが無い場合は用途別メソッドを検出して呼ぶ。
 */
export function playSE(world, name) {
  if (!world || !name) return;
  const audio = world.audio || world.sound || world.audioEngine;
  if (!audio) return;

  const generic = audio.playSE || audio.se || audio.play;
  if (typeof generic === 'function') {
    try {
      generic.call(audio, name);
      return;
    } catch (error) {
      warnOnce(`audio.playSE(${name})`, error);
    }
  }

  switch (name) {
    case SE.enemyDie:
      callAudio(audio, 'playExplosion');
      break;
    case SE.bossDie:
      callAudio(audio, 'playBossDefeat');
      if (typeof audio.playExplosion === 'function') {
        try {
          audio.playExplosion(true);
        } catch (error) {
          warnOnce('audio.playExplosion(true)', error);
        }
      }
      break;
    case SE.enemyHit:
    case SE.bossHit:
      callAudio(audio, 'playHit');
      break;
    case SE.bossPhase:
      callAudio(audio, 'playWarning');
      break;
    case SE.item:
      callAudio(audio, 'playItem');
      break;
    default:
      break;
  }
}

/**
 * スコア加算。world.addScore → manager.onScore → manager.stats の順で通知する。
 */
export function awardScore(world, manager, amount) {
  if (!amount) return;
  if (world && typeof world.addScore === 'function') {
    try {
      world.addScore(amount);
    } catch (error) {
      warnOnce('world.addScore', error);
    }
  } else if (world && typeof world.score === 'number') {
    world.score += amount;
  }
  if (manager) {
    if (manager.stats) manager.stats.score += amount;
    if (typeof manager.onScore === 'function') manager.onScore(amount);
  }
}

/** 画面揺れ。world.shake / world.camera.shake を試す。 */
export function shakeScreen(world, amount) {
  if (!world || !amount) return;
  const target = typeof world.shake === 'function' ? world : world.camera;
  if (!target) return;
  const method = target.shake;
  if (typeof method !== 'function') return;
  try {
    method.call(target, amount);
  } catch (error) {
    warnOnce('world.shake', error);
  }
}

/**
 * ボスフェーズ移行時の消弾。
 * danmaku.clearBullets(true) を最優先し、次に敵弾専用APIを試す。
 * (clearBullets(true) は得点アイテム化を伴う消弾。danmaku.js の既定挙動)
 */
export function clearEnemyBullets(world) {
  if (!world) return false;

  const danmaku = world.danmaku;
  if (danmaku) {
    if (typeof danmaku.clearBullets === 'function') {
      try {
        danmaku.clearBullets(true);
        return true;
      } catch (error) {
        warnOnce('danmaku.clearBullets', error);
      }
    }
    if (typeof danmaku.clearEnemyBullets === 'function') {
      try {
        danmaku.clearEnemyBullets();
        return true;
      } catch (error) {
        warnOnce('danmaku.clearEnemyBullets', error);
      }
    }
  }

  const pools = [world.bullets, world.bulletManager];
  for (const pool of pools) {
    if (!pool) continue;
    for (const name of ['clearEnemyBullets', 'clearHostileBullets', 'clear']) {
      if (typeof pool[name] === 'function') {
        try {
          pool[name]();
          return true;
        } catch (error) {
          warnOnce(`bullets.${name}`, error);
        }
      }
    }
  }
  for (const name of ['clearEnemyBullets', 'clearBullets']) {
    if (typeof world[name] === 'function') {
      try {
        world[name]();
        return true;
      } catch (error) {
        warnOnce(`world.${name}`, error);
      }
    }
  }
  return false;
}

/**
 * 弾を1発生成する。danmaku.js との接続口。
 * spec は角度・速度と vx/vy の両方を持つため、どちらの方式でも受け取れる。
 */
export function fireBullet(world, spec) {
  if (!world || !spec) return null;
  const bullet = { ...spec };
  if (bullet.radius == null) bullet.radius = bullet.r == null ? 6 : bullet.r;
  if (bullet.r == null) bullet.r = bullet.radius;
  if (bullet.vx == null || bullet.vy == null) {
    const speed = bullet.speed ?? 0;
    const angle = bullet.angle ?? 0;
    if (bullet.vx == null) bullet.vx = Math.cos(angle) * speed;
    if (bullet.vy == null) bullet.vy = Math.sin(angle) * speed;
  }
  if (!bullet.owner) bullet.owner = 'enemy';
  if (bullet.hostile == null) bullet.hostile = true;

  const hosts = [
    [world, ['fireBullet', 'spawnBullet', 'emitBullet']],
    [world.bullets, ['spawn', 'fire', 'add', 'emit', 'push']],
    [world.danmaku, ['spawnEnemyBullet', 'fire', 'spawn', 'emit', 'add']],
    [world.bulletManager, ['spawnEnemyBullet', 'fire', 'spawn', 'add']],
  ];
  for (const [host, methods] of hosts) {
    if (!host) continue;
    for (const name of methods) {
      if (typeof host[name] !== 'function') continue;
      try {
        return host[name](bullet);
      } catch (error) {
        warnOnce(`fireBullet:${name}`, error);
        return null;
      }
    }
  }
  if (Array.isArray(world.bullets)) {
    world.bullets.push(bullet);
    return bullet;
  }
  return null;
}

/** 角度・速度から弾specを作る。 */
export function bulletSpec(x, y, angle, speed, options = {}) {
  const radius = options.radius ?? 6;
  const shape = options.shape ?? options.type ?? 'orb';
  const spec = {
    x,
    y,
    angle,
    speed,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    radius,
    r: radius,
    color: options.color ?? '#9fe8ff',
    type: shape,
    shape,
    damage: options.damage ?? 1,
    owner: 'enemy',
    hostile: true,
    grazable: options.grazable ?? true,
  };
  if (options.life != null) spec.life = options.life;
  return spec;
}

/** 弾を撃つショートハンド。 */
export function shoot(world, x, y, angle, speed, options = {}) {
  return fireBullet(world, bulletSpec(x, y, angle, speed, options));
}

/* ------------------------------------------------------------------ *
 * 内部エフェクト (被弾火花・撃破爆発・フェーズ移行リング)
 * world 側のパーティクルと二重にならないよう、enemy.js 内で完結する
 * 軽量レイヤーとして持つ。
 * ------------------------------------------------------------------ */

class Effects {
  constructor(maxParticles = 320) {
    this.maxParticles = maxParticles;
    this.particles = [];
    this.rings = [];
  }

  burst(x, y, options = {}) {
    const count = options.count ?? 12;
    const color = options.color ?? '#9fe8ff';
    const speed = options.speed ?? 150;
    const spread = options.spread ?? TAU;
    const baseAngle = options.angle ?? rand(0, TAU);
    const life = options.life ?? 0.5;
    const size = options.size ?? 2.4;
    const drag = options.drag ?? 3;
    const gravity = options.gravity ?? 0;

    for (let i = 0; i < count; i += 1) {
      const angle = baseAngle + rand(-spread / 2, spread / 2);
      const velocity = speed * rand(0.35, 1);
      const particleLife = life * rand(0.6, 1.2);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        life: particleLife,
        maxLife: particleLife,
        size: size * rand(0.6, 1.4),
        color,
        drag,
        gravity,
      });
    }
    if (this.particles.length > this.maxParticles) {
      this.particles.splice(0, this.particles.length - this.maxParticles);
    }
  }

  ring(x, y, options = {}) {
    this.rings.push({
      x,
      y,
      radius: options.radius ?? 6,
      speed: options.speed ?? 320,
      life: options.life ?? 0.5,
      maxLife: options.life ?? 0.5,
      color: options.color ?? '#bde8ff',
      width: options.width ?? 2.5,
      fill: options.fill ?? false,
    });
    if (this.rings.length > 24) this.rings.shift();
  }

  update(dt) {
    for (const particle of this.particles) {
      particle.life -= dt;
      const damping = Math.max(0, 1 - particle.drag * dt);
      particle.vx *= damping;
      particle.vy = particle.vy * damping + particle.gravity * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
    }
    if (this.particles.length) {
      this.particles = this.particles.filter((particle) => particle.life > 0);
    }
    for (const ring of this.rings) {
      ring.life -= dt;
      ring.radius += ring.speed * dt;
    }
    if (this.rings.length) {
      this.rings = this.rings.filter((ring) => ring.life > 0);
    }
  }

  render(ctx) {
    if (!this.particles.length && !this.rings.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const particle of this.particles) {
      const alpha = clamp(particle.life / particle.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, particle.size * (0.4 + alpha * 0.6), 0, TAU);
      ctx.fill();
    }
    for (const ring of this.rings) {
      const alpha = clamp(ring.life / ring.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = ring.width;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ring.radius, 0, TAU);
      if (ring.fill) {
        ctx.fillStyle = hexAlpha(ring.color, 0.18);
        ctx.fill();
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  clear() {
    this.particles.length = 0;
    this.rings.length = 0;
  }
}

/* ------------------------------------------------------------------ *
 * 汎用移動パス (直線 / ベジエ / Catmull-Rom スプライン / ホバリング)
 * Enemy の options.path にそのまま渡せる。
 * ------------------------------------------------------------------ */

const EASINGS = {
  linear: (t) => clamp(t, 0, 1),
  inout: easeInOutQuad,
  out: easeOutCubic,
};

function pointLerp(from, to, t) {
  return { x: lerp(from.x, to.x, t), y: lerp(from.y, to.y, t) };
}

/**
 * @param {'line'|'bezier'|'spline'|'hover'} kind
 * @param {object} params
 * @returns {{ duration: number, at: (t: number) => {x:number, y:number} }}
 */
export function createPath(kind, params = {}) {
  const from = params.from ?? { x: 0, y: 0 };
  const to = params.to ?? from;
  const ease = typeof params.ease === 'function' ? params.ease : EASINGS[params.ease] ?? easeInOutQuad;

  if (kind === 'spline') {
    const points = Array.isArray(params.points) && params.points.length >= 2 ? params.points : [from, to];
    const duration = Math.max(0.0001, params.duration ?? 1);
    return {
      duration,
      at(time) {
        const global = clamp(time / duration, 0, 1) * (points.length - 1);
        const index = Math.min(points.length - 2, Math.floor(global));
        const t = global - index;
        const p0 = points[Math.max(0, index - 1)];
        const p1 = points[index];
        const p2 = points[index + 1];
        const p3 = points[Math.min(points.length - 1, index + 2)];
        const t2 = t * t;
        const t3 = t2 * t;
        return {
          x:
            0.5 *
            (2 * p1.x +
              (-p0.x + p2.x) * t +
              (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
              (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y:
            0.5 *
            (2 * p1.y +
              (-p0.y + p2.y) * t +
              (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
              (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
        };
      },
    };
  }

  if (kind === 'hover') {
    const enter = Math.max(0.0001, params.enter ?? 1);
    const hold = Math.max(0, params.hold ?? 0);
    const exit = params.exit ?? null;
    const exitDuration = Math.max(0.0001, params.exitDuration ?? 1.2);
    const bobAmp = params.bobAmp ?? 0;
    const bobFreq = params.bobFreq ?? 2;
    const duration = enter + hold + (exit ? exitDuration : 0);
    return {
      duration,
      at(time) {
        if (time <= enter) {
          return pointLerp(from, to, ease(time / enter));
        }
        if (exit && time > enter + hold) {
          return pointLerp(to, exit, ease((time - enter - hold) / exitDuration));
        }
        return {
          x: to.x + Math.sin(time * bobFreq) * bobAmp,
          y: to.y + Math.cos(time * bobFreq * 0.8) * bobAmp * 0.5,
        };
      },
    };
  }

  if (kind === 'bezier') {
    const c1 = params.control1 ?? params.c1 ?? from;
    const c2 = params.control2 ?? params.c2 ?? to;
    const duration = Math.max(0.0001, params.duration ?? 1);
    return {
      duration,
      at(time) {
        const t = ease(time / duration);
        const m = 1 - t;
        return {
          x: m * m * m * from.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * to.x,
          y: m * m * m * from.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * to.y,
        };
      },
    };
  }

  // 'line' (既定)
  const duration = Math.max(0.0001, params.duration ?? 1);
  return {
    duration,
    at(time) {
      return pointLerp(from, to, ease(time / duration));
    },
  };
}

/* ------------------------------------------------------------------ *
 * ザコ敵
 * ------------------------------------------------------------------ */

export const ENEMY_TYPES = Object.freeze({
  scout: {
    label: 'SCOUT',
    hp: 7,
    radius: 15,
    score: 120,
    body: '#31d2ff',
    accent: '#d6fbff',
    glow: '#7be9ff',
    drops: [
      ['power', 50],
      ['score', 43],
      ['bomb', 6],
      ['life', 1],
    ],
    dropRolls: 1,
    descend: 105,
    zigAmp: 76,
    zigFreq: 2.4,
    shotInterval: 1.05,
  },
  fairy: {
    label: 'FAIRY',
    hp: 16,
    radius: 17,
    score: 380,
    body: '#ff79d2',
    accent: '#ffe4f7',
    glow: '#ffa8e6',
    drops: [
      ['power', 44],
      ['score', 44],
      ['bomb', 10],
      ['life', 2],
    ],
    dropRolls: 2,
    hoverTime: 3.4,
  },
  tank: {
    label: 'TANK',
    hp: 70,
    radius: 30,
    score: 1600,
    body: '#ffa64b',
    accent: '#fff0c8',
    glow: '#ffc77d',
    drops: [
      ['power', 45],
      ['score', 38],
      ['bomb', 13],
      ['life', 4],
    ],
    dropRolls: 4,
    hoverTime: 14,
  },
});

/**
 * ザコ敵。
 * 移動経路はタイプごとに 直線+ジグザグ (scout) / ベジエ進入+ホバリング (fairy) /
 * ホバリング+旋回 (tank) を使い分ける。options.path で任意パスも差し込める。
 */
export class Enemy {
  constructor(type = 'scout', options = {}, world = null) {
    const def = ENEMY_TYPES[type];
    if (!def) throw new Error(`[enemy.js] unknown enemy type: ${type}`);

    this.type = type;
    this.def = def;
    this.world = world;
    this.manager = options.manager ?? null;

    const screenWidth = world?.width ?? options.screenWidth ?? 480;
    const screenHeight = world?.height ?? options.screenHeight ?? 720;
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;

    this.x = options.x ?? screenWidth / 2;
    this.y = options.y ?? -36;
    this.spawnX = this.x;
    this.spawnY = this.y;

    this.maxHp = Math.max(1, Math.round(def.hp * (options.hpScale ?? 1)));
    this.hp = this.maxHp;
    this.radius = options.radius ?? def.radius;
    this.score = Math.round(def.score * (options.scoreScale ?? 1));
    this.invulnerable = options.invulnerable ?? false;
    this.dropOverride = options.drop ?? null;

    this.age = 0;
    this.flash = 0;
    this.flashTimer = 0;
    this.dead = false;
    this.removed = false;
    this.deathTimer = 0;
    this.phase = options.phase ?? rand(0, TAU);
    this.rotation = 0;

    this.state = 'enter';
    this.stateTime = 0;
    this.path = options.path ?? null;
    this.pathTime = 0;
    this.pathDone = false;

    this.shotTimer = options.firstShot ?? rand(0.7, 1.1);
    this.fanTimer = 1.3;
    this.spiralTimer = 0.6;
    this.spiralAngle = rand(0, TAU);
    this.shotStep = 0;

    this.initMovement(options, screenWidth, screenHeight);
  }

  initMovement(options, width, height) {
    if (this.type === 'scout') {
      this.descend = options.descend ?? this.def.descend;
      this.zigFreq = options.zigFreq ?? this.def.zigFreq;
      // 編隊の進入位置を保ちつつ、画面外へはみ出さない振幅に制限する
      this.baseX = clamp(this.spawnX, 30, width - 30);
      const room = Math.max(12, Math.min(this.baseX - 18, width - this.baseX - 18));
      this.zigAmp = Math.min(options.zigAmp ?? this.def.zigAmp, room);
      this.x = this.baseX;
      return;
    }

    if (this.type === 'fairy') {
      const hoverX = clamp(options.hoverX ?? this.x + rand(-90, 90), 48, width - 48);
      const hoverY = options.hoverY ?? height * 0.25;
      this.hoverPoint = { x: hoverX, y: hoverY };
      this.enterDuration = options.enterDuration ?? 1.35;
      this.holdTime = options.holdTime ?? this.def.hoverTime;
      this.holdTimer = 0;
      this.exitPath = null;
      const direction = hoverX >= this.x ? 1 : -1;
      this.enterPath = createPath('bezier', {
        from: { x: this.x, y: this.y },
        control1: { x: this.x + direction * 30, y: height * 0.05 },
        control2: { x: hoverX - direction * 120, y: hoverY - 90 },
        to: this.hoverPoint,
        duration: this.enterDuration,
        ease: 'inout',
      });
      return;
    }

    // tank
    this.hoverX = clamp(options.hoverX ?? width / 2 + rand(-width * 0.22, width * 0.22), 72, width - 72);
    this.hoverY = options.hoverY ?? height * 0.2;
    this.enterDuration = options.enterDuration ?? 2.2;
    this.stayTime = options.stayTime ?? this.def.hoverTime;
    this.stayTimer = 0;
    this.driftPhase = rand(0, TAU);
    this.exitPath = null;
  }

  /* ---------------------------- 更新 ---------------------------- */

  /** 外部の衝突判定向け。生存中のみ true。 */
  get active() {
    return !this.dead && !this.removed;
  }

  update(dt, world = this.world) {
    if (this.dead) {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) this.removed = true;
      return;
    }
    // 外部 (game.js など) が hp を直接減らした場合もここで撃破処理へ入る
    if (this.hp <= 0) {
      this.die(world ?? this.world);
      return;
    }
    if (world) this.world = world;
    const scene = this.world ?? { width: this.screenWidth, height: this.screenHeight };

    this.age += dt;
    if (this.flashTimer > 0) {
      this.flash = 1;
      this.flashTimer = Math.max(0, this.flashTimer - dt);
    } else {
      this.flash = Math.max(0, this.flash - dt * 5);
    }

    this.updateMovement(dt, scene);
    this.updatePattern(dt, scene);

    const width = scene.width ?? this.screenWidth;
    const height = scene.height ?? this.screenHeight;
    if (this.x < -150 || this.x > width + 150 || this.y > height + 100) {
      this.removed = true;
    }
  }

  updateMovement(dt, world) {
    const width = world.width ?? this.screenWidth;
    const height = world.height ?? this.screenHeight;
    this.stateTime += dt;

    if (this.path) {
      this.pathTime += dt;
      const point = this.path.at(this.pathTime);
      this.x = point.x;
      this.y = point.y;
      if (this.pathTime >= this.path.duration) this.pathDone = true;
      return;
    }

    if (this.type === 'scout') {
      this.y += this.descend * dt;
      const wave = Math.sin(this.age * this.zigFreq + this.phase);
      this.x = this.baseX + wave * this.zigAmp;
      this.rotation = Math.cos(this.age * this.zigFreq + this.phase) * 0.3;
      return;
    }

    if (this.type === 'fairy') {
      if (this.state === 'enter') {
        const point = this.enterPath.at(this.stateTime);
        this.x = point.x;
        this.y = point.y;
        this.rotation = Math.sin(this.stateTime * 4) * 0.08;
        if (this.stateTime >= this.enterDuration) {
          this.state = 'hold';
          this.stateTime = 0;
          this.holdTimer = 0;
        }
      } else if (this.state === 'hold') {
        this.holdTimer += dt;
        this.x = this.hoverPoint.x + Math.sin(this.age * 1.35 + this.phase) * 26;
        this.y = this.hoverPoint.y + Math.sin(this.age * 2.6 + this.phase) * 9;
        this.rotation = Math.sin(this.age * 2.1) * 0.06;
        if (this.holdTimer >= this.holdTime) {
          this.beginExit(world);
        }
      } else if (this.state === 'exit' && this.exitPath) {
        const point = this.exitPath.at(this.stateTime);
        this.x = point.x;
        this.y = point.y;
        this.rotation = -0.25;
        if (this.stateTime >= this.exitPath.duration) this.removed = true;
      }
      return;
    }

    // tank
    if (this.state === 'enter') {
      const k = easeOutCubic(this.stateTime / this.enterDuration);
      this.x = lerp(this.spawnX, this.hoverX, k);
      this.y = lerp(this.spawnY, this.hoverY, k);
      if (this.stateTime >= this.enterDuration) {
        this.state = 'hold';
        this.stateTime = 0;
      }
    } else if (this.state === 'hold') {
      this.stayTimer += dt;
      this.x = this.hoverX + Math.sin(this.age * 0.85 + this.driftPhase) * width * 0.17;
      this.x = clamp(this.x, this.radius + 14, width - this.radius - 14);
      this.y = this.hoverY + Math.sin(this.age * 1.6) * 9;
      this.rotation = Math.sin(this.age * 0.85 + this.driftPhase) * 0.1;
      if (this.stayTimer >= this.stayTime) this.beginExit(world);
    } else if (this.state === 'exit' && this.exitPath) {
      const point = this.exitPath.at(this.stateTime);
      this.x = point.x;
      this.y = point.y;
      if (this.stateTime >= this.exitPath.duration) this.removed = true;
    }

    // 画面外へ出た個体は manager が回収する
    if (this.y < -220 || this.y > height + 120) this.removed = true;
  }

  beginExit(world) {
    const width = world.width ?? this.screenWidth;
    const height = world.height ?? this.screenHeight;
    const direction = this.x < width / 2 ? -1 : 1;
    this.state = 'exit';
    this.stateTime = 0;
    this.exitPath = createPath('bezier', {
      from: { x: this.x, y: this.y },
      control1: { x: this.x - direction * 40, y: this.y - 90 },
      control2: { x: this.x + direction * 150, y: height * 0.04 },
      to: { x: this.x + direction * 260, y: -120 },
      duration: 1.5,
      ease: 'inout',
    });
  }

  updatePattern(dt, world) {
    if (!world) return;
    const height = world.height ?? this.screenHeight;

    if (this.type === 'scout') {
      if (this.y < 0 || this.y > height - 10) return;
      this.shotTimer -= dt;
      if (this.shotTimer <= 0) {
        this.shotTimer = Math.max(0.35, this.def.shotInterval * rand(0.85, 1.15));
        this.fireAimedSpread(1, 0, 235, world);
      }
      return;
    }

    if (this.type === 'fairy') {
      if (this.state !== 'hold') return;
      if (this.shotStep === 0 && this.holdTimer >= 0.35) {
        this.shotStep = 1;
        this.fireAimedSpread(3, 0.17, 190, world);
      }
      if (this.shotStep === 1 && this.holdTimer >= 1.25) {
        this.shotStep = 2;
        this.fireRing(12, 140, world, this.phase);
      }
      if (this.shotStep === 2 && this.holdTimer >= 2.35) {
        this.shotStep = 3;
        this.fireAimedSpread(3, 0.2, 205, world);
      }
      return;
    }

    // tank: 扇状弾幕 + 渦巻き
    if (this.state === 'exit') return;
    this.fanTimer -= dt;
    if (this.fanTimer <= 0) {
      this.fanTimer = Math.max(0.7, 1.55 * rand(0.9, 1.1));
      this.fireFan(7, 0.15, 200, world);
    }
    this.spiralTimer -= dt;
    while (this.spiralTimer <= 0) {
      this.spiralTimer += 0.12;
      this.spiralAngle += 0.43;
      const speed = 135;
      shoot(world, this.x, this.y, this.spiralAngle, speed, {
        color: this.def.glow,
        radius: 4.5,
        shape: 'orb',
      });
      shoot(world, this.x, this.y, this.spiralAngle + Math.PI, speed, {
        color: this.def.accent,
        radius: 4.5,
        shape: 'orb',
      });
    }
  }

  /* --------------------------- 攻撃 ---------------------------- */

  aimAngle(world, fallback = Math.PI / 2) {
    const player = world?.player;
    if (!player || player.alive === false || player.dead) return fallback;
    return angleTo(this.x, this.y, player.x, player.y);
  }

  fireAimedSpread(count, spread, speed, world) {
    const target = this.aimAngle(world);
    const start = target - (spread * (count - 1)) / 2;
    for (let i = 0; i < count; i += 1) {
      shoot(world, this.x, this.y, start + spread * i, speed, {
        color: this.def.accent,
        radius: 5,
        shape: 'orb',
      });
    }
    playSE(world, SE.enemyShot);
  }

  fireFan(count, spread, speed, world) {
    const target = this.aimAngle(world);
    const start = target - (spread * (count - 1)) / 2;
    for (let i = 0; i < count; i += 1) {
      shoot(world, this.x, this.y, start + spread * i, speed * rand(0.92, 1.08), {
        color: this.def.body,
        radius: 5.5,
        shape: 'orb',
      });
    }
    playSE(world, SE.enemyShot);
  }

  fireRing(count, speed, world, offset = 0) {
    for (let i = 0; i < count; i += 1) {
      const angle = offset + (TAU * i) / count;
      shoot(world, this.x, this.y, angle, speed, {
        color: this.def.glow,
        radius: 5,
        shape: 'orb',
      });
    }
    playSE(world, SE.enemyShot);
  }

  /* --------------------------- 被弾 ---------------------------- */

  hit(damage = 1, world = this.world) {
    if (this.dead || this.invulnerable) return false;
    this.hp -= damage;
    this.flash = 1;
    const fx = this.manager?.fx;
    if (fx && Math.random() < 0.55) {
      fx.burst(this.x, this.y, {
        count: 2,
        color: '#ffffff',
        speed: 95,
        life: 0.2,
        size: 1.8,
      });
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this.die(world);
    }
    return true;
  }

  die(world = this.world) {
    if (this.dead) return;
    this.dead = true;
    this.deathTimer = 0.32;
    const isTank = this.type === 'tank';
    const fx = this.manager?.fx;
    if (fx) {
      fx.burst(this.x, this.y, {
        count: isTank ? 46 : 26,
        color: this.def.body,
        speed: isTank ? 300 : 220,
        life: 0.7,
        size: 3,
      });
      fx.burst(this.x, this.y, {
        count: isTank ? 22 : 12,
        color: '#ffffff',
        speed: 130,
        life: 0.36,
        size: 2.2,
      });
      fx.ring(this.x, this.y, {
        radius: this.radius * 0.6,
        speed: isTank ? 420 : 280,
        life: 0.45,
        color: this.def.glow,
        width: 3,
      });
    }
    shakeScreen(world, isTank ? 0.35 : 0.15);
    playSE(world, SE.enemyDie);
    awardScore(world, this.manager, this.score);
    if (this.manager) {
      if (this.manager.stats) this.manager.stats.kills += 1;
      this.manager.dropItems(this, world);
      if (typeof this.manager.onEnemyKilled === 'function') {
        this.manager.onEnemyKilled(this, world);
      }
    }
  }

  /* --------------------------- 描画 ---------------------------- */

  traceBody(ctx) {
    if (this.type === 'scout') {
      ctx.moveTo(0, -18);
      ctx.lineTo(11, 8);
      ctx.lineTo(4, 5);
      ctx.lineTo(0, 14);
      ctx.lineTo(-4, 5);
      ctx.lineTo(-11, 8);
      ctx.closePath();
      return;
    }

    if (this.type === 'fairy') {
      // 左右の羽
      ctx.moveTo(-3, -2);
      ctx.bezierCurveTo(-17, -17, -30, 1, -8, 12);
      ctx.bezierCurveTo(-15, 4, -9, 0, -3, -2);
      ctx.closePath();
      ctx.moveTo(3, -2);
      ctx.bezierCurveTo(17, -17, 30, 1, 8, 12);
      ctx.bezierCurveTo(15, 4, 9, 0, 3, -2);
      ctx.closePath();
      // 胴体
      ctx.moveTo(0, -13);
      ctx.lineTo(8, 0);
      ctx.lineTo(0, 15);
      ctx.lineTo(-8, 0);
      ctx.closePath();
      return;
    }

    // tank: 六角形の装甲 + 左右の砲身
    const radius = 26;
    for (let i = 0; i < 6; i += 1) {
      const angle = (TAU * i) / 6 - Math.PI / 2;
      const px = Math.cos(angle) * radius;
      const py = Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.moveTo(-34, -7);
    ctx.lineTo(-17, -7);
    ctx.lineTo(-17, 7);
    ctx.lineTo(-34, 7);
    ctx.closePath();
    ctx.moveTo(34, -7);
    ctx.lineTo(17, -7);
    ctx.lineTo(17, 7);
    ctx.lineTo(34, 7);
    ctx.closePath();
  }

  render(ctx) {
    if (this.dead) return;
    const def = this.def;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);

    const gradient = ctx.createLinearGradient(0, -this.radius, 0, this.radius);
    gradient.addColorStop(0, '#0a1524');
    gradient.addColorStop(0.45, def.body);
    gradient.addColorStop(1, '#08111d');

    ctx.beginPath();
    this.traceBody(ctx);
    ctx.fillStyle = gradient;
    ctx.shadowColor = def.glow;
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.7;
    ctx.strokeStyle = def.accent;
    ctx.stroke();

    if (this.type === 'scout') {
      ctx.beginPath();
      ctx.arc(0, -5, 3.4, 0, TAU);
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = def.glow;
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.moveTo(-7, 12);
      ctx.lineTo(0, 18);
      ctx.lineTo(7, 12);
      ctx.strokeStyle = hexAlpha(def.accent, 0.65);
      ctx.lineWidth = 1.4;
      ctx.stroke();
    } else if (this.type === 'fairy') {
      const sparkle = this.age * 3 + this.phase;
      ctx.beginPath();
      ctx.arc(0, 0, 4.2, 0, TAU);
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = def.glow;
      ctx.shadowBlur = 12;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = hexAlpha(def.accent, 0.7);
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 3; i += 1) {
        const angle = sparkle + (TAU * i) / 3;
        ctx.beginPath();
        ctx.arc(Math.cos(angle) * 22, Math.sin(angle) * 16, 2.2, 0, TAU);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, 13, 0, TAU);
      ctx.strokeStyle = hexAlpha(def.accent, 0.85);
      ctx.lineWidth = 2;
      ctx.stroke();
      const spin = this.age * 1.8;
      ctx.beginPath();
      for (let i = 0; i < 3; i += 1) {
        const angle = spin + (TAU * i) / 3;
        const px = Math.cos(angle) * 19;
        const py = Math.sin(angle) * 19;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.strokeStyle = hexAlpha(def.glow, 0.8);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 5.5, 0, TAU);
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = def.glow;
      ctx.shadowBlur = 14;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    if (this.flash > 0) {
      ctx.globalAlpha = this.flash * 0.9;
      ctx.beginPath();
      this.traceBody(ctx);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    if (this.type === 'tank' && this.hp < this.maxHp) {
      const barWidth = 48;
      const ratio = clamp(this.hp / this.maxHp, 0, 1);
      const barY = this.y + this.radius + 12;
      ctx.save();
      ctx.fillStyle = 'rgba(4, 10, 20, 0.65)';
      ctx.fillRect(this.x - barWidth / 2, barY, barWidth, 3.5);
      ctx.fillStyle = def.body;
      ctx.fillRect(this.x - barWidth / 2, barY, barWidth * ratio, 3.5);
      ctx.restore();
    }
  }
}

/* ------------------------------------------------------------------ *
 * アイテム
 * ------------------------------------------------------------------ */

export const ITEM_TYPES = Object.freeze({
  power: { label: 'P', color: '#ff4d6d', glow: '#ffa3b6', score: 0 },
  score: { label: '点', color: '#43cfff', glow: '#bdf1ff', score: 1000 },
  bomb: { label: 'B', color: '#58ff9d', glow: '#c9ffdf', score: 0 },
  life: { label: 'L', color: '#ff79d5', glow: '#ffd6f2', score: 0 },
});

const ITEM_FALLBACK_METHODS = {
  power: ['addPower', 'powerUp', 'upgrade'],
  bomb: ['addBomb', 'stockBomb'],
  life: ['addLife', 'extendLife', 'addPlayer'],
};

/**
 * ドロップアイテム。
 * ゆっくり落下し、自機が磁力範囲内 or POC ラインより上に居ると
 * 全アイテムが自機へ吸引されて自動回収される。
 */
export class Item {
  constructor(type, x, y, options = {}) {
    if (!ITEM_TYPES[type]) throw new Error(`[enemy.js] unknown item type: ${type}`);
    this.type = type;
    this.def = ITEM_TYPES[type];
    this.x = x;
    this.y = y;
    this.vx = options.vx ?? rand(-55, 55);
    this.vy = options.vy ?? rand(-115, -35);
    this.radius = options.radius ?? 10;
    this.age = 0;
    this.magnet = false;
    this.collected = false;
    this.removed = false;
    this.collectDelay = options.collectDelay ?? 0.3;
    this.swayPhase = rand(0, TAU);
    this.spin = rand(0, TAU);
  }

  /** 外部の衝突判定向け。未回収かつ未削除なら true。 */
  get active() {
    return !this.collected && !this.removed;
  }

  set active(value) {
    // game.js 側の独自回収ループが active=false を代入するケースに対応する
    if (!value) {
      this.collected = true;
      this.removed = true;
    }
  }

  update(dt, world = {}, manager = null) {
    if (this.collected) return;
    this.age += dt;

    const width = world.width ?? manager?.width ?? 480;
    const height = world.height ?? manager?.height ?? 720;
    const player = world.player;
    const fallSpeed = manager?.fallSpeed ?? 68;
    const magnetRadius = world.itemMagnetRadius ?? manager?.magnetRadius ?? 100;
    const collectRadius = manager?.collectRadius ?? 20;
    const pocRatio = manager?.pocRatio ?? 0.22;
    const pocLine = world.pocLine ?? height * pocRatio;

    let attracted = false;
    let dx = 0;
    let dy = 0;
    if (player && player.alive !== false && player.dead !== true && this.age >= this.collectDelay) {
      dx = player.x - this.x;
      dy = player.y - this.y;
      const distance = Math.hypot(dx, dy);
      // POC: 画面上部に自機が居れば全アイテム自動回収
      attracted = player.y <= pocLine || distance <= magnetRadius;
    }

    if (attracted) {
      this.magnet = true;
      const distance = Math.hypot(dx, dy);
      if (distance > 0.0001) {
        // 距離が近いほど高速化し、確実に回収する
        const speed = Math.min(1200, 320 + this.age * 900);
        this.vx = (dx / distance) * speed;
        this.vy = (dy / distance) * speed;
      }
    } else if (!this.magnet) {
      this.vy += (fallSpeed - this.vy) * Math.min(1, dt * 2.4);
      this.vx *= Math.max(0, 1 - dt * 2);
      this.x += Math.sin(this.age * 2.2 + this.swayPhase) * 22 * dt;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (player && player.alive !== false && this.age >= this.collectDelay) {
      const distance = Math.hypot(player.x - this.x, player.y - this.y);
      if (distance <= collectRadius + this.radius) {
        this.collect(world, manager);
        return;
      }
    }

    if (this.y > height + 48 || this.x < -90 || this.x > width + 90) {
      this.removed = true;
    }
  }

  collect(world = {}, manager = null) {
    if (this.collected) return;
    this.collected = true;
    this.removed = true;

    // 回収音は連携先 (game.js の _applyItem など) が鳴らす場合があるため、
    // 独自ハンドラが無いときだけ鳴らす
    const hasWorldHandler =
      world && (typeof world.collectItem === 'function' || typeof world.onCollect === 'function');
    if (!hasWorldHandler) playSE(world, SE.item);

    const fx = manager?.fx;
    if (fx) {
      fx.burst(this.x, this.y, {
        count: 8,
        color: this.def.glow,
        speed: 130,
        life: 0.35,
        size: 2,
      });
      fx.ring(this.x, this.y, {
        radius: 4,
        speed: 140,
        life: 0.26,
        color: this.def.color,
        width: 1.6,
      });
    }

    let handled = false;
    if (world && typeof world.collectItem === 'function') {
      try {
        world.collectItem(this.type, this);
        handled = true;
      } catch (error) {
        warnOnce('world.collectItem', error);
      }
    } else if (world && typeof world.onCollect === 'function') {
      try {
        world.onCollect(this.type, this);
        handled = true;
      } catch (error) {
        warnOnce('world.onCollect', error);
      }
    }

    if (manager) {
      if (manager.stats?.items) manager.stats.items[this.type] += 1;
      if (typeof manager.onItemCollected === 'function') {
        manager.onItemCollected(this.type, this, world);
        handled = true;
      }
    }

    if (!handled) this.applyFallback(world, manager);
  }

  /** 連携先が未接続でも最低限の効果を適用する。 */
  applyFallback(world, manager) {
    if (this.type === 'score') {
      awardScore(world, manager, this.def.score);
      return;
    }

    const methods = ITEM_FALLBACK_METHODS[this.type] ?? [];
    const player = world?.player;
    for (const target of [player, world]) {
      if (!target) continue;
      for (const name of methods) {
        if (typeof target[name] !== 'function') continue;
        try {
          target[name](1);
          return;
        } catch (error) {
          warnOnce(`item.${name}`, error);
        }
      }
    }

    const props = { power: 'power', bomb: 'bombs', life: 'lives' };
    const prop = props[this.type];
    if (!prop) return;
    if (player && typeof player[prop] === 'number') {
      player[prop] += 1;
    } else if (world && typeof world[prop] === 'number') {
      world[prop] += 1;
    }
  }

  render(ctx) {
    const def = this.def;
    const bob = Math.sin(this.age * 3.5 + this.swayPhase) * 1.5;
    const pop = this.magnet ? 1 : Math.min(1, this.age * 6);

    ctx.save();
    ctx.translate(this.x, this.y + bob);
    ctx.scale(pop, pop);

    const aura = ctx.createRadialGradient(0, 0, 1, 0, 0, 20);
    aura.addColorStop(0, hexAlpha(def.glow, 0.55));
    aura.addColorStop(0.6, hexAlpha(def.color, 0.2));
    aura.addColorStop(1, hexAlpha(def.color, 0));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(0, 0, 20, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.rotate(this.age * 1.8 + this.spin);
    ctx.strokeStyle = hexAlpha(def.color, 0.9);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < 4; i += 1) {
      const angle = (TAU * i) / 4;
      const px = Math.cos(angle) * 12.5;
      const py = Math.sin(angle) * 12.5;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, TAU);
    ctx.fillStyle = 'rgba(6, 12, 24, 0.9)';
    ctx.fill();
    ctx.strokeStyle = def.color;
    ctx.lineWidth = 2;
    ctx.shadowColor = def.color;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = def.glow;
    ctx.font = 'bold 11px "Trebuchet MS", "Hiragino Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.label, 0, 0.5);
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ *
 * ボス
 * ------------------------------------------------------------------ */

export const BOSS_PHASES = Object.freeze([
  {
    key: 'spiral',
    label: 'PHASE 1',
    spell: '蒼穹螺旋 - AZURE SPIRAL',
    color: '#49d7ff',
    accent: '#b48cff',
    hp: 800,
    timeLimit: 32,
  },
  {
    key: 'petal',
    label: 'PHASE 2',
    spell: '花葬月華 - PETAL LUNAR',
    color: '#ff6bd6',
    accent: '#ffd166',
    hp: 1000,
    timeLimit: 38,
  },
  {
    key: 'finale',
    label: 'PHASE 3 / 発狂',
    spell: '終焉輪廻 - CHRONO REQUIEM',
    color: '#ff4757',
    accent: '#ffe066',
    hp: 1200,
    timeLimit: 42,
  },
]);

/**
 * 多段階ボス。
 * フェーズ移行時は消弾 + 無敵 + エフェクト + スペルカード表示を行う。
 * タイマー切れは次フェーズへ。最終形態のタイマー切れは自爆。
 */
export class Boss {
  constructor(config = {}, world = null) {
    this.world = world;
    this.manager = config.manager ?? null;
    this.name = config.name ?? 'PHANTOM AURA';
    this.subtitle = config.subtitle ?? 'CHRONO WEAVER';
    this.displayName = config.displayName ?? `${this.name} - ${this.subtitle}`;

    const width = world?.width ?? config.screenWidth ?? 480;
    const height = world?.height ?? config.screenHeight ?? 720;
    this.screenWidth = width;
    this.screenHeight = height;

    this.x = config.x ?? width / 2;
    this.y = config.y ?? -120;
    this.radius = config.radius ?? 46;
    this.hitRadius = config.hitRadius ?? 42;
    this.score = config.score ?? 80000;

    const source = Array.isArray(config.phases) && config.phases.length ? config.phases : BOSS_PHASES;
    const hpScale = config.hpScale ?? 1;
    this.phases = source.map((phase) => ({
      ...phase,
      hp: Math.max(1, Math.round((phase.hp ?? 800) * hpScale)),
    }));

    this.phaseIndex = -1;
    this.phase = null;
    this.hp = 0;
    this.maxHp = 1;
    this.timeLeft = 0;
    this.phaseTime = 0;
    this.spellName = '';

    this.state = 'transition';
    this.stateTime = 0;
    this.age = 0;
    this.invulnerable = true;
    this.flash = 0;
    this.flashTimer = 0;
    this.defeated = false;
    this.removed = false;
    this.deathTimer = 0;
    this.deathBurstTimer = 0;

    this.introDuration = config.introDuration ?? 1.8;
    this.transitionDuration = config.transitionDuration ?? 1.5;
    this.acc = this.resetTimers();
    this.spiralAngle = rand(0, TAU);
    this.petalAngle = rand(0, TAU);
    this.ringOffset = rand(0, TAU);
    this.curtainGap = 0;
    this.beamSide = 1;
    this.hitSoundTimer = 0;

    this.startPhase(0, world);
  }

  resetTimers() {
    return {
      spiral: 0,
      aim: 0,
      beam: 1.2,
      petal: 0,
      ring: 0,
      curtain: 0,
    };
  }

  /* ------------------------- フェーズ制御 ------------------------- */

  startPhase(index, world = this.world) {
    const phase = this.phases[index];
    if (!phase) return;

    this.phaseIndex = index;
    this.phase = phase;
    this.maxHp = phase.hp;
    this.hp = phase.hp;
    this.timeLeft = phase.timeLimit ?? 30;
    this.phaseTime = 0;
    this.spellName = phase.spell ?? '';
    this.state = 'transition';
    this.stateTime = 0;
    this.invulnerable = true;
    this.acc = this.resetTimers();
    this.defeated = false;

    clearEnemyBullets(world);
    playSE(world, SE.bossPhase);
    shakeScreen(world, 0.5);

    const fx = this.manager?.fx;
    if (fx) {
      fx.ring(this.x, this.y, {
        radius: this.radius * 0.4,
        speed: 620,
        life: 0.9,
        color: phase.color,
        width: 4,
      });
      fx.ring(this.x, this.y, {
        radius: this.radius * 0.2,
        speed: 380,
        life: 1.1,
        color: phase.accent,
        width: 2,
      });
      fx.burst(this.x, this.y, {
        count: 34,
        color: phase.color,
        speed: 300,
        life: 0.8,
        size: 3,
      });
    }

    if (this.manager) {
      if (this.manager.stats) this.manager.stats.bossPhases = index + 1;
      if (typeof this.manager.onBossPhase === 'function') {
        this.manager.onBossPhase(phase, index, this);
      }
    }
  }

  advancePhase(world, timeout = false) {
    if (this.state === 'dying' || this.removed) return;
    if (this.phaseIndex >= this.phases.length - 1) {
      this.defeat(world, { timeout });
      return;
    }
    this.startPhase(this.phaseIndex + 1, world);
  }

  defeat(world, options = {}) {
    if (this.state === 'dying' || this.removed) return;
    const timeout = options.timeout ?? false;
    this.state = 'dying';
    this.stateTime = 0;
    this.invulnerable = true;
    this.defeated = true;
    this.deathTimer = 2.4;
    this.deathBurstTimer = 0;

    clearEnemyBullets(world);
    playSE(world, SE.bossDie);
    shakeScreen(world, 0.9);
    awardScore(world, this.manager, Math.round(this.score * (timeout ? 0.5 : 1)));

    const fx = this.manager?.fx;
    if (fx) {
      fx.burst(this.x, this.y, {
        count: 90,
        color: this.phase?.color ?? '#ffffff',
        speed: 430,
        life: 1.1,
        size: 4.2,
      });
      fx.burst(this.x, this.y, {
        count: 50,
        color: '#ffffff',
        speed: 200,
        life: 0.7,
        size: 3,
      });
      fx.ring(this.x, this.y, {
        radius: this.radius * 0.5,
        speed: 760,
        life: 1,
        color: this.phase?.accent ?? '#ffffff',
        width: 5,
      });
    }

    if (this.manager) {
      if (this.manager.stats) this.manager.stats.bossDefeats += 1;
      const drops = timeout
        ? [
            ['score', 8],
            ['power', 4],
            ['bomb', 1],
          ]
        : [
            ['power', 8],
            ['score', 6],
            ['bomb', 2],
            ['life', 1],
          ];
      for (const [type, count] of drops) {
        for (let i = 0; i < count; i += 1) {
          this.manager.addItem(type, this.x + rand(-70, 70), this.y + rand(-30, 30), {
            vx: rand(-130, 130),
            vy: rand(-170, -40),
            collectDelay: 0.8,
          });
        }
      }
      if (typeof this.manager.onBossDefeated === 'function') {
        this.manager.onBossDefeated(this, { timeout }, world);
      }
    }
  }

  /* ---------------------------- 更新 ---------------------------- */

  update(dt, world = this.world) {
    if (this.removed) return;
    if (world) this.world = world;
    const scene = this.world ?? { width: this.screenWidth, height: this.screenHeight };

    this.age += dt;
    if (this.flashTimer > 0) {
      this.flash = 1;
      this.flashTimer = Math.max(0, this.flashTimer - dt);
    } else {
      this.flash = Math.max(0, this.flash - dt * 4.5);
    }
    this.hitSoundTimer = Math.max(0, this.hitSoundTimer - dt);

    if (this.state === 'dying') {
      this.updateDying(dt, scene);
      return;
    }

    this.updateMotion(dt, scene);

    if (this.state === 'transition') {
      this.stateTime += dt;
      if (this.stateTime >= this.transitionDuration) {
        this.state = 'active';
        this.stateTime = 0;
        this.phaseTime = 0;
        this.invulnerable = false;
      }
      return;
    }

    if (this.state !== 'active') return;

    this.stateTime += dt;
    this.phaseTime += dt;
    this.timeLeft = Math.max(0, this.timeLeft - dt);

    this.runPattern(dt, scene);

    if (this.hp <= 0) {
      this.advancePhase(scene);
      return;
    }
    if (this.timeLeft <= 0) {
      this.advancePhase(scene, true);
    }
  }

  updateDying(dt, scene) {
    this.stateTime += dt;
    this.deathTimer -= dt;
    this.deathBurstTimer -= dt;

    if (this.deathBurstTimer <= 0) {
      this.deathBurstTimer = 0.16;
      const fx = this.manager?.fx;
      if (fx) {
        fx.burst(this.x + rand(-this.radius, this.radius), this.y + rand(-this.radius, this.radius), {
          count: 10,
          color: Math.random() < 0.5 ? '#ffffff' : this.phase?.color ?? '#ffd166',
          speed: 240,
          life: 0.5,
          size: 2.6,
        });
      }
    }

    this.x += Math.sin(this.age * 20) * 30 * dt;
    if (this.deathTimer <= 0) {
      this.removed = true;
      if (this.manager && this.manager.boss === this) this.manager.boss = null;
    }
  }

  updateMotion(dt, scene) {
    const width = scene.width ?? this.screenWidth;
    const height = scene.height ?? this.screenHeight;
    const targetX = width / 2 + Math.sin(this.age * 0.42) * width * 0.2;
    const targetY = height * 0.16 + Math.sin(this.age * 0.7) * 20;
    const ease = 1 - Math.exp(-dt * 2.4);
    this.x = clamp(lerp(this.x, targetX, ease), this.radius + 20, width - this.radius - 20);
    this.y = lerp(this.y, targetY, ease);
  }

  /** 外部HUD/衝突判定向け。攻撃可能フェーズ中のみ true。 */
  get active() {
    return this.state === 'active' && !this.removed;
  }

  isHittable() {
    return this.active && !this.invulnerable;
  }

  hit(damage = 1, world = this.world) {
    if (!this.isHittable()) return false;
    this.hp = Math.max(0, this.hp - damage);
    this.flash = 1;
    if (this.hitSoundTimer <= 0) {
      this.hitSoundTimer = 0.075;
      playSE(world, SE.bossHit);
      const fx = this.manager?.fx;
      if (fx) {
        fx.burst(this.x, this.y, {
          count: 2,
          color: '#ffffff',
          speed: 110,
          life: 0.18,
          size: 2,
        });
      }
    }
    return true;
  }

  /* --------------------------- 弾幕 ---------------------------- */

  runPattern(dt, world) {
    const phase = this.phase;
    if (!phase) return;
    if (phase.key === 'petal') this.patternPetal(dt, world, phase);
    else if (phase.key === 'finale') this.patternFinale(dt, world, phase);
    else this.patternSpiral(dt, world, phase);
  }

  patternSpiral(dt, world, phase) {
    const enraged = this.hp / this.maxHp < 0.4;
    this.acc.spiral += dt;
    const step = enraged ? 0.055 : 0.075;
    let guard = 0;
    while (this.acc.spiral >= step && guard < 10) {
      this.acc.spiral -= step;
      guard += 1;
      this.spiralAngle += enraged ? 0.3 : 0.24;
      const arms = enraged ? 4 : 3;
      const speed = enraged ? 178 : 152;
      for (let i = 0; i < arms; i += 1) {
        shoot(world, this.x, this.y, this.spiralAngle + (TAU * i) / arms, speed, {
          color: i % 2 === 0 ? phase.color : phase.accent,
          radius: 6,
          shape: 'orb',
        });
      }
    }

    // 旋回レーザー (専用APIが無ければ弾列で表現)
    this.acc.beam += dt;
    if (this.acc.beam >= (enraged ? 3 : 3.6)) {
      this.acc.beam = 0;
      this.fireSweepLaser(world, phase);
    }

    // 自機狙い 5way
    this.acc.aim += dt;
    if (this.acc.aim >= (enraged ? 1 : 1.45)) {
      this.acc.aim = 0;
      const target = world.player;
      if (target) {
        const base = angleTo(this.x, this.y, target.x, target.y);
        for (let i = -2; i <= 2; i += 1) {
          shoot(world, this.x, this.y, base + i * 0.1, 235, {
            color: phase.accent,
            radius: 5,
            shape: 'orb',
          });
        }
        playSE(world, SE.enemyShot);
      }
    }
  }

  fireSweepLaser(world, phase) {
    const side = this.beamSide;
    this.beamSide *= -1;
    playSE(world, SE.laser);

    const host =
      world && typeof world.spawnLaser === 'function'
        ? world
        : world?.danmaku && typeof world.danmaku.spawnLaser === 'function'
          ? world.danmaku
          : null;
    if (host) {
      try {
        host.spawnLaser({
          x: this.x,
          y: this.y,
          angle: Math.PI / 2 - side * 0.55,
          length: 1200,
          width: 16,
          duration: 1.5,
          color: phase.color,
          owner: 'enemy',
          hostile: true,
        });
        return;
      } catch (error) {
        warnOnce('spawnLaser', error);
      }
    }

    const steps = 44;
    const start = Math.PI / 2 - side * 0.85;
    const end = Math.PI / 2 + side * 0.85;
    for (let i = 0; i < steps; i += 1) {
      const angle = start + ((end - start) * i) / (steps - 1);
      shoot(world, this.x, this.y, angle, 210 + (i % 3) * 30, {
        color: phase.color,
        radius: 4.5,
        shape: 'needle',
      });
    }
  }

  patternPetal(dt, world, phase) {
    const enraged = this.hp / this.maxHp < 0.45;

    // 幾何学花弁: 腕ごとに速度を脈動させて花形を作る
    this.acc.petal += dt;
    const step = enraged ? 0.07 : 0.095;
    let guard = 0;
    while (this.acc.petal >= step && guard < 10) {
      this.acc.petal -= step;
      guard += 1;
      this.petalAngle += 0.11;
      const arms = 6;
      for (let i = 0; i < arms; i += 1) {
        const angle = this.petalAngle + (TAU * i) / arms;
        const pulse = 0.5 + 0.5 * Math.sin(this.petalAngle * 2.4 + i * 1.7);
        shoot(world, this.x, this.y, angle, 85 + pulse * 80, {
          color: i % 2 === 0 ? phase.color : phase.accent,
          radius: 5.5,
          shape: i % 2 === 0 ? 'orb' : 'petal',
        });
        if (enraged) {
          shoot(world, this.x, this.y, angle + Math.PI / 6, 100 + (1 - pulse) * 90, {
            color: phase.accent,
            radius: 4,
            shape: 'orb',
          });
        }
      }
    }

    // 自機狙い 3way
    this.acc.aim += dt;
    if (this.acc.aim >= (enraged ? 1.05 : 1.5)) {
      this.acc.aim = 0;
      const target = world.player;
      if (target) {
        const base = angleTo(this.x, this.y, target.x, target.y);
        for (let i = -1; i <= 1; i += 1) {
          shoot(world, this.x, this.y, base + i * 0.14, 240, {
            color: '#ffffff',
            radius: 5,
            shape: 'orb',
          });
        }
        playSE(world, SE.enemyShot);
      }
    }

    // ゆっくりしたリング
    this.acc.ring += dt;
    if (this.acc.ring >= 2.6) {
      this.acc.ring = 0;
      const count = 16;
      for (let i = 0; i < count; i += 1) {
        shoot(world, this.x, this.y, this.petalAngle + (TAU * i) / count, 120, {
          color: phase.accent,
          radius: 4,
          shape: 'orb',
        });
      }
    }
  }

  patternFinale(dt, world, phase) {
    const width = world.width ?? this.screenWidth;
    const enraged = this.hp / this.maxHp < 0.5;

    // 弾幕カーテン: 上部から壁状に降下、3列の隙間が移動する
    this.acc.curtain += dt;
    const curtainStep = enraged ? 0.34 : 0.44;
    let guard = 0;
    while (this.acc.curtain >= curtainStep && guard < 3) {
      this.acc.curtain -= curtainStep;
      guard += 1;
      const columns = 15;
      this.curtainGap = (this.curtainGap + 2) % columns;
      for (let i = 0; i < columns; i += 1) {
        const offset = (i - this.curtainGap + columns) % columns;
        if (offset < 3) continue;
        const x = ((i + 0.5) / columns) * width;
        shoot(world, x, 8, Math.PI / 2 + (x - width / 2) * 0.0004, 150 + (i % 2) * 35, {
          color: phase.color,
          radius: 6,
          shape: 'needle',
        });
      }
    }

    // 全方位高速リング
    this.acc.ring += dt;
    if (this.acc.ring >= (enraged ? 1.05 : 1.3)) {
      this.acc.ring = 0;
      this.ringOffset += 0.13;
      const count = enraged ? 36 : 32;
      for (let i = 0; i < count; i += 1) {
        shoot(world, this.x, this.y, this.ringOffset + (TAU * i) / count, enraged ? 235 : 215, {
          color: i % 2 === 0 ? phase.accent : '#ffffff',
          radius: 5,
          shape: 'orb',
        });
      }
      playSE(world, SE.enemyShot);
    }

    // 自機狙い 5way
    this.acc.aim += dt;
    if (this.acc.aim >= (enraged ? 0.8 : 1)) {
      this.acc.aim = 0;
      const target = world.player;
      if (target) {
        const base = angleTo(this.x, this.y, target.x, target.y);
        for (let i = -2; i <= 2; i += 1) {
          shoot(world, this.x, this.y, base + i * 0.09, 265, {
            color: phase.accent,
            radius: 4.5,
            shape: 'orb',
          });
        }
        playSE(world, SE.enemyShot);
      }
    }
  }

  /* --------------------------- 描画 ---------------------------- */

  drawOrbit(ctx, radius, rotation, color, segments = 4) {
    ctx.save();
    ctx.rotate(rotation);
    ctx.strokeStyle = hexAlpha(color, 0.55);
    ctx.lineWidth = 1.6;
    const arc = (TAU / segments) * 0.55;
    for (let i = 0; i < segments; i += 1) {
      ctx.beginPath();
      ctx.arc(0, 0, radius, (TAU * i) / segments, (TAU * i) / segments + arc);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawWings(ctx, color, accent) {
    const R = this.radius;
    const gradient = ctx.createLinearGradient(0, -R, 0, R);
    gradient.addColorStop(0, hexAlpha(color, 0.7));
    gradient.addColorStop(1, hexAlpha(accent, 0.08));

    for (const side of [-1, 1]) {
      ctx.save();
      ctx.scale(side, 1);
      ctx.beginPath();
      ctx.moveTo(R * 0.2, -R * 0.45);
      ctx.bezierCurveTo(R * 0.9, -R * 1.35, R * 2.05, -R * 0.55, R * 1.25, R * 0.35);
      ctx.bezierCurveTo(R * 0.95, R * 0.75, R * 0.4, R * 0.4, R * 0.2, R * 0.1);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.strokeStyle = hexAlpha(color, 0.8);
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(R * 0.35, -R * 0.2);
      ctx.quadraticCurveTo(R * 1.1, -R * 0.5, R * 1.4, R * 0.05);
      ctx.strokeStyle = hexAlpha(accent, 0.55);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }
  }

  drawCore(ctx, color, accent) {
    const R = this.radius;
    const gradient = ctx.createRadialGradient(-R * 0.2, -R * 0.3, 2, 0, 0, R * 0.8);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.4, accent);
    gradient.addColorStop(1, '#0a1220');

    ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const angle = (TAU * i) / 6 - Math.PI / 2 + Math.sin(this.age * 0.8) * 0.05;
      const px = Math.cos(angle) * R * 0.66;
      const py = Math.sin(angle) * R * 0.66;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(0, 0, R * 0.16, 0, TAU);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.save();
    ctx.rotate(-this.age * 1.6);
    ctx.beginPath();
    for (let i = 0; i < 3; i += 1) {
      const angle = (TAU * i) / 3 - Math.PI / 2;
      const px = Math.cos(angle) * R * 0.42;
      const py = Math.sin(angle) * R * 0.42;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.strokeStyle = hexAlpha(color, 0.85);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }

  drawShield(ctx, color) {
    const radius = this.radius * (1.55 + Math.sin(this.age * 5) * 0.04);
    ctx.save();
    ctx.rotate(this.age * 0.9);
    ctx.strokeStyle = hexAlpha(color, 0.75);
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 12]);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = hexAlpha(color, 0.07);
    ctx.fill();
    ctx.restore();
  }

  render(ctx) {
    if (this.removed) return;
    const phase = this.phase ?? this.phases[0];
    const color = phase?.color ?? '#49d7ff';
    const accent = phase?.accent ?? '#b48cff';
    const R = this.radius;

    ctx.save();
    ctx.translate(this.x, this.y);
    if (this.state === 'dying') {
      ctx.globalAlpha = clamp(this.deathTimer / 2.4, 0.15, 1);
    }

    ctx.globalCompositeOperation = 'lighter';
    const aura = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R * 2.6);
    aura.addColorStop(0, hexAlpha(color, 0.4));
    aura.addColorStop(0.5, hexAlpha(color, 0.12));
    aura.addColorStop(1, hexAlpha(color, 0));
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(0, 0, R * 2.6, 0, TAU);
    ctx.fill();

    this.drawOrbit(ctx, R * 1.7, this.age * 0.55, color, 5);
    this.drawOrbit(ctx, R * 1.32, -this.age * 0.9, accent, 3);

    const shardCount = 8;
    for (let i = 0; i < shardCount; i += 1) {
      const angle = this.age * 1.4 + (TAU * i) / shardCount;
      const distance = R * (1.95 + Math.sin(this.age * 2 + i) * 0.12);
      ctx.save();
      ctx.translate(Math.cos(angle) * distance, Math.sin(angle) * distance);
      ctx.rotate(angle + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(3.4, 0);
      ctx.lineTo(0, 6);
      ctx.lineTo(-3.4, 0);
      ctx.closePath();
      ctx.fillStyle = hexAlpha(accent, 0.85);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';

    this.drawWings(ctx, color, accent);
    this.drawCore(ctx, color, accent);

    if (this.invulnerable && this.state !== 'dying') {
      this.drawShield(ctx, color);
    }

    if (this.flash > 0) {
      ctx.globalAlpha = this.flash * 0.85;
      ctx.beginPath();
      for (let i = 0; i < 6; i += 1) {
        const angle = (TAU * i) / 6 - Math.PI / 2;
        const px = Math.cos(angle) * R * 0.66;
        const py = Math.sin(angle) * R * 0.66;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  renderUI(ctx, width = this.screenWidth, height = this.screenHeight) {
    if (this.removed) return;
    const phase = this.phase ?? this.phases[0];
    const color = phase?.color ?? '#49d7ff';
    const accent = phase?.accent ?? '#b48cff';
    const margin = Math.max(10, width * 0.025);
    const barWidth = width - margin * 2 - 30;
    const top = 8;

    ctx.save();
    ctx.fillStyle = 'rgba(4, 9, 22, 0.55)';
    roundedRect(ctx, margin - 4, top, width - (margin - 4) * 2, 46, 8);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '700 12px "Trebuchet MS", "Hiragino Sans", "Segoe UI", sans-serif';
    ctx.fillStyle = '#eaf8ff';
    ctx.fillText(this.displayName, margin + 2, top + 15);

    ctx.textAlign = 'right';
    ctx.font = '600 10px "Trebuchet MS", "Hiragino Sans", sans-serif';
    ctx.fillStyle = accent;
    ctx.fillText(this.spellName, width - margin - 2, top + 15);

    const barY = top + 23;
    const barHeight = 7;
    ctx.fillStyle = 'rgba(10, 18, 34, 0.9)';
    roundedRect(ctx, margin, barY, barWidth, barHeight, 3.5);
    ctx.fill();

    const ratio = clamp(this.hp / this.maxHp, 0, 1);
    const fillWidth = barWidth * ratio;
    if (fillWidth > 0.5) {
      const gradient = ctx.createLinearGradient(margin, 0, margin + barWidth, 0);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, accent);
      ctx.fillStyle = gradient;
      roundedRect(ctx, margin, barY, Math.max(2, fillWidth), barHeight, 3.5);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fillRect(margin + 2, barY + 1.2, Math.max(0, fillWidth - 4), 1.6);
    }

    const pipY = barY + barHeight + 8;
    for (let i = 0; i < this.phases.length; i += 1) {
      ctx.beginPath();
      ctx.arc(margin + 4 + i * 13, pipY, 3, 0, TAU);
      if (i < this.phaseIndex) {
        ctx.fillStyle = hexAlpha(accent, 0.9);
        ctx.fill();
      } else if (i === this.phaseIndex) {
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      } else {
        ctx.strokeStyle = hexAlpha('#ffffff', 0.35);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    const timerX = width - margin - 12;
    const timerY = barY + barHeight + 9;
    const timerRadius = 10;
    const timeRatio = clamp(this.timeLeft / (phase?.timeLimit || 1), 0, 1);
    ctx.strokeStyle = hexAlpha('#ffffff', 0.2);
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(timerX, timerY, timerRadius, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = timeRatio < 0.25 ? '#ff5a6e' : color;
    ctx.beginPath();
    ctx.arc(timerX, timerY, timerRadius, -Math.PI / 2, -Math.PI / 2 + TAU * timeRatio);
    ctx.stroke();
    ctx.fillStyle = '#dff3ff';
    ctx.font = '700 8px "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.ceil(this.timeLeft)), timerX, timerY + 0.5);

    ctx.restore();
    this.renderBanner(ctx, width, height);
  }

  /**
   * スペルカード帯のみを描く。外部HUD (#boss-hud) と併用する場合はこちらを使う。
   */
  renderBanner(ctx, width = this.screenWidth, height = this.screenHeight) {
    if (this.removed || this.state !== 'transition' || this.stateTime >= this.transitionDuration) return;
    const phase = this.phase ?? this.phases[0];
    const color = phase?.color ?? '#49d7ff';
    const accent = phase?.accent ?? '#b48cff';
    const t = clamp(this.stateTime / this.transitionDuration, 0, 1);

    ctx.save();
    ctx.globalAlpha = Math.sin(t * Math.PI);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 20px "Trebuchet MS", "Hiragino Sans", sans-serif';
    ctx.fillText(this.spellName, width / 2, height * 0.42);
    ctx.fillStyle = hexAlpha(accent, 0.95);
    ctx.font = '600 10px "Trebuchet MS", sans-serif';
    ctx.fillText(phase?.label ?? '', width / 2, height * 0.42 + 22);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ *
 * マネージャ
 * ------------------------------------------------------------------ */

function rollWeighted(table) {
  if (!Array.isArray(table) || table.length === 0) return 'score';
  let total = 0;
  for (const entry of table) total += entry[1] ?? 1;
  let pick = Math.random() * total;
  for (const entry of table) {
    pick -= entry[1] ?? 1;
    if (pick <= 0) return entry[0];
  }
  return table[table.length - 1][0];
}

/**
 * 敵・ボス・アイテムの一括管理。
 * update(dt, world) / render(ctx) をゲームループから呼ぶ。
 * world は省略可能で、2回目以降は前回の world を再利用する。
 */
export class EnemyManager {
  /**
   * new EnemyManager(width, height) と new EnemyManager({ width, height, ... }) の両方を受け付ける。
   */
  constructor(widthOrOptions = {}, height = 720) {
    const options = typeof widthOrOptions === 'number' ? { width: widthOrOptions, height } : widthOrOptions ?? {};
    this.width = options.width ?? 480;
    this.height = options.height ?? 720;
    this.world = options.world ?? null;

    this.enemies = [];
    this.items = [];
    this.boss = null;
    this.fx = new Effects(options.maxParticles ?? 320);

    this.onScore = options.onScore ?? null;
    this.onItemCollected = options.onItemCollected ?? null;
    this.onEnemyKilled = options.onEnemyKilled ?? null;
    this.onBossPhase = options.onBossPhase ?? null;
    this.onBossDefeated = options.onBossDefeated ?? null;

    this.pocRatio = options.pocRatio ?? 0.22;
    this.magnetRadius = options.magnetRadius ?? 100;
    this.collectRadius = options.collectRadius ?? 20;
    this.fallSpeed = options.fallSpeed ?? 68;
    // 'auto' は #boss-hud を持つ既存HUDがある場合、ボスバーを描かずスペル帯のみ描く
    this.bossUI = options.bossUI ?? 'auto';
    this._bossUIMode = null;

    this.stats = this.createStats();
  }

  createStats() {
    return {
      score: 0,
      kills: 0,
      items: { power: 0, score: 0, bomb: 0, life: 0 },
      bossPhases: 0,
      bossDefeats: 0,
    };
  }

  resize(width, height) {
    if (width > 0) this.width = width;
    if (height > 0) this.height = height;
  }

  reset() {
    this.enemies.length = 0;
    this.items.length = 0;
    this.boss = null;
    this.fx.clear();
    this.stats = this.createStats();
  }

  get enemyCount() {
    return this.enemies.length;
  }

  get isBossActive() {
    return Boolean(this.boss && this.boss.state !== 'dying' && !this.boss.removed);
  }

  /* --------------------------- 生成 ---------------------------- */

  spawn(type, options = {}) {
    const scene = this.world ?? { width: this.width, height: this.height };
    const enemy = new Enemy(
      type,
      {
        screenWidth: this.width,
        screenHeight: this.height,
        manager: this,
        ...options,
      },
      scene,
    );
    enemy.manager = this;
    this.enemies.push(enemy);
    return enemy;
  }

  spawnScout(options = {}) {
    return this.spawn('scout', options);
  }

  spawnFairy(options = {}) {
    return this.spawn('fairy', options);
  }

  spawnTank(options = {}) {
    return this.spawn('tank', options);
  }

  /** game.js のステージ進行が呼ぶ編隊生成。未定義名は scout 単機。 */
  spawnWave(name, world = this.world) {
    if (world) {
      this.world = world;
      if (world.width) this.width = world.width;
      if (world.height) this.height = world.height;
    }
    const width = this.width;
    const height = this.height;
    const spawned = [];

    if (name === 'fairy_squad') {
      for (let i = 0; i < 3; i += 1) {
        spawned.push(
          this.spawn('fairy', {
            x: width * (0.32 + i * 0.18),
            y: -40 - i * 45,
            hoverX: width * (0.3 + i * 0.2),
            hoverY: height * (0.2 + i * 0.035),
            firstShot: 0.6,
          }),
        );
      }
    } else if (name === 'tank_formation') {
      spawned.push(this.spawn('tank', { x: width * 0.5, y: -60 }));
      spawned.push(this.spawn('scout', { x: width * 0.25, y: -110, phase: 0.4 }));
      spawned.push(this.spawn('scout', { x: width * 0.75, y: -110, phase: 2.4 }));
    } else if (name === 'scout_swarm') {
      for (let i = 0; i < 7; i += 1) {
        spawned.push(
          this.spawn('scout', {
            x: (width / 8) * (i + 1),
            y: -40 - (i % 3) * 45,
            phase: i * 0.9,
          }),
        );
      }
    } else if (name === 'scout_left' || name === 'scout_right') {
      const fromLeft = name === 'scout_left';
      for (let i = 0; i < 5; i += 1) {
        spawned.push(
          this.spawn('scout', {
            x: fromLeft ? width * 0.22 : width * 0.78,
            y: -40 - i * 55,
            phase: (fromLeft ? 0 : Math.PI) + i * 0.35,
            zigAmp: 60,
          }),
        );
      }
    } else {
      spawned.push(this.spawn('scout', { x: width / 2 }));
    }
    return spawned;
  }

  /** ボムなどの全体ダメージ。 */
  damageAll(amount = 1, world = this.world) {
    let hits = 0;
    for (const enemy of [...this.enemies]) {
      if (enemy.dead || enemy.invulnerable) continue;
      if (enemy.hit(amount, world)) hits += 1;
    }
    if (this.boss && this.boss.isHittable() && this.boss.hit(amount, world)) hits += 1;
    return hits;
  }

  spawnBoss(config = {}) {
    if (this.boss) return this.boss;
    let bossConfig = config ?? {};
    let scene = this.world ?? { width: this.width, height: this.height };
    // game.js は spawnBoss(world) の形で呼ぶ。world を設定と誤認しないよう判定する
    if (typeof bossConfig.width === 'number' && typeof bossConfig.height === 'number') {
      scene = bossConfig;
      bossConfig = {};
      this.world = scene;
      this.width = scene.width;
      this.height = scene.height;
    }
    const boss = new Boss(
      {
        screenWidth: this.width,
        screenHeight: this.height,
        manager: this,
        ...bossConfig,
      },
      scene,
    );
    boss.manager = this;
    this.boss = boss;
    return boss;
  }

  addItem(type, x, y, options = {}) {
    const item = new Item(type, x, y, options);
    this.items.push(item);
    return item;
  }

  dropItems(enemy, world = this.world) {
    if (!enemy) return;
    const table = Array.isArray(enemy.dropOverride) ? enemy.dropOverride : enemy.def?.drops;
    const rolls = Array.isArray(enemy.dropOverride) ? 1 : enemy.def?.dropRolls ?? 1;
    for (let i = 0; i < rolls; i += 1) {
      const type = rollWeighted(table);
      this.addItem(type, enemy.x + rand(-10, 10), enemy.y + rand(-10, 10));
    }
  }

  /* --------------------------- 更新 ---------------------------- */

  update(dt, world = this.world) {
    const step = clamp(dt ?? 0, 0, 0.05);
    if (world) {
      this.world = world;
      if (world.width) this.width = world.width;
      if (world.height) this.height = world.height;
    }
    const scene = this.world ?? { width: this.width, height: this.height };

    for (const enemy of this.enemies) enemy.update(step, scene);
    if (this.enemies.length) {
      this.enemies = this.enemies.filter((enemy) => !enemy.removed);
    }

    if (this.boss) {
      this.boss.update(step, scene);
      if (this.boss && this.boss.removed) this.boss = null;
    }

    for (const item of this.items) item.update(step, scene, this);
    if (this.items.length) {
      this.items = this.items.filter((item) => !item.removed);
    }

    this.fx.update(step);
  }

  /* --------------------------- 描画 ---------------------------- */

  /** 'auto' のとき外部ボスHUD (#boss-hud) の有無でキャンバスUIを切り替える。 */
  resolveBossUI() {
    if (this.bossUI !== 'auto') return this.bossUI;
    if (this._bossUIMode) return this._bossUIMode;
    let mode = 'full';
    try {
      if (typeof document !== 'undefined' && document.getElementById && document.getElementById('boss-hud')) {
        mode = 'banner';
      }
    } catch {
      mode = 'full';
    }
    this._bossUIMode = mode;
    return mode;
  }

  render(ctx, world = this.world) {
    const width = world?.width ?? this.width;
    const height = world?.height ?? this.height;

    for (const item of this.items) item.render(ctx);
    for (const enemy of this.enemies) enemy.render(ctx);
    if (this.boss) this.boss.render(ctx);
    this.fx.render(ctx);

    if (this.boss && this.boss.state !== 'dying') {
      const mode = this.resolveBossUI();
      if (mode === 'full') this.boss.renderUI(ctx, width, height);
      else if (mode === 'banner') this.boss.renderBanner(ctx, width, height);
    }
  }

  /* --------------------------- 衝突 ---------------------------- */

  /**
   * 自機弾と敵/ボスの当たり判定 (任意)。
   * game.js が独自判定を持つ場合は呼ばなくてよい。
   * 戻り値はヒット数。弾は dead/alive/removed を立てて無効化する。
   */
  collidePlayerBullets(bullets, world = this.world) {
    if (!Array.isArray(bullets) || bullets.length === 0) return 0;
    let hits = 0;

    for (const bullet of bullets) {
      if (!bullet || bullet.dead || bullet.alive === false || bullet.removed) continue;
      if (bullet.hostile || bullet.owner === 'enemy') continue;
      const bx = bullet.x;
      const by = bullet.y;
      if (typeof bx !== 'number' || typeof by !== 'number') continue;
      const radius = bullet.radius ?? bullet.r ?? 3;
      const damage = bullet.damage ?? 1;

      if (this.boss && this.boss.isHittable()) {
        const boss = this.boss;
        if (Math.hypot(bx - boss.x, by - boss.y) <= boss.hitRadius + radius) {
          boss.hit(damage, world);
          bullet.dead = true;
          bullet.alive = false;
          bullet.removed = true;
          hits += 1;
          continue;
        }
      }

      for (const enemy of this.enemies) {
        if (enemy.dead || enemy.invulnerable) continue;
        if (Math.hypot(bx - enemy.x, by - enemy.y) <= enemy.radius + radius) {
          enemy.hit(damage, world);
          bullet.dead = true;
          bullet.alive = false;
          bullet.removed = true;
          hits += 1;
          break;
        }
      }
    }

    return hits;
  }

  /** 敵・ボスの当たり判定情報 (自機側の衝突判定用)。 */
  getColliders() {
    const colliders = [];
    for (const enemy of this.enemies) {
      if (enemy.dead || enemy.removed) continue;
      colliders.push({ x: enemy.x, y: enemy.y, radius: enemy.radius * 0.8, kind: 'enemy', ref: enemy });
    }
    if (this.boss && !this.boss.removed) {
      colliders.push({ x: this.boss.x, y: this.boss.y, radius: this.boss.hitRadius, kind: 'boss', ref: this.boss });
    }
    return colliders;
  }
}

