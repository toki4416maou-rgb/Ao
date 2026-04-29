// ═══════════════════════════════════════════════════════════════════════
// PIPE 4: 4軸統計信用値 → StatisticalTokenizer
//
// 役割：
//   StatisticalTokenizer に
//   接尾語・語末・位置・区切り の4軸信用値を統計のみで付与する。
//   意味は一切ハードコードしない。
//   トークンの「使われ方・位置関係」の観測だけで浮かび上がる。
//
// 繋ぎ方：
//   _updateFrequencies() に並列カウンターを追加（既存コード不変）
//   _rebuildVocab()       に4軸信用値の合成を追加
//   _segment()            に合成スコアによる境界判定を追加
//
// ═══════════════════════════════════════════════════════════════════════

function attachPipe4(being) {
    if (!being) return;
    if (being._pipe4Attached) return;
    being._pipe4Attached = true;

    // StatisticalTokenizer は languageOutputDL.languageAcquisition.perceptualParser
    const statTok = being.statisticalTokenizer
        || (being.languageOutputDL
            && being.languageOutputDL.languageAcquisition
            && being.languageOutputDL.languageAcquisition.perceptualParser);

    if (!statTok) {
        console.warn('[PIPE4] StatisticalTokenizer 未接続 - リトライ');
        setTimeout(() => { being._pipe4Attached = false; attachPipe4(being); }, 2000);
        return;
    }

    // ─────────────────────────────────────────────────────────────────
    // 4軸カウンター（トークンごとに統計を蓄積）
    // ─────────────────────────────────────────────────────────────────
    // suffixCount   : トークンの直前に別トークンが来た回数
    //                 かつ直後でunigramFreqが急変した回数
    // wordEndCount  : トークンが文末付近（後ろ20%以内）に出た回数
    // positionSum   : 出現した相対位置（0.0〜1.0）の累積
    // positionCount : 出現回数
    // delimCount    : トークンの前後でPMIが急落した回数
    // total         : 総出現回数

    statTok._axis4 = new Map();
    // { token → { suffixCount, wordEndCount, posSum, posCount, delimCount, total } }

    function getAxis(token) {
        if (!statTok._axis4.has(token)) {
            statTok._axis4.set(token, {
                suffixCount:  0,
                wordEndCount: 0,
                posSum:       0,
                posCount:     0,
                delimCount:   0,
                total:        0,
            });
        }
        return statTok._axis4.get(token);
    }

    // ─────────────────────────────────────────────────────────────────
    // _updateFrequencies() をラップ → 4軸カウンターを並列更新
    // ─────────────────────────────────────────────────────────────────
    const origUpdateFreq = statTok._updateFrequencies.bind(statTok);

    statTok._updateFrequencies = function(text) {
        origUpdateFreq(text);   // 既存処理は必ず通す

        try {
            const chars  = [...text];
            const len    = chars.length;
            if (len < 2) return;

            // ── トークン候補を文字種境界で粗く抽出 ──────────────────
            // （vocab未確定でも動くよう文字種境界を使う）
            const segments = _roughSegment(text, statTok);

            segments.forEach((seg, idx) => {
                const token = seg.surface;
                if (!token || token.length === 0) return;

                const ax = getAxis(token);
                ax.total++;

                // 相対位置（0.0=文頭, 1.0=文末）
                const relPos = segments.length > 1 ? idx / (segments.length - 1) : 0.5;
                ax.posSum   += relPos;
                ax.posCount++;

                // 語末信用値：文末付近（relPos > 0.8）に出る頻度
                if (relPos > 0.8) ax.wordEndCount++;

                // 接尾語信用値：直前に別セグメントがあり直後も別セグメントがある
                // つまり「挟まれている」トークンが接尾語候補
                const hasPrev = idx > 0;
                const hasNext = idx < segments.length - 1;
                if (hasPrev && hasNext) {
                    // 直後のトークンのunigramFreqが直前と大きく違う → 意味境界
                    const prevChar = segments[idx - 1].surface.slice(-1);
                    const nextChar = hasNext ? segments[idx + 1].surface[0] : '';
                    const freqPrev = statTok.unigramFreq.get(prevChar) || 0;
                    const freqNext = statTok.unigramFreq.get(nextChar) || 0;
                    const freqRatio = freqPrev > 0 ? Math.abs(freqNext - freqPrev) / freqPrev : 0;
                    if (freqRatio > 0.3) ax.suffixCount++;
                }

                // 区切り信用値：このトークンの前後でbigramのPMIが急落するか
                if (hasPrev && hasNext) {
                    const prevTok = segments[idx - 1].surface;
                    const nextTok = segments[idx + 1].surface;
                    // トークン内部のPMI vs トークン境界のPMI
                    const innerPMI  = _bigramPMI(statTok, token[0], token.slice(-1));
                    const outerPMI1 = _bigramPMI(statTok, prevTok.slice(-1), token[0]);
                    const outerPMI2 = _bigramPMI(statTok, token.slice(-1), nextTok[0]);
                    const outerPMI  = (outerPMI1 + outerPMI2) / 2;
                    // 内部PMIより外部PMIが低い → 境界になりやすい
                    if (innerPMI - outerPMI > 0.2) ax.delimCount++;
                }
            });
        } catch(e) {
            console.warn('[PIPE4] _updateFrequencies hook error:', e);
        }
    };

    // ─────────────────────────────────────────────────────────────────
    // _rebuildVocab() をラップ → 4軸信用値を tokenScores に合成
    // ─────────────────────────────────────────────────────────────────
    const origRebuild = statTok._rebuildVocab.bind(statTok);

    statTok._rebuildVocab = function() {
        origRebuild();   // 既存のPMIスコア計算は必ず通す

        try {
            // 各トークンの4軸信用値を計算して tokenScores に追記
            for (const [token, info] of statTok.tokenScores) {
                const ax = statTok._axis4.get(token);
                if (!ax || ax.total === 0) continue;

                // ── 各軸の信用値（0〜1）──────────────────────────────
                // suffixConf  : 接尾語として使われた割合
                const suffixConf  = ax.suffixCount / ax.total;

                // wordEndConf : 語末として使われた割合
                const wordEndConf = ax.wordEndCount / ax.total;

                // positionConf: 位置の一貫性（分散が低いほど高い）
                //   平均位置からのばらつきが小さい = 固定位置に出る = 位置が意味を持つ
                const avgPos = ax.posSum / ax.posCount;
                const posVariance = _posVariance(token, statTok._corpus || [], avgPos);
                const positionConf = Math.max(0, 1 - posVariance * 4);

                // delimConf   : 区切りとして機能した割合
                const delimConf   = ax.delimCount / ax.total;

                // ── 既存スコアに4軸を合成 ────────────────────────────
                // 4軸の中で最も強い信号を使って既存スコアを補正する
                // （意味を決めるのではなく「このトークンの役割の強さ」として）
                const axis4Score = Math.max(suffixConf, wordEndConf, positionConf, delimConf);
                const combined   = info.score * 0.6 + axis4Score * 0.4;

                // tokenScores に4軸情報を追記
                info.suffixConf   = suffixConf;
                info.wordEndConf  = wordEndConf;
                info.positionConf = positionConf;
                info.delimConf    = delimConf;
                info.axis4Score   = axis4Score;
                info.score        = Math.min(1, combined);
            }
        } catch(e) {
            console.warn('[PIPE4] _rebuildVocab hook error:', e);
        }
    };

    // ─────────────────────────────────────────────────────────────────
    // _segment() をラップ → 4軸信用値を境界判定に使う
    // ─────────────────────────────────────────────────────────────────
    const origSegment = statTok._segment.bind(statTok);

    statTok._segment = function(text) {
        const tokens = origSegment(text);   // 既存の最長一致結果

        try {
            // 4軸信用値で境界を補正する
            // delimConfが高いトークンの前後は境界として強化
            // positionConfが高いトークンは位置ベースの意味を保持
            const result = [];
            for (let i = 0; i < tokens.length; i++) {
                const tok  = tokens[i];
                const info = statTok.tokenScores.get(tok.surface);

                if (info) {
                    // 4軸情報をトークンに付与（PIPE1が参照できるようにする）
                    tok.suffixConf   = info.suffixConf   || 0;
                    tok.wordEndConf  = info.wordEndConf  || 0;
                    tok.positionConf = info.positionConf || 0;
                    tok.delimConf    = info.delimConf    || 0;
                    tok.axis4Score   = info.axis4Score   || 0;

                    // delimConfが高いトークンの後を境界として明示
                    tok.isBoundary = (info.delimConf || 0) > 0.5;

                    // 合成スコアで更新
                    tok.score = info.score;
                }

                result.push(tok);
            }
            return result;
        } catch(e) {
            console.warn('[PIPE4] _segment hook error:', e);
            return tokens;
        }
    };

    // ─────────────────────────────────────────────────────────────────
    // exportState / importState に4軸データを追加
    // ─────────────────────────────────────────────────────────────────
    const origExport = statTok.exportState.bind(statTok);
    statTok.exportState = function() {
        const data = origExport();
        try {
            data.axis4 = [...statTok._axis4.entries()].map(([k, v]) => [k, v]);
        } catch(e) {}
        return data;
    };

    const origImport = statTok.importState.bind(statTok);
    statTok.importState = function(data) {
        origImport(data);
        try {
            if (data.axis4) {
                statTok._axis4 = new Map(data.axis4.map(([k, v]) => [k, v]));
            }
        } catch(e) {}
    };

    // ─────────────────────────────────────────────────────────────────
    // PIPE1との連携：extractPerceptualFeatures() に4軸情報を追加
    // PIPE1はこれを使ってgrammarConfidenceをより精度高く計算できる
    // ─────────────────────────────────────────────────────────────────
    const origExtract = statTok.extractPerceptualFeatures.bind(statTok);
    statTok.extractPerceptualFeatures = function(utterance, tokens) {
        const feats = origExtract(utterance, tokens);
        try {
            // 文全体の4軸平均信用値を付与
            const toks = tokens || statTok.tokenize(utterance);
            let sumSuffix = 0, sumEnd = 0, sumPos = 0, sumDelim = 0, count = 0;
            for (const tok of toks) {
                const info = statTok.tokenScores.get(tok.surface || tok);
                if (info) {
                    sumSuffix += info.suffixConf   || 0;
                    sumEnd    += info.wordEndConf   || 0;
                    sumPos    += info.positionConf  || 0;
                    sumDelim  += info.delimConf     || 0;
                    count++;
                }
            }
            if (count > 0) {
                feats.avgSuffixConf   = sumSuffix / count;
                feats.avgWordEndConf  = sumEnd    / count;
                feats.avgPositionConf = sumPos    / count;
                feats.avgDelimConf    = sumDelim  / count;
            }
        } catch(e) {}
        return feats;
    };

    console.log('[PIPE4] 4軸統計信用値 → StatisticalTokenizer 接続完了');
    being.addLog && being.addLog('[PIPE4] 接尾語・語末・位置・区切り 4軸パイプ接続完了');
}

