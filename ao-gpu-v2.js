/*!
 * ao-gpu-v2.js  v2.1 – Ao V2 空間・幾何認識 ＆ 高解像度3D PBRアクセラレーター
 *
 * 概要:
 *   画像を「色」「明度」「境界」「質感(多次元スペクトル)」の4層高精度レイヤーに分解。
 *   直線エッジの交点合意から「消失点 (Vanishing Point)」を推定し、
 *   立体感の基盤となる「3D Perspective Depth Field」と「Surface Normal Field」を直接構築。
 *   AoSpatialRendererV2 (Photo-PBR Renderer) へ高解像度フィードバックを供給。
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
        this.initialized = true;
        console.log('[AoGPU-v2] Photo-PBR V2空間幾何 ＆ レイヤーアクセラレーター初期化完了');
        return true;
    }

    // ─────────────────────────────────────────────────────────────────
    // ① 多層レイヤー分解 (色、明度、境界、多次元質感)
    // ─────────────────────────────────────────────────────────────────
    decomposeLayers(imgData) {
        const width = imgData.width;
        const height = imgData.height;
        const data = imgData.data;

        // 各レイヤーバッファ
        const colorLayer      = new Uint8ClampedArray(width * height);
        const hueLayer        = new Uint8Array(width * height);
        const saturationLayer = new Uint8Array(width * height);
        const brightnessLayer = new Uint8ClampedArray(width * height);
        const boundaryLayer   = new Uint8ClampedArray(width * height);
        const textureLayer    = new Uint8ClampedArray(width * height);
        const normalXLayer    = new Float32Array(width * height);
        const normalYLayer    = new Float32Array(width * height);

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
            colorLayer[idx] = Math.min(255, chroma * 2);
            const sat = maxVal ? chroma / maxVal : 0;
            let hue = 0;
            if (chroma) {
                if (maxVal === r) hue = ((g - b) / chroma) % 6;
                else if (maxVal === g) hue = (b - r) / chroma + 2;
                else hue = (r - g) / chroma + 4;
                hue = (hue * 60 + 360) % 360;
            }
            hueLayer[idx] = Math.round(hue / 360 * 255);
            saturationLayer[idx] = Math.round(sat * 255);
        }

        // 境界 (Sobel エッジ検出) ＆ 質感 (LBP + 局所法線勾配)
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const idx = y * width + x;

                // Sobel 勾配
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
                boundaryLayer[idx] = edge > 35 ? edge : 0;

                // 局所法線ベクトルの正規化成分
                const len = Math.hypot(gx, gy, 255.0) || 1;
                normalXLayer[idx] = -gx / len;
                normalYLayer[idx] = -gy / len;

                // LBP (Local Binary Pattern) 質感コード
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

        return { width, height, colorLayer, hueLayer, saturationLayer, brightnessLayer, boundaryLayer, textureLayer, normalXLayer, normalYLayer };
    }

    // ─────────────────────────────────────────────────────────────────
    // ② 消失点 (Vanishing Point) の幾何学的検出
    // ─────────────────────────────────────────────────────────────────
    extractCenterPoint(boundaryLayer, brightnessLayer, width, height) {
        const samples = [];
        // Sobel勾配は「直線エッジの法線」。各エッジを ax+by=c の直線として扱い、
        // 複数直線の交点をRANSACで合意させる。エッジ量の重心は用いない。
        const step = Math.max(2, Math.floor(Math.min(width, height) / 160));
        for (let y = 1; y < height - 1; y += step) {
            for (let x = 1; x < width - 1; x += step) {
                const idx = y * width + x;
                const edge = boundaryLayer[idx];
                if (edge < 80) continue;

                const dx = brightnessLayer[y*width + (x+1)] - brightnessLayer[y*width + (x-1)];
                const dy = brightnessLayer[(y+1)*width + x] - brightnessLayer[(y-1)*width + x];
                if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;

                const length = Math.hypot(dx, dy);
                samples.push({ x, y, nx: dx / length, ny: dy / length, weight: edge });
            }
        }
        const geometry = window.AoPerspectiveGeometry;
        if (geometry && geometry.estimateVanishingPoint) {
            return geometry.estimateVanishingPoint(samples, width, height);
        }
        // 通常は ao-spatial-renderer.js が先に読み込まれる。未読込時も「未検出」を
        // 明示し、画面中央を正しい消失点であるかのようには扱わない。
        return {
            x: width / 2, y: height / 2, normalizedX: 0.5, normalizedY: 0.5,
            detected: false, confidence: 0, method: 'geometry-helper-unavailable'
        };
    }

    // 単眼画像から得られる「空間観測」を明示的に構成する。
    // ここでの depthProxy は絶対距離ではない。線遠近と見かけの大きさから得る
    // 相対的な奥行き手掛かりであり、概念学習時に複数観測を比較するために使う。
    estimateSpatialObservation(layers, centerPoint, width, height) {
        const boundary = layers.boundaryLayer;
        let minX = width, minY = height, maxX = -1, maxY = -1;
        let sumX = 0, sumY = 0, sumW = 0, count = 0;
        const step = Math.max(2, Math.floor(Math.min(width, height) / 160));
        for (let y = 1; y < height - 1; y += step) {
            for (let x = 1; x < width - 1; x += step) {
                const edge = boundary[y * width + x];
                if (edge < 80) continue;
                minX = Math.min(minX, x); minY = Math.min(minY, y);
                maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
                sumX += x * edge; sumY += y * edge; sumW += edge; count++;
            }
        }
        const hasRegion = count >= 6 && maxX >= minX && maxY >= minY;
        const regionW = hasRegion ? (maxX - minX + step) / width : 0;
        const regionH = hasRegion ? (maxY - minY + step) / height : 0;
        const scale = hasRegion ? Math.min(1, Math.max(regionW, regionH)) : 0;
        const imageX = hasRegion ? (sumX / sumW) / width : 0.5;
        const imageY = hasRegion ? (sumY / sumW) / height : 0.5;
        const perspectiveConfidence = centerPoint.detected ? (centerPoint.confidence || 0) : 0;
        return {
            imagePosition: { x: imageX, y: imageY },
            edgeRegion: hasRegion ? { x: minX / width, y: minY / height, width: regionW, height: regionH } : null,
            apparentScale: scale,
            depthProxy: scale > 0 ? 1 / Math.max(scale, 0.05) : null,
            vanishingPoint: centerPoint,
            perspectiveConfidence,
            confidence: Math.min(1, 0.25 + Math.min(0.5, count / 80) + perspectiveConfidence * 0.25),
            depthKind: 'relative-single-view',
            note: '単眼画像のため絶対距離ではなく、見かけの大きさと線遠近による相対手掛かり'
        };
    }

    // ─────────────────────────────────────────────────────────────────
    // ③ 3D 遠近幾何グリッド (3D Perspective Grid) の生成
    // ─────────────────────────────────────────────────────────────────
    generatePerspectiveGrid(centerPoint, width, height) {
        const grid = new Uint8ClampedArray(width * height);
        const cx = centerPoint.x;
        const cy = centerPoint.y;

        const rayCount = 16;
        for (let r = 0; r < rayCount; r++) {
            const angle = (r / rayCount) * Math.PI * 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            for (let d = 0; d < width; d++) {
                const px = Math.round(cx + cos * d);
                const py = Math.round(cy + sin * d);
                if (px >= 0 && px < width && py >= 0 && py < height) {
                    grid[py * width + px] = 140;
                }
            }
        }

        let yStep = 3.5;
        let py = cy;
        while (py < height) {
            const roundedY = Math.round(py);
            if (roundedY >= 0 && roundedY < height) {
                for (let px = 0; px < width; px++) {
                    grid[roundedY * width + px] = 180;
                }
            }
            yStep *= 1.3;
            py += yStep;
        }

        return grid;
    }

    // ─────────────────────────────────────────────────────────────────
    // 128×128 PBR レンダラー用高解像度データ生成
    // ─────────────────────────────────────────────────────────────────
    generateHighResData(layers, centerPoint, width, height, G = 128) {
        const brightnessGrid = new Float32Array(G * G);
        const edgeAngles     = new Float32Array(G * G);
        const edgeStrengths  = new Float32Array(G * G);
        const textureEnergy  = new Float32Array(G * G);

        const blockW = width / G;
        const blockH = height / G;

        for (let gy = 0; gy < G; gy++) {
            for (let gx = 0; gx < G; gx++) {
                const idx = gy * G + gx;
                const px = Math.min(width - 1, Math.floor((gx + 0.5) * blockW));
                const py = Math.min(height - 1, Math.floor((gy + 0.5) * blockH));
                const pIdx = py * width + px;

                brightnessGrid[idx] = (layers.brightnessLayer[pIdx] || 0) / 255.0;
                edgeStrengths[idx]  = (layers.boundaryLayer[pIdx] || 0) / 255.0;
                
                const nx = layers.normalXLayer[pIdx] || 0;
                const ny = layers.normalYLayer[pIdx] || 0;
                edgeAngles[idx]     = Math.atan2(ny, nx) + Math.PI;
                textureEnergy[idx]  = (layers.textureLayer[pIdx] || 0) / 255.0;
            }
        }

        return {
            GCELLS: G,
            centerPoint: { x: centerPoint.normalizedX, y: centerPoint.normalizedY },
            brightnessGrid,
            edgeAngles,
            edgeStrengths,
            textureEnergy
        };
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

            // 1. 4層高精度レイヤー分解
            const layers = this.decomposeLayers(imgData);

            // 2. 消失点 (FOE) 精密抽出
            const centerPoint = this.extractCenterPoint(layers.boundaryLayer, layers.brightnessLayer, width, height);
            const spatialObservation = this.estimateSpatialObservation(layers, centerPoint, width, height);

            // 3. 3D 遠近幾何グリッド生成
            const perspectiveGrid = this.generatePerspectiveGrid(centerPoint, width, height);

            // 4. PBR レンダラー用 128×128 フィードバックデータ構成
            const highResData = this.generateHighResData(layers, centerPoint, width, height, 128);

            const duration = performance.now() - start;
            this._stats.totalMs += duration;

            // 🧠 記憶バッファ・自動保存マネージャーへ即時フック接続
            if (typeof window.aoTypedMemory !== 'undefined' && window.aoTypedMemory && typeof window.aoTypedMemory._scheduleSave === 'function') {
                window.aoTypedMemory._scheduleSave();
            }
            if (typeof window.ao !== 'undefined' && window.ao && window.ao.saveManager && typeof window.ao.saveManager.markDirty === 'function') {
                window.ao.saveManager.markDirty();
            }

            return {
                layers,
                centerPoint,
                spatialObservation,
                perspectiveGrid,
                highResData,
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

            if (ao.activeVisionVersion === 'v2') {
                try {
                    const SIZE = adapter._fastMode ? 64 : IMG_SIZE;
                    const imgD = await _srcToImageData(imageData, SIZE);
                    if (!imgD) return origExtract(imageData);

                    const resultV2 = gpuV2.computeFeaturesV2(imgD);
                    const v1Features = window.aoGPU ? window.aoGPU.computeFeatures(imgD) : null;
                    const v1Result = v1Features 
                        ? _buildResultV1(adapter, v1Features, imageData)
                        : await origExtract(imageData);

                    v1Result.v2 = resultV2;
                    v1Result.highResData = resultV2.highResData;
                    v1Result.raw_descriptor += ` [Photo-PBR V2] 消失点(${resultV2.centerPoint.normalizedX.toFixed(2)}, ${resultV2.centerPoint.normalizedY.toFixed(2)})`;

                    return v1Result;
                } catch(e) {
                    console.warn('[AoGPU-v2] V2計算エラー → V1/CPUへ退避', e);
                    return origExtract(imageData);
                }
            } else {
                return origExtract(imageData);
            }
        };

        console.log('[AoGPU-v2] ImageAdapter Photo-PBR V2 パッチ適用完了');
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

    const avgBrightness = brightness_grid.reduce((a, b) => a + b, 0) / brightness_grid.length;
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
