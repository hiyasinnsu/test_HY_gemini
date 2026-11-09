/**
 * js/player.js — 自機（Player）システム
 *
 * スマホの相対ドラッグ / PC のキーボード・マウスドラッグに両対応した弾幕 STG 用プレイヤー。
 * 外部依存なし。座標系は論理座標で、既定のプレイフィールドは 480x720。
 *
 * 使い方:
 *   import { Player } from './player.js';
 *   const player = new Player({ game, danmaku, playfield: { x: 0, y: 0, width: 480, height: 720 } });
 *
 *   // 毎フレーム
 *   player.handleKeyboard(input.keys, dt); // PC（タッチのみなら不要）
 *   player.moveBy(dx, dy);                 // スマホ/マウスの相対ドラッグ
 *   player.moveTo(x, y, 0.25);             // 指やマウスへのスムーズ追従
 *   player.update(dt);                     // ショット/グレイズ/被弾/ボム/エフェクト
 *   player.render(ctx);
 *
 * 接続契約（duck typing。すべて任意）:
 *   自機弾  : danmaku.spawnPlayerBullet(spec) → danmaku.addPlayerBullet(spec)
 *             → danmaku.playerBullets.push(spec) → this.bullets の順で自動選択。
 *             spec = { x, y, vx, vy, power, damage, radius, color, shape, type:'player', ... }
 *   敵弾    : options.getEnemyBullets() / danmaku.enemyBullets / danmaku.getEnemyBullets()
 *             / game.enemyBullets を自動走査してグレイズ・被弾・危険度を判定。
 *   ボム消弾: danmaku.clearEnemyBullets(opts) / danmaku.clearBullets(true)
 *             / danmaku.bombClear(opts) を順に試し、未接続なら敵弾を直接 dead 化して
 *             spawnScoreItem / onBulletToItem を発火。
 *   ボムダメ: danmaku.applyBombDamage(info) / game.applyBombDamage(info) /
 *             敵配列への直接ダメージの順。
 *   フック  : onBomb(x, y, info), onGraze(x, y, info), onHit(x, y, info),
 *             onDeath(info), onShot(volley, player), onBombEnd(player),
 *             onPowerChange(power, tier, player), onTierChange(tier, oldTier, player)。
 */

const TAU = Math.PI * 2;

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

const isLiveEnemy = (entity) => {
  if (!entity || entity.dead || entity.removed) return false;
  if (entity.alive === false) return false;
  if (typeof entity.hp === 'number' && entity.hp <= 0) return false;
  return true;
};

/** パワーレベルの閾値（0-19: 単発 / 20-49: 2連 / 50-79: 3連+サブ / 80+: 5連ワイド+ビット）。 */
export const POWER_TIER_THRESHOLDS = Object.freeze({
  double: 20,
  triple: 50,
  wide: 80,
});

export class Player {
  constructor(options = {}) {
    const o = options && typeof options === 'object' ? options : {};
    const game = o.game ?? null;

    this.id = o.id ?? 'player';
    this.game = game;
    this.danmaku = o.danmaku ?? game?.danmaku ?? null;
    this.audio = o.audio ?? o.audioEngine ?? game?.audio ?? game?.sound ?? null;

    // 移動・判定
    this.normalSpeed = Math.max(1, finite(o.normalSpeed, 320));
    this.slowSpeed = Math.max(1, finite(o.slowSpeed, 130));
    this.hitboxRadius = clamp(finite(o.hitboxRadius, 3.5), 2, 8);
    this.grazeRadius = clamp(finite(o.grazeRadius, 20), this.hitboxRadius + 6, 80);
    this.edgeMargin = Math.max(0, finite(o.edgeMargin, 8));
    this.dragSensitivity = Math.max(0.05, finite(o.dragSensitivity, 1));
    this.slowDragFactor = clamp(finite(o.slowDragFactor, 0.55), 0.05, 1);

    // 残機・ボム・パワー
    this.maxBombs = Math.max(1, Math.floor(finite(o.maxBombs, 5)));
    this.maxLives = Math.max(1, Math.floor(finite(o.maxLives, 99)));
    this.initialLives = clamp(Math.floor(finite(o.lives, 3)), 0, this.maxLives);
    this.initialBombs = clamp(Math.floor(finite(o.bombs, 3)), 0, this.maxBombs);
    this.lives = this.initialLives;
    this.bombs = this.initialBombs;
    this.power = Math.floor(clamp(finite(o.power, 0), 0, 100));
    this.score = 0;
    this.grazeCount = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.comboWindow = Math.max(0.2, finite(o.comboWindow, 3));
    this.grazeMultiplier = 1;
    this.maxCombo = 0;

    // 攻撃・タイマー
    this.shotInterval = Math.max(0.01, finite(o.shotInterval, 0.075));
    this.fireCooldown = 0;
    this.autoFire = o.autoFire !== false;
    this.autoGraze = o.autoGraze !== false;
    this.autoCollide = o.autoCollide !== false;
    this.invincibleTimer = 0;
    this.respawnInvincibility = Math.max(0, finite(o.respawnInvincibility, 2.0));
    this.bombTimer = 0;
    this.bombDuration = Math.max(0, finite(o.bombDuration, 1.6));
    this.bombInvincibility = Math.max(0, finite(o.bombInvincibility, 2.5));
    this.bombDamage = Math.max(0, finite(o.bombDamage, 120));
    this.bombDamageRadius = Number.isFinite(o.bombDamageRadius) ? o.bombDamageRadius : Infinity;
    this.deathPowerLoss = Math.max(0, finite(o.deathPowerLoss, 0));
    this.dangerRadius = Math.max(1, finite(o.dangerRadius, 64));
    this.dangerLevel = 0;
    this.nearestBulletDistance = Infinity;
    this.alive = true;
    this.hidden = false;
    this.time = 0;
    this.muzzleFlash = 0;
    this.screenFlash = 0;
    this.hitFlash = 0;

    // 入力・見た目
    this.isKeyboardSlow = false;
    this.isTouchSlow = false;
    this.moveDirX = 0;
    this.moveDirY = 0;
    this.bank = 0;
    this._movingTimer = 0;
    this._thrusterAcc = 0;

    // スポーン位置（未指定ならプレイフィールドから自動計算）
    this._autoSpawnX = !Number.isFinite(o.spawnX);
    this._autoSpawnY = !Number.isFinite(o.spawnY);
    this.spawnX = finite(o.spawnX, 0);
    this.spawnY = finite(o.spawnY, 0);
    this.x = NaN;
    this.y = NaN;
    this.playfield = { x: 0, y: 0, width: 480, height: 720 };

    // 弾・エフェクト
    this.bullets = []; // danmaku 未接続時の自前弾配列
    this.lastVolley = [];
    this.lastBombInfo = null;
    this.particles = [];
    this.debris = [];
    this.grazeEffects = [];
    this.hitEffects = [];
    this.bombWaves = [];
    this.bits = this._createBits();
    this.stats = this._createStats();

    // イベントフック
    this.onShot = o.onShot ?? null;
    this.onGraze = o.onGraze ?? null;
    this.onCombo = o.onCombo ?? null;
    this.onScore = o.onScore ?? null;
    this.onHit = o.onHit ?? null;
    this.onDeath = o.onDeath ?? null;
    this.onBomb = o.onBomb ?? null;
    this.onBombEnd = o.onBombEnd ?? null;
    this.onBulletToItem = o.onBulletToItem ?? null;
    this.onPowerChange = o.onPowerChange ?? null;
    this.onTierChange = o.onTierChange ?? null;

    // 敵弾・敵の取得元
    this._enemyBulletsSource = typeof o.getEnemyBullets === 'function'
      ? o.getEnemyBullets
      : (Array.isArray(o.getEnemyBullets) ? o.getEnemyBullets : null);
    this._nearestEnemySource = typeof o.getNearestEnemy === 'function' ? o.getNearestEnemy : null;
    this.enemies = Array.isArray(o.enemies)
      ? o.enemies
      : (Array.isArray(game?.enemies) ? game.enemies : null);

    // プレイフィールド
    const bounds = o.playfield ?? o.bounds ?? game?.playfield ?? game?.bounds
      ?? (Number.isFinite(game?.width) && Number.isFinite(game?.height)
        ? { x: 0, y: 0, width: game.width, height: game.height }
        : null)
      ?? (Number.isFinite(o.width) && Number.isFinite(o.height)
        ? { x: 0, y: 0, width: o.width, height: o.height }
        : null);
    this.setPlayfield(bounds ?? this.playfield);

    this.x = Number.isFinite(o.x) ? o.x : this.spawnX;
    this.y = Number.isFinite(o.y) ? o.y : this.spawnY;
    this.clamp();
    this._resetBits(true);
  }

