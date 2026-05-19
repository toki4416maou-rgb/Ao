// ═══════════════════════════════════════════════════════════════════════
// PIPE 7: CIR → LanguageOutputGenerator（自然言語生成エンジン）
//
// 役割：
//   ① cir.designSpeech()  : 「何を・どの順で」をCIRと概念グラフで設計
//   ② LanguageOutputGenerator : bigramFreq + 4軸統計でトークンを繋いで発話文字列を生成
//   ③ being.speak()        : 公開API + prefrontal.decide()フック
//
// ハードコードなし：
//   助詞・区切り・文末は全て学習済みのdelimConf/suffixConf/wordEndConfから選ぶ
//   統計が育っていない初期は崩れた文でよい（それが学習初期の自然な出力）
//
// 接続場所：
//   ao-pipe6.js の直後に読み込む
//   （pipe1〜6が完了し being.conceptGraph が存在する状態）
//
// 使い方：
//   attachPipe7(being)
//   または自動アタッチ（pollForPipe7）
//
// 外部API：
//   being.speak('犬')                     → 「犬はイヌ科だ」的な発話を返す
//   being.speak({ topic:'犬', mood:... })  → 感情込みで設計して返す
//   cir.designSpeech({ topic:'犬' })       → 設計のみ（トークン列+構造）
// ═══════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────
// LanguageOutputGenerator
// bigramFreq + 4軸信用値(suffixConf / delimConf / wordEndConf) を使って
// 意味トークン列 → 発話文字列 に変換する
//
// 設計方針：
//   意味トークン（何を言うか）はCIRが決める
//   トークン間の「繋ぎ」（は・が・です等）は統計から選ぶ
//   最初は崩れた文が出る → 会話を重ねるほど統計が育って自然になる
// ─────────────────────────────────────────────────────────────────────
class LanguageOutputGenerator {
    constructor(being) {
        this.being = being;
    }

    // ── StatisticalTokenizer を取得 ────────────────────────────────────
    _getStatTok() {
        const b = this.being;
        return b.statisticalTokenizer
            || (b.languageOutputDL
                && b.languageOutputDL.languageAcquisition
                && b.languageOutputDL.languageAcquisition.perceptualParser)
            || null;
    }

    // ── 4軸から候補トークンを分類して取得 ─────────────────────────────
    // suffixes  : 接尾語・助詞候補（suffixConf高い）
    // delimiters: 区切り候補（delimConf高い）
    // endings   : 文末候補（wordEndConf高い）
    // ─────────────────────────────────────────────────────────────────
    _getCandidates() {
        const statTok = this._getStatTok();
        const empty = { suffixes: [], delimiters: [], endings: [], ready: false };
        if (!statTok || statTok.tokenScores.size < 5) return empty;

        const suffixes   = [];
        const delimiters = [];
        const endings    = [];

        for (const [token, info] of statTok.tokenScores) {
            if (!info || !token) continue;
            const sc = info.suffixConf   || 0;
            const dc = info.delimConf    || 0;
            const ec = info.wordEndConf  || 0;

            // 意味トークン（suffixConf低・delimConf低）は除外
            // 役割を持つトークンだけを候補にする
            if (sc > 0.25) suffixes.push({ token, conf: sc });
            if (dc > 0.35) delimiters.push({ token, conf: dc });
            if (ec > 0.30) endings.push({ token, conf: ec });
        }

        suffixes.sort((a, b) => b.conf - a.conf);
        delimiters.sort((a, b) => b.conf - a.conf);
        endings.sort((a, b) => b.conf - a.conf);

        return {
            suffixes:   suffixes.slice(0, 15),
            delimiters: delimiters.slice(0, 10),
            endings:    endings.slice(0, 5),
            ready:      suffixes.length > 0 || endings.length > 0,
        };
    }

