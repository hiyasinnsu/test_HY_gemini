/**
 * game.js - ゲーム全体の統括エンジン
 * プレイヤー、弾幕、敵・ボス、アイテム、パーティクル、入力、オーディオ、HUD、ステージ進行の統合
 */

import { Player } from './player.js';
import { BulletManager } from './danmaku.js';
import { EnemyManager } from './enemy.js';
import { ParticleManager } from './particle.js';

export class Game {
  constructor({ canvas, audio, input, background, width, height }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.audio = audio;
    this.input = input;
    this.background = background;
    this.width = width;
    this.height = height;

    this.state = 'title'; // 'title' | 'playing' | 'paused' | 'gameover' | 'clear'
    this.hiscore = parseInt(localStorage.getItem('cyber_stg_hiscore') || '100000', 10);

    // サブマネージャー
    this.particles = new ParticleManager(800);
    this.bullets = new BulletManager(width, height);
    this.enemies = new EnemyManager(width, height);
    this.player = new Player(width / 2, height * 0.82, { width, height });

    // ステージ進行管理
    this.stageTime = 0;
    this.waveSpawned = new Set();
    this.bossAlertTimer = 0;
    this.screenShake = 0;

    // HUD要素のキャッシュ
    this.hudScore = document.getElementById('hud-score');
    this.hudHiscore = document.getElementById('hud-hiscore');
    this.hudLives = document.getElementById('hud-lives');
    this.hudBombs = document.getElementById('hud-bombs');
    this.hudGraze = document.getElementById('hud-graze');
    this.hudPower = document.getElementById('hud-power');
    this.touchBombCount = document.getElementById('touch-bomb-count');
    this.bossHud = document.getElementById('boss-hud');
    this.bossName = document.getElementById('boss-name');
    this.bossBarInner = document.getElementById('boss-bar-inner');

    this.pauseScreen = document.getElementById('pause-screen');
    this.gameoverScreen = document.getElementById('gameover-screen');
    this.clearScreen = document.getElementById('clear-screen');

    this._updateHiscoreDisplay();
  }

  start() {
    this.state = 'playing';
    this.stageTime = 0;
    this.waveSpawned.clear();
    this.bossAlertTimer = 0;
    this.screenShake = 0;

    // リセット
    if (this.bullets.clear) this.bullets.clear();
    if (this.bullets.clearBullets) this.bullets.clearBullets(false);
    if (this.enemies.reset) this.enemies.reset();
    if (this.particles.clear) this.particles.clear();

    this.player.reset ? this.player.reset(this.width / 2, this.height * 0.82) : this._resetPlayer();

    // BGMスタート
    if (this.audio && this.audio.startBgm) {
      this.audio.startBgm('stage');
    }

    if (this.bossHud) this.bossHud.style.display = 'none';
    this.updateHUD();
  }

  _resetPlayer() {
    this.player.x = this.width / 2;
    this.player.y = this.height * 0.82;
    this.player.lives = 3;
    this.player.bombs = 3;
    this.player.power = 0;
    this.player.score = 0;
    this.player.graze = 0;
    this.player.invincibleTimer = 2.0;
  }

  stop() {
    this.state = 'title';
    if (this.audio && this.audio.stopBgm) {
      this.audio.stopBgm();
    }
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    if (this.audio && this.audio.pauseBgm) this.audio.pauseBgm();
    if (this.pauseScreen) this.pauseScreen.classList.remove('hidden');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    if (this.audio && this.audio.resumeBgm) this.audio.resumeBgm();
    if (this.pauseScreen) this.pauseScreen.classList.add('hidden');
  }

