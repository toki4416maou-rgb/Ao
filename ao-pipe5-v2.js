// ═══════════════════════════════════════════════════════════════════════
// PIPE 5-v2: SensoryAssetBridgeV2
//            素材ファイル → 感覚器官（ao-gpu-v2.js / AudioContext） → CIR ＆ 空間野
//
// 役割：
//   動画・画像ファイルを感覚器官（V2：レイヤー分解・中心点・幾何遠近線）に通し、
//   立体空間情報・カメラワーク動きを抽出して CIR ＆ 空間野へ投影する。
//
// 接続場所：
//   ao-loader.js 経由で自動アタッチ（pollForPipe5_v2）
//   window.ao.activeVisionVersion === 'v2' の時に動作する。
// ═══════════════════════════════════════════════════════════════════════

'use strict';

class SensoryAssetBridgeV2 {
    constructor(being) {
        this.being    = being;
        this.cir      = being.causalInterventionReasoner;
        this.gpuV2    = window.aoGPU_v2 || null;
        this._cache   = new Map(); // filename → 感覚サマリ（V2）
    }

    // ── 画像ファイルから V2 特徴量を抽出 ─────────────────────────────
    async _extractImageFeaturesV2(src) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                try {
                    const SIZE = 256;
                    const cv   = document.createElement('canvas');
                    cv.width   = SIZE;
                    cv.height  = SIZE;
                    const ctx  = cv.getContext('2d');
                    ctx.drawImage(img, 0, 0, SIZE, SIZE);
                    const imgData = ctx.getImageData(0, 0, SIZE, SIZE);

                    const gpuV2 = window.aoGPU_v2 || this.gpuV2;
                    if (gpuV2 && gpuV2.computeFeaturesV2) {
                        const features = gpuV2.computeFeaturesV2(imgData);
                        resolve(features || this._cpuFallbackV2(imgData));
                    } else {
                        resolve(this._cpuFallbackV2(imgData));
                    }
                } catch (e) {
                    resolve(null);
                }
            };
            img.onerror = () => resolve(null);

            if (src instanceof File) {
                img.src = URL.createObjectURL(src);
            } else {
                img.src = src;
            }
        });
    }

    // ── V2用 CPUフォールバック ──────────────────────────────────────────
    _cpuFallbackV2(imgData) {
        const width = imgData.width || 256;
        const height = imgData.height || 256;
        const colorLayer = new Uint8ClampedArray(width * height);
        const brightnessLayer = new Uint8ClampedArray(width * height);
        const boundaryLayer = new Uint8ClampedArray(width * height);
        const textureLayer = new Uint8ClampedArray(width * height);
        const perspectiveGrid = new Uint8ClampedArray(width * height);

        // ダミーのフラットデータ
        brightnessLayer.fill(128);
        return {
            layers: { colorLayer, brightnessLayer, boundaryLayer, textureLayer },
            centerPoint: { x: width/2, y: height/2, normalizedX: 0.5, normalizedY: 0.5 },
            perspectiveGrid,
            processingTimeMs: 1
        };
    }

    // ── 動画ファイル → 3フレームサンプリング ＆ 消失点トラッキング ──
    async _extractVideoFeaturesV2(file) {
        return new Promise((resolve) => {
            const video = document.createElement('video');
            video.muted    = true;
            video.preload  = 'metadata';
            const url      = URL.createObjectURL(file);
            video.src      = url;

            video.onloadedmetadata = async () => {
                const duration = video.duration || 1;
                const seekPoints = [
                    duration * 0.1,  // 開始
                    duration * 0.5,  // 中間
                    duration * 0.9,  // 終了
                ];

                const frameResults = [];

                for (const t of seekPoints) {
                    const feat = await this._captureVideoFrameV2(video, t);
                    if (feat) frameResults.push(feat);
                }

                URL.revokeObjectURL(url);

                if (frameResults.length === 0) {
                    resolve(null);
                    return;
                }

                // フレーム間の中心点（消失点）の変動を計算し、カメラワーク（Pan/Zoom/Still）を識別
                let dx = 0, dy = 0;
                for (let i = 1; i < frameResults.length; i++) {
                    dx += Math.abs(frameResults[i].centerPoint.normalizedX - frameResults[i-1].centerPoint.normalizedX);
                    dy += Math.abs(frameResults[i].centerPoint.normalizedY - frameResults[i-1].centerPoint.normalizedY);
                }
                const motionThreshold = 0.05;
                const cameraMotion = (dx > motionThreshold || dy > motionThreshold) ? 'pan' : 'still';

                // 代表フレームとして中間フレーム、または平均値を使用
                const midFrame = frameResults[Math.floor(frameResults.length / 2)] || frameResults[0];

                resolve({
                    layers: midFrame.layers,
                    centerPoint: midFrame.centerPoint,
                    perspectiveGrid: midFrame.perspectiveGrid,
                    motionDelta: { dx, dy },
                    cameraMotion: cameraMotion,
                    framesAnalyzed: frameResults.length
                });
            };

            video.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(null);
            };
        });
    }

    _captureVideoFrameV2(video, time) {
        return new Promise((resolve) => {
            video.currentTime = time;
            const onSeek = () => {
                video.removeEventListener('seeked', onSeek);
                try {
                    const SIZE = 256;
                    const cv   = document.createElement('canvas');
                    cv.width   = SIZE;
                    cv.height  = SIZE;
                    const ctx  = cv.getContext('2d');
                    ctx.drawImage(video, 0, 0, SIZE, SIZE);
                    const imgData = ctx.getImageData(0, 0, SIZE, SIZE);

                    const gpuV2 = window.aoGPU_v2 || this.gpuV2;
                    const feat = gpuV2 && gpuV2.computeFeaturesV2
                        ? gpuV2.computeFeaturesV2(imgData)
                        : this._cpuFallbackV2(imgData);

                    resolve(feat);
                } catch(e) {
                    resolve(null);
                }
            };
            video.addEventListener('seeked', onSeek);
        });
    }

    // ── V2感覚特徴量 → CIRに渡すサマリに変換 ─────────────────────────────
    _toSensorySummaryV2(features, fileType) {
        if (!features) return null;

        // レイヤー分解結果の統計計算
        const { colorLayer, brightnessLayer, boundaryLayer, textureLayer } = features.layers;
        const len = brightnessLayer.length;

        let avgColor = 0;
        let avgBright = 0;
        let avgEdge = 0;
        let avgTexture = 0;

        for (let i = 0; i < len; i++) {
            avgColor   += colorLayer[i];
            avgBright  += brightnessLayer[i];
            avgEdge    += boundaryLayer[i];
            avgTexture += textureLayer[i];
        }

        avgColor   /= (len * 255);
        avgBright  /= (len * 255);
        avgEdge    /= (len * 255);
        avgTexture /= (len * 255);

        return {
            type:         fileType,
            avgColor,
            avgBright,
            avgEdge,
            avgTexture,
            centerPoint:  features.centerPoint,
            cameraMotion: features.cameraMotion || 'still',
            motionDelta:  features.motionDelta  || { dx: 0, dy: 0 },
            // 感情マッピング
            joy:          avgBright,
            tension:      avgEdge * 4,
            curiosity:    avgTexture * 6 + (features.motionDelta ? Math.hypot(features.motionDelta.dx, features.motionDelta.dy) * 5 : 0),
        };
    }

    // ── メイン処理：1ファイルをV2感覚器官に通してCIR＆空間野に記録 ──
    async processFileV2(file) {
        if (!file || !this.cir) return null;

        const name = file.name || 'unknown';
        if (this._cache.has(name)) return this._cache.get(name);

        const type = file.type || '';
        let features = null;
        let fileType = 'unknown';

        if (type.startsWith('image/')) {
            features = await this._extractImageFeaturesV2(file);
            fileType = 'image';
        } else if (type.startsWith('video/')) {
            features = await this._extractVideoFeaturesV2(file);
            fileType = 'video';
        } else if (type.startsWith('audio/')) {
            // 音声はV1のブリッジにフォールバック（またはPipe5本体で定義された処理を流用）
            if (this.being.sensoryAssetBridge) {
                return this.being.sensoryAssetBridge.processFile(file);
            }
            return null;
        } else {
            return null;
        }

        const summary = this._toSensorySummaryV2(features, fileType);
        if (!summary) return null;

        // CIRへの感覚イベント記録
        const action = `感覚V2[${fileType}]::${name}`;
        const stateBefore = {
            emotionalState: 'sensing',
            known:          false,
            tension:        0.4,
        };
        const stateAfter = {
            emotionalState: 'sensed',
            known:          true,
            fileType,
            fileName:       name,
            joy:            summary.joy,
            tension:        summary.tension,
            curiosity:      summary.curiosity,
            centerPointX:   summary.centerPoint.normalizedX,
            centerPointY:   summary.centerPoint.normalizedY,
            cameraMotion:   summary.cameraMotion,
            ...summary
        };

        this.cir.record(action, stateBefore, stateAfter);

        // 空間野（SpatialInteractionModel）へ投影
        const sp = this.being.spatialState || this.being.spatialInteractionModel;
        if (sp && sp.update) {
            try {
                sp.update(name, {
                    motionType:    summary.cameraMotion,
                    poseDiversity: summary.curiosity,
                    avgBright:     summary.avgBright,
                    centerPoint:   summary.centerPoint, // 消失点を渡す
                    v2Enabled:     true
                });
                console.log(`[PIPE5-v2] 空間野アップデート完了: ${name} (消失点: ${summary.centerPoint.normalizedX.toFixed(2)}, ${summary.centerPoint.normalizedY.toFixed(2)})`);
            } catch(e) {
                console.warn('[PIPE5-v2] 空間野アップデート失敗:', e);
            }
        }

        this._cache.set(name, summary);

        this.being.addLog && this.being.addLog(
            `[PIPE5-v2] 感覚 V2 ${fileType}: ${name} ` +
            `消失点=(${summary.centerPoint.normalizedX.toFixed(2)}, ${summary.centerPoint.normalizedY.toFixed(2)}) ` +
            `camera=${summary.cameraMotion}`
        );

        return summary;
    }

    async processFilesV2(files) {
        const results = [];
        for (const file of files) {
            const r = await this.processFileV2(file);
            if (r) results.push({ name: file.name, summary: r });
        }
        this.being.addLog && this.being.addLog(
            `[PIPE5-v2] 感覚処理完了: ${results.length}/${files.length}ファイル → CIR＆空間野にV2記録`
        );
        return results;
    }
}

