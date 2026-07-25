/*!
 * ao-gpu-v2.js  v2.0 – Ao V2 空間・幾何認識モジュール
 *
 * 概要:
 *   画像を「色」「明度」「境界」「質感」の4レイヤーに分解。
 *   境界線の収束方向から「中心点 (消失点 / Focus of Expansion)」を算出し、
 *   立体感の基盤となる「幾何学遠近潜在線」を最奥レイヤーに配置する。
 *
 * 接続方法:
 *   ao-loader.js からロードされ、自動的に window.aoGPU_v2 に登録される。
 *   window.ao.activeVisionVersion === 'v2' の時に実行される。
 */

(function () {
'use strict';

const IMG_SIZE = 1024; // 高解像度・高幾何パースペクティブ対応基盤

class AoGPUV2Accelerator {
    constructor() {
        this.initialized = false;
        this._stats = { calls: 0, totalMs: 0, errors: 0 };
    }

    async init() {
        // 初期化処理（必要に応じてCanvasやWebGLコンテキストを確保）
        this.initialized = true;
        console.log('[AoGPU-v2] V2空間幾何プロセッサ初期化完了');
        return true;
    }

    // ─────────────────────────────────────────────────────────────────
    // ① 多層レイヤー分解 (色、明度、境界、質感)
    // ─────────────────────────────────────────────────────────────────
    decomposeLayers(imgData) {
        const width = imgData.width;
        const height = imgData.height;
        const data = imgData.data;

        // 各レイヤーバッファ (灰度スケールで表現)
        const colorLayer      = new Uint8ClampedArray(width * height);
        const brightnessLayer = new Uint8ClampedArray(width * height);
        const boundaryLayer   = new Uint8ClampedArray(width * height);
        const textureLayer    = new Uint8ClampedArray(width * height);

        // 明度 (輝度) マップの事前計算
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i+1];
            const b = data[i+2];
            const idx = i / 4;

            // 明度 (Luminance)
            const Y = Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b));
            brightnessLayer[idx] = Y;

            // 色 (彩度・色相の強さ)
            const maxVal = Math.max(r, g, b);
            const minVal = Math.min(r, g, b);
            const chroma = maxVal - minVal;
            colorLayer[idx] = Math.min(255, chroma * 2); // 強調表現
        }

        // 境界 (Sobelフィルタによるエッジ検出) & 質感 (LBPによる局所テクスチャ)
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;

                // --- Sobel エッジ検出 ---
                const gx = (
                    -1 * brightnessLayer[(y-1)*width + (x-1)] + 1 * brightnessLayer[(y-1)*width + (x+1)] +
                    -2 * brightnessLayer[y*width + (x-1)]     + 2 * brightnessLayer[y*width + (x+1)] +
                    -1 * brightnessLayer[(y+1)*width + (x-1)] + 1 * brightnessLayer[(y+1)*width + (x+1)]
                );
                const gy = (
                    -1 * brightnessLayer[(y-1)*width + (x-1)] - 2 * brightnessLayer[(y-1)*width + x] - 1 * brightnessLayer[(y-1)*width + (x+1)] +
                    1 * brightnessLayer[(y+1)*width + (x-1)] + 2 * brightnessLayer[(y+1)*width + x] + 1 * brightnessLayer[(y+1)*width + (x+1)]
                );
                const edge = Math.min(255, Math.round(Math.sqrt(gx * gx + gy * gy)));
                boundaryLayer[idx] = edge > 45 ? edge : 0; // ノイズカットの閾値処理

                // --- LBP (Local Binary Pattern) による質感 ---
                const center = brightnessLayer[idx];
                let code = 0;
                if (brightnessLayer[(y-1)*width + (x-1)] >= center) code |= 1;
                if (brightnessLayer[(y-1)*width + x]     >= center) code |= 2;
                if (brightnessLayer[(y-1)*width + (x+1)] >= center) code |= 4;
                if (brightnessLayer[y*width + (x+1)]     >= center) code |= 8;
                if (brightnessLayer[(y+1)*width + (x+1)] >= center) code |= 16;
                if (brightnessLayer[(y+1)*width + x]     >= center) code |= 32;
                if (brightnessLayer[(y+1)*width + (x-1)] >= center) code |= 64;
                if (brightnessLayer[y*width + (x-1)]     >= center) code |= 128;
                textureLayer[idx] = code;
            }
        }

        return { colorLayer, brightnessLayer, boundaryLayer, textureLayer };
    }

    // ─────────────────────────────────────────────────────────────────
    // ② 中心点 (消失点 / Focus of Expansion) の検出
    // ─────────────────────────────────────────────────────────────────
    extractCenterPoint(boundaryLayer, brightnessLayer, width, height) {
        // ハフ変換に近いアプローチで、エッジ（境界線）の延長線が最も交差する場所を特定
        const acc = new Int32Array(width * height);
        const step = 8; // 計算量削減のためのサンプリング間隔

        for (let y = step; y < height - step; y += step) {
            for (let x = step; x < width - step; x += step) {
                const idx = y * width + x;
                const edge = boundaryLayer[idx];
                if (edge < 100) continue; // 強い境界線のみを使用

                // 局所の明度グラデーション（法線方向）を計算
                const dx = brightnessLayer[y*width + (x+1)] - brightnessLayer[y*width + (x-1)];
                const dy = brightnessLayer[(y+1)*width + x] - brightnessLayer[(y-1)*width + x];
                if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;

                // 法線の傾き
                const angle = Math.atan2(dy, dx);
                // 延長線上の点をアキュムレータ（蓄積器）に加算
                const cos = Math.cos(angle + Math.PI/2); // 直交（線の進む）方向
                const sin = Math.sin(angle + Math.PI/2);

                for (let d = -120; d <= 120; d += 4) {
                    const px = Math.round(x + cos * d);
                    const py = Math.round(y + sin * d);
                    if (px >= 0 && px < width && py >= 0 && py < height) {
                        acc[py * width + px] += edge;
                    }
                }
            }
        }

        // 蓄積値が最大となる「中心点」を検索（初期フォールバックは中心 0.5, 0.5）
        let maxVal = -1;
        let bestX = Math.round(width / 2);
        let bestY = Math.round(height * 0.45); // やや上寄り（一般的なアイレベル）

        // 中心付近を重視するガウシアンウェイトをかける
        for (let y = 10; y < height - 10; y++) {
            for (let x = 10; x < width - 10; x++) {
                const idx = y * width + x;
                const distToCenter = Math.hypot(x - width/2, y - height/2);
                const weight = Math.exp(-distToCenter * distToCenter / (width * width * 0.15));
                const val = acc[idx] * weight;

                if (val > maxVal) {
                    maxVal = val;
                    bestX = x;
                    bestY = y;
                }
            }
        }

        return { x: bestX, y: bestY, normalizedX: bestX / width, normalizedY: bestY / height };
    }

    // ─────────────────────────────────────────────────────────────────
    // ③ 幾何学遠近グリッド (Perspective Grid) の生成
    // ─────────────────────────────────────────────────────────────────
    generatePerspectiveGrid(centerPoint, width, height) {
        const grid = new Uint8ClampedArray(width * height);
        const cx = centerPoint.x;
        const cy = centerPoint.y;

        // 1. 中心点（消失点）から伸びる放射状パース線の描画
        const rayCount = 12;
        for (let r = 0; r < rayCount; r++) {
            const angle = (r / rayCount) * Math.PI * 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            for (let d = 0; d < width; d++) {
                const px = Math.round(cx + cos * d);
                const py = Math.round(cy + sin * d);
                if (px >= 0 && px < width && py >= 0 && py < height) {
                    grid[py * width + px] = 120; // 中程度の明度で描画
                }
            }
        }

        // 2. 奥行きに応じた対数スケールの水平グリッド線の描画
        let yStep = 4.0;
        let py = cy;
        while (py < height) {
            const roundedY = Math.round(py);
            if (roundedY >= 0 && roundedY < height) {
                for (let px = 0; px < width; px++) {
                    grid[roundedY * width + px] = 160; // やや強めに水平線
                }
            }
            yStep *= 1.35; // 奥行きを表現するため手前に来るほど間隔を広げる
            py += yStep;
        }

        return grid;
    }

    // ─────────────────────────────────────────────────────────────────
    // コア計算エントリーポイント
    // ─────────────────────────────────────────────────────────────────
    computeFeaturesV2(imgData) {
        const start = performance.now();
        this._stats.calls++;

        try {
            const width = imgData.width;
            const height = imgData.height;

            // 1. レイヤー分解
            const layers = this.decomposeLayers(imgData);

            // 2. 中心点抽出
            const centerPoint = this.extractCenterPoint(layers.boundaryLayer, layers.brightnessLayer, width, height);

            // 3. 遠近グリッド生成
            const perspectiveGrid = this.generatePerspectiveGrid(centerPoint, width, height);

            const duration = performance.now() - start;
            this._stats.totalMs += duration;

            return {
                layers,
                centerPoint,
                perspectiveGrid,
                processingTimeMs: duration
            };
        } catch(e) {
            this._stats.errors++;
            console.error('[AoGPU-v2] computeFeaturesV2 失敗:', e);
            return null;
        }
    }

    getStats() {
        const avg = this._stats.calls > 0
            ? (this._stats.totalMs / this._stats.calls).toFixed(1)
            : '—';
        return { ...this._stats, avgMs: avg };
    }
}