  gameOver() {
    this.state = 'gameover';
    if (this.audio && this.audio.stopBgm) this.audio.stopBgm();
    if (this.audio && this.audio.playPlayerDeath) this.audio.playPlayerDeath();

    const score = this.player.score || 0;
    if (score > this.hiscore) {
      this.hiscore = score;
      localStorage.setItem('cyber_stg_hiscore', String(this.hiscore));
      this._updateHiscoreDisplay();
    }

    const goScore = document.getElementById('go-score');
    const goGraze = document.getElementById('go-graze');
    const goHiscore = document.getElementById('go-hiscore');
    if (goScore) goScore.textContent = score.toLocaleString();
    if (goGraze) goGraze.textContent = (this.player.graze || 0).toLocaleString();
    if (goHiscore) goHiscore.textContent = this.hiscore.toLocaleString();

    if (this.gameoverScreen) this.gameoverScreen.classList.remove('hidden');
  }

  stageClear() {
    this.state = 'clear';
    if (this.audio && this.audio.stopBgm) this.audio.stopBgm();
    if (this.audio && this.audio.playBossDefeat) this.audio.playBossDefeat();

    const baseScore = this.player.score || 0;
    const grazeBonus = (this.player.graze || 0) * 1000;
    const survivalBonus = (this.player.lives || 0) * 50000 + (this.player.bombs || 0) * 20000;
    const totalScore = baseScore + grazeBonus + survivalBonus;

    if (totalScore > this.hiscore) {
      this.hiscore = totalScore;
      localStorage.setItem('cyber_stg_hiscore', String(this.hiscore));
      this._updateHiscoreDisplay();
    }

    const clrScore = document.getElementById('clear-score');
    const clrGraze = document.getElementById('clear-graze-bonus');
    const clrSurv = document.getElementById('clear-survival-bonus');
    const clrTotal = document.getElementById('clear-total-score');
    if (clrScore) clrScore.textContent = baseScore.toLocaleString();
    if (clrGraze) clrGraze.textContent = '+' + grazeBonus.toLocaleString();
    if (clrSurv) clrSurv.textContent = '+' + survivalBonus.toLocaleString();
    if (clrTotal) clrTotal.textContent = totalScore.toLocaleString();

    if (this.clearScreen) this.clearScreen.classList.remove('hidden');
  }

  _updateHiscoreDisplay() {
    if (this.hudHiscore) {
      this.hudHiscore.textContent = String(this.hiscore).padStart(8, '0');
    }
  }

  // ワールドコンテキスト（各マネージャーに渡すアダプタ）
  getWorldContext() {
    return {
      width: this.width,
      height: this.height,
      player: this.player,
      audio: this.audio,
      particles: this.particles,
      bullets: this.bullets,
      danmaku: this.bullets,
      fireBullet: (spec) => {
        if (this.bullets.spawnEnemyBullet) return this.bullets.spawnEnemyBullet(spec);
        if (this.bullets.spawn) return this.bullets.spawn(spec);
        if (this.bullets.add) return this.bullets.add(spec);
      },
      clearBullets: (toItems = true) => {
        let items = [];
        if (this.bullets.clearBullets) items = this.bullets.clearBullets(toItems);
        else if (this.bullets.clearEnemyBullets) items = this.bullets.clearEnemyBullets({ toItems });
        if (toItems && Array.isArray(items)) {
          for (const pt of items) {
            if (this.enemies.addItem) this.enemies.addItem('score', pt.x, pt.y);
          }
        }
      },
      addScore: (n) => {
        this.player.score = (this.player.score || 0) + n;
      },
      collectItem: (type, item) => {
        this._applyItem(type);
      },
      shake: (amt) => {
        this.screenShake = Math.max(this.screenShake, amt);
      }
    };
  }

  _applyItem(type) {
    if (this.audio && this.audio.playItem) this.audio.playItem();
    switch (type) {
      case 'power':
        this.player.power = Math.min(100, (this.player.power || 0) + 10);
        this.player.score = (this.player.score || 0) + 500;
        break;
      case 'score':
        this.player.score = (this.player.score || 0) + 5000;
        break;
      case 'bomb':
        this.player.bombs = Math.min(5, (this.player.bombs || 0) + 1);
        this.player.score = (this.player.score || 0) + 10000;
        break;
      case 'life':
        this.player.lives = Math.min(5, (this.player.lives || 0) + 1);
        this.player.score = (this.player.score || 0) + 50000;
        break;
    }
    this.updateHUD();
  }

