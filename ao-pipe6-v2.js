// ═══════════════════════════════════════════════════════════════════════
// PIPE 6-v2: PrefrontalSpatialReasoningV2
//            空間野（V2） ＋ 因果推論野 ➡️ 確信度メタ認知
//
// 役割：
//   感覚器官V2から得られた「中心点」「境界エッジ」「幾何グリッド」の整合性を
//   推論システム（CIR）および UncertaintyEstimator につなぎ、
//   「画像の空間的信用値」を評価してメタ認知する。
//
// 接続場所：
//   ao-loader.js 経由で自動アタッチ（pollForPipe6_v2）
//   window.ao.activeVisionVersion === 'v2' の時に評価ロジックが走る。
// ═══════════════════════════════════════════════════════════════════════

'use strict';

class PrefrontalSpatialReasoningV2 {
    constructor(being) {
        this.being = being;
        this.cir   = being.causalInterventionReasoner;
        this.ue    = being.uncertaintyEstimator;
    }

    // ─────────────────────────────────────────────────────────────────
    // V2 空間的信用値（幾何・パース整合性）の推定
    // ─────────────────────────────────────────────────────────────────
    estimateSpatialConfidence(v2Result) {
        if (!v2Result) return { confidence: 0.5, entropy: 0.5, reason: 'データなし' };

        const { centerPoint, layers } = v2Result;
        const { boundaryLayer, brightnessLayer } = layers;

        // 1. 消失点（中心点）の安定性スコア
        // 中心点が画面の中央に留まりすぎ、かつエッジが極端に少ない場合は、パースがとれないフラットな画像とみなす
        const isDefaultCenter = Math.abs(centerPoint.normalizedX - 0.5) < 0.01 && 
                                Math.abs(centerPoint.normalizedY - 0.45) < 0.01;
        
        let edgeSum = 0;
        const len = boundaryLayer.length;
        for (let i = 0; i < len; i++) {
            if (boundaryLayer[i] > 100) edgeSum++;
        }
        const edgeDensity = edgeSum / len;

        const geometricConfidence = Number.isFinite(centerPoint.confidence) ? centerPoint.confidence : null;
        let centerConfidence = 1.0;
        if (centerPoint.detected === false) {
            centerConfidence = Math.max(0.15, geometricConfidence || 0.15);
        } else if (geometricConfidence !== null) {
            centerConfidence = geometricConfidence;
        } else if (isDefaultCenter && edgeDensity < 0.02) {
            centerConfidence = 0.3; // 幾何線がほとんど検出できない
        } else if (isDefaultCenter) {
            centerConfidence = 0.6; // 平行投影、または消失点が外にある
        } else {
            // 中心点（消失点）が明確に検出された場合、スコアを高くする
            centerConfidence = 0.95;
        }

        // 2. 境界線と明度変化の整合性スコア
        // 境界線（エッジ）がある場所で、明度（陰影）の変化が激しすぎるとノイズ（砂嵐画像など）と判定する
        let noisePenalties = 0;
        const sampleSize = 1000;
        for (let i = 0; i < sampleSize; i++) {
            const idx = Math.floor(Math.random() * len);
            if (boundaryLayer[idx] > 120 && brightnessLayer[idx] < 20) {
                noisePenalties++;
            }
        }
        const noiseRate = noisePenalties / sampleSize;
        const structureScore = Math.max(0.0, 1.0 - noiseRate * 4);

        // 3. 複合エントロピー計算
        const entropy = Math.min(1.0, 
            (1.0 - centerConfidence) * 0.5 + 
            (1.0 - structureScore) * 0.5
        );
        const confidence = 1.0 - entropy;

        let reason = '空間構造: 安定';
        if (confidence < 0.4) reason = '空間構造: 幾何学的ノイズ大';
        else if (confidence < 0.65) reason = '空間構造: フラット（遠近感低）';

        return { confidence, entropy, reason };
    }

    // ─────────────────────────────────────────────────────────────────
    // 空間メタ認知の実行＆記録
    // ─────────────────────────────────────────────────────────────────
    evaluateAndRecord(name, v2Result) {
        const evalRes = this.estimateSpatialConfidence(v2Result);

        // UncertaintyEstimator に履歴として記録
        const ue = this.being.uncertaintyEstimator || this.ue;
        if (ue && ue._record) {
            try {
                ue._record(`v2_spatial::${name}`, evalRes.entropy);
            } catch(e) { /* ignore */ }
        }

        // 因果推論野（CIR）に空間評価結果を記録
        if (this.cir) {
            try {
                this.cir.record(
                    `空間評価[${name}]`,
                    { verified: false, spatialConfidence: 0.5 },
                    {
                        verified:          true,
                        spatialConfidence: evalRes.confidence,
                        spatialEntropy:    evalRes.entropy,
                        spatialReason:     evalRes.reason,
                        centerPointX:      v2Result.centerPoint.normalizedX,
                        centerPointY:      v2Result.centerPoint.normalizedY,
                    }
                );
            } catch(e) { /* ignore */ }
        }

        return evalRes;
    }
}

// ─────────────────────────────────────────────────────────────────────
// attachPipe6_v2
// ─────────────────────────────────────────────────────────────────────
function attachPipe6_v2(being) {
    if (!being) return;
    if (being._pipe6V2Attached) return;
    being._pipe6V2Attached = true;

    const ue = being.uncertaintyEstimator;
    const cir = being.causalInterventionReasoner;

    if (!ue || !cir) {
        console.warn('[PIPE6-v2] 確信度推定器またはCIR未接続 - 後でリトライ');
        setTimeout(() => {
            being._pipe6V2Attached = false;
            attachPipe6_v2(being);
        }, 2000);
        return;
    }

    const prV2 = new PrefrontalSpatialReasoningV2(being);
    being.prefrontalSpatialReasoningV2 = prV2;

    // ImageAdapter のフック
    const adapter = being.imageAdapter;
    if (adapter) {
        const origExtract = adapter.extractMeaning;
        adapter.extractMeaning = async function(imageData) {
            const res = await origExtract.call(this, imageData);
            if (being.activeVisionVersion === 'v2' && res && res.v2) {
                const evalRes = prV2.evaluateAndRecord(res.raw_descriptor || 'image', res.v2);
                res.v2_spatial_eval = evalRes;
                res.raw_descriptor += ` 信用:${(evalRes.confidence * 100).toFixed(0)}% (${evalRes.reason})`;
            }
            return res;
        };
    }

    console.log('[PIPE6-v2] PrefrontalSpatialReasoningV2 (V2推論パイプ) 接続完了');
    being.addLog && being.addLog('[PIPE6-v2] 空間メタ認知パイプ6-v2 接続完了 (空間野・CIR ➡️ 確信度推定)');
}

// 自動アタッチ
(function pollForPipe6_v2() {
    const being = window.ao;
    if (being && being.uncertaintyEstimator && being.causalInterventionReasoner) {
        setTimeout(() => {
            try {
                attachPipe6_v2(being);
            } catch(e) {
                console.error('[PIPE6-v2] attachPipe6_v2 error:', e);
            }
        }, 800);
    } else {
        setTimeout(pollForPipe6_v2, 1000);
    }
})();

window.PrefrontalSpatialReasoningV2 = PrefrontalSpatialReasoningV2;
window.attachPipe6_v2              = attachPipe6_v2;