// ─────────────────────────────────────────────────────────────────────
// attachPipe5_v2
// ─────────────────────────────────────────────────────────────────────
function attachPipe5_v2(being) {
    if (!being) return;
    if (being._pipe5V2Attached) return;
    being._pipe5V2Attached = true;

    const cir = being.causalInterventionReasoner;
    const ve  = being.videoEditing;

    if (!cir || !ve) {
        console.warn('[PIPE5-v2] CIR または VideoEditing 未接続 - 後でリトライ');
        setTimeout(() => {
            being._pipe5V2Attached = false;
            attachPipe5_v2(being);
        }, 2000);
        return;
    }

    const bridgeV2 = new SensoryAssetBridgeV2(being);
    being.sensoryAssetBridgeV2 = bridgeV2;

    // VideoEditingIntegration.createProject() のフックをV2モードに対応させる
    const origCreate = ve.createProject.bind(ve);

    ve.createProject = async function(intent, folderPath, projectName, format) {
        if (Array.isArray(folderPath) && folderPath.length > 0) {
            // アクティブなビジョンバージョンが v2 の場合のみV2ブリッジを通す
            if (being.activeVisionVersion === 'v2') {
                being.addLog && being.addLog(`[PIPE5-v2] 素材${folderPath.length}件をV2幾何感覚器官に通します...`);
                try {
                    await bridgeV2.processFilesV2(folderPath);
                } catch(e) {
                    console.warn('[PIPE5-v2] V2感覚処理エラー:', e);
                }
            } else if (being.sensoryAssetBridge) {
                // V1フォールバック
                being.addLog && being.addLog(`[PIPE5] 素材${folderPath.length}件をV1感覚器官に通します...`);
                try {
                    await being.sensoryAssetBridge.processFiles(folderPath);
                } catch(e) {
                    console.warn('[PIPE5] V1感覚処理エラー:', e);
                }
            }
        }

        return origCreate(intent, folderPath, projectName, format);
    };

    console.log('[PIPE5-v2] SensoryAssetBridgeV2 (V2感覚パイプ) 接続完了');
    being.addLog && being.addLog('[PIPE5-v2] 素材感覚パイプ5-v2 接続完了 (消失点/幾何グリッド → 空間野/CIR)');
}

// 自動アタッチ
(function pollForPipe5_v2() {
    const being = window.ao;
    if (being && being.causalInterventionReasoner && being.videoEditing) {
        setTimeout(() => {
            try {
                attachPipe5_v2(being);
            } catch(e) {
                console.error('[PIPE5-v2] attachPipe5_v2 error:', e);
            }
        }, 500);
    } else {
        setTimeout(pollForPipe5_v2, 1000);
    }
})();

window.SensoryAssetBridgeV2 = SensoryAssetBridgeV2;
window.attachPipe5_v2        = attachPipe5_v2;