  update(dt) {
    // ポーズ入力
    if (this.input.consumePauseTrigger()) {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
      return;
    }

    if (this.state !== 'playing') {
      // 背景やパーティクルはタイトルやポーズ時もゆっくり動かす
      if (this.background) this.background.update(dt, 0.4);
      if (this.particles && this.particles.update) this.particles.update(dt * 0.5);
      return;
    }

    this.stageTime += dt;

    // 画面揺れ減衰
    if (this.screenShake > 0) {
      this.screenShake = Math.max(0, this.screenShake - dt * 25);
    }

    // 1. 入力処理
    const delta = this.input.consumeDelta();
    const kbVec = this.input.getKeyboardVector();
    const slow = this.input.slowMode;
    const speed = slow ? 180 : 340;

    if (delta.x !== 0 || delta.y !== 0) {
      // タッチ・マウス相対移動
      this.player.x += delta.x;
      this.player.y += delta.y;
    }
    if (kbVec.dx !== 0 || kbVec.dy !== 0) {
      // キーボード移動
      this.player.x += kbVec.dx * speed * dt;
      this.player.y += kbVec.dy * speed * dt;
    }

    // 画面内クランプ
    const pad = 16;
    this.player.x = Math.max(pad, Math.min(this.width - pad, this.player.x));
    this.player.y = Math.max(pad + 20, Math.min(this.height - pad, this.player.y));

    // ボムトリガー
    if (this.input.consumeBombTrigger()) {
      if ((this.player.bombs || 0) > 0) {
        this.player.bombs--;
        this.player.invincibleTimer = 3.5;
        this.screenShake = 18;
        if (this.audio && this.audio.playBomb) this.audio.playBomb();
        if (this.particles.createBombWave) this.particles.createBombWave(this.player.x, this.player.y, 200);

        // 消弾＆全敵大ダメージ
        let items = [];
        if (this.bullets.clearBullets) items = this.bullets.clearBullets(true);
        else if (this.bullets.clearEnemyBullets) items = this.bullets.clearEnemyBullets({ toItems: true, fromBomb: true });
        if (Array.isArray(items)) {
          for (const pt of items) {
            if (this.enemies.addItem) this.enemies.addItem('score', pt.x, pt.y);
          }
        }

        if (this.enemies.damageAll) this.enemies.damageAll(300);
        this.updateHUD();
      }
    }

    // 自機ショット発射
    if (this.input.fireHeld) {
      this._firePlayerBullets(dt);
    }

    // 自機更新
    if (this.player.update) {
      this.player.update(dt, this.input);
    }

    // 推進炎エフェクト
    if (this.particles.createThruster && Math.random() < 0.6) {
      this.particles.createThruster(this.player.x, this.player.y + 14);
    }

    // 2. ステージ・敵の進行
    this._updateStageProgression(dt);

    // 3. ワールド更新
    const world = this.getWorldContext();
    if (this.enemies.update) this.enemies.update(dt, world);
    if (this.bullets.update) this.bullets.update(dt);
    if (this.particles.update) this.particles.update(dt);
    if (this.background) this.background.update(dt, 1.0);

    // 4. 衝突判定・グレイズ判定
    this._handleCollisions();

    // 5. HUD更新
    this.updateHUD();
  }