// ─────────────────────────────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────────────────────────────

// 文字種境界による粗いセグメント（vocab未確定時用）
function _roughSegment(text, statTok) {
    const chars = [...text];
    const segs  = [];
    let start   = 0;
    for (let i = 1; i <= chars.length; i++) {
        const isBound = i === chars.length
            || statTok._isInfraChar(text.charCodeAt(i))
            || statTok._isCharTypeBoundary(text.charCodeAt(i - 1), text.charCodeAt(i));
        if (isBound) {
            const seg = chars.slice(start, i).join('').trim();
            if (seg.length > 0) segs.push({ surface: seg });
            start = i;
        }
    }
    return segs;
}

// bigramのPMIを計算
function _bigramPMI(statTok, a, b) {
    if (!a || !b) return 0;
    const total = Math.max(statTok.totalChars, 1);
    const pAB   = (statTok.bigramFreq.get(a + b) || 0) / total;
    const pA    = (statTok.unigramFreq.get(a) || 0) / total;
    const pB    = (statTok.unigramFreq.get(b) || 0) / total;
    if (pAB <= 0 || pA <= 0 || pB <= 0) return 0;
    const raw    = Math.log2(pAB / (pA * pB));
    const maxPMI = -Math.log2(pAB);
    return maxPMI > 0 ? Math.max(-1, Math.min(1, raw / maxPMI)) : 0;
}

// コーパス上での位置分散を計算
function _posVariance(token, corpus, avgPos) {
    let sum = 0, count = 0;
    for (const text of corpus.slice(-50)) {  // 直近50文だけ使う（軽量化）
        const segs = text.split(/[\s　、。]/);
        const idx  = segs.findIndex(s => s.includes(token));
        if (idx < 0 || segs.length <= 1) continue;
        const pos = idx / (segs.length - 1);
        sum += Math.pow(pos - avgPos, 2);
        count++;
    }
    return count > 0 ? sum / count : 1;
}

// ─────────────────────────────────────────────────────────────────────
// 自動アタッチ
// ─────────────────────────────────────────────────────────────────────
(function pollForPipe4() {
    const being = window.ao;
    const statTok = being && (
        being.statisticalTokenizer
        || (being.languageOutputDL
            && being.languageOutputDL.languageAcquisition
            && being.languageOutputDL.languageAcquisition.perceptualParser)
    );

    if (being && statTok) {
        setTimeout(() => {
            try { attachPipe4(being); } catch(e) { console.error('[PIPE4] error:', e); }
        }, 2500);
    } else {
        setTimeout(pollForPipe4, 1000);
    }
})();

window.attachPipe4 = attachPipe4;