  // ────────────────────────────── 接続・設定 ──────────────────────────────

  attachGame(game) {
    if (!game) return this;
    this.game = game;
    if (!this.danmaku && game.danmaku) this.danmaku = game.danmaku;
    if (!this.audio && (game.audio || game.sound)) this.audio = game.audio ?? game.sound;
    if (Array.isArray(game.enemies)) this.enemies = game.enemies;
    if (game.playfield) this.setPlayfield(game.playfield);
    return this;
  }

  setGame(game) {
    return this.attachGame(game);
  }

  setDanmaku(danmaku) {
    this.danmaku = danmaku ?? null;
    return this;
  }

  setAudio(audio) {
    this.audio = audio ?? null;
    return this;
  }

  setEnemyBulletsSource(source) {
    this._enemyBulletsSource = typeof source === 'function' || Array.isArray(source) ? source : null;
    return this;
  }

  setNearestEnemySource(source) {
    this._nearestEnemySource = typeof source === 'function' ? source : null;
    return this;
  }

  /** プレイフィールドを設定する。{ x, y, width, height } または [x, y, width, height]。 */
  setPlayfield(bounds) {
    let x = 0;
    let y = 0;
    let width = 480;
    let height = 720;
    if (Array.isArray(bounds)) {
      x = finite(bounds[0], 0);
      y = finite(bounds[1], 0);
      width = finite(bounds[2], 480);
      height = finite(bounds[3], 720);
    } else if (bounds && typeof bounds === 'object') {
      x = finite(bounds.x ?? bounds.left, 0);
      y = finite(bounds.y ?? bounds.top, 0);
      if (Number.isFinite(bounds.width) || Number.isFinite(bounds.w)) {
        width = finite(bounds.width ?? bounds.w, width);
      } else if (Number.isFinite(bounds.right)) {
        width = bounds.right - x;
      }
      if (Number.isFinite(bounds.height) || Number.isFinite(bounds.h)) {
        height = finite(bounds.height ?? bounds.h, height);
      } else if (Number.isFinite(bounds.bottom)) {
        height = bounds.bottom - y;
      }
    }
    width = Math.max(1, width);
    height = Math.max(1, height);
    this.playfield = { x, y, width, height };

    if (this._autoSpawnX) this.spawnX = x + width / 2;
    if (this._autoSpawnY) this.spawnY = y + height * 0.86;
    this.spawnX = clamp(finite(this.spawnX, x + width / 2), x, x + width);
    this.spawnY = clamp(finite(this.spawnY, y + height * 0.86), y, y + height);

    if (Number.isFinite(this.x) && Number.isFinite(this.y)) this.clamp();
    if (Array.isArray(this.bits)) this._clampBits();
    return this;
  }

  // ────────────────────────────── 状態 ──────────────────────────────

  /** 0-19: 単発 / 20-49: 2連 / 50-79: 3連+サブ / 80+: 5連ワイド+追従ビット。 */
  get powerTier() {
    if (this.power >= POWER_TIER_THRESHOLDS.wide) return 3;
    if (this.power >= POWER_TIER_THRESHOLDS.triple) return 2;
    if (this.power >= POWER_TIER_THRESHOLDS.double) return 1;
    return 0;
  }

  getShotTier() {
    return this.powerTier;
  }

  get isSlow() {
    return this.isKeyboardSlow || this.isTouchSlow;
  }

  get isMoving() {
    return this._movingTimer > 0;
  }

  get isInvincible() {
    return this.invincibleTimer > 0 || this.bombTimer > 0;
  }

  get bombActive() {
    return this.bombTimer > 0;
  }

  /** コンボ/かすり倍率（1.0〜4.0）。 */
  get comboMultiplier() {
    return this.grazeMultiplier;
  }

  setSlow(active) {
    this.isTouchSlow = !!active;
    return this;
  }

  setTouchSlow(active) {
    this.isTouchSlow = !!active;
    return this;
  }

  setPower(value, options = {}) {
    const silent = options === true || (options && options.silent === true);
    const previousTier = this.powerTier;
    this.power = clamp(Math.floor(finite(value, this.power)), 0, 100);
    const tier = this.powerTier;
    if (tier >= 3 && previousTier < 3) this._resetBits(true);
    if (!silent) {
      this.onPowerChange?.(this.power, tier, this);
      if (tier !== previousTier) this.onTierChange?.(tier, previousTier, this);
    }
    return this.power;
  }

  addPower(amount) {
    return this.setPower(this.power + finite(amount, 0));
  }

  addBomb(count = 1) {
    this.bombs = clamp(this.bombs + Math.floor(finite(count, 1)), 0, this.maxBombs);
    return this.bombs;
  }

  addLife(count = 1) {
    this.lives = clamp(this.lives + Math.floor(finite(count, 1)), 0, this.maxLives);
    return this.lives;
  }

  addScore(base, useMultiplier = false) {
    const factor = useMultiplier ? this.grazeMultiplier : 1;
    const gained = Math.max(0, Math.round(finite(base, 0) * factor));
    this.score += gained;
    this.onScore?.(gained, this.score, this);
    return gained;
  }

  /**
   * グレイズを登録する。コンボ・倍率・スコア・光彩エフェクトを更新。
   * @returns {number} 獲得スコア
   */
  registerGraze(x = this.x, y = this.y, bullet = null) {
    if (!this.alive) return 0;
    this.grazeCount += 1;
    this.combo += 1;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.comboTimer = this.comboWindow;
    this.grazeMultiplier = Math.min(4, 1 + Math.min(this.combo, 300) * 0.01);
    const gained = this.addScore(10, true);
    this._addGrazeEffect(x, y);
    this._playSound('graze');
    this.onGraze?.(x, y, {
      player: this,
      bullet,
      combo: this.combo,
      multiplier: this.grazeMultiplier,
      score: gained,
    });
    this.onCombo?.(this.combo, this.grazeMultiplier, this);
    return gained;
  }