    // ── bigramFreqで「prevTokenの後に来やすいフィラー」を選ぶ ──────────
    // prevToken の末尾文字 + candidate[0] のbigramスコアが高い候補を返す
    // ─────────────────────────────────────────────────────────────────
    _selectFiller(prevToken, nextToken, candidates) {
        const statTok = this._getStatTok();
        if (!statTok || candidates.suffixes.length === 0) return '';

        const lastChar  = (prevToken  || '').slice(-1);
        const firstChar = (nextToken  || '')[0] || '';

        let bestScore  = -1;
        let bestFiller = '';

        for (const { token, conf } of candidates.suffixes) {
            const fillerFirst = token[0] || '';
            const fillerLast  = token.slice(-1);

            // prevToken末尾 → filler先頭 のbigram強度
            const bigramIn  = lastChar && fillerFirst
                ? (statTok.bigramFreq.get(lastChar + fillerFirst) || 0)
                : 0;

            // filler末尾 → nextToken先頭 のbigram強度
            const bigramOut = fillerLast && firstChar
                ? (statTok.bigramFreq.get(fillerLast + firstChar) || 0)
                : 0;

            // 両方向のbigramとsuffixConfを合成してスコア化
            const total = statTok.totalChars || 1;
            const normIn  = bigramIn  / total;
            const normOut = bigramOut / total;
            const score = (normIn * 0.5 + normOut * 0.3) * 1000 + conf * 0.2;

            if (score > bestScore) {
                bestScore  = score;
                bestFiller = token;
            }
        }

        return bestFiller;
    }

    // ── 文末トークンを選ぶ ─────────────────────────────────────────────
    // lastToken の末尾文字と最もつながりやすい wordEndConf高トークンを選ぶ
    _selectEnding(lastToken, candidates) {
        const statTok = this._getStatTok();
        if (candidates.endings.length === 0) return '';

        if (!statTok || !lastToken) return candidates.endings[0].token;

        const lastChar = lastToken.slice(-1);
        let bestScore  = -1;
        let bestEnding = candidates.endings[0].token;

        for (const { token, conf } of candidates.endings) {
            const bigramScore = lastChar
                ? (statTok.bigramFreq.get(lastChar + (token[0] || '')) || 0)
                : 0;
            const total = statTok.totalChars || 1;
            const score = (bigramScore / total) * 1000 + conf;
            if (score > bestScore) {
                bestScore  = score;
                bestEnding = token;
            }
        }

        return bestEnding;
    }

    // ── 意味トークン列 → 発話文字列 ────────────────────────────────────
    // メインの生成関数
    //
    // 統計未成熟期: トークンをそのまま並べる（崩れた文）
    // 統計成熟期  : 各トークン間にbigramが選んだフィラーを挿入 → 自然な文
    // ─────────────────────────────────────────────────────────────────
    generate(meaningTokens, opts = {}) {
        if (!meaningTokens || meaningTokens.length === 0) return '';

        const candidates = this._getCandidates();
        const parts      = [];

        for (let i = 0; i < meaningTokens.length; i++) {
            const tok  = meaningTokens[i];
            const next = meaningTokens[i + 1];

            parts.push(tok);

            if (next !== undefined) {
                if (candidates.ready) {
                    // 統計から「繋ぎ」を選んで挿入
                    const filler = this._selectFiller(tok, next, candidates);
                    if (filler) parts.push(filler);
                }
                // 統計未成熟 → 空でつなぐ（崩れた文として出力）
            }
        }

        // 文末を付加（統計が育っていれば選ばれる）
        if (candidates.ready && candidates.endings.length > 0) {
            const ending = this._selectEnding(parts[parts.length - 1], candidates);
            if (ending && !parts[parts.length - 1].endsWith(ending)) {
                parts.push(ending);
            }
        }

        return parts.join('');
    }
}


