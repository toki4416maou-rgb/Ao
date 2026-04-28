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
// [A] 保存パッチ
//     本当の重さの原因は persistenceLayer.save() の中の
//     JSON.stringify + LZString.compressToUTF16 がメインスレッドで同期実行されること。
//     ここを直接 Worker にオフロードする。
//     AutoSaveManager 経由・手動保存ボタン経由どちらも捕捉できる。
// ================================================================

// ---- exportAll を yield しながら収集（実際の構造に合わせた版）----
async function _chunkedExportAll (ao) {
    if (!ao.exportAll) return null;

    // 実際の exportAll() の構造に合わせてサブシステムを個別に yield しながら収集
    // 一番重い concepts と episodicMemory は必ず個別に yield する
    const yield_ = () => new Promise(r => setTimeout(r, 0));

    const cs = {}; // coreState

    // ── 重いもの（個別に yield）──
    try { cs.concepts        = ao.concepts.exportState();        } catch(_){}
    await yield_();
    try { cs.episodicMemory  = ao.episodicMemory.exportState();  } catch(_){}
    await yield_();
    try { cs.languageOutputDL = ao.languageOutputDL.exportState(); } catch(_){}
    await yield_();

    // ── 中程度（2〜3個まとめて yield）──
    try { cs.protoConcepts   = ao.protoGenerator.exportState();  } catch(_){}
    try { cs.hierarchy       = ao.hierarchy.exportState();       } catch(_){}
    await yield_();
    try { cs.valueLayer      = ao.valueLayer.exportState();      } catch(_){}
    try { cs.failures        = ao.failures.exportState();        } catch(_){}
    await yield_();
    try { cs.personModel     = ao.personModel.exportState();     } catch(_){}
    try { cs.sensoryIntegrator = ao.sensoryIntegrator.exportState(); } catch(_){}
    await yield_();
    try { cs.uninterpreted   = ao.uninterpreted.exportState();   } catch(_){}
    try { cs.cognitiveMetabolism = ao.humanBrainMetabolism.exportState(); } catch(_){}
    await yield_();

    // ── 状態値（軽い）──
    cs.state = {
        joy:       ao._stateVector?.[0] ?? ao.state?.joy      ?? 0,
        tension:   ao._stateVector?.[1] ?? ao.state?.tension  ?? 0,
        curiosity: ao._stateVector?.[2] ?? ao.state?.curiosity?? 0,
        calm:      ao._stateVector?.[3] ?? ao.state?.calm     ?? 0
    };
    cs.world    = { ...ao.world };
    cs.identity = { ...ao.identity };
    cs.conversationFlow = (ao.conversationFlow || []).slice(-30);
    cs.log              = (ao.log || []).slice(-30);
    cs.abstractionAttempts = ao.abstractionAttempts;
    cs.questionEngineState = {
        lastQuestion: ao.questionEngine?.lastQuestion,
        cooldown:     ao.questionEngine?.cooldown
    };
    await yield_();

    // ── 分散記憶 ──
    try {
        cs.distributedMemory = {
            episodic:  ao.distributedEpisodic.exportState(),
            semantic:  ao.distributedSemantic.exportState(),
            affective: ao.distributedAffective.exportState()
        };
    } catch(_){}
    await yield_();

    // ── 視覚・音声関連 ──
    try { cs.qualiaField           = ao.qualiaField?.exportState() ?? null; } catch(_){}
    try { cs.visualHypothesisTable = ao.imageAdapter?.hypothesisTable.exportState() ?? null; } catch(_){}
    try { cs.labelCoOccurrence     = ao.imageAdapter ? Array.from(ao.imageAdapter.labelCoOccurrence.entries()) : []; } catch(_){}
    try { cs.audioLabelCoOccurrence = ao.audioAdapter?.exportCoOccurrence() ?? []; } catch(_){}
    try { cs.videoParserState      = ao.videoAdapter?.videoParser?.exportState() ?? null; } catch(_){}
    await yield_();

    // ── 残りのサブシステム（まとめて）──
    const optionals = [
        ['perpetualLoop',          () => ao.perpetualLoop?.getState()],
        ['intelligence',           () => ({
            causalMemory:        ao.intelligence.causalMemory.exportState(),
            knowledgeBoundary:   ao.intelligence.knowledgeBoundary.exportState(),
            abstractResolution:  ao.intelligence.abstractResolution.exportState()
        })],
        ['worldView',              () => ao.worldView?.exportState()],
        ['axisCodec',              () => ao.axisCodec?.exportState()],
        ['identityManager',        () => ao.identityManager?.exportState()],
        ['spatialState',           () => ao.spatialState?.exportState()],
        ['intentGenerator',        () => ao.intentGenerator?.exportState()],
        ['conceptIntegration',     () => ao.conceptIntegration?.exportState()],
        ['abstractionController',  () => ao.abstractionController?.exportState()],
        ['generationalCompression',() => ao.generationalCompression?.exportState()],
        ['memoryLimits',           () => ao.memoryLimits?.exportState()],
        ['attentionManager',       () => ao.attentionManager?.exportState()],
        ['asymmetricMemory',       () => ao.asymmetricMemory?.exportState()],
        ['predictionLayer',        () => ao.predictionLayer?.exportState()],
        ['errorDrivenUpdate',      () => ao.errorDrivenUpdate?.exportState()],
        ['thoughtBias',            () => ao.thoughtBias?.exportState()],
        ['subjectiveFocus',        () => ao.subjectiveFocus?.exportState()],
        ['mPFC',                   () => ao.mPFC?.exportState()],
        ['hypothalamus',           () => ao.hypothalamus?.exportState()],
        ['amygdala',               () => ao.amygdala?.exportState()],
        ['acc',                    () => ao.acc?.exportState()],
        ['inferenceMode',          () => ao.inferenceMode?.exportState()],
        ['autonomousCreator',      () => ({
            running:    ao.autonomousCreator.running,
            mood:       ao.autonomousCreator.mood,
            curiosity:  ao.autonomousCreator.curiosity,
            tension:    ao.autonomousCreator.tension,
            confidence: ao.autonomousCreator.confidence,
            postCount:  ao.autonomousCreator.postCount
        })],
        ['sageSystem',             () => ({
            metricsHistory:  ao.sageSystem.metrics.history,
            generationCost:  ao.sageSystem.consolidation.generationCost,
            lastUpdate:      ao.sageSystem.lastUpdate
        })],
        ['otakuCultureIntegration',() => ao.otakuCultureIntegration?.exportState()],
    ];

    for (let i = 0; i < optionals.length; i++) {
        const [key, fn] = optionals[i];
        try { const v = fn(); if (v !== undefined) cs[key] = v; } catch(_){}
        if (i % 4 === 3) await yield_(); // 4件ごとに yield
    }

    return {
        version:   '26.3.1',
        timestamp: Date.now(),
        coreState: cs
    };
}