// ─────────────────────────────────────────────────────────────────────
// ImageAdapter V2 パッチ適用
// ─────────────────────────────────────────────────────────────────────
function patchImageAdapterV2(gpuV2) {
    const poll = setInterval(() => {
        const ao = window.ao;
        if (!ao || !ao.imageAdapter) return;
        clearInterval(poll);

        const adapter = ao.imageAdapter;
        const origExtract = adapter.extractMeaning?.bind(adapter);

        adapter.extractMeaning = async function (imageData) {
            if (!imageData) return origExtract(imageData);

            // V2 が有効な場合
            if (ao.activeVisionVersion === 'v2') {
                try {
                    const SIZE = adapter._fastMode ? 64 : IMG_SIZE;
                    const imgD = await _srcToImageData(imageData, SIZE);
                    if (!imgD) return origExtract(imageData);

                    // V2 特徴量計算
                    const resultV2 = gpuV2.computeFeaturesV2(imgD);

                    // V1 の既存の特徴量もダミー/フォールバック用に取得
                    // (エラーを避けるために既存の形式のオブジェクトを返す)
                    const v1Features = window.aoGPU ? window.aoGPU.computeFeatures(imgD) : null;
                    const v1Result = v1Features 
                        ? _buildResultV1(adapter, v1Features, imageData)
                        : await origExtract(imageData);

                    // V2 独自の結果をマージ
                    v1Result.v2 = resultV2;
                    v1Result.raw_descriptor += ` [V2] 消失点(${resultV2.centerPoint.normalizedX.toFixed(2)}, ${resultV2.centerPoint.normalizedY.toFixed(2)})`;

                    return v1Result;
                } catch(e) {
                    console.warn('[AoGPU-v2] V2計算エラー → V1/CPUへ退避', e);
                    return origExtract(imageData);
                }
            } else {
                // V1 (従来処理)
                return origExtract(imageData);
            }
        };

        console.log('[AoGPU-v2] ImageAdapter V2 パッチ適用完了');
    }, 800);
}