// ─────────────────────────────────────────────────────────────────────
// CIR拡張: designSpeech()
//
// 「何を伝えたいか」→ 意味トークン列（因果論理で順序付き）
//
// 設計ステップ：
//   1. CIR履歴からtopicに関連するパターンを検索
//   2. ConceptGraphで概念を展開（is-a / has-property）
//   3. クオリア力場の状態で感情的重みを付与（何を前に出すか）
//   4. 因果論理（cause → statement → is-a → has-prop）で順序整理
// ─────────────────────────────────────────────────────────────────────
function _extendCIRWithDesignSpeech(cir, being) {
    if (cir.designSpeech) return; // 二重定義防止

    cir.designSpeech = function(intent) {
        const { topic, mood } = intent;
        if (!topic) return null;

        try {
            const cg = being.conceptGraph || window._aoConceptGraph;
            const qf = being.qualiaField;

            // ── 1. CIR履歴からtopicに関連するレコードを収集 ─────────────
            const related = this.history.filter(e => {
                const sa = e.stateAfter || {};
                return (
                    sa.subject   === topic ||
                    sa.predicate === topic ||
                    (e.action && e.action.includes(topic))
                );
            }).slice(-30);

            // ── 2. 関係タイプ別に仕分け ───────────────────────────────
            const isARecords     = related.filter(e => e.stateAfter.relationType === 'is-a');
            const hasPropRecords = related.filter(e => e.stateAfter.relationType === 'has-property');
            const causeRecords   = related.filter(e => e.stateAfter.relationType === 'cause');
            const stmtRecords    = related.filter(e => e.stateAfter.relationType === 'statement');

            // ── 3. ConceptGraphから概念を展開 ─────────────────────────
            const cgParents = cg ? [...cg.getParents(topic)] : [];
            const cgProps   = cg ? [...(cg.properties.get(topic) || [])] : [];
            // topicがカテゴリなら、そのメンバーも参照（共通点として使う）
            const cgMembers = cg ? [...(cg.groups.get(topic) || [])].slice(0, 3) : [];

            // ── 4. クオリア力場から「何を前に出すか」の感情的重み ─────
            let emotionalBias = 'neutral'; // default
            if (qf) {
                try {
                    const constraints = qf.getActionConstraints();
                    if (constraints.direction === 'approach') emotionalBias = 'positive';
                    if (constraints.direction === 'avoid')    emotionalBias = 'negative';
                    if (constraints.originMode === 'curious') emotionalBias = 'curious';
                } catch(_) {}
            }

            // ── 5. 因果論理で順序を決める ─────────────────────────────
            // 基本構造: [主題] → [述語/カテゴリ] → [プロパティ/補足] → [結果/因果]
            //
            // cause が育っている → 「AだからB」の文を優先
            // is-a が育っている → 「AはBだ」の文を優先
            // has-prop が育っている → 「AはBを持つ」の文を優先
            const tokens = [];

            // 主題は必ず最初
            tokens.push(topic);

            if (causeRecords.length > 0) {
                // 因果が蓄積 → 「topic だから/なので X」
                const causeTarget = causeRecords[causeRecords.length - 1].stateAfter.predicate;
                if (causeTarget && causeTarget !== topic) tokens.push(causeTarget);
                // is-aも補足として追加
                if (isARecords.length > 0) {
                    const cat = isARecords[isARecords.length - 1].stateAfter.predicate;
                    if (cat && !tokens.includes(cat)) tokens.push(cat);
                }
            } else if (isARecords.length > 0) {
                // is-a が主要 → 「topic は X だ」
                const cat = isARecords[isARecords.length - 1].stateAfter.predicate;
                if (cat && !tokens.includes(cat)) tokens.push(cat);
                // プロパティも補足
                if (hasPropRecords.length > 0) {
                    const prop = hasPropRecords[hasPropRecords.length - 1].stateAfter.predicate;
                    if (prop && !tokens.includes(prop)) tokens.push(prop);
                }
            } else if (hasPropRecords.length > 0) {
                // has-prop → 「topic は X を持つ」
                const prop = hasPropRecords[hasPropRecords.length - 1].stateAfter.predicate;
                if (prop && !tokens.includes(prop)) tokens.push(prop);
            } else if (stmtRecords.length > 0) {
                // 一般述語
                const pred = stmtRecords[stmtRecords.length - 1].stateAfter.predicate;
                if (pred && !tokens.includes(pred)) tokens.push(pred);
            }

            // ConceptGraphから補足（CIR履歴で見つからなかった場合）
            if (tokens.length === 1) {
                if (cgParents.length > 0 && !tokens.includes(cgParents[0])) {
                    tokens.push(cgParents[0]);
                }
                if (cgProps.length > 0 && !tokens.includes(cgProps[0])) {
                    tokens.push(cgProps[0]);
                }
            }

            // 感情バイアスで補足を追加
            if (emotionalBias === 'curious' && cgMembers.length > 0) {
                // 好奇心状態 → メンバーの列挙傾向
                for (const m of cgMembers) {
                    if (!tokens.includes(m)) tokens.push(m);
                }
            }

            // ── 6. この設計をCIRに記録（学習素材として） ────────────────
            this.record(
                `発話設計[${topic}]`,
                { tokens: [] },
                {
                    tokens,
                    relationType:    'speech-design',
                    grammarConf:     related.length > 5 ? 0.7 : 0.3,
                    subject:         topic,
                    predicate:       tokens[1] || '',
                    emotionalBias,
                    relatedCount:    related.length,
                }
            );

            return {
                tokens,
                structure: {
                    hasCause:    causeRecords.length > 0,
                    hasIsA:      isARecords.length > 0,
                    hasProperty: hasPropRecords.length > 0,
                    emotionalBias,
                    relatedCount: related.length,
                },
                topic,
            };

        } catch(e) {
            console.warn('[PIPE7] designSpeech error:', e);
            return { tokens: [topic], structure: {}, topic };
        }
    };
}