// ---- persistenceLayer.save() を Worker にオフロード ----
function _patchPersistenceLayer (ao) {
    const pl = ao.persistenceLayer;
    if (!pl || pl._workerPatched) return false;

    const _origSave = pl.save.bind(pl);

    pl.save = async function (data) {
        try {
            // JSON.stringify + LZString を Worker に投げる
            const { compressed, originalBytes, compressedLen } = await _send(
                'compress', data, 'save'
            );

            // IndexedDB / localStorage への書き込みはメインスレッドで
            if (pl.useLocalStorage) {
                localStorage.setItem('ao_state', compressed);
                localStorage.setItem('ao_state_compressed', '1');
            } else if (pl.db) {
                await new Promise((resolve, reject) => {
                    const tx      = pl.db.transaction([pl.storeName], 'readwrite');
                    const store   = tx.objectStore(pl.storeName);
                    const request = store.put({
                        id: 'current_state',
                        timestamp: Date.now(),
                        compressed: true,
                        data: compressed
                    });
                    request.onsuccess = () => resolve();
                    request.onerror   = () => reject(request.error);
                });
            }

            _stats.saves++;
            console.log(
                `[AoWorker] persistenceLayer 非同期保存完了`,
                `${(originalBytes/1024).toFixed(0)}KB → ${(compressedLen/1024).toFixed(0)}KB`
            );
            return { success: true, timestamp: Date.now() };

        } catch (e) {
            console.warn('[AoWorker] persistenceLayer Worker失敗 → CPU退避:', e.message);
            _stats.errors++;
            return _origSave(data);
        }
    };

    pl._workerPatched = true;
    console.log('[AoWorker] persistenceLayer.save() Worker パッチ適用完了');
    return true;
}

// ---- AutoSaveManager._performAutoSave を chunked exportAll に差し替え ----
function _patchAutoSaveManager (ao) {
    const asm = ao.autoSaveManager;
    if (!asm || asm._workerPatched) return false;

    const _origPerform = asm._performAutoSave.bind(asm);

    asm._performAutoSave = async function (reason) {
        try {
            const now = Date.now();
            if (now - (asm.lastSave || 0) < 5000) return;

            // exportAll を yield しながら収集（メインスレッドだが刻む）
            const data = await _chunkedExportAll(ao);
            if (!data) return _origPerform(reason);

            // persistenceLayer.save() は Worker パッチ済みなので非同期
            const result = await asm.persistenceLayer.save(data);
            if (result?.success) {
                asm.lastSave = now;
                if (ao.saveManager) ao.saveManager.markClean?.();
            }
        } catch (e) {
            console.warn('[AoWorker] AutoSave chunked失敗 → 元実装:', e.message);
            return _origPerform(reason);
        }
    };

    asm._workerPatched = true;
    console.log('[AoWorker] AutoSaveManager._performAutoSave chunked パッチ適用完了');
    return true;
}

function _patchSaveManager (ao) {
    const plOK  = _patchPersistenceLayer(ao);
    const asmOK = _patchAutoSaveManager(ao);

    // 手動保存ボタン（saveManager.save）もパッチ
    const sm = ao.saveManager;
    if (sm && !sm._workerPatched) {
        const _origSave = sm.save?.bind(sm);
        sm.save = async function () {
            try {
                const data   = await _chunkedExportAll(ao);
                if (!data) return _origSave?.();
                return await ao.persistenceLayer.save(data);
            } catch(e) {
                return _origSave?.();
            }
        };
        sm._workerPatched = true;
        console.log('[AoWorker] saveManager.save() パッチ適用完了');
    }

    return plOK || asmOK || !!sm;
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
