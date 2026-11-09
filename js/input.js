/**
 * input.js - スマホタッチ・PCキーボード・マウスの統合入力管理
 * スマホ最優先: 相対ドラッグ追従（指で自機が隠れない）、マルチタッチ対応、誤操作完全抑止
 */

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;

    // キーボード状態
    this.keys = {};

    // 移動デルタ（相対移動量: フレームごとに自機に加算されリセット）
    this.moveDelta = { x: 0, y: 0 };

    // スムーズ追従用（マウス/タッチ直接位置追従モード用）
    this.pointerPos = null;

    // タッチトラッキング
    this.activeTouches = new Map(); // identifier -> { startX, startY, lastX, lastY, isMoveTouch }
    this.moveTouchId = null;

    // アクションフラグ
    this.bombTriggered = false;
    this.slowMode = false;
    this.fireHeld = true; // デフォルトで自動ショットON
    this.pauseTriggered = false;

    // 感度設定（1.0〜2.0、スマホの画面サイズに合わせて調整可能）
    this.touchSensitivity = 1.25;

    this._setupListeners();
  }

  _setupListeners() {
    // --- キーボードイベント ---
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
      if (e.code === 'KeyX' || e.code === 'Space') {
        this.bombTriggered = true;
      }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.slowMode = true;
      }
      if (e.code === 'KeyP' || e.code === 'Escape') {
        this.pauseTriggered = true;
      }
    }, { passive: false });

    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        this.slowMode = false;
      }
    });

    // --- マウス操作（ドラッグによる相対移動） ---
    let isMouseDown = false;
    let lastMouseX = 0;
    let lastMouseY = 0;

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) { // 左クリック
        isMouseDown = true;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
      } else if (e.button === 2) { // 右クリックでボム
        this.bombTriggered = true;
        e.preventDefault();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!isMouseDown) return;
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;

      const dx = (e.clientX - lastMouseX) * scaleX;
      const dy = (e.clientY - lastMouseY) * scaleY;

      this.moveDelta.x += dx;
      this.moveDelta.y += dy;

      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    });

    window.addEventListener('mouseup', () => {
      isMouseDown = false;
    });

    // 右クリックメニューの抑止
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // --- タッチ操作（相対ドラッグ＆マルチタッチ） ---
    this.canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;

      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        const touchData = {
          startX: touch.clientX,
          startY: touch.clientY,
          lastX: touch.clientX,
          lastY: touch.clientY,
          gameX: (touch.clientX - rect.left) * scaleX,
          gameY: (touch.clientY - rect.top) * scaleY
        };
        this.activeTouches.set(touch.identifier, touchData);

        // 最初の移動タッチとして登録
        if (this.moveTouchId === null) {
          this.moveTouchId = touch.identifier;
        }
      }
    }, { passive: false });

    this.canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;

      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier === this.moveTouchId) {
          const prev = this.activeTouches.get(touch.identifier);
          if (prev) {
            const dx = (touch.clientX - prev.lastX) * scaleX * this.touchSensitivity;
            const dy = (touch.clientY - prev.lastY) * scaleY * this.touchSensitivity;

            this.moveDelta.x += dx;
            this.moveDelta.y += dy;

            prev.lastX = touch.clientX;
            prev.lastY = touch.clientY;
            prev.gameX = (touch.clientX - rect.left) * scaleX;
            prev.gameY = (touch.clientY - rect.top) * scaleY;
          }
        }
      }
    }, { passive: false });

    const handleTouchEnd = (e) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        this.activeTouches.delete(touch.identifier);
        if (touch.identifier === this.moveTouchId) {
          this.moveTouchId = null;
          // まだ他の指が触れていればそれを移動タッチに切り替え
          if (this.activeTouches.size > 0) {
            const nextKey = this.activeTouches.keys().next().value;
            this.moveTouchId = nextKey;
            const nextTouch = this.activeTouches.get(nextKey);
            if (nextTouch) {
              // 基準位置をリセットして急激なジャンプを防ぐ
              nextTouch.lastX = nextTouch.startX;
              nextTouch.lastY = nextTouch.startY;
            }
          }
        }
      }
    };

    this.canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
    this.canvas.addEventListener('touchcancel', handleTouchEnd, { passive: false });

    // HTML上のボム・低速ボタンとのバインド
    const bombBtn = document.getElementById('btn-bomb');
    if (bombBtn) {
      const triggerBomb = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.bombTriggered = true;
        bombBtn.classList.add('pressed');
        setTimeout(() => bombBtn.classList.remove('pressed'), 120);
      };
      bombBtn.addEventListener('touchstart', triggerBomb, { passive: false });
      bombBtn.addEventListener('click', triggerBomb);
    }

    const slowBtn = document.getElementById('btn-slow');
    if (slowBtn) {
      const toggleSlow = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.slowMode = !this.slowMode;
        if (this.slowMode) {
          slowBtn.classList.add('active');
        } else {
          slowBtn.classList.remove('active');
        }
      };
      slowBtn.addEventListener('touchstart', toggleSlow, { passive: false });
      slowBtn.addEventListener('click', toggleSlow);
    }
  }

  // 1フレームの終わりに移動デルタやワンショットフラグを消費
  consumeDelta() {
    const delta = { x: this.moveDelta.x, y: this.moveDelta.y };
    this.moveDelta.x = 0;
    this.moveDelta.y = 0;
    return delta;
  }

  consumeBombTrigger() {
    const val = this.bombTriggered;
    this.bombTriggered = false;
    return val;
  }

  consumePauseTrigger() {
    const val = this.pauseTriggered;
    this.pauseTriggered = false;
    return val;
  }

  // キーボード移動ベクトル（正規化）
  getKeyboardVector() {
    let dx = 0;
    let dy = 0;
    if (this.keys['ArrowLeft'] || this.keys['KeyA']) dx -= 1;
    if (this.keys['ArrowRight'] || this.keys['KeyD']) dx += 1;
    if (this.keys['ArrowUp'] || this.keys['KeyW']) dy -= 1;
    if (this.keys['ArrowDown'] || this.keys['KeyS']) dy += 1;

    if (dx !== 0 && dy !== 0) {
      const invLen = 1 / Math.SQRT2;
      dx *= invLen;
      dy *= invLen;
    }
    return { dx, dy };
  }
}
