// ═══════════════════════════════════════════════════════════════════════
// ao-pipe-orchestrator.js
//
// 役割：
//   PIPE1〜7の初期化順序を依存グラフで管理する。
//   各PIPEのpollForXxxに散らばっていたhardcoded delay（1500/2000/2500/3500ms）
//   を廃止し、「依存PIPEのattach完了」を条件に次のPIPEを起動する。
//
// 読み込み順：
//   ao-pipe7.js の直後に読み込む。
//   （全PIPE・attachPipeXxx関数・window.ao が存在する状態）
//
// 既存PIPEファイルへの変更：
//   各ファイルのpollForXxx内のhardcoded delayのみ削除。
//   attachPipeXxx 本体・二重アタッチ防止フラグはそのまま維持。
//
// 依存グラフ：
//   PIPE1  : window.ao + languageInputDL + CIR
//   PIPE4  : window.ao + statisticalTokenizer
//   PIPE2/3: window.ao + CIR + abstractFormer + worldView  ← PIPE1完了後
//   PIPE5  : window.ao + CIR + videoEditing               ← PIPE4完了後
//   PIPE6  : window.ao + qualiaField + CIR + prefrontal
//              + imageGenerator + audioGenerator           ← PIPE2/3完了後
//   PIPE7  : window.ao + CIR + conceptGraph               ← PIPE6完了後
//
// ═══════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────────────
    // 定数
    // ─────────────────────────────────────────────────────────────────
    const POLL_INTERVAL   = 200;   // ms: 依存チェックの間隔（旧1000ms → 短縮）
    const MAX_WAIT_MS     = 30000; // ms: この時間内に依存が揃わなければ警告
    const LOG_PREFIX      = '[ao-orchestrator]';

    // ─────────────────────────────────────────────────────────────────
    // 状態管理
    // ─────────────────────────────────────────────────────────────────
    // being._pipeReady: Set<string> — attach完了済みPIPEの名前セット
    // ここはbeingが生えてから初期化する（下のwaitForBeing参照）
    function getReady(being) {
        if (!being._pipeReady) being._pipeReady = new Set();
        return being._pipeReady;
    }

    function markReady(being, pipeName) {
        getReady(being).add(pipeName);
        console.log(`${LOG_PREFIX} ${pipeName} ready`);
        being.addLog && being.addLog(`${LOG_PREFIX} ${pipeName} 接続完了`);
        // 次のPIPEを起動するためにスケジューラを再評価
        scheduleCheck();
    }

    function isReady(being, pipeName) {
        return getReady(being).has(pipeName);
    }

    // ─────────────────────────────────────────────────────────────────
    // 依存チェック関数
    // being と「そのPIPEが必要とするオブジェクト」が全て存在するかを返す
    // ─────────────────────────────────────────────────────────────────
    function depsOk_pipe1(being) {
        return !!(being.languageInputDL && being.causalInterventionReasoner);
    }

    function depsOk_pipe4(being) {
        return !!(
            being.statisticalTokenizer ||
            (being.languageOutputDL &&
             being.languageOutputDL.languageAcquisition &&
             being.languageOutputDL.languageAcquisition.perceptualParser)
        );
    }

    function depsOk_pipe23(being) {
        return !!(
            being.causalInterventionReasoner &&
            being.abstractFormer &&
            being.worldView
        );
    }

    function depsOk_pipe5(being) {
        return !!(being.causalInterventionReasoner && being.videoEditing);
    }

    function depsOk_pipe6(being) {
        return !!(
            being.qualiaField &&
            being.causalInterventionReasoner &&
            being.prefrontalCoreV1_1 &&
            being.imageGenerator &&
            being.audioGenerator
        );
    }

    function depsOk_pipe7(being) {
        return !!(being.causalInterventionReasoner && being.conceptGraph);
    }

    // ─────────────────────────────────────────────────────────────────
    // 各PIPEのattachラッパー
    // 成功時に markReady() を呼ぶ
    // attachPipeXxx自体の二重アタッチ防止は既存フラグ（_pipeXAttached）が担う
    // ─────────────────────────────────────────────────────────────────
    function tryAttach1(being) {
        if (being._pipe1Attached && isReady(being, 'pipe1')) return;
        try {
            window.attachPipe1(being);
            // attachPipe1は内部で依存チェックして自己リトライする場合がある
            // langDL + CIR が揃っている時点でattachを呼んでいるので完了扱い
            markReady(being, 'pipe1');
        } catch (e) {
            console.error(`${LOG_PREFIX} attachPipe1 error:`, e);
        }
    }

    function tryAttach4(being) {
        if (being._pipe4Attached && isReady(being, 'pipe4')) return;
        try {
            window.attachPipe4(being);
            markReady(being, 'pipe4');
        } catch (e) {
            console.error(`${LOG_PREFIX} attachPipe4 error:`, e);
        }
    }

    function tryAttach23(being) {
        if (being._pipe2Attached && being._pipe3Attached && isReady(being, 'pipe23')) return;
        try {
            // ConceptGraphはPIPE2/3で共有するインスタンス
            // 既にbeingにあればそれを使う（二重attach時の整合性）
            const conceptGraph = being.conceptGraph || new window.ConceptGraph();
            window.attachPipe2(being, conceptGraph);
            window.attachPipe3(being, conceptGraph);
            // conceptGraphをbeingに保存（PIPE7がdepsOk_pipe7で参照する）
            if (!being.conceptGraph) being.conceptGraph = conceptGraph;
            if (!window._aoConceptGraph) window._aoConceptGraph = conceptGraph;
            markReady(being, 'pipe23');
        } catch (e) {
            console.error(`${LOG_PREFIX} attachPipe2/3 error:`, e);
        }
    }

    function tryAttach5(being) {
        if (being._pipe5Attached && isReady(being, 'pipe5')) return;
        try {
            window.attachPipe5(being);
            markReady(being, 'pipe5');
        } catch (e) {
            console.error(`${LOG_PREFIX} attachPipe5 error:`, e);
        }
    }

    function tryAttach6(being) {
        if (being._pipe6Attached && isReady(being, 'pipe6')) return;
        try {
            window.attachPipe6(being);
            markReady(being, 'pipe6');
        } catch (e) {
            console.error(`${LOG_PREFIX} attachPipe6 error:`, e);
        }
    }

    function tryAttach7(being) {
        if (being._pipe7Attached && isReady(being, 'pipe7')) return;
        try {
            window.attachPipe7(being);
            markReady(being, 'pipe7');
        } catch (e) {
            console.error(`${LOG_PREFIX} attachPipe7 error:`, e);
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // メインスケジューラ
    // 依存グラフを上から評価し、条件が揃ったPIPEを順に起動する
    // ─────────────────────────────────────────────────────────────────
    let _checkTimer   = null;
    let _startTime    = Date.now();
    let _allDone      = false;

    function scheduleCheck() {
        if (_allDone) return;
        if (_checkTimer) clearTimeout(_checkTimer);
        _checkTimer = setTimeout(runCheck, POLL_INTERVAL);
    }

    function runCheck() {
        _checkTimer = null;

        const being = window.ao;
        if (!being) {
            // window.ao がまだ生えていない
            if (Date.now() - _startTime > MAX_WAIT_MS) {
                console.warn(`${LOG_PREFIX} window.ao が ${MAX_WAIT_MS}ms 経っても存在しない`);
                return;
            }
            scheduleCheck();
            return;
        }

        // ── PIPE1: langDL + CIR ──────────────────────────────────────
        if (!isReady(being, 'pipe1') && depsOk_pipe1(being)) {
            tryAttach1(being);
        }

        // ── PIPE4: statisticalTokenizer（PIPE1と並列でOK）───────────
        if (!isReady(being, 'pipe4') && depsOk_pipe4(being)) {
            tryAttach4(being);
        }

        // ── PIPE2/3: PIPE1完了後 ─────────────────────────────────────
        if (!isReady(being, 'pipe23') &&
            isReady(being, 'pipe1') &&
            depsOk_pipe23(being)) {
            tryAttach23(being);
        }

        // ── PIPE5: PIPE4完了後 ───────────────────────────────────────
        if (!isReady(being, 'pipe5') &&
            isReady(being, 'pipe4') &&
            depsOk_pipe5(being)) {
            tryAttach5(being);
        }

        // ── PIPE6: PIPE2/3完了後 ────────────────────────────────────
        if (!isReady(being, 'pipe6') &&
            isReady(being, 'pipe23') &&
            depsOk_pipe6(being)) {
            tryAttach6(being);
        }

        // ── PIPE7: PIPE6完了後 ───────────────────────────────────────
        if (!isReady(being, 'pipe7') &&
            isReady(being, 'pipe6') &&
            depsOk_pipe7(being)) {
            tryAttach7(being);
        }

        // ── 全完了チェック ───────────────────────────────────────────
        if (isReady(being, 'pipe1') &&
            isReady(being, 'pipe4') &&
            isReady(being, 'pipe23') &&
            isReady(being, 'pipe5') &&
            isReady(being, 'pipe6') &&
            isReady(being, 'pipe7')) {
            _allDone = true;
            const elapsed = Date.now() - _startTime;
            console.log(`${LOG_PREFIX} 全PIPE接続完了 (${elapsed}ms)`);
            being.addLog && being.addLog(`${LOG_PREFIX} 全PIPE接続完了`);
            window.dispatchEvent(new CustomEvent('ao-pipes-ready', { detail: { elapsed } }));
            return;
        }

        // ── 未完了があればタイムアウト確認してリスケ ─────────────────
        if (Date.now() - _startTime > MAX_WAIT_MS) {
            const ready = being._pipeReady ? [...being._pipeReady] : [];
            const missing = ['pipe1','pipe4','pipe23','pipe5','pipe6','pipe7']
                .filter(p => !isReady(being, p));
            console.warn(`${LOG_PREFIX} タイムアウト: 未完了=${missing.join(',')} 完了=${ready.join(',')}`);
            return;
        }

        scheduleCheck();
    }

    // ─────────────────────────────────────────────────────────────────
    // 既存のpollForXxx（各PIPEファイル内）は引き続き動く。
    // orchestratorとpollForXxxが同時にattachを試みても
    // 各ファイルの _pipeXAttached フラグで二重アタッチが防がれる。
    //
    // ただし既存pollForXxxのhardcoded delayが残っていると
    // orchestratorより遅れてattachされ、markReady()が呼ばれないまま
    // 後続PIPEの起動が止まる。
    // → 各ファイルのpollFor内のsetTimeout delay値を0にパッチする。
    //   （pollForXxx自体は削除しない：万一orchestratorが失敗した時の保険）
    // ─────────────────────────────────────────────────────────────────

    // ─────────────────────────────────────────────────────────────────
    // 起動
    // ─────────────────────────────────────────────────────────────────
    scheduleCheck();

    // デバッグ用公開API
    window._aoPipeOrchestrator = {
        getStatus() {
            const being = window.ao;
            if (!being) return { error: 'window.ao なし' };
            return {
                ready:   being._pipeReady ? [...being._pipeReady] : [],
                allDone: _allDone,
                elapsed: Date.now() - _startTime,
            };
        },
        retry() {
            _allDone    = false;
            _startTime  = Date.now();
            scheduleCheck();
        },
    };

    console.log(`${LOG_PREFIX} 起動`);
})();