  addGraze(x = this.x, y = this.y, bullet = null) {
    return this.registerGraze(x, y, bullet);
  }

  // ────────────────────────────── 移動 ──────────────────────────────

  clampPosition(x = this.x, y = this.y) {
    const pf = this.playfield;
    const marginX = Math.min(this.edgeMargin, pf.width / 2);
    const marginY = Math.min(this.edgeMargin, pf.height / 2);
    return {
      x: clamp(finite(x, this.x), pf.x + marginX, pf.x + pf.width - marginX),
      y: clamp(finite(y, this.y), pf.y + marginY, pf.y + pf.height - marginY),
    };
  }

  /** 現在位置をプレイフィールド内に制限する。 */
  clamp() {
    const p = this.clampPosition(this.x, this.y);
    this.x = p.x;
    this.y = p.y;
    return this;
  }

  /**
   * 相対移動（スマホのタッチドラッグ / マウスドラッグ）。
   * 感度・低速時の微調整・画面外クランプを適用する。
   */
  moveBy(dx, dy, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const sensitivity = Math.max(0.05, finite(opts.sensitivity, this.dragSensitivity));
    const slowFactor = opts.respectSlow === false ? 1 : (this.isSlow ? this.slowDragFactor : 1);
    const factor = sensitivity * slowFactor;
    this._moveInternal(finite(dx, 0) * factor, finite(dy, 0) * factor);
    return this;
  }

  /** 目標座標へ lerp（0〜1）でスムーズ追従する。 */
  moveTo(x, y, lerp = 0.25, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const target = this.clampPosition(finite(x, this.x), finite(y, this.y));
    const t = clamp(finite(lerp, 0.25), 0, 1);
    const slowFactor = opts.respectSlow === false ? 1 : (this.isSlow ? this.slowDragFactor : 1);
    this._moveInternal((target.x - this.x) * t * slowFactor, (target.y - this.y) * t * slowFactor);
    return this;
  }

  /**
   * WASD / 矢印キーで移動する。Shift で低速（精密回避）。
   * @param {Set<string>|string[]|Record<string, boolean>} keys
   * @param {number} dt 秒
   */
  handleKeyboard(keys, dt) {
    const d = Math.max(0, finite(dt, 0));
    if (!this.alive || !keys) {
      this.isKeyboardSlow = false;
      return this;
    }
    const left = this._isKeyDown(keys, 'ArrowLeft', 'KeyA', 'a', 'A', 'left', 'Left');
    const right = this._isKeyDown(keys, 'ArrowRight', 'KeyD', 'd', 'D', 'right', 'Right');
    const up = this._isKeyDown(keys, 'ArrowUp', 'KeyW', 'w', 'W', 'up', 'Up');
    const down = this._isKeyDown(keys, 'ArrowDown', 'KeyS', 's', 'S', 'down', 'Down');
    const shift = this._isKeyDown(keys, 'ShiftLeft', 'ShiftRight', 'Shift', 'shift', 'slow', 'Slow');
    this.isKeyboardSlow = shift;
    if (d <= 0) return this;

    let dx = (right ? 1 : 0) - (left ? 1 : 0);
    let dy = (down ? 1 : 0) - (up ? 1 : 0);
    if (dx === 0 && dy === 0) return this;
    const length = Math.hypot(dx, dy);
    dx /= length;
    dy /= length;
    const speed = this.isSlow ? this.slowSpeed : this.normalSpeed;
    this._moveInternal(dx * speed * d, dy * speed * d);
    this.moveDirX = dx;
    this.moveDirY = dy;
    return this;
  }

  _moveInternal(dx, dy) {
    if (!this.alive) return false;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    if (dx === 0 && dy === 0) return false;
    this.x += dx;
    this.y += dy;
    this.clamp();
    const length = Math.hypot(dx, dy);
    this.moveDirX = dx / length;
    this.moveDirY = dy / length;
    this._movingTimer = 0.08;
    return true;
  }

  _isKeyDown(keys, ...names) {
    if (!keys) return false;
    const has = typeof keys.has === 'function';
    const isArray = Array.isArray(keys);
    for (const name of names) {
      if (has) {
        if (keys.has(name)) return true;
        const lower = name.toLowerCase();
        if (lower !== name && keys.has(lower)) return true;
        continue;
      }
      if (isArray) {
        if (keys.includes(name)) return true;
        const lower = name.toLowerCase();
        if (lower !== name && keys.includes(lower)) return true;
        continue;
      }
      if (typeof keys === 'object') {
        if (keys[name] === true || keys[name] === 1) return true;
        const lower = name.toLowerCase();
        if (keys[lower] === true || keys[lower] === 1) return true;
      }
    }
    return false;
  }

  // ────────────────────────────── 更新 ──────────────────────────────

  update(dt) {
    const d = Math.max(0, finite(dt, 0));
    this.time += d;

    this._movingTimer = Math.max(0, this._movingTimer - d);
    const bankTarget = this._movingTimer > 0 ? this.moveDirX * 0.26 : 0;
    this.bank += (bankTarget - this.bank) * Math.min(1, d * 10);

    this.invincibleTimer = Math.max(0, this.invincibleTimer - d);
    if (this.bombTimer > 0) {
      this.bombTimer -= d;
      if (this.bombTimer <= 0) {
        this.bombTimer = 0;
        this.onBombEnd?.(this);
      }
    }
    this.muzzleFlash = Math.max(0, this.muzzleFlash - d);
    this.screenFlash = Math.max(0, this.screenFlash - d);
    this.hitFlash = Math.max(0, this.hitFlash - d);
    this.fireCooldown = Math.max(0, this.fireCooldown - d);

    this._decayCombo(d);
    this._ageEffects(d);
    this._updateParticles(d);
    this._updateBits(d);

    if (this.alive) {
      this._emitThrusterParticles(d);
      if (this.autoFire) this.tryFire();
      if (this.autoGraze || this.autoCollide) this._scanBullets();
    } else {
      this.dangerLevel = Math.max(0, this.dangerLevel - d * 3);
    }
    return this;
  }

  /** クールダウンを尊重して発射する。update() の自動ショットから使用。 */
  tryFire() {
    if (!this.alive || this.fireCooldown > 0) return [];
    const volley = this.fire();
    this.fireCooldown = this.shotInterval;
    return volley;
  }