function _srcToImageData(src, size) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const cv  = document.createElement('canvas');
            cv.width  = size;
            cv.height = size;
            cv.getContext('2d').drawImage(img, 0, 0, size, size);
            resolve(cv.getContext('2d').getImageData(0, 0, size, size));
        };
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

function _buildResultV1(adapter, features, originalSrc) {
    const { hue_hist, brightness_grid, gradient_hist, hog_blocks, gabor_features, lbp_features } = features;
    const visual_vector = [...hue_hist, ...brightness_grid, ...gradient_hist, ...hog_blocks, ...gabor_features, ...lbp_features];

    window._aoRawFeaturesBuf = { visualVector: visual_vector, hogBlocks: hog_blocks };

    const avgBrightness = brightness_grid.reduce((a, b) => a + b, 0) / 16;
    const dominantHue = (adapter.hueLabels || ['赤','橙','黄','黄緑','緑','水色','青','紫'])[hue_hist.indexOf(Math.max(...hue_hist))];
    const dominantDir = (adapter.dirLabels || ['水平','斜め右下','垂直','斜め左下','水平','斜め右上','垂直','斜め左上'])[gradient_hist.indexOf(Math.max(...gradient_hist))];

    return {
        semantic_candidates: [],
        modality:     'visual',
        visual_vector: visual_vector,
        features: {
            brightness:       avgBrightness,
            hue_hist:         hue_hist,
            brightness_grid:  brightness_grid,
            gradient_hist:    gradient_hist,
            hog_blocks:       hog_blocks,
            gabor_features:   gabor_features,
            lbp_features:     lbp_features,
            dominant_hue:     dominantHue,
            dominant_dir:     dominantDir,
        },
        raw_descriptor: `色:${dominantHue} 明度:${(avgBrightness*100).toFixed(0)}% 輪郭:${dominantDir}`,
        _gpu: true
    };
}

// 起動
const gpuV2 = new AoGPUV2Accelerator();
async function boot() {
    const ok = await gpuV2.init();
    window.aoGPU_v2 = ok ? gpuV2 : null;
    if (ok) patchImageAdapterV2(gpuV2);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

window.AoGPUV2Accelerator = AoGPUV2Accelerator;

})();
