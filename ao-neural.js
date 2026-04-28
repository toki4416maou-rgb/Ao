/*!
 * ao-neural.js  v1.0
 *
 * 脳波アニメ（内部状態の波形）を OffscreenCanvas + Worker で完全分離。
 * メインスレッドが保存・学習・UI更新で何をしていても脳波は止まらない。
 *
 * 仕組み:
 *   メインスレッド: canvas.transferControlToOffscreen() で Canvas を Worker に渡す
 *                  100ms ごとに ao の状態値だけ Worker に送る
 *   Worker:        受け取った状態値で自分の RAF ループを回して描画し続ける
 *
 * 追加方法:
 *   <script src="ao-neural.js"></script>  ← ao-worker.js の直後に追加
 *
 * OffscreenCanvas 非対応ブラウザ（Safari 16以前など）は自動フォールバック。
 * その場合は元の initNeural() がそのまま動く。
 */

// ================================================================
// ① Worker コンテキスト（描画側）
// ================================================================
if (typeof window === 'undefined') {

    let _canvas = null;
    let _ctx    = null;
    let _W = 300, _H = 100;
    let _rafId  = null;
    let _time   = 0;
    let _lastTs = null;

    // 受け取った状態（メインスレッドから100msごとに更新）
    let _state = {
        curiosity:   0.5,
        tension:     0.3,
        avgDepth:    0.0,
        processing:  false,
        saving:      false   // 保存中フラグ（波形を少し荒くして表現）
    };

    // パーティクル（Worker内で初期化）
    let _particles = [];
    function _initParticles() {
        _particles = [];
        for (let i = 0; i < 25; i++) {
            _particles.push({
                x:  Math.random() * _W,
                y:  Math.random() * _H,
                vx: (Math.random() - 0.5) * 0.3,
                vy: (Math.random() - 0.5) * 0.3,
                r:  Math.random() * 1.5 + 0.5
            });
        }
    }

    function _animate(ts) {
        if (!_ctx) return;

        if (_lastTs === null) _lastTs = ts;
        const dt = Math.min((ts - _lastTs) / 1000, 0.1);
        _lastTs = ts;
        _time  += dt * 3;

        const { curiosity, tension, avgDepth, processing, saving } = _state;
        const arousal    = 0.5 + curiosity * 0.3;
        const tensionMod = tension * 0.5;

        // 背景（残像効果）
        _ctx.fillStyle = 'rgba(10, 10, 20, 0.15)';
        _ctx.fillRect(0, 0, _W, _H);

        // ── メイン波形（青・常時）──
        _ctx.strokeStyle = 'rgba(100, 200, 255, 0.4)';
        _ctx.lineWidth = 2;
        _ctx.beginPath();
        for (let x = 0; x < _W; x += 3) {
            const wave = Math.sin(_time * 0.3 + x * 0.02) * arousal * 15;
            // 保存中は少しノイズを乗せて「負荷中」を表現
            const noise = saving ? (Math.random() - 0.5) * 3 : 0;
            const y = _H / 2 + wave + noise;
            x === 0 ? _ctx.moveTo(x, y) : _ctx.lineTo(x, y);
        }
        _ctx.stroke();

        // ── 処理中波形（水色）──
        if (processing) {
            _ctx.strokeStyle = 'rgba(96, 165, 250, 0.6)';
            _ctx.lineWidth = 2;
            _ctx.beginPath();
            for (let x = 0; x < _W; x += 2) {
                const dlWave = Math.sin(_time * 1.2 + x * 0.05) * 10;
                const y = _H / 2 + dlWave;
                x === 0 ? _ctx.moveTo(x, y) : _ctx.lineTo(x, y);
            }
            _ctx.stroke();
        }

        // ── 緊張波形（橙）──
        if (tensionMod > 0.3) {
            _ctx.strokeStyle = `rgba(245, 158, 11, ${tensionMod})`;
            _ctx.lineWidth = 1.5;
            _ctx.beginPath();
            for (let x = 0; x < _W; x += 2) {
                const tensionWave = Math.sin(_time * 0.7 + x * 0.04) * tensionMod * 12;
                const y = _H / 2 + tensionWave;
                x === 0 ? _ctx.moveTo(x, y) : _ctx.lineTo(x, y);
            }
            _ctx.stroke();
        }

        // ── 成長波形（緑）──
        if (avgDepth > 0.3) {
            _ctx.strokeStyle = `rgba(16, 185, 129, ${0.6 * avgDepth})`;
            _ctx.lineWidth = 2;
            _ctx.beginPath();
            for (let x = 0; x < _W; x += 2) {
                const depthWave = Math.sin(_time * 0.5 + x * 0.03) * avgDepth * 20;
                const y = _H / 2 + depthWave;
                x === 0 ? _ctx.moveTo(x, y) : _ctx.lineTo(x, y);
            }
            _ctx.stroke();
        }

        // ── パーティクル（紫）──
        _ctx.strokeStyle = 'rgba(192, 132, 252, 0.15)';
        _ctx.lineWidth = 0.5;
        _particles.forEach((p, i) => {
            p.x += p.vx * arousal;
            p.y += p.vy * arousal;
            if (p.x < 0 || p.x > _W) p.vx *= -1;
            if (p.y < 0 || p.y > _H) p.vy *= -1;

            _particles.forEach((p2, j) => {
                if (i >= j) return;
                const dx = p.x - p2.x, dy = p.y - p2.y;
                if (dx * dx + dy * dy < 6400) { // 80px²
                    _ctx.beginPath();
                    _ctx.moveTo(p.x, p.y);
                    _ctx.lineTo(p2.x, p2.y);
                    _ctx.stroke();
                }
            });

            _ctx.fillStyle = 'rgba(192, 132, 252, 0.8)';
            _ctx.beginPath();
            _ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            _ctx.fill();
        });

        _rafId = self.requestAnimationFrame(_animate);
    }

    self.onmessage = function (e) {
        const { type } = e.data;

        // ── Canvas 受け取り（初回）──
        if (type === 'init') {
            _canvas = e.data.canvas;  // transferredなOffscreenCanvas
            _W      = e.data.width  || 300;
            _H      = e.data.height || 100;
            _ctx    = _canvas.getContext('2d');
            _initParticles();
            if (_rafId) self.cancelAnimationFrame(_rafId);
            _rafId = self.requestAnimationFrame(_animate);
            return;
        }

        // ── サイズ変更 ──
        if (type === 'resize') {
            _W = e.data.width;
            _H = e.data.height;
            if (_canvas) {
                _canvas.width  = _W;
                _canvas.height = _H;
            }
            _initParticles();
            return;
        }

        // ── 状態更新（メインスレッドから100msごと）──
        if (type === 'state') {
            _state = { ..._state, ...e.data.state };
            return;
        }

        // ── 停止・再開（タブ非表示時）──
        if (type === 'pause') {
            if (_rafId) { self.cancelAnimationFrame(_rafId); _rafId = null; }
            _lastTs = null;
            return;
        }
        if (type === 'resume') {
            if (!_rafId) _rafId = self.requestAnimationFrame(_animate);
            return;
        }
    };

} // ================================================================
// ② メインスレッドコンテキスト
// ================================================================
else {
(function () {
'use strict';

// OffscreenCanvas 対応チェック
const supported = typeof OffscreenCanvas !== 'undefined'
    && typeof Worker !== 'undefined';

if (!supported) {
    console.warn('[AoNeural] OffscreenCanvas 非対応 → 元のinitNeural()をそのまま使用');
    return;
}

let _worker  = null;
let _started = false;

// ── Worker 起動 ──
function _initWorker() {
    try {
        _worker = new Worker('ao-neural.js');
        _worker.onerror = e => console.error('[AoNeural] Worker error:', e.message);
        console.log('[AoNeural] Worker 起動完了');
        return true;
    } catch(e) {
        console.warn('[AoNeural] Worker 起動失敗:', e.message);
        return false;
    }
}

// ── initNeural() を乗っ取って OffscreenCanvas に差し替え ──
function _patchInitNeural() {
    // initNeural はグローバルスコープにある（DOMContentLoaded後に呼ばれる）
    // Ao本体の initNeural 呼び出しより先に差し替えておく
    const _origInitNeural = window.initNeural;

    window.initNeural = function () {
        const canvas = document.getElementById('neural');
        if (!canvas || !canvas.transferControlToOffscreen) {
            // OffscreenCanvas 非対応の canvas → 元の実装へ
            console.warn('[AoNeural] transferControlToOffscreen 非対応 → フォールバック');
            return _origInitNeural ? _origInitNeural() : null;
        }

        try {
            const dpr  = window.devicePixelRatio || 1;
            const cssW = canvas.clientWidth  || canvas.parentElement?.clientWidth || 300;
            const cssH = canvas.clientHeight || 100;
            canvas.width  = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);

            // Canvas の制御を Worker に転送（以後メインスレッドから描画不可）
            const offscreen = canvas.transferControlToOffscreen();
            _worker.postMessage(
                { type: 'init', canvas: offscreen, width: canvas.width, height: canvas.height },
                [offscreen]  // transferable
            );

            _started = true;
            console.log('[AoNeural] OffscreenCanvas Worker に転送完了');

            // ── サイズ変更監視 ──
            if (window.ResizeObserver) {
                new ResizeObserver(() => {
                    const dpr  = window.devicePixelRatio || 1;
                    const cssW = canvas.clientWidth || 300;
                    const cssH = canvas.clientHeight || 100;
                    _worker.postMessage({
                        type:   'resize',
                        width:  Math.round(cssW * dpr),
                        height: Math.round(cssH * dpr)
                    });
                }).observe(canvas);
            }

            // ── タブ非表示時に Worker の RAF を停止 ──
            document.addEventListener('visibilitychange', () => {
                if (!_worker) return;
                _worker.postMessage({ type: document.hidden ? 'pause' : 'resume' });
            });

        } catch(e) {
            console.warn('[AoNeural] OffscreenCanvas 転送失敗 → フォールバック:', e.message);
            return _origInitNeural ? _origInitNeural() : null;
        }
    };

    console.log('[AoNeural] initNeural() パッチ適用完了');
}

// ── 状態値を 100ms ごとに Worker に送る ──
function _startStateLoop() {
    // ao が来るまで待つ
    const poll = setInterval(() => {
        if (!window.ao || !_started) return;
        clearInterval(poll);

        // 保存中フラグを ao-worker.js と共有
        // ao.persistenceLayer.save がパッチ済みなら _isSaving を見る
        setInterval(() => {
            if (!_worker || !_started) return;
            const ao = window.ao;
            if (!ao) return;

            let processing = false;
            try {
                processing = !!(
                    ao.languageInputDL?.processing  ||
                    ao.languageOutputDL?.processing ||
                    ao.imageAdapter?.processing     ||
                    ao.audioAdapter?.processing     ||
                    ao.videoAdapter?.processing     ||
                    ao.videoGenerator?.processing
                );
            } catch(_) {}

            let avgDepth = 0;
            try {
                // getGrowth は ao-optimizer.js でキャッシュ済みなので軽い
                avgDepth = ao.concepts?.getGrowth?.()?.avgDepth || 0;
            } catch(_) {}

            _worker.postMessage({
                type: 'state',
                state: {
                    curiosity:  ao.state?.curiosity  ?? 0.5,
                    tension:    ao.state?.tension    ?? 0.3,
                    avgDepth,
                    processing,
                    saving: !!window._aoIsSaving   // ao-worker.js 側でセットするフラグ
                }
            });
        }, 100); // 100ms ごと（10fps で十分）

    }, 500);
}

// ── 保存中フラグ連携（ao-worker.js が _aoIsSaving をセットする想定）──
// ao-worker.js 側の persistenceLayer.save() の前後で
// window._aoIsSaving = true / false をセットしてもらう
// → 脳波がわずかにノイジーになって「保存中」を視覚表現できる

// ── 起動 ──
const ok = _initWorker();
if (ok) {
    // initNeural より前に差し替え（DOMContentLoaded前でも安全）
    _patchInitNeural();
    _startStateLoop();
}

window.aoNeural = ok ? { worker: _worker } : null;

})();
} // end main-thread context