  /**
   * パワーに応じた自機弾を生成する。クールダウンは fire() では判定しない。
   * @returns {Array<object>} 生成した弾（または登録した弾）の配列
   */
  fire() {
    if (!this.alive) return [];
    const tier = this.powerTier;
    const specs = [];
    const addShot = (x, y, angle, speed, damage, radius, extra = {}) => {
      specs.push(this._makeBulletSpec(x, y, angle, speed, damage, radius, extra));
    };
    const color = tier >= 2 ? '#9defff' : '#6fe7ff';

    if (tier === 0) {
      addShot(this.x, this.y - 14, 0, 920, 9, 3.3, { color, shape: 'needle' });
    } else if (tier === 1) {
      addShot(this.x - 5, this.y - 13, 0, 900, 7, 3.0, { color, shape: 'needle' });
      addShot(this.x + 5, this.y - 13, 0, 900, 7, 3.0, { color, shape: 'needle' });
    } else if (tier === 2) {
      addShot(this.x, this.y - 15, 0, 900, 8, 3.2, { color, shape: 'needle' });
      addShot(this.x - 9, this.y - 12, -0.11, 900, 7, 3.0, { color, shape: 'needle' });
      addShot(this.x + 9, this.y - 12, 0.11, 900, 7, 3.0, { color, shape: 'needle' });
      addShot(this.x - 18, this.y - 8, -0.24, 760, 4.5, 2.4, { color: '#ff8df0', shape: 'orb', sub: true });
      addShot(this.x + 18, this.y - 8, 0.24, 760, 4.5, 2.4, { color: '#ff8df0', shape: 'orb', sub: true });
    } else {
      addShot(this.x, this.y - 16, 0, 940, 9, 3.4, { color, shape: 'needle' });
      addShot(this.x - 12, this.y - 13, -0.12, 920, 7, 3.0, { color, shape: 'needle' });
      addShot(this.x + 12, this.y - 13, 0.12, 920, 7, 3.0, { color, shape: 'needle' });
      addShot(this.x - 24, this.y - 9, -0.26, 880, 6.5, 2.8, { color, shape: 'needle' });
      addShot(this.x + 24, this.y - 9, 0.26, 880, 6.5, 2.8, { color, shape: 'needle' });

      // 追従ビット：最寄りの敵へホーミング（敵がいなければ外向き）
      if (!this.bits[0]?.active) this._updateBits(0);
      const target = this._findNearestEnemy();
      for (const bit of this.bits) {
        if (!bit.active) continue;
        addShot(bit.x, bit.y, bit.side * 0.08, 760, 5.5, 2.6, {
          color: '#ff9df5',
          shape: 'orb',
          bit: true,
          homing: !!target,
          target: target ?? null,
          turnRate: 5.5,
          homingTime: 1.2,
        });
      }
    }

    this.stats.shotsFired += specs.length;
    this.muzzleFlash = 0.08;
    this._playSound('shot');
    const created = specs.map((spec) => this._spawnPlayerBullet(spec));
    this.lastVolley = created;
    this.onShot?.(created, this);
    return created;
  }

  _makeBulletSpec(x, y, offsetAngle, speed, damage, radius, extra = {}) {
    const vx = Math.sin(offsetAngle) * speed;
    const vy = -Math.cos(offsetAngle) * speed;
    return {
      x,
      y,
      vx,
      vy,
      angle: Math.atan2(vy, vx),
      aimAngle: offsetAngle,
      speed,
      power: this.power,
      damage,
      radius,
      color: '#8beeff',
      shape: 'orb',
      type: 'player',
      owner: 'player',
      friendly: true,
      ...extra,
    };
  }

  _spawnPlayerBullet(spec) {
    const dm = this.danmaku ?? this.game?.danmaku ?? null;
    let created = null;
    if (dm) {
      if (typeof dm.spawnPlayerBullet === 'function') {
        created = dm.spawnPlayerBullet(spec) ?? spec;
      } else if (typeof dm.addPlayerBullet === 'function') {
        created = dm.addPlayerBullet(spec) ?? spec;
      } else if (dm.playerBullets && typeof dm.playerBullets.push === 'function') {
        dm.playerBullets.push(spec);
        created = spec;
      } else if (dm.playerBulletPool && typeof dm.playerBulletPool.spawn === 'function') {
        created = dm.playerBulletPool.spawn(spec) ?? spec;
      }
    }
    if (!created) {
      this.bullets.push(spec);
      created = spec;
    }
    return created;
  }

