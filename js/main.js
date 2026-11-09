/**
 * main.js - エントリーポイント
 * キャンバスリサイズ、UIイベント、AudioContextのアンロック、メインループ起動
 */

import { AudioManager } from './audio.js';
import { InputManager } from './input.js';
import { Background } from './background.js';
import { Game } from './game.js';

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('gameCanvas');
  const appContainer = document.getElementById('app-container');

  // キャンバスの内部解像度（縦画面STGの黄金比 480 x 720）
  const GAME_WIDTH = 480;
  const GAME_HEIGHT = 720;
  canvas.width = GAME_WIDTH;
  canvas.height = GAME_HEIGHT;

  // 各マネージャーの初期化
  const audio = new AudioManager();
  const input = new InputManager(canvas);
  const background = new Background(GAME_WIDTH, GAME_HEIGHT);
  const game = new Game({ canvas, audio, input, background, width: GAME_WIDTH, height: GAME_HEIGHT });

  // サウンド切替ボタン
  const soundBtn = document.getElementById('btn-sound-toggle');
  if (soundBtn) {
    soundBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      audio.init();
      const isMuted = audio.toggleMute ? audio.toggleMute() : false;
      soundBtn.textContent = isMuted ? '🔇' : '🔊';
      soundBtn.style.opacity = isMuted ? '0.6' : '1.0';
    });
  }

  // 初回ユーザー操作でAudioContextをアンロック
  const unlockAudio = () => {
    audio.init();
    window.removeEventListener('touchstart', unlockAudio);
    window.removeEventListener('mousedown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
  window.addEventListener('touchstart', unlockAudio, { passive: true });
  window.addEventListener('mousedown', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio, { passive: true });

  // UI画面のボタン操作
  const titleScreen = document.getElementById('title-screen');
  const pauseScreen = document.getElementById('pause-screen');
  const gameoverScreen = document.getElementById('gameover-screen');
  const clearScreen = document.getElementById('clear-screen');

  const btnStart = document.getElementById('btn-start');
  if (btnStart) {
    btnStart.addEventListener('click', () => {
      audio.init();
      titleScreen.classList.add('hidden');
      game.start();
    });
  }

  const btnResume = document.getElementById('btn-resume');
  if (btnResume) {
    btnResume.addEventListener('click', () => {
      pauseScreen.classList.add('hidden');
      game.resume();
    });
  }

  const btnRestartPause = document.getElementById('btn-restart-pause');
  if (btnRestartPause) {
    btnRestartPause.addEventListener('click', () => {
      pauseScreen.classList.add('hidden');
      game.start();
    });
  }

  const btnRetry = document.getElementById('btn-retry');
  if (btnRetry) {
    btnRetry.addEventListener('click', () => {
      gameoverScreen.classList.add('hidden');
      game.start();
    });
  }

  const btnTitleGo = document.getElementById('btn-title-go');
  if (btnTitleGo) {
    btnTitleGo.addEventListener('click', () => {
      gameoverScreen.classList.add('hidden');
      titleScreen.classList.remove('hidden');
      game.stop();
    });
  }

  const btnClearRetry = document.getElementById('btn-clear-retry');
  if (btnClearRetry) {
    btnClearRetry.addEventListener('click', () => {
      clearScreen.classList.add('hidden');
      game.start();
    });
  }

  // 画面リサイズ / ビューポート調整
  function handleResize() {
    // 100dvh 対応
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
  }
  window.addEventListener('resize', handleResize);
  window.addEventListener('orientationchange', handleResize);
  handleResize();

  // ゲームループの起動
  let lastTime = performance.now();
  function gameLoop(currentTime) {
    const dt = Math.min((currentTime - lastTime) / 1000, 0.1); // 最大100msでクランプ
    lastTime = currentTime;

    game.update(dt);
    game.draw();

    requestAnimationFrame(gameLoop);
  }
  requestAnimationFrame(gameLoop);
});