  _firePlayerBullets(dt) {
    if (!this.player.shotCooldown) this.player.shotCooldown = 0;
    this.player.shotCooldown -= dt;
    if (this.player.shotCooldown > 0) return;

    this.player.shotCooldown = 0.085; // 発射間隔約12発/秒
    if (this.audio && this.audio.playShoot) this.audio.playShoot();

    const px = this.player.x;
    const py = this.player.y - 12;
    const pwr = this.player.power || 0;

    const spawn = (x, y, vx, vy, dmg = 10, color = '#38bdf8') => {
      const spec = { x, y, vx, vy, speed: 850, angle: Math.atan2(vy, vx), damage: dmg, color, shape: 'needle', owner: 'player' };
      if (this.bullets.spawnPlayerBullet) this.bullets.spawnPlayerBullet(spec);
      else if (this.bullets.addPlayerBullet) this.bullets.addPlayerBullet(spec);
      else if (this.player.bullets) this.player.bullets.push(spec);
    };

    // パワーに応じたショット形態
    if (pwr < 20) {
      // 単発
      spawn(px, py, 0, -850, 12);
    } else if (pwr < 50) {
      // 2連
      spawn(px - 8, py, 0, -850, 11);
      spawn(px + 8, py, 0, -850, 11);
    } else if (pwr < 80) {
      // 3連 + 拡散
      spawn(px - 10, py, -60, -840, 10);
      spawn(px, py - 4, 0, -850, 14);
      spawn(px + 10, py, 60, -840, 10);
    } else {
      // 5連フルパワーワイド
      spawn(px, py - 6, 0, -870, 15);
      spawn(px - 10, py - 2, -50, -850, 11);
      spawn(px + 10, py - 2, 50, -850, 11);
      spawn(px - 22, py, -160, -820, 10, '#c084fc');
      spawn(px + 22, py, 160, -820, 10, '#c084fc');
    }
  }

  _updateStageProgression(dt) {
    const t = this.stageTime;
    const world = this.getWorldContext();

    // ウェーブ1 (t = 2s): Scout編隊 左
    if (t >= 2.0 && !this.waveSpawned.has(1)) {
      this.waveSpawned.add(1);
      if (this.enemies.spawnWave) this.enemies.spawnWave('scout_left', world);
    }
    // ウェーブ2 (t = 6s): Scout編隊 右
    if (t >= 6.0 && !this.waveSpawned.has(2)) {
      this.waveSpawned.add(2);
      if (this.enemies.spawnWave) this.enemies.spawnWave('scout_right', world);
    }
    // ウェーブ3 (t = 11s): Fairy妖精中隊（3way弾）
    if (t >= 11.0 && !this.waveSpawned.has(3)) {
      this.waveSpawned.add(3);
      if (this.enemies.spawnWave) this.enemies.spawnWave('fairy_squad', world);
    }
    // ウェーブ4 (t = 17s): 中型Tank機 + 護衛
    if (t >= 17.0 && !this.waveSpawned.has(4)) {
      this.waveSpawned.add(4);
      if (this.enemies.spawnWave) this.enemies.spawnWave('tank_formation', world);
    }
    // ウェーブ5 (t = 25s): 突撃Scout大編隊
    if (t >= 25.0 && !this.waveSpawned.has(5)) {
      this.waveSpawned.add(5);
      if (this.enemies.spawnWave) this.enemies.spawnWave('scout_swarm', world);
    }
    // ボスアラート (t = 32s)
    if (t >= 32.0 && !this.waveSpawned.has('alert')) {
      this.waveSpawned.add('alert');
      if (this.audio && this.audio.playWarning) this.audio.playWarning();
      if (this.audio && this.audio.startBgm) this.audio.startBgm('boss');
    }
    // ボス出現 (t = 34s)
    if (t >= 34.0 && !this.waveSpawned.has('boss')) {
      this.waveSpawned.add('boss');
      if (this.enemies.spawnBoss) this.enemies.spawnBoss(world);
      if (this.bossHud) this.bossHud.style.display = 'block';
    }

    // ボス撃破監視
    const boss = this.enemies.boss || (this.enemies.getBoss ? this.enemies.getBoss() : null);
    if (this.waveSpawned.has('boss')) {
      if (boss && boss.active) {
        if (this.bossBarInner && boss.maxHp) {
          const ratio = Math.max(0, Math.min(1, boss.hp / boss.maxHp));
          this.bossBarInner.style.width = `${ratio * 100}%`;
        }
        if (this.bossName) {
          this.bossName.textContent = boss.name || `CHRONO WEAVER - PHASE ${boss.phase || 1}`;
        }
      } else if (boss && boss.defeated && this.state === 'playing') {
        this.stageClear();
      }
    }
  }