// ─────────────────────────────────────────────────────────────────────
// attachPipe7 メイン
// ─────────────────────────────────────────────────────────────────────
function attachPipe7(being) {
    if (!being) return;
    if (being._pipe7Attached) return;
    being._pipe7Attached = true;

    const cir       = being.causalInterventionReasoner;
    const prefrontal = being.prefrontalCoreV1_1;

    if (!cir) {
        console.warn('[PIPE7] CIR 未接続 - リトライ');
        setTimeout(() => { being._pipe7Attached = false; attachPipe7(being); }, 2000);
        return;
    }

    // ── ① CIR に designSpeech() を追加 ─────────────────────────────
    _extendCIRWithDesignSpeech(cir, being);

    // ── ② LanguageOutputGenerator をインスタンス化 ───────────────────
    const generator = new LanguageOutputGenerator(being);
    being._languageOutputGenerator = generator;

    // ── ③ being.speak() : 公開API ───────────────────────────────────
    //
    // 使い方：
    //   const text = await being.speak('犬');
    //   const text = await being.speak({ topic: '犬', mood: being.state });
    //
    // 戻り値：
    //   { text, tokens, structure, confidence }
    // ─────────────────────────────────────────────────────────────────
    being.speak = function(intentOrTopic) {
        try {
            // intent の正規化
            const intent = (typeof intentOrTopic === 'string')
                ? { topic: intentOrTopic }
                : intentOrTopic;

            if (!intent || !intent.topic) return { text: '', tokens: [], confidence: 0 };

            // CIRで発話を設計（何を・どの順で）
            const design = cir.designSpeech(intent);
            if (!design || design.tokens.length === 0) {
                return { text: intent.topic, tokens: [intent.topic], confidence: 0 };
            }

            // 生成エンジンでトークン → 発話文字列
            const text = generator.generate(design.tokens);

            // 信用値：統計成熟度 × CIR関連レコード数
            const statTok    = generator._getStatTok();
            const statReady  = statTok ? Math.min(1, statTok.tokenScores.size / 50) : 0;
            const cirReady   = Math.min(1, (design.structure.relatedCount || 0) / 10);
            const confidence = statReady * 0.5 + cirReady * 0.5;

            being.addLog && being.addLog(
                `[PIPE7] speak: "${text}" | tokens=[${design.tokens.join(',')}] conf=${(confidence*100).toFixed(0)}%`
            );

            return { text, tokens: design.tokens, structure: design.structure, confidence };

        } catch(e) {
            console.warn('[PIPE7] speak error:', e);
            return { text: '', tokens: [], confidence: 0 };
        }
    };

    // ── ④ prefrontal.decide() フック ────────────────────────────────
    // 意思決定野が何かを出力しようとしたとき
    // テキスト発話の意図が含まれていれば being.speak() を走らせる
    // ─────────────────────────────────────────────────────────────────
    const origDecide = prefrontal && prefrontal.decide && prefrontal.decide.bind(prefrontal);
    if (origDecide) {
        prefrontal.decide = function(input) {
            const result = origDecide(input);
            try {
                const chosen = result && (result.chosen || result.decision);
                if (chosen && chosen.text) {
                    const raw = chosen.text;

                    // 画像・音声以外の意図 → テキスト発話を試みる
                    const isImageRequest = /画像|描|イメージ/.test(raw);
                    const isAudioRequest = /音|サウンド|音楽/.test(raw);

                    if (!isImageRequest && !isAudioRequest) {
                        // 意思決定の出力テキストから意味トークンを抽出して発話設計
                        const statTok = generator._getStatTok();
                        const tokens  = statTok && statTok.tokenScores.size > 10
                            ? statTok._segment(raw)
                                  .filter(t => {
                                      const info = statTok.tokenScores.get(t.surface);
                                      return !info
                                          || ((info.delimConf || 0) < 0.5 && (info.suffixConf || 0) < 0.5);
                                  })
                                  .map(t => t.surface)
                            : raw.split(/\s+/).filter(Boolean);

                        if (tokens.length > 0) {
                            const spoken = being.speak({ topic: tokens[0] });
                            if (spoken.text && spoken.confidence > 0.1) {
                                // 発話結果を chosen に反映（UI側が拾えるように）
                                chosen._spokenText = spoken.text;
                                chosen._spokenConf = spoken.confidence;
                                being.addLog && being.addLog(
                                    `[PIPE7] 意思決定→発話: "${spoken.text}" (conf=${(spoken.confidence*100).toFixed(0)}%)`
                                );
                            }
                        }
                    }
                }
            } catch(e) { console.warn('[PIPE7] decide hook error:', e); }
            return result;
        };
    }

    // ── ⑤ selectUtterance() フック ← チャットへの接続点 ────────────
    //
    // 既存の流れ：
    //   languageOutputDL.generate() → テンプレート候補
    //   selectUtterance(candidates, intentVector) → selected.text に格納
    //   addMessage('ao', selected.text) → チャットに表示
    //
    // pipe7の介入：
    //   selectUtterance の後に being.speak(topic) を呼ぶ
    //   confidence が閾値以上なら selected.text を差し替え → チャットに出る
    //   閾値未満なら既存テンプレートのまま（フォールバック）
    //
    // 閾値 0.25：
    //   統計未成熟期 → テンプレート
    //   語彙・因果が育ってきたら → pipe7の文
    // ─────────────────────────────────────────────────────────────────
    // [v28.2] PIPE7はcandidatesに意味核テキストを追加するだけ
    // selectUtteranceのresult.textを直接書き換えない
    // 全てlanguageOutputDL → selectUtterance → チャットの単一ルートを通る
    // Levelごとの処理はlanguageOutputDL側に委ねる

    const PIPE7_THRESHOLD = 0.25;

    // being.languageOutputDLのgenerateをフックしてPIPE7候補を注入する
    const origGenerate = being.languageOutputDL && being.languageOutputDL.generate.bind(being.languageOutputDL);
    if (origGenerate) {
        being.languageOutputDL.generate = async function(intentVector, beingRef) {
            const result = await origGenerate(intentVector, beingRef);
            try {
                const concepts = intentVector && intentVector.concepts;
                const topic = Array.isArray(concepts) && concepts.length > 0
                    ? concepts[0]
                    : null; // intentをtopicにしない

                if (!topic) return result;

                const spoken = being.speak({ topic, mood: being.state || {} });

                if (spoken.text && spoken.confidence >= PIPE7_THRESHOLD) {
                    // PIPE7候補をcandidatesの先頭に追加（selectUtteranceが最終選択）
                    result.candidates.unshift({
                        text: spoken.text,
                        meaningScore: 0.5 + spoken.confidence * 0.5,
                        expressionBias: 0,
                        source: 'pipe7',
                        _pipe7Conf: spoken.confidence,
                        _pipe7Tokens: spoken.tokens
                    });
                    being.addLog && being.addLog(
                        `[PIPE7→DL] "${spoken.text}" conf=${(spoken.confidence*100).toFixed(0)}% → candidates追加`
                    );
                } else {
                    being.addLog && being.addLog(
                        `[PIPE7] conf低(${spoken.confidence ? (spoken.confidence*100).toFixed(0) : 0}%) → テンプレートにフォールバック`
                    );
                }
            } catch(e) {
                console.warn('[PIPE7] generate hook error:', e);
            }
            return result;
        };
        being.addLog && being.addLog('[PIPE7] languageOutputDL.generate → チャット接続完了');
    } else {
        console.warn('[PIPE7] languageOutputDL 未定義 - 接続スキップ');
    }

    // ── ⑥ being.process() フック ────────────────────────────────────
    // 入力処理の後、Aoが「応答を返すべきか」判断して自律発話
    // 会話の流れ（会話の全体）をCIRが参照して設計する
    // ─────────────────────────────────────────────────────────────────
    const origProcess = being.process && being.process.bind(being);
    if (origProcess) {
        being.process = async function(text, ...args) {
            const result = await origProcess(text, ...args);

            // 入力処理後に自律発話を試みる（低頻度・条件付き）
            try {
                // 最近の会話でtopicが浮かび上がっているか（CIR履歴を参照）
                const recentIsA = cir.history
                    .filter(e => e.stateAfter && e.stateAfter.relationType === 'is-a')
                    .slice(-3);

                if (recentIsA.length > 0) {
                    const latestTopic = recentIsA[recentIsA.length - 1].stateAfter.subject;
                    if (latestTopic) {
                        const spoken = being.speak({ topic: latestTopic });
                        if (spoken.text && spoken.confidence > 0.15) {
                            // 応答候補として保存（UIが参照できるように）
                            being._lastSpokenOutput = spoken;
                            being.addLog && being.addLog(
                                `[PIPE7] 自律発話候補: "${spoken.text}"`
                            );
                        }
                    }
                }
            } catch(e) { /* 発話失敗は無視 */ }

            return result;
        };
    }

    console.log('[PIPE7] Language Output Generator 接続完了');
    being.addLog && being.addLog('[PIPE7] CIR→発話エンジン パイプ7 接続完了');
}


// ─────────────────────────────────────────────────────────────────────
// 自動アタッチ
// pipe6 完了後（being.conceptGraph が存在する）を待つ
// ─────────────────────────────────────────────────────────────────────
(function pollForPipe7() {
    const being = window.ao;
    if (being &&
        being.causalInterventionReasoner &&
        being.conceptGraph) {   // pipe2/3 が完了している

        setTimeout(() => {
            try {
                attachPipe7(being);
            } catch(e) {
                console.error('[PIPE7] attachPipe7 error:', e);
            }
        }, 3500); // pipe6(3000ms想定)の後

    } else {
        setTimeout(pollForPipe7, 1000);
    }
})();

window.LanguageOutputGenerator = LanguageOutputGenerator;
window.attachPipe7              = attachPipe7;