  _findNearestEnemy() {
    if (this._nearestEnemySource) {
      const found = this._nearestEnemySource(this.x, this.y);
      if (found) return found;
    }
    const game = this.game;
    if (typeof game?.getNearestEnemy === 'function') {
      const found = game.getNearestEnemy(this.x, this.y);
      if (found) return found;
    }
    const list = this.enemies ?? game?.enemies ?? game?.enemyList;
    if (!Array.isArray(list)) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const enemy of list) {
      if (!isLiveEnemy(enemy)) continue;
      const ex = finite(enemy.x ?? enemy.pos?.x, NaN);
      const ey = finite(enemy.y ?? enemy.pos?.y, NaN);
      if (!Number.isFinite(ex) || !Number.isFinite(ey)) continue;
      const distance = (ex - this.x) ** 2 + (ey - this.y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = enemy;
      }
    }
    return best;
  }

  _decayCombo(dt) {
    if (this.comboTimer <= 0) return;
    this.comboTimer -= dt;
    if (this.comboTimer > 0) return;
    this.comboTimer = 0;
    this.combo = 0;
    this.grazeMultiplier = 1;
    this.onCombo?.(0, 1, this);
  }

  // ────────────────────────────── 当たり判定 ──────────────────────────────

  _getEnemyBullets() {
    const source = this._enemyBulletsSource;
    if (typeof source === 'function') {
      const result = source();
      if (result) return result;
    } else if (Array.isArray(source)) {
      return source;
    }

    const dm = this.danmaku ?? this.game?.danmaku ?? null;
    if (dm) {
      if (Array.isArray(dm.enemyBullets)) return dm.enemyBullets;
      if (typeof dm.getEnemyBullets === 'function') {
        const result = dm.getEnemyBullets();
        if (result) return result;
      }
      if (dm.enemyBulletPool && Array.isArray(dm.enemyBulletPool.active)) return dm.enemyBulletPool.active;
      if (Array.isArray(dm.bullets)) return dm.bullets;
    }

    const game = this.game;
    if (game) {
      if (Array.isArray(game.enemyBullets)) return game.enemyBullets;
      if (typeof game.getEnemyBullets === 'function') {
        const result = game.getEnemyBullets();
        if (result) return result;
      }
    }
    if (Array.isArray(this.enemyBullets)) return this.enemyBullets;
    return null;
  }

  _bulletArray() {
    const bullets = this._getEnemyBullets();
    if (!bullets) return null;
    if (Array.isArray(bullets)) return bullets;
    if (Array.isArray(bullets.bullets)) return bullets.bullets;
    if (Array.isArray(bullets.active)) return bullets.active;
    if (Array.isArray(bullets.list)) return bullets.list;
    if (typeof bullets[Symbol.iterator] === 'function') return Array.from(bullets);
    return null;
  }

  _isHostileBullet(bullet) {
    if (!bullet || bullet.dead || bullet.removed || bullet.active === false) return false;
    if (bullet.friendly === true) return false;
    if (bullet.owner === 'player' || bullet.type === 'player' || bullet.isPlayerBullet === true) return false;
    return true;
  }

  _scanBullets() {
    const bullets = this._bulletArray();
    if (!bullets || bullets.length === 0) {
      this.nearestBulletDistance = Infinity;
      this.dangerLevel = Math.max(0, this.dangerLevel - 0.15);
      return;
    }

    let nearestSq = Infinity;
    for (let i = 0; i < bullets.length; i += 1) {
      const bullet = bullets[i];
      if (!this._isHostileBullet(bullet)) continue;
      const bx = bullet.x ?? bullet.pos?.x;
      const by = bullet.y ?? bullet.pos?.y;
      if (!Number.isFinite(bx) || !Number.isFinite(by)) continue;
      const radius = finite(
        bullet.radius
          ?? bullet.hitRadius
          ?? bullet.r
          ?? (Number.isFinite(bullet.size) ? bullet.size / 2 : undefined),
        4,
      );
      const dx = bx - this.x;
      const dy = by - this.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < nearestSq) nearestSq = distanceSq;

      const distance = Math.sqrt(distanceSq);
      const hitDistance = this.hitboxRadius + radius;
      if (this.autoCollide && distance <= hitDistance) {
        this.takeHit(bullet);
        if (!this.alive) break;
        continue;
      }
      if (this.autoGraze
        && !bullet.noGraze
        && !bullet.grazed
        && !bullet.grazedByPlayer
        && distance > hitDistance
        && distance <= this.grazeRadius + radius) {
        bullet.grazed = true;
        bullet.grazedByPlayer = true;
        this.registerGraze(bx, by, bullet);
      }
    }

    this.nearestBulletDistance = Math.sqrt(nearestSq);
    const dangerStart = this.hitboxRadius + this.dangerRadius;
    if (this.nearestBulletDistance < dangerStart) {
      this.dangerLevel = clamp(
        1 - (this.nearestBulletDistance - this.hitboxRadius) / this.dangerRadius,
        0,
        1,
      );
    } else {
      this.dangerLevel = 0;
    }
  }

  // ────────────────────────────── 被弾・ボム ──────────────────────────────

  /** 被弾。無敵中・ボム中は無効。 @returns {boolean} 実際に被弾したか */
  takeHit(source = null) {
    if (!this.alive || this.invincibleTimer > 0 || this.bombTimer > 0) return false;
    this.stats.damageTaken += 1;
    this.stats.livesLost += 1;
    this.lives = Math.max(0, this.lives - 1);
    this.invincibleTimer = Math.max(this.invincibleTimer, this.respawnInvincibility);
    this.combo = 0;
    this.comboTimer = 0;
    this.grazeMultiplier = 1;
    this.hitFlash = 0.55;
    this.screenFlash = Math.max(this.screenFlash, 0.18);
    this.hitEffects.push({ x: this.x, y: this.y, life: 0.7, maxLife: 0.7 });
    this._spawnDebris(this.x, this.y, 22);
    this._playSound('hit');
    if (this.deathPowerLoss > 0) this.setPower(this.power - this.deathPowerLoss);

    const info = {
      player: this,
      source,
      lives: this.lives,
      x: this.x,
      y: this.y,
    };
    this.onHit?.(this.x, this.y, info);
    if (this.lives <= 0) {
      this.alive = false;
      this.dangerLevel = 0;
      this.onDeath?.(info);
      this._playSound('death');
    }
    return true;
  }

  hit(source = null) {
    return this.takeHit(source);
  }

  /** 残機を消費せずに無敵時間を付与する。 */
  grantInvincibility(seconds = 1) {
    this.invincibleTimer = Math.max(this.invincibleTimer, Math.max(0, finite(seconds, 1)));
    return this;
  }

  /** 残機があればスポーン位置へ復帰する。 */
  respawn() {
    if (this.lives <= 0) return false;
    this.alive = true;
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.clamp();
    this.invincibleTimer = Math.max(this.invincibleTimer, this.respawnInvincibility);
    this.dangerLevel = 0;
    this.nearestBulletDistance = Infinity;
    this._resetBits(true);
    this._updateBits(0);
    return true;
  }

  /**
   * ボム発動。画面全体消弾・炸裂波・大ダメージ・一定時間無敵・得点アイテム化を実行。
   * @returns {boolean} 発動できたか
   */
  activateBomb() {
    if (!this.alive || this.bombs <= 0 || this.bombTimer > 0) return false;
    this.bombs -= 1;
    this.stats.bombsUsed += 1;
    this.bombTimer = this.bombDuration;
    this.invincibleTimer = Math.max(this.invincibleTimer, this.bombInvincibility);
    this.screenFlash = Math.max(this.screenFlash, 0.3);
    this.dangerLevel = 0;

    const info = {
      player: this,
      x: this.x,
      y: this.y,
      damage: this.bombDamage,
      damageRadius: this.bombDamageRadius,
      toItems: true,
      convertToItems: true,
      fromBomb: true,
    };

    const waveRadius = Math.hypot(this.playfield.width, this.playfield.height) * 0.95;
    this.bombWaves.push({
      x: this.x,
      y: this.y,
      life: 1.1,
      maxLife: 1.1,
      maxRadius: waveRadius,
    });
    this._spawnDebris(this.x, this.y, 26, true);

    info.clearedBullets = this._clearEnemyBullets(info);
    this._applyBombDamage(info);
    this.lastBombInfo = info;
    this._playSound('bomb');
    this.onBomb?.(this.x, this.y, info);
    return true;
  }

  _clearEnemyBullets(info) {
    const dm = this.danmaku ?? this.game?.danmaku ?? null;
    const opts = { ...info, toItems: true, convertToItems: true, scoreItems: true };
    let handled = false;
    let count = 0;

    if (dm) {
      if (typeof dm.clearEnemyBullets === 'function') {
        const result = dm.clearEnemyBullets(opts);
        if (typeof result === 'number') count = result;
        handled = true;
      } else if (typeof dm.clearBullets === 'function') {
        const result = dm.clearBullets(true);
        if (typeof result === 'number') count = result;
        handled = true;
      } else if (typeof dm.bombClear === 'function') {
        const result = dm.bombClear(opts);
        if (typeof result === 'number') count = result;
        handled = true;
      } else if (typeof dm.convertEnemyBulletsToItems === 'function') {
        const bullets = this._bulletArray();
        if (bullets) {
          const result = dm.convertEnemyBulletsToItems(bullets, opts);
          if (typeof result === 'number') count = result;
          handled = true;
        }
      }
    }

    if (!handled && this.game) {
      if (typeof this.game.clearEnemyBullets === 'function') {
        const result = this.game.clearEnemyBullets(opts);
        if (typeof result === 'number') count = result;
        handled = true;
      } else if (typeof this.game.bombClear === 'function') {
        const result = this.game.bombClear(opts);
        if (typeof result === 'number') count = result;
        handled = true;
      }
    }

    if (handled) return count;

    const bullets = this._bulletArray();
    if (!bullets) return count;
    for (let i = bullets.length - 1; i >= 0; i -= 1) {
      const bullet = bullets[i];
      if (!this._isHostileBullet(bullet)) continue;
      const bx = finite(bullet.x ?? bullet.pos?.x, this.x);
      const by = finite(bullet.y ?? bullet.pos?.y, this.y);
      bullet.dead = true;
      bullet.convertedToItem = true;
      if (typeof bullet.kill === 'function') bullet.kill();
      this._spawnScoreItem(bx, by, bullet);
      count += 1;
    }
    return count;
  }

  _spawnScoreItem(x, y, bullet = null) {
    const dm = this.danmaku ?? this.game?.danmaku ?? null;
    const game = this.game;
    const payload = { x, y, value: 1, source: 'bomb', bullet };
    if (typeof dm?.spawnScoreItem === 'function') return dm.spawnScoreItem(x, y, payload);
    if (typeof game?.spawnScoreItem === 'function') return game.spawnScoreItem(x, y, payload);
    if (typeof dm?.spawnItem === 'function') return dm.spawnItem(x, y, 'score', payload);
    if (typeof game?.spawnItem === 'function') return game.spawnItem(x, y, 'score', payload);
    if (this.onBulletToItem) {
      this.onBulletToItem(payload, bullet, this);
      return true;
    }
    return null;
  }

  _applyBombDamage(info) {
    const dm = this.danmaku ?? this.game?.danmaku ?? null;
    const game = this.game;
    if (typeof dm?.applyBombDamage === 'function') {
      dm.applyBombDamage(info);
      return true;
    }
    if (typeof dm?.damageEnemiesInRadius === 'function') {
      dm.damageEnemiesInRadius(info.x, info.y, info.damageRadius, info.damage, info);
      return true;
    }
    if (typeof game?.applyBombDamage === 'function') {
      game.applyBombDamage(info);
      return true;
    }
    if (typeof game?.damageEnemiesInRadius === 'function') {
      game.damageEnemiesInRadius(info.x, info.y, info.damageRadius, info.damage, info);
      return true;
    }

    const enemies = this.enemies ?? game?.enemies;
    if (!Array.isArray(enemies)) return false;
    const radiusSq = info.damageRadius === Infinity
      ? Infinity
      : info.damageRadius * info.damageRadius;
    let applied = false;
    for (const enemy of enemies) {
      if (!isLiveEnemy(enemy)) continue;
      const ex = finite(enemy.x ?? enemy.pos?.x, NaN);
      const ey = finite(enemy.y ?? enemy.pos?.y, NaN);
      if (!Number.isFinite(ex) || !Number.isFinite(ey)) continue;
      const dx = ex - info.x;
      const dy = ey - info.y;
      if (dx * dx + dy * dy > radiusSq) continue;
      if (typeof enemy.takeDamage === 'function') enemy.takeDamage(info.damage, info);
      else if (typeof enemy.damage === 'function') enemy.damage(info.damage, info);
      else if (typeof enemy.hp === 'number') enemy.hp -= info.damage;
      enemy.lastBombHit = this.time;
      applied = true;
    }
    return applied;
  }

  // ────────────────────────────── ビット・エフェクト ──────────────────────────────

  _createBits() {
    return [
      { side: -1, x: 0, y: 0, active: false, phase: 0 },
      { side: 1, x: 0, y: 0, active: false, phase: Math.PI },
    ];
  }

  _resetBits(snap) {
    const cx = finite(this.x, this.spawnX);
    const cy = finite(this.y, this.spawnY);
    for (const bit of this.bits) {
      const tx = cx + bit.side * 30;
      const ty = cy + 2;
      if (snap) {
        bit.x = tx;
        bit.y = ty;
      }
    }
  }

  _clampBits() {
    const pf = this.playfield;
    for (const bit of this.bits) {
      if (!Number.isFinite(bit.x) || !Number.isFinite(bit.y)) continue;
      bit.x = clamp(bit.x, pf.x, pf.x + pf.width);
      bit.y = clamp(bit.y, pf.y, pf.y + pf.height);
    }
  }

  _updateBits(dt) {
    const active = this.powerTier >= 3;
    for (const bit of this.bits) {
      if (!active) {
        bit.active = false;
        continue;
      }
      const targetX = this.x + bit.side * (30 + Math.sin(this.time * 3 + bit.phase) * 4);
      const targetY = this.y + 2 + Math.cos(this.time * 2.6 + bit.phase) * 7;
      if (!bit.active) {
        bit.x = targetX;
        bit.y = targetY;
        bit.active = true;
      } else {
        const k = dt > 0 ? Math.min(1, dt * 12) : 1;
        bit.x += (targetX - bit.x) * k;
        bit.y += (targetY - bit.y) * k;
      }
    }
  }

  _emitThrusterParticles(dt) {
    if (dt <= 0) return;
    this._thrusterAcc += dt * (this.isSlow ? 32 : 55);
    const maxParticles = 160;
    while (this._thrusterAcc >= 1) {
      this._thrusterAcc -= 1;
      if (this.particles.length >= maxParticles) {
        this._thrusterAcc = 0;
        break;
      }
      const spread = Math.random() - 0.5;
      const life = 0.16 + Math.random() * 0.24;
      this.particles.push({
        x: this.x + spread * 6,
        y: this.y + 12 + Math.random() * 3,
        vx: spread * 40 + this.bank * 80,
        vy: 70 + Math.random() * 100,
        gravity: 20,
        life,
        maxLife: life,
        size: 1 + Math.random() * 2,
        kind: Math.random() < 0.35 ? 'spark' : 'flame',
      });
    }
  }

  _addGrazeEffect(x, y) {
    this.grazeEffects.push({
      x,
      y,
      life: 0.34,
      maxLife: 0.34,
      seed: Math.random() * TAU,
    });
    if (this.grazeEffects.length > 24) this.grazeEffects.shift();
  }

  _spawnDebris(x, y, count = 16, bomb = false) {
    for (let i = 0; i < count; i += 1) {
      const angle = Math.random() * TAU;
      const speed = (bomb ? 120 : 70) + Math.random() * (bomb ? 220 : 150);
      const life = 0.35 + Math.random() * (bomb ? 0.5 : 0.35);
      this.debris.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: 90,
        drag: 1.6,
        life,
        maxLife: life,
        size: 1.5 + Math.random() * 2.5,
        color: bomb ? 'bomb' : 'hit',
      });
    }
    if (this.debris.length > 220) this.debris.splice(0, this.debris.length - 220);
  }

  _ageEffects(dt) {
    for (const list of [this.grazeEffects, this.hitEffects, this.bombWaves]) {
      let write = 0;
      for (let i = 0; i < list.length; i += 1) {
        const effect = list[i];
        effect.life -= dt;
        if (effect.life > 0) {
          list[write] = effect;
          write += 1;
        }
      }
      list.length = write;
    }
  }

  _updateParticles(dt) {
    this._advanceParticles(this.particles, dt);
    this._advanceParticles(this.debris, dt);
  }

  _advanceParticles(list, dt) {
    let write = 0;
    for (let i = 0; i < list.length; i += 1) {
      const particle = list[i];
      particle.life -= dt;
      if (particle.life <= 0) continue;
      particle.vy += (particle.gravity ?? 0) * dt;
      if (particle.drag) {
        const factor = Math.max(0, 1 - particle.drag * dt);
        particle.vx *= factor;
        particle.vy *= factor;
      }
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      list[write] = particle;
      write += 1;
    }
    list.length = write;
  }

  _playSound(name) {
    const audio = this.audio;
    if (!audio) return;
    if (typeof audio.play === 'function') audio.play(name, this);
    else if (typeof audio.playSound === 'function') audio.playSound(name, this);
    else if (typeof audio[name] === 'function') audio[name](this);
  }

  _createStats() {
    return {
      shotsFired: 0,
      bombsUsed: 0,
      damageTaken: 0,
      livesLost: 0,
    };
  }

  /** 新しいゲーム用に自機状態を初期化する（danmaku 側の弾は消さない）。 */
  reset() {
    this.lives = this.initialLives;
    this.bombs = this.initialBombs;
    this.power = 0;
    this.score = 0;
    this.grazeCount = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.grazeMultiplier = 1;
    this.maxCombo = 0;
    this.alive = true;
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.clamp();
    this.invincibleTimer = 0;
    this.bombTimer = 0;
    this.fireCooldown = 0;
    this.muzzleFlash = 0;
    this.screenFlash = 0;
    this.hitFlash = 0;
    this.dangerLevel = 0;
    this.nearestBulletDistance = Infinity;
    this.isKeyboardSlow = false;
    this.isTouchSlow = false;
    this.moveDirX = 0;
    this.moveDirY = 0;
    this.bank = 0;
    this._movingTimer = 0;
    this._thrusterAcc = 0;
    this.time = 0;
    this.particles.length = 0;
    this.debris.length = 0;
    this.grazeEffects.length = 0;
    this.hitEffects.length = 0;
    this.bombWaves.length = 0;
    this.bullets.length = 0;
    this.lastVolley = [];
    this.lastBombInfo = null;
    this.stats = this._createStats();
    this._resetBits(true);
    this._updateBits(0);
    return this;
  }

  // ────────────────────────────── 描画 ──────────────────────────────

  /** 自機・ビット・当たり判定コア・各種エフェクトを描画する。 */
  render(ctx) {
    if (!ctx || this.hidden) return;
    ctx.save();
    this._drawScreenFlash(ctx);
    this._drawBombWaves(ctx);
    this._drawThrusterParticles(ctx);
    this._drawDebris(ctx);
    this._drawGrazeEffects(ctx);
    this._drawHitEffects(ctx);

    if (this.alive || this.hitFlash > 0) {
      ctx.save();
      ctx.translate(this.x, this.y);
      const blink = this.alive
        && this.invincibleTimer > 0
        && Math.floor(this.invincibleTimer * 24) % 2 === 0;
      if (!blink) {
        this._drawShip(ctx);
        this._drawBits(ctx);
        this._drawMuzzleFlash(ctx);
      }
      if (this.invincibleTimer > 0) this._drawShield(ctx);
      this._drawHitbox(ctx);
      ctx.restore();
    }
    ctx.restore();
  }

  draw(ctx) {
    this.render(ctx);
  }

  _drawScreenFlash(ctx) {
    if (this.screenFlash <= 0) return;
    const pf = this.playfield;
    const alpha = clamp(this.screenFlash / 0.3, 0, 1) * 0.32;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const gradient = ctx.createLinearGradient(pf.x, pf.y, pf.x, pf.y + pf.height);
    gradient.addColorStop(0, `rgba(170, 245, 255, ${alpha})`);
    gradient.addColorStop(0.5, `rgba(120, 200, 255, ${alpha * 0.65})`);
    gradient.addColorStop(1, `rgba(255, 120, 240, ${alpha * 0.45})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(pf.x, pf.y, pf.width, pf.height);
    ctx.restore();
  }

  _drawBombWaves(ctx) {
    for (const wave of this.bombWaves) {
      const progress = clamp(1 - wave.life / wave.maxLife, 0, 1);
      const alpha = (1 - progress) ** 2;
      if (alpha <= 0.01) continue;
      const radius = (wave.maxRadius ?? 400) * (0.08 + progress * 0.92);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(wave.x, wave.y);

      ctx.strokeStyle = `rgba(120, 240, 255, ${alpha * 0.9})`;
      ctx.lineWidth = 2 + (1 - progress) * 9;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, TAU);
      ctx.stroke();

      ctx.strokeStyle = `rgba(255, 100, 235, ${alpha * 0.6})`;
      ctx.lineWidth = 1.5 + (1 - progress) * 3;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(0.1, radius * 0.78), 0, TAU);
      ctx.stroke();

      ctx.strokeStyle = `rgba(170, 250, 255, ${alpha * 0.35})`;
      ctx.lineWidth = 1;
      for (let i = 0; i < 12; i += 1) {
        const angle = (i / 12) * TAU + progress * 0.8;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * radius * 0.42, Math.sin(angle) * radius * 0.42);
        ctx.lineTo(Math.cos(angle) * radius * 0.95, Math.sin(angle) * radius * 0.95);
        ctx.stroke();
      }

      if (progress < 0.35) {
        const coreAlpha = (1 - progress / 0.35) * 0.8;
        const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 60);
        core.addColorStop(0, `rgba(255, 255, 255, ${coreAlpha})`);
        core.addColorStop(1, 'rgba(120, 230, 255, 0)');
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(0, 0, 60, 0, TAU);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  _drawThrusterParticles(ctx) {
    if (this.particles.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const particle of this.particles) {
      const alpha = clamp(particle.life / particle.maxLife, 0, 1);
      if (particle.kind === 'spark') {
        ctx.strokeStyle = `rgba(255, 220, 140, ${alpha * 0.9})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(particle.x, particle.y);
        ctx.lineTo(particle.x - particle.vx * 0.02, particle.y - particle.vy * 0.02);
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(110, 230, 255, ${alpha * 0.75})`;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size * (0.45 + alpha * 0.8), 0, TAU);
        ctx.fill();
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.35})`;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size * 0.35, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  _drawDebris(ctx) {
    if (this.debris.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const particle of this.debris) {
      const alpha = clamp(particle.life / particle.maxLife, 0, 1);
      ctx.strokeStyle = particle.color === 'bomb'
        ? `rgba(140, 240, 255, ${alpha})`
        : `rgba(255, 110, 150, ${alpha})`;
      ctx.lineWidth = particle.size * 0.8;
      ctx.beginPath();
      ctx.moveTo(particle.x, particle.y);
      ctx.lineTo(particle.x - particle.vx * 0.03, particle.y - particle.vy * 0.03);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawGrazeEffects(ctx) {
    for (const effect of this.grazeEffects) {
      const progress = clamp(1 - effect.life / effect.maxLife, 0, 1);
      const alpha = (1 - progress) ** 1.5;
      const radius = this.grazeRadius * (0.3 + progress * 0.9);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(effect.x, effect.y);

      ctx.strokeStyle = `rgba(140, 245, 255, ${alpha * 0.85})`;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.arc(0, 0, radius, effect.seed, effect.seed + 1.5);
      ctx.stroke();

      ctx.strokeStyle = `rgba(255, 120, 240, ${alpha * 0.55})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.7, effect.seed + Math.PI, effect.seed + Math.PI + 1.2);
      ctx.stroke();

      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.beginPath();
      ctx.arc(
        Math.cos(effect.seed) * radius * 0.8,
        Math.sin(effect.seed) * radius * 0.8,
        1.6,
        0,
        TAU,
      );
      ctx.fill();
      ctx.restore();
    }
  }

  _drawHitEffects(ctx) {
    for (const effect of this.hitEffects) {
      const progress = clamp(1 - effect.life / effect.maxLife, 0, 1);
      const alpha = (1 - progress) ** 1.4;
      const radius = 6 + progress * 36;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(effect.x, effect.y);

      ctx.strokeStyle = `rgba(255, 70, 110, ${alpha * 0.9})`;
      ctx.lineWidth = 2 + (1 - progress) * 3;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, TAU);
      ctx.stroke();

      ctx.strokeStyle = `rgba(255, 190, 120, ${alpha * 0.55})`;
      ctx.lineWidth = 1;
      for (let i = 0; i < 6; i += 1) {
        const angle = (i / 6) * TAU + progress;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * radius * 0.4, Math.sin(angle) * radius * 0.4);
        ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  _drawShip(ctx) {
    ctx.save();
    ctx.rotate(this.bank);
    this._drawEngineFlame(ctx);

    ctx.save();
    ctx.shadowColor = 'rgba(80, 230, 255, 0.85)';
    ctx.shadowBlur = 14;
    const hull = ctx.createLinearGradient(0, -18, 0, 12);
    hull.addColorStop(0, '#1b4b66');
    hull.addColorStop(0.55, '#0a1a2b');
    hull.addColorStop(1, '#071019');
    ctx.fillStyle = hull;
    ctx.strokeStyle = 'rgba(110, 240, 255, 0.95)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -18);
    ctx.lineTo(3.5, -9);
    ctx.lineTo(8, -3);
    ctx.lineTo(17, 8);
    ctx.lineTo(17, 11);
    ctx.lineTo(6, 7);
    ctx.lineTo(4, 12);
    ctx.lineTo(0, 10);
    ctx.lineTo(-4, 12);
    ctx.lineTo(-6, 7);
    ctx.lineTo(-17, 11);
    ctx.lineTo(-17, 8);
    ctx.lineTo(-8, -3);
    ctx.lineTo(-3.5, -9);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = this.powerTier >= 3
      ? 'rgba(255, 120, 240, 0.95)'
      : 'rgba(255, 90, 220, 0.8)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-15, 8);
    ctx.lineTo(-8, 0);
    ctx.lineTo(-5, 5);
    ctx.moveTo(15, 8);
    ctx.lineTo(8, 0);
    ctx.lineTo(5, 5);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(150, 250, 255, 0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -14);
    ctx.lineTo(0, 9);
    ctx.stroke();

    const cockpit = ctx.createRadialGradient(0, -6, 0.5, 0, -6, 5.5);
    cockpit.addColorStop(0, 'rgba(230, 255, 255, 0.95)');
    cockpit.addColorStop(0.5, 'rgba(80, 230, 255, 0.85)');
    cockpit.addColorStop(1, 'rgba(20, 80, 120, 0.2)');
    ctx.fillStyle = cockpit;
    ctx.beginPath();
    ctx.ellipse(0, -6, 3.1, 5.2, 0, 0, TAU);
    ctx.fill();

    if (this.powerTier >= 2) {
      ctx.fillStyle = 'rgba(10, 25, 40, 0.9)';
      ctx.strokeStyle = 'rgba(255, 130, 240, 0.9)';
      ctx.lineWidth = 1;
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.rect(side < 0 ? -14 : 10, 2, 4, 7);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.restore();
  }

  _drawEngineFlame(ctx) {
    const flicker = 0.72 + Math.sin(this.time * 42) * 0.18 + Math.random() * 0.1;
    const length = 13 + flicker * 10;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const flame = ctx.createLinearGradient(0, 8, 0, 8 + length);
    flame.addColorStop(0, 'rgba(255, 255, 220, 0.95)');
    flame.addColorStop(0.3, 'rgba(130, 240, 255, 0.85)');
    flame.addColorStop(1, 'rgba(70, 120, 255, 0)');
    ctx.fillStyle = flame;
    ctx.beginPath();
    ctx.moveTo(-4, 7);
    ctx.quadraticCurveTo(-1.5, 7 + length * 0.75, 0, 7 + length);
    ctx.quadraticCurveTo(1.5, 7 + length * 0.75, 4, 7);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(120, 230, 255, 0.5)';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 6, 6);
      ctx.quadraticCurveTo(side * 7.5, 6 + length * 0.35, side * 5, 6 + length * 0.45);
      ctx.quadraticCurveTo(side * 4.5, 6 + length * 0.2, side * 6, 6);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawBits(ctx) {
    for (const bit of this.bits) {
      if (!bit.active) continue;
      const lx = bit.x - this.x;
      const ly = bit.y - this.y;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      ctx.strokeStyle = 'rgba(100, 230, 255, 0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bit.side * 8, 4);
      ctx.lineTo(lx, ly);
      ctx.stroke();

      ctx.translate(lx, ly);
      ctx.rotate(this.time * 2.2 * bit.side);
      ctx.shadowColor = 'rgba(255, 110, 245, 0.95)';
      ctx.shadowBlur = 12;
      ctx.fillStyle = 'rgba(12, 24, 44, 0.92)';
      ctx.strokeStyle = 'rgba(255, 130, 245, 0.95)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(5, 0);
      ctx.lineTo(0, 6);
      ctx.lineTo(-5, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.fillStyle = 'rgba(190, 255, 255, 0.95)';
      ctx.beginPath();
      ctx.arc(0, 0, 1.5, 0, TAU);
      ctx.fill();

      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 10);
      glow.addColorStop(0, 'rgba(255, 150, 250, 0.35)');
      glow.addColorStop(1, 'rgba(255, 80, 240, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  _drawShield(ctx) {
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 9);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(120, 235, 255, ${(this.bombActive ? 0.3 : 0.18) + pulse * 0.14})`;
    ctx.lineWidth = 1.2;
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.arc(0, 0, 20 + pulse * 2, 0, TAU);
    ctx.stroke();
    if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    ctx.restore();
  }

  _drawMuzzleFlash(ctx) {
    if (this.muzzleFlash <= 0) return;
    const alpha = clamp(this.muzzleFlash / 0.08, 0, 1);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(180, 250, 255, ${alpha * 0.65})`;
    ctx.beginPath();
    ctx.moveTo(-4, -14);
    ctx.lineTo(0, -26 - 6 * alpha);
    ctx.lineTo(4, -14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _drawHitbox(ctx) {
    const radius = this.hitboxRadius;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 11);
    const slow = this.isSlow ? 1 : 0;
    const danger = this.dangerLevel;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const glowRadius = 9 + pulse * 2 + slow * 3 + danger * 7;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowRadius);
    glow.addColorStop(0, `rgba(255, 255, 255, ${0.55 + slow * 0.2})`);
    glow.addColorStop(0.25, `rgba(255, 90, 120, ${0.55 + danger * 0.25})`);
    glow.addColorStop(0.6, `rgba(255, 30, 80, ${0.22 + danger * 0.2})`);
    glow.addColorStop(1, 'rgba(255, 0, 60, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, glowRadius, 0, TAU);
    ctx.fill();

    if (slow || danger > 0.05) {
      ctx.strokeStyle = `rgba(255, 100, 140, ${0.16 + danger * 0.32 + slow * 0.1})`;
      ctx.lineWidth = 1;
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, this.grazeRadius, 0, TAU);
      ctx.stroke();
      if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
    }

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(1.3, radius * 0.52), 0, TAU);
    ctx.fill();

    ctx.strokeStyle = `rgba(255, 40, 80, ${0.85 + danger * 0.15})`;
    ctx.lineWidth = 1.4 + danger * 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, radius + 0.6, 0, TAU);
    ctx.stroke();

    if (slow) {
      ctx.strokeStyle = 'rgba(255, 190, 215, 0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, radius + 4 + pulse * 1.6, 0, TAU);
      ctx.stroke();

      ctx.save();
      ctx.rotate(this.time * 3.2);
      ctx.strokeStyle = 'rgba(255, 105, 150, 0.9)';
      ctx.lineWidth = 1.1;
      for (let i = 0; i < 4; i += 1) {
        ctx.beginPath();
        ctx.arc(0, 0, radius + 7, (i * Math.PI) / 2, (i * Math.PI) / 2 + 0.38);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (danger > 0.15) {
      ctx.strokeStyle = `rgba(255, 45, 105, ${danger * 0.9})`;
      ctx.lineWidth = 1 + danger * 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, radius + 6 + danger * 8 * pulse, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }
}

export default Player;
