// ═══════════════════════════════════════════════════════════════════════
// PIPE 1: 文法統計信用値 → 因果推論野（CausalInterventionReasoner）
//
// 役割：
//   LanguageInputDL.parse() が返す構文情報 + StatisticalTokenizer の
//   bigram/PMI統計を「文法パターン信用値」としてCIRに渡す。
//   CIRが自律的に「AはBだ」「AはBに属する」等の構造を読み解けるようになる。
//
// 挿入場所：
//   being.process() 内の languageInputDL.parse() 直後
//   （index.html 約24053行目付近）
//
// 使い方：
//   attachPipe1(being) を attachExtendedSystems / attachMissingPieces の後に呼ぶ
// ═══════════════════════════════════════════════════════════════════════

function attachPipe1(being) {
    if (!being) return;
    if (being._pipe1Attached) return; // 二重アタッチ防止
    being._pipe1Attached = true;

    const langDL = being.languageInputDL;
    const cir    = being.causalInterventionReasoner;
    const statTok = being.statisticalTokenizer;

    if (!langDL || !cir) {
        console.warn('[PIPE1] langDL or CIR が未接続 - 後でリトライ');
        setTimeout(() => {
            being._pipe1Attached = false;
            attachPipe1(being);
        }, 2000);
        return;
    }

    // ─── 文法パターン信用値を計算するアダプタ ───────────────────────────
    //
    // StatisticalTokenizer の持つ bigramFreq / PMI から
    // 「このトークン列がどれだけ確立した文法パターンか」をスコア化する。
    //
    // スコアの意味：
    //   grammarConfidence  : 全体的な文法の安定度（0〜1）
    //   subjectPredicatePMI: 主語-述語ペアの結びつき強度
    //   patternLabel       : CIRが参照するアクションラベル
    //
    function extractGrammarSignal(dlResult, text) {
        const syntax = dlResult.syntax || {};
        const { subject, predicate, object, hasStructure, isGrammatical } = syntax;

        // ── 1. 基本構造スコア ──
        // hasStructure（主語/目的語が検出された）とisGrammaticalをベースにする
        let structureScore = 0;
        if (hasStructure)   structureScore += 0.5;
        if (isGrammatical)  structureScore += 0.3;
        if (subject)        structureScore += 0.1;
        if (predicate)      structureScore += 0.1;
        structureScore = Math.min(1.0, structureScore);

        // ── 2. StatisticalTokenizer の PMI + 4軸信用値 ──
        // PIPE4が付与した4軸（接尾語・語末・位置・区切り）をPMIと合成する
        // これにより因果推論野が「どの軸で文法が決まっているか」を理解できる
        let pmiScore    = 0.5; // デフォルト（statTokなし時）
        let axis4Signal = { suffix: 0, wordEnd: 0, position: 0, delim: 0 };

        if (statTok && subject && predicate) {
            try {
                const feats = statTok.extractPerceptualFeatures(
                    `${subject} ${predicate}`,
                    [subject, predicate]
                );

                // PMI基本スコア
                const basePMI = Math.min(1.0, (feats.avgPMI || 0) * 2 + 0.3);

                // 4軸信用値（PIPE4が追加したフィールド）
                const suffixConf   = feats.avgSuffixConf   || 0;
                const wordEndConf  = feats.avgWordEndConf  || 0;
                const positionConf = feats.avgPositionConf || 0;
                const delimConf    = feats.avgDelimConf    || 0;

                // 4軸の中で最も強い信号を使ってPMIを補正する
                // 接尾語が強い → その言語は接尾語で文法が決まる確信度が上がる
                // 位置が強い  → その言語は語順で文法が決まる確信度が上がる
                const axis4Max = Math.max(suffixConf, wordEndConf, positionConf, delimConf);
                pmiScore = Math.min(1.0, basePMI * 0.6 + axis4Max * 0.4);

                // CIRに渡すために保存
                axis4Signal = { suffix: suffixConf, wordEnd: wordEndConf, position: positionConf, delim: delimConf };

            } catch (_) {}
        }

        // ── 3. 関係タイプの判定（CIRへのアクションラベル） ──
        // 文中の助詞・述語パターンから「何の関係か」を判定する
        // これがCIRに渡る「action」になり、CIRが自律的に読み解く
        let relationLabel = '言語構造[不明]';
        let relationType  = 'unknown';

        if (text) {
            // is-a 関係：「〜はXだ」「〜はXに属する」「〜はXの一種」
            if (/は.+?(だ|です|である|に属す|の一種|の仲間)/.test(text)) {
                relationLabel = `言語構造[is-a]::${subject || '?'}→${predicate || object || '?'}`;
                relationType  = 'is-a';
            }
            // has-property 関係：「〜はXを持つ」「〜にはXがある」
            else if (/は.+?(を持つ|を持っ|がある|がいる|ができる)/.test(text)) {
                relationLabel = `言語構造[has-prop]::${subject || '?'}→${object || predicate || '?'}`;
                relationType  = 'has-property';
            }
            // cause 関係：「〜するので」「〜だから」「〜のため」
            else if (/(ので|だから|のため|ゆえに|により)/.test(text)) {
                relationLabel = `言語構造[cause]::${subject || '?'}→${predicate || '?'}`;
                relationType  = 'cause';
            }
            // 一般的な主語-述語
            else if (hasStructure && subject) {
                relationLabel = `言語構造[stmt]::${subject}→${predicate || '?'}`;
                relationType  = 'statement';
            }
        }

        // ── 4. 総合信用値（CIRのstateBefore/Afterに載せる） ──
        // 4軸信号が強い場合はstructureScoreの重みを下げて4軸に委ねる
        const axis4Dominant = Math.max(axis4Signal.suffix, axis4Signal.position) > 0.5;
        const grammarConfidence = axis4Dominant
            ? (structureScore * 0.4) + (pmiScore * 0.6)  // 4軸が主役
            : (structureScore * 0.6) + (pmiScore * 0.4); // 構造スコアが主役

        return {
            patternLabel:       relationLabel,
            relationType:       relationType,
            grammarConfidence:  grammarConfidence,
            structureScore:     structureScore,
            subjectPredicatePMI: pmiScore,
            axis4Signal:        axis4Signal,   // CIRへ渡す4軸情報
            axis4Dominant:      axis4Dominant, // どちらが主役か
            subject:            subject,
            predicate:          predicate,
            object:             object,
            hasStructure:       hasStructure,
            isGrammatical:      isGrammatical,
            rawText:            text,
        };
    }

    // ─── parse() をラップしてパイプを接続 ───────────────────────────────
    const origParse = langDL.parse.bind(langDL);

    langDL.parse = async function(text, ...args) {
        const dlResult = await origParse(text, ...args);

        // 文法信用値を抽出
        try {
            const signal = extractGrammarSignal(dlResult, text);

            // CIRに渡す：
            //   action     = 文法パターンラベル（CIRが推論の「きっかけ」として使う）
            //   stateBefore = 信用値が低い状態（この文法パターンがまだ弱い）
            //   stateAfter  = 信用値が高い状態（この文法パターンが確立した）
            //
            // CIRはこれを蓄積していくことで
            // 「言語構造[is-a]が来たら概念関係が変化する」という因果を学ぶ
            if (signal.hasStructure || signal.relationType !== 'unknown') {
                const stateBefore = {
                    conceptCount:   0,
                    emotionalState: 'listening',
                    tension:        1.0 - signal.grammarConfidence, // 信用値が低い=緊張高
                    grammarConf:    0,
                    relationType:   signal.relationType,
                };
                const stateAfter = {
                    conceptCount:   signal.hasStructure ? 1 : 0,
                    emotionalState: signal.grammarConfidence > 0.6 ? 'understood' : 'uncertain',
                    tension:        1.0 - signal.grammarConfidence,
                    grammarConf:    signal.grammarConfidence,
                    pmiScore:       signal.subjectPredicatePMI,
                    subject:        signal.subject,
                    predicate:      signal.predicate,
                    relationType:   signal.relationType,
                    // PIPE4から来た4軸信用値（因果推論野が言語構造を理解するための鍵）
                    axis4:          signal.axis4Signal,
                    axis4Dominant:  signal.axis4Dominant,
                    // どの軸が主役か（CIRが蓄積して言語の文法型を自律的に把握する）
                    dominantAxis: signal.axis4Signal
                        ? Object.entries(signal.axis4Signal).sort((a,b) => b[1]-a[1])[0][0]
                        : 'unknown',
                };

                cir.record(signal.patternLabel, stateBefore, stateAfter);

                being.addLog && being.addLog(
                    `[PIPE1] ${signal.patternLabel} conf=${(signal.grammarConfidence*100).toFixed(0)}% axis=${stateAfter.dominantAxis}`
                );
            }
        } catch(e) {
            console.warn('[PIPE1] signal extraction error:', e);
        }

        return dlResult;
    };

    // ─── CIR側：言語構造パターンから推論する能力を拡張 ─────────────────
    // 既存の counterfactual() はそのままに、
    // 「言語パターンから関係タイプを照会する」メソッドを追加する
    if (!cir.queryLinguisticRelation) {
        cir.queryLinguisticRelation = function(relationType) {
            // 指定タイプの言語構造パターンをCIR履歴から収集
            const matches = this.history.filter(e =>
                e.action && e.action.includes(`言語構造[${relationType}]`)
            );
            if (matches.length === 0) {
                return { count: 0, avgConfidence: 0, examples: [] };
            }
            const avgConf = matches.reduce((s, e) =>
                s + (e.stateAfter.grammarConf || 0), 0) / matches.length;

            // パターンからsubject/predicateのペアを抽出
            const examples = matches.slice(-5).map(e => ({
                subject:   e.stateAfter.subject,
                predicate: e.stateAfter.predicate,
                conf:      e.stateAfter.grammarConf,
            }));

            return {
                relationType,
                count:         matches.length,
                avgConfidence: avgConf,
                examples,
                // 「このパターンが来たら概念変化が起きる確率」
                reliabilityScore: Math.min(1.0, matches.length / 10) * avgConf,
            };
        };

        // 「is-a関係として学習済みのペア一覧」を返すメソッド
        cir.getLearnedIsA = function() {
            return this.history
                .filter(e => e.action && e.action.includes('言語構造[is-a]'))
                .filter(e => e.stateAfter.subject && e.stateAfter.predicate)
                .map(e => ({
                    subject:   e.stateAfter.subject,
                    category:  e.stateAfter.predicate,
                    conf:      e.stateAfter.grammarConf,
                    timestamp: e.timestamp,
                }));
        };
    }

    console.log('[PIPE1] 文法統計信用値 → CIR パイプ接続完了');
    being.addLog && being.addLog('[PIPE1] 言語野→因果推論野 パイプ1 接続完了');
}

// ─── 自動アタッチ ──────────────────────────────────────────────────────
// attachMissingPieces 完了後（being.causalInterventionReasoner が存在する）
// のタイミングでアタッチする
(function pollForPipe1() {
    const being = window.ao;
    if (being && being.languageInputDL && being.causalInterventionReasoner) {
        setTimeout(() => {
            try {
                attachPipe1(being);
            } catch(e) {
                console.error('[PIPE1] attachPipe1 error:', e);
            }
        }, 1500);
    } else {
        setTimeout(pollForPipe1, 1000);
    }
})();

window.attachPipe1 = attachPipe1;
