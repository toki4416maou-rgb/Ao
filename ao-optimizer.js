/**
 * ao-optimizer.js
 * Ao ランタイム最適化MOD
 * Optifine的なアプローチ：本体を変えずに処理を軽くする
 *
 * 機能：
 *   1. DOMキャッシュ       - getElementById の毎回検索をなくす
 *   2. RAFバッチ           - DOM書き込みを1フレームにまとめる
 *   3. Scheduler統合       - 500ms interval 3本→1本に統合
 *   4. メモize             - 同じ計算を繰り返さない
 *   5. IdleGC             - アイドル時に不要メモリをクリア
 *   6. チャット中フリーズ防止 - 処理の競合を回避
 */

(function() {
    'use strict';

    // ─── 最適化ログ ────────────────────────────────────────────
    const OPT = {
        version: '1.0.0',
        stats: {
            domCacheHits:    0,
            domCacheMisses:  0,
            rafBatched:      0,
            memoHits:        0,
            gcRuns:          0,
            schedulerTicks:  0,
            skippedHidden:   0,
        },
        log(msg) {
            if (window.globalLogManager) {
                window.globalLogManager.log(`[OPT] ${msg}`, 'info');
            } else {
                console.log(`[AoOptimizer] ${msg}`);
            }
        },
        report() {
            const s = OPT.stats;
            const hitRate = s.domCacheHits + s.domCacheMisses > 0
                ? ((s.domCacheHits / (s.domCacheHits + s.domCacheMisses)) * 100).toFixed(1)
                : 0;
            OPT.log(
                `DOM cache hit ${hitRate}% | RAF batched ${s.rafBatched} | ` +
                `memo hits ${s.memoHits} | GC ${s.gcRuns}回 | ` +
                `hidden skip ${s.skippedHidden}回`
            );
        }
    };

    // ─── 1. DOMキャッシュ ──────────────────────────────────────
    // getElementById を毎回DOMツリー検索するのを防ぎ、
    // 初回取得した要素を使い回す
    const DOMCache = {
        _cache: new Map(),

        get(id) {
            if (this._cache.has(id)) {
                // キャッシュにある場合でも要素がDOMから外れてないか確認
                const cached = this._cache.get(id);
                if (cached && cached.isConnected) {
                    OPT.stats.domCacheHits++;
                    return cached;
                }
                // 外れていたら再取得
                this._cache.delete(id);
            }
            OPT.stats.domCacheMisses++;
            const el = document.getElementById(id);
            if (el) this._cache.set(id, el);
            return el;
        },

        invalidate(id) {
            this._cache.delete(id);
        },

        clear() {
            this._cache.clear();
        }
    };

    // グローバルに公開（Ao本体からも使えるように）
    window.AoDOMCache = DOMCache;

    // ─── 2. RAFバッチライター ──────────────────────────────────
    // DOM への textContent / innerHTML 書き込みを
    // requestAnimationFrame でまとめて1フレームに集約する
    const RAFBatch = {
        _pending: new Map(), // id → { type, value }
        _scheduled: false,

        write(id, type, value) {
            this._pending.set(id, { type, value });
            if (!this._scheduled) {
                this._scheduled = true;
                requestAnimationFrame(() => this._flush());
            }
        },

        setText(id, text) {
            this.write(id, 'text', text);
        },

        setHTML(id, html) {
            this.write(id, 'html', html);
        },

        setStyle(id, prop, val) {
            this.write(id + ':' + prop, 'style:' + prop, val);
        },

        _flush() {
            this._scheduled = false;
            const count = this._pending.size;
            if (count === 0) return;

            for (const [id, { type, value }] of this._pending) {
                try {
                    if (type.startsWith('style:')) {
                        const prop = type.slice(6);
                        const realId = id.split(':')[0];
                        const el = DOMCache.get(realId);
                        if (el) el.style[prop] = value;
                    } else {
                        const el = DOMCache.get(id);
                        if (!el) continue;
                        if (type === 'text') el.textContent = value;
                        else if (type === 'html') el.innerHTML = value;
                    }
                } catch (e) { /* 静かに失敗 */ }
            }

            this._pending.clear();
            OPT.stats.rafBatched += count;
        }
    };

    window.AoRAFBatch = RAFBatch;

    // ─── 3. メモize ────────────────────────────────────────────
    // 同じ引数で何度も呼ばれる関数の結果をキャッシュ
    function memoize(fn, keyFn, maxSize = 100) {
        const cache = new Map();
        return function(...args) {
            const key = keyFn ? keyFn(...args) : JSON.stringify(args);
            if (cache.has(key)) {
                OPT.stats.memoHits++;
                return cache.get(key);
            }
            const result = fn.apply(this, args);
            if (cache.size >= maxSize) {
                // 古いものから削除（LRU的に）
                const firstKey = cache.keys().next().value;
                cache.delete(firstKey);
            }
            cache.set(key, result);
            return result;
        };
    }

    window.AoMemoize = memoize;

    // ─── 4. Schedulerパッチ ────────────────────────────────────
    // 500ms interval が複数並走しているのを1本に統合する
    // Aoの初期化完了後に実行
    const Scheduler = {
        _tasks: new Map(),    // name → fn
        _intervalId: null,
        _paused: false,
        _tickMs: 500,

        register(name, fn) {
            this._tasks.set(name, fn);
        },

        unregister(name) {
            this._tasks.delete(name);
        },

        pause() {
            this._paused = true;
        },

        resume() {
            this._paused = false;
        },

        start() {
            if (this._intervalId) return;
            this._intervalId = setInterval(() => this._tick(), this._tickMs);
            OPT.log(`Scheduler 起動 (${this._tickMs}ms / ${this._tasks.size}タスク統合)`);
        },

        stop() {
            if (this._intervalId) {
                clearInterval(this._intervalId);
                this._intervalId = null;
            }
        },

        _tick() {
            // 画面非表示中はスキップ
            if (document.hidden) {
                OPT.stats.skippedHidden++;
                return;
            }
            // チャット処理中はスキップ
            if (this._paused) return;

            OPT.stats.schedulerTicks++;
            for (const [name, fn] of this._tasks) {
                try {
                    fn();
                } catch (e) {
                    // タスクが死んでも他は継続
                    console.warn(`[AoOptimizer] Scheduler task "${name}" failed:`, e);
                }
            }
        }
    };

    window.AoScheduler = Scheduler;

    // ─── 5. IdleGC ─────────────────────────────────────────────
    // ブラウザがアイドル状態のときだけメモリ整理
    const IdleGC = {
        _targets: [], // { obj, keys }
        _lastRun: 0,
        _minInterval: 30000, // 最低30秒あける

        register(obj, keys) {
            this._targets.push({ obj, keys });
        },

        _run(deadline) {
            const now = Date.now();
            if (now - this._lastRun < this._minInterval) return;
            this._lastRun = now;

            let cleaned = 0;
            for (const { obj, keys } of this._targets) {
                if (deadline && deadline.timeRemaining() < 5) break;
                for (const key of keys) {
                    try {
                        if (obj[key] instanceof Map && obj[key].size > 500) {
                            // 古いエントリを半分削除
                            const entries = [...obj[key].entries()];
                            entries.slice(0, Math.floor(entries.length / 2))
                                   .forEach(([k]) => obj[key].delete(k));
                            cleaned++;
                        }
                    } catch (e) {}
                }
            }

            if (cleaned > 0) {
                OPT.stats.gcRuns++;
                OPT.log(`IdleGC: ${cleaned}個のMapを整理`);
            }
        },

        start() {
            if ('requestIdleCallback' in window) {
                const loop = (deadline) => {
                    this._run(deadline);
                    requestIdleCallback(loop, { timeout: 60000 });
                };
                requestIdleCallback(loop, { timeout: 60000 });
            } else {
                // フォールバック: 60秒ごと
                setInterval(() => this._run(null), 60000);
            }
        }
    };

    window.AoIdleGC = IdleGC;

    // ─── 6. チャット競合防止パッチ ─────────────────────────────
    // Aoのprocess()（チャット処理）の前後でSchedulerを一時停止
    function patchChatProcess(being) {
        if (!being || !being.process || being._optimizerPatched) return;

        const origProcess = being.process.bind(being);
        being.process = async function(...args) {
            Scheduler.pause();
            try {
                return await origProcess(...args);
            } finally {
                Scheduler.resume();
            }
        };
        being._optimizerPatched = true;
        OPT.log('チャット競合防止パッチ適用完了');
    }

    // ─── 7. Aoへのアタッチ ─────────────────────────────────────
    // Ao本体の初期化完了を待ってからアタッチ
    function attachOptimizer(being) {
        OPT.log(`v${OPT.version} アタッチ開始`);

        // --- 元のsetIntervalを殺す（二重実行防止）---
        const toKill = [
            '_aoIntervalUpdateUI',
            '_aoIntervalIdentityUI',
            '_aoIntervalDrift',
            '_aoIntervalAutonomousThought',
        ];
        toKill.forEach(key => {
            if (window[key]) {
                clearInterval(window[key]);
                window[key] = null;
                OPT.log(`元のsetInterval[${key}]を停止`);
            }
        });

        // --- Scheduler に既存の500ms処理を登録 ---
        // updateUI（window スコープに存在する）
        if (typeof updateUI === 'function') {
            Scheduler.register('updateUI', updateUI);
            OPT.log('updateUI → Schedulerに統合');
        }

        // _updateIdentityUI
        if (typeof _updateIdentityUI === 'function') {
            Scheduler.register('updateIdentityUI', _updateIdentityUI);
            OPT.log('_updateIdentityUI → Schedulerに統合');
        }

        // drift（5秒ごと → Schedulerで10tickに1回実行）
        if (typeof drift === 'function') {
            let _driftTick = 0;
            Scheduler.register('drift', () => {
                _driftTick++;
                if (_driftTick % 10 === 0) drift(); // 500ms×10 = 5秒相当
            });
            OPT.log('drift → Schedulerに統合');
        }

        // checkAutonomousThought（20秒ごと → 40tickに1回）
        if (typeof checkAutonomousThought === 'function') {
            let _autonomousTick = 0;
            Scheduler.register('autonomousThought', () => {
                _autonomousTick++;
                if (_autonomousTick % 40 === 0) checkAutonomousThought(); // 500ms×40 = 20秒相当
            });
            OPT.log('checkAutonomousThought → Schedulerに統合');
        }

        // SpatialInteractionModel の update
        if (being.spatialInteractionModel) {
            Scheduler.register('spatialUpdate', () => {
                try {
                    const result = being.spatialInteractionModel.update();
                    if (!result) return;
                    if (result.collisions.length > 0 || result.tensionLevel > 0.4) {
                        const ctx = being.spatialInteractionModel.getInferenceContext();
                        if (being.rawState) {
                            being.rawState.tension = Math.max(
                                being.rawState.tension || 0,
                                ctx.tensionLevel * 0.5
                            );
                        }
                    }
                    const el = DOMCache.get('simStatus');
                    if (el) {
                        RAFBatch.setText('simStatus',
                            `衝突:${result.collisions.length} 接近:${result.approaches.length} ` +
                            `緊張:${(result.tensionLevel * 100).toFixed(0)}%`
                        );
                    }
                } catch(e) {}
            });
            OPT.log('SpatialInteractionModel.update → Schedulerに統合');
        }

        // MissingPieces の UI更新（2500ms → Schedulerに統合）
        // 既存の2500msインターバルより頻度は上がるが統合で軽くなる
        Scheduler.register('missingPiecesUI', () => {
            try {
                const hch = being.hierarchicalChunker;
                const hEl = DOMCache.get('hchStatus');
                if (hch && hEl) {
                    RAFBatch.setText('hchStatus',
                        `L1:${hch.vocabs[1].size}語 L2:${hch.vocabs[2].size}句 L3:${hch.vocabs[3].size}単位`
                    );
                }
                const ue  = being.uncertaintyEstimator;
                const uEl = DOMCache.get('ueStatus');
                if (ue && uEl) {
                    const rc = ue.recentConfidence(10);
                    RAFBatch.setText('ueStatus',
                        `確信度:${(rc * 100).toFixed(0)}% エントロピー:${(ue._avgEntropy * 100).toFixed(0)}% ` +
                        `不明:${ue.unknownCount}件 確信:${ue.knownCount}件`
                    );
                    RAFBatch.setStyle('ueBarFill', 'width', `${rc * 100}%`);
                }
            } catch(e) {}
        });

        // --- チャット競合防止 ---
        patchChatProcess(being);

        // --- IdleGC にAoの大きなMapを登録 ---
        if (being.concepts)       IdleGC.register(being.concepts,       ['_map', 'cache']);
        if (being.episodicMemory) IdleGC.register(being.episodicMemory, ['episodes']);
        if (being.worldView)      IdleGC.register(being.worldView,      ['cache']);

        // --- 起動 ---
        Scheduler.start();
        IdleGC.start();

        // 5分ごとに統計レポート
        setInterval(() => OPT.report(), 300000);

        OPT.log(`v${OPT.version} アタッチ完了 🚀`);
    }

    // ─── Ao初期化完了を待つ ────────────────────────────────────
    (function pollForAo() {
        const being = window.ao;
        // spatialInteractionModel が入ってれば全初期化済みと判断
        if (being && being.statisticalTokenizer && being.spatialInteractionModel) {
            setTimeout(() => {
                try {
                    attachOptimizer(being);
                } catch (e) {
                    console.error('[AoOptimizer] attachOptimizer error:', e);
                }
            }, 1500); // MissingPiecesのアタッチ（1000ms）より後に実行
        } else {
            setTimeout(pollForAo, 800);
        }
    })();

    OPT.log(`v${OPT.version} ロード完了 - Ao起動待ち...`);

})();