  _handleCollisions() {
    const px = this.player.x;
    const py = this.player.y;
    const pHitR = this.player.hitboxRadius || 3.5;
    const pGrazeR = this.player.grazeRadius || 20;
    const isInvincible = (this.player.invincibleTimer || 0) > 0;

    // 1. 敵弾と自機（当たり判定 & グレイズ）
    const enemyBullets = this.bullets.enemyBullets || (this.bullets.getEnemyBullets ? this.bullets.getEnemyBullets() : []);
    for (let i = 0; i < enemyBullets.length; i++) {
      const b = enemyBullets[i];
      if (!b.active) continue;

      const dx = b.x - px;
      const dy = b.y - py;
      const distSq = dx * dx + dy * dy;
      const bR = b.radius || b.hitboxRadius || 4;

      // 被弾判定
      const hitDist = pHitR + bR;
      if (distSq <= hitDist * hitDist) {
        if (!isInvincible) {
          b.active = false;
          this._playerHit();
          break;
        }
      } else {
        // グレイズ判定
        const grazeDist = pGrazeR + bR;
        if (!b.grazed && distSq <= grazeDist * grazeDist) {
          b.grazed = true;
          this.player.graze = (this.player.graze || 0) + 1;
          this.player.score = (this.player.score || 0) + 100;
          if (this.audio && this.audio.playGraze) this.audio.playGraze();
          if (this.particles.createGrazeSpark) this.particles.createGrazeSpark(b.x, b.y);
        }
      }
    }

    // 2. 自機弾と敵
    const playerBullets = this.bullets.playerBullets || (this.bullets.getPlayerBullets ? this.bullets.getPlayerBullets() : this.player.bullets || []);
    const enemyList = this.enemies.enemies || (this.enemies.getEnemies ? this.enemies.getEnemies() : []);
    const boss = this.enemies.boss || (this.enemies.getBoss ? this.enemies.getBoss() : null);

    for (let i = 0; i < playerBullets.length; i++) {
      const pb = playerBullets[i];
      if (!pb.active && pb.active !== undefined) continue;

      // ザコ敵との判定
      for (let j = 0; j < enemyList.length; j++) {
        const en = enemyList[j];
        if (!en.active) continue;

        const edx = pb.x - en.x;
        const edy = pb.y - en.y;
        const er = en.radius || 18;
        if (edx * edx + edy * edy <= er * er) {
          pb.active = false;
          en.hp -= pb.damage || 10;
          en.flashTimer = 0.08;
          if (this.audio && this.audio.playHit) this.audio.playHit();
          if (this.particles.createSpark) this.particles.createSpark(pb.x, pb.y, 4, '#38bdf8');
          break;
        }
      }

      // ボスとの判定
      if (boss && boss.active && (!pb.active === false)) {
        const bdx = pb.x - boss.x;
        const bdy = pb.y - boss.y;
        const br = boss.radius || 36;
        if (bdx * bdx + bdy * bdy <= br * br) {
          pb.active = false;
          boss.hp -= pb.damage || 10;
          boss.flashTimer = 0.08;
          if (this.audio && this.audio.playHit) this.audio.playHit();
          if (this.particles.createSpark) this.particles.createSpark(pb.x, pb.y, 4, '#f43f5e');
        }
      }
    }

    // 3. 自機とアイテムの回収
    const items = this.enemies.items || (this.enemies.getItems ? this.enemies.getItems() : []);
    const isPOC = py < this.height * 0.28; // 画面上部28%以上でオート全回収ライン (POC)

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.active) continue;

      const idx = px - it.x;
      const idy = py - it.y;
      const dist = Math.sqrt(idx * idx + idy * idy);

      // 自動吸引
      if (isPOC || dist < 120) {
        const pullSpeed = 500;
        it.x += (idx / dist) * pullSpeed * 0.016;
        it.y += (idy / dist) * pullSpeed * 0.016;
      }

