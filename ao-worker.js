/*!
 * ao-worker.js  v1.0
 *
 * 役割:
 *   メインスレッドをブロックする重い処理をバックグラウンドに分離する。
 *
 * Worker側が担う処理:
 *   1. JSON.stringify + LZString.compressToUTF16  (保存)
 *   2. LZString.decompressFromUTF16 + JSON.parse  (ロード)
 *   3. エピソード記憶のソート (HippocampalReplay)
 *
 * メインスレッド側が担う処理 (<script src="ao-worker.js"> で読み込んだ時):
 *   - SaveManager.save() を非同期パッチ
 *   - HippocampalReplay をワーカー経由に差し替え
 *   - PALループの重い代謝処理を requestIdleCallback にスケジュール
 *
 * 追加方法:
 *   index.html の ao-gpu.js の直後 (ao-optimizer.js の直前) に
 *     <script src="ao-worker.js"></script>
 *   を1行追加するだけ。Worker生成に失敗した場合は自動的にCPUフォールバック。
 */

// ================================================================
// ① Worker コンテキスト（window が無い = Worker 内で実行中）
// ================================================================
if (typeof window === 'undefined') {

    // LZString をCDNからインポート
    try {
        importScripts(
            'https://cdnjs.cloudflare.com/ajax/libs/lz-string/1.5.0/lz-string.min.js'
        );
    } catch (e) {
        // CDN取得失敗時はフォールバック実装（UTF16のみ）
        self.LZString = {
            compressToUTF16:     (s) => s,
            decompressFromUTF16: (s) => s
        };
    }

    self.onmessage = function (e) {
        const { type, id, payload } = e.data;

        // ---- 保存: JS object → JSON → LZString圧縮 ----
        if (type === 'compress') {
            try {
                const json       = JSON.stringify(payload);
                const compressed = LZString.compressToUTF16(json);
                self.postMessage({
                    type: 'compressed',
                    id,
                    compressed,
                    originalBytes: json.length,
                    compressedLen: compressed.length
                });
            } catch (err) {
                self.postMessage({ type: 'error', id, error: err.message });
            }
            return;
        }

        // ---- ロード: LZString解凍 → JSON.parse ----
        if (type === 'decompress') {
            try {
                const json = LZString.decompressFromUTF16(payload);
                if (!json) throw new Error('decompressFromUTF16 returned null');
                const data = JSON.parse(json);
                self.postMessage({ type: 'decompressed', id, data });
            } catch (err) {
                self.postMessage({ type: 'error', id, error: err.message });
            }
            return;
        }

        // ---- HippocampalReplay: 重要度でエピソードをソート ----
        if (type === 'replay_sort') {
            try {
                const { episodes, threshold, topN } = payload;
                const sorted = episodes
                    .filter(ep => (ep.temporalWeight || 1) >= (threshold || 0.3))
                    .sort((a, b) => {
                        const sA = (a.temporalWeight || 1) * (a.importance || 0.5);
                        const sB = (b.temporalWeight || 1) * (b.importance || 0.5);
                        return sB - sA;
                    })
                    .slice(0, topN || 5);
                self.postMessage({ type: 'replay_result', id, result: sorted });
            } catch (err) {
                self.postMessage({ type: 'error', id, error: err.message });
            }
            return;
        }

        // ---- EpisodicMemory 劣化計算: 各エピソードのtemporalWeightを更新 ----
        if (type === 'decay') {
            try {
                const { episodes, decayRate, nowMs } = payload;
                const decayed = episodes.map(ep => {
                    const ageSeconds = (nowMs - ep.timestamp) / 1000;
                    const newWeight  = ep.temporalWeight * Math.pow(decayRate || 0.99, ageSeconds / 3600);
                    return { ...ep, temporalWeight: newWeight };
                });
                self.postMessage({ type: 'decay_result', id, result: decayed });
            } catch (err) {
                self.postMessage({ type: 'error', id, error: err.message });
            }
            return;
        }
    };

} // ================================================================
// ② メインスレッドコンテキスト（<script src="ao-worker.js"> で読込）
// ================================================================
else {
(function () {
'use strict';

// ----------------------------------------------------------------
// 内部変数
// ----------------------------------------------------------------
let   _worker  = null;
let   _msgId   = 0;
const _pending = new Map(); // id → { resolve, reject, label }
const _stats   = { saves: 0, replays: 0, decays: 0, errors: 0, totalMs: 0 };

// ----------------------------------------------------------------
// Worker 初期化
// ----------------------------------------------------------------
function _initWorker () {
    try {
        // 同じファイルをWorkerとして起動（dual-mode）
        _worker = new Worker('ao-worker.js');

        _worker.onmessage = function (e) {
            const { type, id } = e.data;
            const cb = _pending.get(id);
            if (!cb) return;
            _pending.delete(id);
            if (type === 'error') {
                _stats.errors++;
                cb.reject(new Error('[AoWorker:' + cb.label + '] ' + e.data.error));
            } else {
                cb.resolve(e.data);
            }
        };

        _worker.onerror = function (err) {
            console.error('[AoWorker] Worker runtime error:', err.message || err);
            _stats.errors++;
        };

        console.log('[AoWorker] Web Worker 起動完了');
        return true;
    } catch (e) {
        console.warn('[AoWorker] Worker 起動失敗（CPUフォールバック）:', e.message);
        return false;
    }
}

// ----------------------------------------------------------------
// Worker へメッセージ送信 → Promise で結果を待つ
// ----------------------------------------------------------------
function _send (type, payload, label) {
    return new Promise((resolve, reject) => {
        if (!_worker) { reject(new Error('worker not ready')); return; }
        const id = ++_msgId;
        _pending.set(id, { resolve, reject, label: label || type });
        _worker.postMessage({ type, id, payload });
    });
}

// ================================================================
// [A] SaveManager パッチ
//     ao.saveManager.save() → Worker で圧縮 → localStorage 書込
// ================================================================
function _patchSaveManager (ao) {
    const sm = ao.saveManager;
    if (!sm || sm._workerPatched) return !!sm;

    // localStorage キーを既存の save 実装から検出（初回スニッフィング）
    let _storageKey = null;

    const _origSave = sm.save ? sm.save.bind(sm) : null;

    // ---- キー検出: localStorage.setItem を一時フック ----
    function _detectKey (origSaveFn) {
        if (_storageKey || !origSaveFn) return;
        const origSet = localStorage.setItem.bind(localStorage);
        localStorage.setItem = function (k, v) {
            // 圧縮データっぽい（長さ > 100）キーを記録
            if (typeof v === 'string' && v.length > 100 && !_storageKey) {
                _storageKey = k;
                console.log('[AoWorker] localStorage キー検出:', k);
            }
            return origSet(k, v);
        };
        try { origSaveFn(); } catch (_) {}
        // 検出後すぐ復元
        setTimeout(() => { localStorage.setItem = origSet; }, 0);
    }

    // ---- 非同期保存本体 ----
    sm.save = async function () {
        const t0 = performance.now();
        try {
            // exportAll() はメインスレッドで実行（ライブオブジェクトへの参照が必要）
            const exportData = ao.exportAll ? ao.exportAll() : null;
            if (!exportData) {
                return _origSave ? _origSave() : null;
            }

            // キーが未検出なら既存 save を1回実行して検出
            if (!_storageKey && _origSave) {
                _detectKey(_origSave);
            }

            // Worker で JSON.stringify + LZString.compressToUTF16
            const { compressed, originalBytes, compressedLen } = await _send(
                'compress', exportData, 'save'
            );

            // localStorage への書込はメインスレッドで（Worker は非対応）
            const key = _storageKey || 'ao_being_state';
            localStorage.setItem(key, compressed);

            _stats.saves++;
            _stats.totalMs += performance.now() - t0;

            console.log(
                `[AoWorker] 非同期保存完了 key=${key}`,
                `元サイズ: ${(originalBytes / 1024).toFixed(0)}KB`,
                `圧縮後: ${(compressedLen / 1024).toFixed(0)}KB`,
                `所要: ${(performance.now() - t0).toFixed(0)}ms`
            );

            // SaveManager の UI 更新フックを叩く（もし存在すれば）
            if (typeof sm._onSaved === 'function') sm._onSaved();
            if (typeof sm.onSaveComplete === 'function') sm.onSaveComplete();

            return { success: true };

        } catch (e) {
            console.warn('[AoWorker] 非同期保存失敗 → CPUフォールバック:', e.message);
            _stats.errors++;
            return _origSave ? _origSave() : null;
        }
    };

    // ---- 非同期ロード ----
    const _origLoad = sm.load ? sm.load.bind(sm) : null;
    if (_origLoad) {
        sm.load = async function () {
            try {
                const key  = _storageKey || 'ao_being_state';
                const raw  = localStorage.getItem(key);
                if (!raw) return _origLoad();          // 保存データなし → 元の実装へ

                const { data } = await _send('decompress', raw, 'load');
                return { success: true, data, timestamp: data.timestamp };
            } catch (e) {
                console.warn('[AoWorker] 非同期ロード失敗 → CPUフォールバック:', e.message);
                return _origLoad ? _origLoad() : { success: false };
            }
        };
    }

    sm._workerPatched = true;
    console.log('[AoWorker] SaveManager 非同期パッチ 適用完了');
    return true;
}

// ================================================================
// [B] HippocampalReplay パッチ
//     エピソードのソート計算をWorkerにオフロード
// ================================================================
function _patchReplay (ao) {
    const hbm = ao.humanBrainMetabolism;
    if (!hbm || !hbm.hippocampalReplay) return false;

    const hr = hbm.hippocampalReplay;
    if (hr._workerPatched) return true;

    const _origReplay = hr.replay ? hr.replay.bind(hr) : null;

    hr.replay = async function (being) {
        if (!being || !being.episodicMemory) {
            return _origReplay ? _origReplay(being) : null;
        }
        try {
            // エピソードの plain コピーだけWorkerに送る（Mapオブジェクトは送れない）
            const episodes = (being.episodicMemory.episodes || []).map(ep => ({
                event:         ep.event        ? ep.event.substring(0, 50) : '',
                timestamp:     ep.timestamp    || 0,
                temporalWeight: ep.temporalWeight || 1.0,
                importance:    ep.importance   || 0.5,
                conceptIds:    ep.conceptIds   ? ep.conceptIds.slice(0, 5) : [],
                emotion: ep.emotion ? {
                    joy:      ep.emotion.joy      || 0,
                    tension:  ep.emotion.tension  || 0,
                    curiosity: ep.emotion.curiosity || 0
                } : {}
            }));

            const { result } = await _send('replay_sort', {
                episodes,
                threshold: hr.replayThreshold || 0.3,
                topN: 5
            }, 'replay');

            // ソート済みトップエピソードで概念深化（軽い処理はメインスレッドで）
            for (const ep of result) {
                if (ep.conceptIds && being.concepts) {
                    ep.conceptIds.forEach(cid => {
                        try {
                            const c = being.concepts.concepts?.get(cid);
                            if (c) c.depth = Math.min(1, (c.depth || 0) + 0.01);
                        } catch (_) {}
                    });
                }
            }

            hr.lastReplay = Date.now();
            _stats.replays++;
            return { replayed: result.length, top: result };

        } catch (e) {
            console.warn('[AoWorker] Replay Worker失敗 → CPUフォールバック:', e.message);
            return _origReplay ? _origReplay(being) : null;
        }
    };

    hr._workerPatched = true;
    console.log('[AoWorker] HippocampalReplay 非同期パッチ 適用完了');
    return true;
}

// ================================================================
// [C] EpisodicMemory 劣化 (applyTemporalDecay) をWorkerにオフロード
// ================================================================
function _patchDecay (ao) {
    const em = ao.episodicMemory;
    if (!em || em._workerPatched) return false;

    const _origDecay = em.applyTemporalDecay ? em.applyTemporalDecay.bind(em) : null;

    em.applyTemporalDecay = async function (decayRate = 0.99) {
        if (!_worker || em.episodes.length < 500) {
            // 件数が少ない場合はCPUで十分速い
            return _origDecay ? _origDecay(decayRate) : null;
        }
        try {
            const { result } = await _send('decay', {
                episodes:  em.episodes.map(ep => ({
                    timestamp:     ep.timestamp,
                    temporalWeight: ep.temporalWeight || 1.0
                })),
                decayRate,
                nowMs: Date.now()
            }, 'decay');

            // 更新されたweightをメインスレッドのエピソードに書き戻す
            result.forEach((r, i) => {
                if (em.episodes[i]) em.episodes[i].temporalWeight = r.temporalWeight;
            });

            _stats.decays++;
        } catch (e) {
            // フォールバック
            return _origDecay ? _origDecay(decayRate) : null;
        }
    };

    em._workerPatched = true;
    console.log('[AoWorker] EpisodicMemory.applyTemporalDecay 非同期パッチ 適用完了');
    return true;
}

// ================================================================
// [D] PAL (PerpetualAutonomousLoop) アイドルスケジューリング
//     代謝ループの重い tick を requestIdleCallback に退避させる
// ================================================================
function _patchPALIdle (ao) {
    const pal = ao.perpetualLoop;
    if (!pal || pal._idlePatched) return false;

    // PAL が内部で使っている tick メソッド名を探す
    const tickName = ['_tick', 'tick', '_autonomousTick', 'autonomousTick']
        .find(n => typeof pal[n] === 'function');

    if (!tickName) return false;

    const _origTick = pal[tickName].bind(pal);

    pal[tickName] = function () {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(
                () => { try { _origTick(); } catch (e) {} },
                { timeout: 5000 }   // 最大5秒待って強制実行
            );
        } else {
            // requestIdleCallback 非対応 (Safari 旧版等)
            setTimeout(() => { try { _origTick(); } catch (e) {} }, 0);
        }
    };

    pal._idlePatched = true;
    console.log(`[AoWorker] PALループ(${tickName}) アイドルスケジューリング 適用完了`);
    return true;
}

// ================================================================
// 起動シーケンス
// ================================================================
const _workerOK = _initWorker();
window.aoWorker = _workerOK
    ? {
        send:     _send,
        getStats: () => ({ ..._stats, pendingCount: _pending.size })
      }
    : null;

// ao が初期化されるまでポーリングしてパッチを適用
// ※ updateUI の RAF バッチングは ao-optimizer.js の Scheduler 側で処理するため
//   ここでは行わない（二重パッチ防止）
const _poll = setInterval(() => {
    const ao = window.ao;
    if (!ao) return;

    const saveOK   = _workerOK ? _patchSaveManager(ao) : false;
    const replayOK = _workerOK ? _patchReplay(ao)      : false;
    const decayOK  = _workerOK ? _patchDecay(ao)       : false;
    const palOK    = _patchPALIdle(ao);

    // 主要パッチが全部完了したらポーリング終了
    if (saveOK && replayOK && decayOK && palOK) {
        clearInterval(_poll);
        console.log('[AoWorker] 全パッチ適用完了');
    }
}, 800);

})(); // end IIFE
} // end main-thread context