      // 取得判定
      if (dist < 26) {
        it.active = false;
        this._applyItem(it.type || 'score');
        if (this.particles.createItemAbsorb) this.particles.createItemAbsorb(it.x, it.y, px, py);
      }
    }
  }

  _playerHit() {
    this.player.lives = (this.player.lives || 3) - 1;
    this.screenShake = 22;

    if (this.particles.createExplosion) {
      this.particles.createExplosion(this.player.x, this.player.y, 40, '#f43f5e', 380);
    }

    if (this.player.lives < 0) {
      this.gameOver();
    } else {
      // 復活・無敵付与
      if (this.audio && this.audio.playPlayerDeath) this.audio.playPlayerDeath();
      this.player.x = this.width / 2;
      this.player.y = this.height * 0.82;
      this.player.invincibleTimer = 3.0;
      this.player.bombs = Math.max(3, this.player.bombs || 0); // 復活時ボム補充
      // 被弾消弾
      if (this.bullets.clearBullets) this.bullets.clearBullets(true);
      else if (this.bullets.clearEnemyBullets) this.bullets.clearEnemyBullets({ toItems: true });
    }
    this.updateHUD();
  }

  updateHUD() {
    if (this.hudScore) {
      this.hudScore.textContent = String(this.player.score || 0).padStart(8, '0');
    }
    if (this.hudLives) {
      const count = Math.max(0, this.player.lives || 0);
      this.hudLives.textContent = '❤️ '.repeat(count).trim() || 'DEAD';
    }
    if (this.hudBombs) {
      const count = Math.max(0, this.player.bombs || 0);
      this.hudBombs.textContent = '💣 '.repeat(count).trim() || 'NONE';
    }
    if (this.touchBombCount) {
      this.touchBombCount.textContent = `x${Math.max(0, this.player.bombs || 0)}`;
    }
    if (this.hudGraze) {
      this.hudGraze.textContent = String(this.player.graze || 0);
    }
    if (this.hudPower) {
      const p = (this.player.power || 0) / 100 * 4 + 1;
      this.hudPower.textContent = p.toFixed(2);
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.save();

    // 画面揺れ演出
    if (this.screenShake > 0) {
      const shakeX = (Math.random() - 0.5) * this.screenShake;
      const shakeY = (Math.random() - 0.5) * this.screenShake;
      ctx.translate(shakeX, shakeY);
    }

    // 1. 背景描画
    if (this.background) {
      this.background.draw(ctx);
    } else {
      ctx.fillStyle = '#050510';
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // 2. アイテム描画
    if (this.enemies.drawItems) this.enemies.drawItems(ctx);

    // 3. 敵・ボス描画
    if (this.enemies.draw) this.enemies.draw(ctx);
    else if (this.enemies.render) this.enemies.render(ctx);

    // 4. 自機描画
    if (this.player.draw) this.player.draw(ctx);
    else if (this.player.render) this.player.render(ctx);

    // 5. 弾幕（自機弾・敵弾）描画
    if (this.bullets.draw) this.bullets.draw(ctx);
    else if (this.bullets.render) this.bullets.render(ctx);

    // 6. パーティクル描画
    if (this.particles.render) this.particles.render(ctx);
    else if (this.particles.draw) this.particles.draw(ctx);

    // ボス警告バナー（Warning!）
    if (this.stageTime >= 32.0 && this.stageTime <= 34.5) {
      this._drawWarningBanner(ctx);
    }

    ctx.restore();
  }

  _drawWarningBanner(ctx) {
    ctx.save();
    ctx.fillStyle = 'rgba(239, 68, 68, 0.25)';
    ctx.fillRect(0, this.height * 0.42, this.width, 70);

    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, this.height * 0.42, this.width, 70);

    ctx.fillStyle = '#fca5a5';
    ctx.font = 'bold 24px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#ef4444';
    ctx.shadowBlur = 15;
    ctx.fillText('⚠️ WARNING: BOSS APPROACHING ⚠️', this.width / 2, this.height * 0.42 + 35);
    ctx.restore();
  }
}
