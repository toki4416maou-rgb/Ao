/**
 * AoSpatialRendererV2 / AoUnifiedArchitectureEngine (V3 Photo-PBR & Temporal 60fps Engine)
 * 
 * 【ユーザー様設計：空間穴埋め (Spatial Inpainting) ＋ 時間軸穴埋め (Temporal Interpolation) ＝ 60fps ぬるぬるアニメーション出力】
 * 
 *  1. [空間穴埋め (Spatial Inpainting)]
 *     ・スカスカな穴だらけの情報に対し、周囲 3×3〜5×5 近傍セルからガウシアン加重拡散補間 (Diffusion Smoothing) して穴埋め補足
 * 
 *  2. [時間軸穴埋め (Temporal Interpolation / 60fps Animation Synthesis)]
 *     ・キーフレームAとキーフレームBの時間軸ギャップを Smoothstep イージング＆ベクトルモーフィング補間
 *     ・消失点 (Focus of Expansion) の滑らかな連続移動補間 (Smooth FOE Trajectory)
 *     ・フレーム間速度ベクトル $\vec{v}(x,y)$ に連動した動的モーションブラー (Motion Blur Overlay)
 * 
 *  3. [出力・復元パイプライン (3D Shader PBR & Photorealistic Reconstruction Engine)]
 *     ・消失点を軸とした 3D Perspective Depth Field (透視深度場) と Surface Normal Field (表面法線場) の動的生成
 *     ・バイキュービック補間 ＋ PBR シェーディング: 拡散反射 ＋ 鏡面反射 ＋ 空間環境光
 */

/**
 * ── 【ユーザー様本来の設計スタンス：多重独立レイヤー記憶 ＆ レイヤー別信用値構造】 ──
 * 色相・明度・空間立体形状（幾何学）・質感テクスチャをそれぞれ別個のレイヤーとして切り分け、
 * 各レイヤーごとに個別「信用値 (Confidence / Reliability Grid)」を伴って独立記憶する。
 */
class AoMultiLayerDisentangledMemory {
    constructor(gcells = 128) {
        this.GCELLS = gcells;
        
        // 1. 🎨 Color Layer & Confidence
        this.hueGrid = new Float32Array(gcells * gcells);
        this.satGrid = new Float32Array(gcells * gcells);
        this.colorConfidence = new Float32Array(gcells * gcells);

        // 2. 💡 Luminance Layer & Confidence
        this.brightnessGrid = new Float32Array(gcells * gcells);
        this.luminanceConfidence = new Float32Array(gcells * gcells);

        // 3. 📐 Spatial Geometry & 3D Depth Layer & Confidence
        this.edgeAngles = new Float32Array(gcells * gcells);
        this.edgeStrengths = new Float32Array(gcells * gcells);
        this.spatialConfidence = new Float32Array(gcells * gcells);

        // 4. 🧶 Surface Texture & Micro-Grain Layer & Confidence
        this.textureEnergy = new Float32Array(gcells * gcells);
        this.textureConfidence = new Float32Array(gcells * gcells);
    }

    /**
     * 各レイヤーの独立特徴量と信用値をベイズ的に更新蓄積する
     */
    updateLayers(extractedData) {
        const G = this.GCELLS;
        const { brightnessGrid, hueGrid, satGrid, edgeAngles, edgeStrengths, textureEnergy } = extractedData;

        for (let i = 0; i < G * G; i++) {
            // 色相・彩度レイヤー
            const h = hueGrid ? hueGrid[i] : 0;
            const s = satGrid ? satGrid[i] : 0;
            const colorConf = s * 0.8 + 0.2; // 彩度が高いほど色情報としての信用度高
            this.hueGrid[i] = this.hueGrid[i] * (1 - colorConf * 0.1) + h * (colorConf * 0.1);
            this.satGrid[i] = this.satGrid[i] * 0.9 + s * 0.1;
            this.colorConfidence[i] = Math.min(1.0, this.colorConfidence[i] + colorConf * 0.05);

            // 明度レイヤー
            const b = brightnessGrid[i];
            const lumConf = Math.min(1.0, Math.abs(b - 0.5) * 2.0 + 0.3); // 明暗コントラストの明確さ
            this.brightnessGrid[i] = this.brightnessGrid[i] * 0.85 + b * 0.15;
            this.luminanceConfidence[i] = Math.min(1.0, this.luminanceConfidence[i] + lumConf * 0.05);

            // 幾何学空間レイヤー
            const eStr = edgeStrengths[i];
            const eAng = edgeAngles[i];
            const spatConf = Math.min(1.0, eStr * 1.5); // エッジ強度が強いほど幾何学信用度高
            this.edgeAngles[i] = eAng;
            this.edgeStrengths[i] = this.edgeStrengths[i] * 0.8 + eStr * 0.2;
            this.spatialConfidence[i] = Math.min(1.0, this.spatialConfidence[i] + spatConf * 0.05);

            // テクスチャレイヤー
            const texEng = textureEnergy ? textureEnergy[i] : 0;
            const texConf = Math.min(1.0, texEng * 2.0);
            this.textureEnergy[i] = this.textureEnergy[i] * 0.85 + texEng * 0.15;
            this.textureConfidence[i] = Math.min(1.0, this.textureConfidence[i] + texConf * 0.05);
        }
    }
}

class AoCognitiveMemoryBank {
    /**
     * 多重独立レイヤー記憶（信用値付き）をディスクに永続保存する
     */
    static saveToFile(snapshot, filePath) {
        const serializable = {
            version: '26.5-disentangled',
            timestamp: new Date().toISOString(),
            spatial: snapshot.spatial,
            attributes: snapshot.attributes,
            saliency: snapshot.saliency,
            layers: {
                // 🎨 独立レイヤー 1: 色相・彩度 ＋ 信用値
                color: {
                    hueGrid: Array.from(snapshot.highResData.hueGrid || []),
                    satGrid: Array.from(snapshot.highResData.satGrid || []),
                    confidence: Array.from(snapshot.layers?.colorConfidence || [])
                },
                // 💡 独立レイヤー 2: 明度 ＋ 信用値
                luminance: {
                    brightnessGrid: Array.from(snapshot.highResData.brightnessGrid || []),
                    confidence: Array.from(snapshot.layers?.luminanceConfidence || [])
                },
                // 📐 独立レイヤー 3: 幾何学空間 ＋ 信用値
                spatial: {
                    edgeAngles: Array.from(snapshot.highResData.edgeAngles || []),
                    edgeStrengths: Array.from(snapshot.highResData.edgeStrengths || []),
                    confidence: Array.from(snapshot.layers?.spatialConfidence || [])
                },
                // 🧶 独立レイヤー 4: 質感テクスチャ ＋ 信用値
                texture: {
                    textureEnergy: Array.from(snapshot.highResData.textureEnergy || []),
                    confidence: Array.from(snapshot.layers?.textureConfidence || [])
                }
            },
            highResData: {
                GCELLS: snapshot.highResData.GCELLS,
                centerPoint: snapshot.highResData.centerPoint,
                brightnessGrid: Array.from(snapshot.highResData.brightnessGrid || []),
                hueGrid: Array.from(snapshot.highResData.hueGrid || []),
                satGrid: Array.from(snapshot.highResData.satGrid || []),
                edgeAngles: Array.from(snapshot.highResData.edgeAngles || []),
                edgeStrengths: Array.from(snapshot.highResData.edgeStrengths || []),
                textureEnergy: Array.from(snapshot.highResData.textureEnergy || [])
            }
        };

        const fs = require('fs');
        fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2), 'utf8');
        console.log(`[AoCognitiveMemoryBank] 💾 多重独立レイヤー記憶データ（信用値マップ付）を永久保存しました: ${filePath}`);
    }

    /**
     * 保存された多重レイヤー記憶ファイルから完全復元ロードする
     */
    static loadFromFile(filePath) {
        const fs = require('fs');
        if (!fs.existsSync(filePath)) {
            throw new Error(`[AoCognitiveMemoryBank] 指定された学習記憶ファイルが存在しません: ${filePath}`);
        }

        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);

        const hd = parsed.highResData;
        const ly = parsed.layers || {};

        const snapshot = {
            spatial: parsed.spatial,
            attributes: parsed.attributes,
            saliency: parsed.saliency,
            layers: {
                colorConfidence: ly.color?.confidence ? new Float32Array(ly.color.confidence) : null,
                luminanceConfidence: ly.luminance?.confidence ? new Float32Array(ly.luminance.confidence) : null,
                spatialConfidence: ly.spatial?.confidence ? new Float32Array(ly.spatial.confidence) : null,
                textureConfidence: ly.texture?.confidence ? new Float32Array(ly.texture.confidence) : null,
            },
            highResData: {
                GCELLS: hd.GCELLS,
                centerPoint: hd.centerPoint,
                brightnessGrid: new Float32Array(hd.brightnessGrid),
                hueGrid: hd.hueGrid ? new Float32Array(hd.hueGrid) : null,
                satGrid: hd.satGrid ? new Float32Array(hd.satGrid) : null,
                edgeAngles: new Float32Array(hd.edgeAngles),
                edgeStrengths: new Float32Array(hd.edgeStrengths),
                textureEnergy: hd.textureEnergy ? new Float32Array(hd.textureEnergy) : null
            }
        };

        console.log(`[AoCognitiveMemoryBank] 🧠 多重独立レイヤー記憶データ（4レイヤー信用値付）をロード復元しました: ${filePath}`);
        return snapshot;
    }
}

window.AoMultiLayerDisentangledMemory = AoMultiLayerDisentangledMemory;
window.AoCognitiveMemoryBank = AoCognitiveMemoryBank;

/**
 * ── 🧠 【解離型概念合成エンジン (Disentangled Concept Synthesizer)】 ──
 * 写真の「丸暗記・多重重複」から脱却し、
 * ・「物体概念 (Cat Category)」
 * ・「方向概念 (3D Orientation: Yaw/Pitch)」
 * ・「形態・経路概念 (Body Trajectory / Slender Scale)」
 * ・「色彩概念 (Color Constancy: Slate Grey)」
 * を独立した概念軸として結合し、写真には存在しない未知の対象を自力生成する。
 */
class AoGenerativeConceptSynthesizer {
    constructor(gcells = 512) {
        this.GCELLS = gcells;
    }

    /**
     * 概念仕様（方向・体型経路・色彩）から高精度な視覚スナップショットを合成構築
     */
    synthesizeUnseenConcept(conceptSpec) {
        const G = this.GCELLS;
        const {
            category = 'object',
            pose = { yaw: 0, pitch: 0 },
            color = { hue: 210, sat: 0.08, bright: 0.48 },
            bodyTrajectory = { slenderScale: 0.65, heightScale: 1.15 }
        } = conceptSpec;

        console.log(`[AoGenerativeConceptSynthesizer] 🧠 抽象概念から未だ存在しない対象を合成中: Category=${category}, Pose=(yaw=${pose.yaw}°), Body=Scale(${bodyTrajectory.slenderScale})`);

        const brightnessGrid = new Float32Array(G * G);
        const hueGrid        = new Float32Array(G * G);
        const satGrid        = new Float32Array(G * G);
        const edgeAngles     = new Float32Array(G * G);
        const edgeStrengths  = new Float32Array(G * G);
        const textureEnergy  = new Float32Array(G * G);

        const cx = 0.50 + Math.sin(pose.yaw * Math.PI / 180) * 0.15;
        const cy = 0.48 + Math.sin(pose.pitch * Math.PI / 180) * 0.10;

        // 細身の幾何経路（Slender Trajectory Scale）
        const widthScale  = 0.42 * bodyTrajectory.slenderScale;  // 通常の65%の細身幅
        const heightScale = 0.55 * bodyTrajectory.heightScale;  // スレンダーな高さ

        for (let gy = 0; gy < G; gy++) {
            const v = gy / G;
            for (let gx = 0; gx < G; gx++) {
                const u = gx / G;
                const idx = gy * G + gx;

                // 幾何形状・経路概念 (概念パラメータからの汎用シルエット)
                const faceDx = (u - cx) / widthScale;
                const faceDy = (v - cy) / heightScale;
                const faceDist2 = faceDx * faceDx + faceDy * faceDy;

                // 色彩概念: 指定色の統一
                hueGrid[idx] = color.hue;
                satGrid[idx] = color.sat;

                if (faceDist2 <= 1.0) {
                    // 物体領域
                    const edgeDist = Math.sqrt(faceDist2);
                    const bVal = Math.max(0.18, Math.min(0.82, (1.0 - edgeDist * 0.55) * color.bright * 1.5));
                    brightnessGrid[idx] = bVal;

                    if (edgeDist > 0.68) {
                        edgeStrengths[idx] = 0.85;
                        textureEnergy[idx] = 0.60;
                    } else {
                        edgeStrengths[idx] = 0.20;
                        textureEnergy[idx] = 0.35;
                    }

                    // 方向・角度経路
                    const angleToCenter = Math.atan2(v - cy, u - cx);
                    edgeAngles[idx] = angleToCenter + Math.PI * 0.5;
                } else {
                    // 背景
                    brightnessGrid[idx] = 0.90 - Math.hypot(u - 0.5, v - 0.5) * 0.35;
                    edgeStrengths[idx]  = 0.02;
                    textureEnergy[idx]  = 0.05;
                    edgeAngles[idx]     = 0;
                }
            }
        }

        return {
            spatial: { x: cx, y: cy },
            attributes: { hue: color.hue, saturation: color.sat, brightness: color.bright, roughness: 0.30 },
            saliency: [{ concept: `概念合成による未存在の${category}`, saliency: 0.99 }],
            highResData: {
                GCELLS: G,
                centerPoint: { x: cx, y: cy },
                brightnessGrid,
                hueGrid,
                satGrid,
                edgeAngles,
                edgeStrengths,
                textureEnergy
            }
        };
    }
}

window.AoGenerativeConceptSynthesizer = AoGenerativeConceptSynthesizer;

// 透視線（画像中の直線エッジ）から消失点を推定する共通ユーティリティ。
// サンプルは { x, y, nx, ny, weight }。n=(nx,ny) は直線の法線で、
// n・(p-[x,y])=0 を満たす。明度やエッジの「重心」は使用しない。
window.AoPerspectiveGeometry = window.AoPerspectiveGeometry || {
    estimateVanishingPoint(samples, width, height) {
        const fallback = {
            x: width * 0.5, y: height * 0.5, normalizedX: 0.5, normalizedY: 0.5,
            detected: false, confidence: 0, method: 'no-line-consensus'
        };
        if (!samples || samples.length < 8) return fallback;

        // 計算量を一定に保ちつつ、強い線を優先して均等に間引く。
        const sorted = samples.filter(s => Number.isFinite(s.nx) && Number.isFinite(s.ny) && s.weight > 0)
            .sort((a, b) => b.weight - a.weight);
        const limit = 320;
        const stride = Math.max(1, Math.ceil(sorted.length / limit));
        const lines = [];
        for (let i = 0; i < sorted.length && lines.length < limit; i += stride) {
            const s = sorted[i];
            const len = Math.hypot(s.nx, s.ny);
            if (len < 0.5) continue;
            const a = s.nx / len, b = s.ny / len;
            lines.push({ a, b, c: a * s.x + b * s.y, weight: Math.min(255, s.weight) });
        }
        if (lines.length < 8) return fallback;

        const diagonal = Math.hypot(width, height);
        const maxDistance = Math.max(2, diagonal * 0.012);
        const maxExtent = diagonal * 4; // 画面外の消失点も許す
        let best = null;
        const trials = Math.min(240, lines.length * 3);

        // 決定的な組み合わせでRANSAC。実行ごとに結果が揺れない。
        for (let t = 0; t < trials; t++) {
            const l1 = lines[(t * 37 + 11) % lines.length];
            const l2 = lines[(t * 97 + 29) % lines.length];
            const det = l1.a * l2.b - l2.a * l1.b;
            if (Math.abs(det) < 0.22) continue; // ほぼ平行な線は交点に使わない
            const x = (l1.c * l2.b - l2.c * l1.b) / det;
            const y = (l1.a * l2.c - l2.a * l1.c) / det;
            if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x - width * .5, y - height * .5) > maxExtent) continue;

            let score = 0, support = 0, aa = 0, ab = 0, bb = 0, ac = 0, bc = 0;
            for (const line of lines) {
                const residual = Math.abs(line.a * x + line.b * y - line.c);
                if (residual > maxDistance) continue;
                const w = line.weight * (1 - residual / maxDistance);
                score += w; support++;
                aa += w * line.a * line.a; ab += w * line.a * line.b; bb += w * line.b * line.b;
                ac += w * line.a * line.c; bc += w * line.b * line.c;
            }
            if (!best || score > best.score) best = { x, y, score, support, aa, ab, bb, ac, bc };
        }
        if (!best || best.support < 4) return fallback;

        // 合意した直線全体に最小二乗フィットして、二線交点のノイズを除く。
        const normalDet = best.aa * best.bb - best.ab * best.ab;
        if (Math.abs(normalDet) > 1e-6) {
            best.x = (best.ac * best.bb - best.ab * best.bc) / normalDet;
            best.y = (best.aa * best.bc - best.ab * best.ac) / normalDet;
        }
        const totalWeight = lines.reduce((sum, line) => sum + line.weight, 0) || 1;
        const confidence = Math.min(1, (best.score / totalWeight) * Math.min(1, best.support / 10));
        if (confidence < 0.12) return fallback;
        return {
            x: best.x, y: best.y, normalizedX: best.x / width, normalizedY: best.y / height,
            detected: true, confidence, support: best.support, method: 'edge-line-ransac-least-squares'
        };
    }
};

class AoHighResSpatialAnalyzer {
    constructor(gcells = 512) {
        console.log(`[AoUnifiedArchitectureEngine] Photo-PBR High-Res Retinal Spatial Analyzer (GCELLS=${gcells}) Initialized`);
        this.GCELLS = gcells;
    }



    /**
     * 画像から 色・明度・境界・高次元テクスチャを分離し、消失点を割り出す高精度解析関数
     */
    analyzeAndCompress(ctx, w, h) {
        const G = this.GCELLS;
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        const brightnessGrid = new Float32Array(G * G);
        const hueGrid        = new Float32Array(G * G);
        const satGrid        = new Float32Array(G * G);
        const edgeAngles     = new Float32Array(G * G);
        const edgeStrengths  = new Float32Array(G * G);
        const textureEnergy  = new Float32Array(G * G);

        const blockW = w / G;
        const blockH = h / G;

        const perspectiveSamples = [];
        let totalEdgeX = 0, totalEdgeY = 0, totalEdgeWeight = 0.001;
        let brightX = 0, brightY = 0, totalBrightness = 0.001;

        for (let gy = 0; gy < G; gy++) {
            for (let gx = 0; gx < G; gx++) {
                const idx = gy * G + gx;
                let sumB = 0, sumR = 0, sumG = 0, sumBColor = 0, count = 0;
                let sumGradX = 0, sumGradY = 0;
                let localVariance = 0;

                const startY = Math.floor(gy * blockH);
                const endY   = Math.floor((gy + 1) * blockH);
                const startX = Math.floor(gx * blockW);
                const endX   = Math.floor((gx + 1) * blockW);

                const step = Math.max(1, Math.floor(Math.min(blockW, blockH) / 4));

                let lums = [];
                for (let py = startY; py < endY; py += step) {
                    for (let px = startX; px < endX; px += step) {
                        if (px >= w || py >= h) continue;
                        const pIdx = (py * w + px) * 4;
                        const r = data[pIdx], g = data[pIdx + 1], b = data[pIdx + 2];
                        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                        sumB += lum;
                        sumR += r; sumG += g; sumBColor += b;
                        lums.push(lum);

                        if (px < w - step && py < h - step) {
                            const pRight = (py * w + (px + step)) * 4;
                            const pDown  = ((py + step) * w + px) * 4;
                            const lumRight = (0.299 * data[pRight] + 0.587 * data[pRight + 1] + 0.114 * data[pRight + 2]) / 255;
                            const lumDown  = (0.299 * data[pDown]  + 0.587 * data[pDown + 1]  + 0.114 * data[pDown + 2]) / 255;

                            sumGradX += (lumRight - lum);
                            sumGradY += (lumDown - lum);
                        }
                        count++;
                    }
                }

                const avgB = count > 0 ? sumB / count : 0;
                brightnessGrid[idx] = avgB;

                if (count > 0) {
                    const avgR = sumR / count, avgG = sumG / count, avgBCol = sumBColor / count;
                    const maxC = Math.max(avgR, avgG, avgBCol) / 255;
                    const minC = Math.min(avgR, avgG, avgBCol) / 255;
                    const delta = maxC - minC;
                    let hVal = 0;
                    if (delta > 0) {
                        if (maxC === avgR / 255) hVal = ((avgG - avgBCol) / 255 / delta) % 6;
                        else if (maxC === avgG / 255) hVal = ((avgBCol - avgR) / 255 / delta) + 2;
                        else hVal = ((avgR - avgG) / 255 / delta) + 4;
                        hVal = Math.round(hVal * 60);
                        if (hVal < 0) hVal += 360;
                    }
                    const sVal = maxC > 0 ? delta / maxC : 0;
                    hueGrid[idx] = hVal;
                    satGrid[idx] = sVal;
                }

                if (count > 1) {
                    for (let i = 0; i < lums.length; i++) {
                        const diff = lums[i] - avgB;
                        localVariance += diff * diff;
                    }
                    textureEnergy[idx] = Math.sqrt(localVariance / count);
                }

                brightX += gx * avgB;
                brightY += gy * avgB;
                totalBrightness += avgB;

                const mag = Math.hypot(sumGradX, sumGradY);
                const angle = Math.atan2(sumGradY, sumGradX);

                edgeAngles[idx]    = angle < 0 ? angle + Math.PI * 2 : angle;
                edgeStrengths[idx] = Math.min(1.0, mag * 2.0);

                if (mag > 0.03) {
                    totalEdgeX += gx * mag;
                    totalEdgeY += gy * mag;
                    totalEdgeWeight += mag;
                    // 勾配はエッジ直線の法線。画像座標へ変換して幾何推定に渡す。
                    perspectiveSamples.push({
                        x: (gx + 0.5) * blockW, y: (gy + 0.5) * blockH,
                        nx: sumGradX / mag, ny: sumGradY / mag, weight: mag
                    });
                }
            }
        }

        const centerGx = (brightX / totalBrightness * 0.35) + (totalEdgeX / totalEdgeWeight * 0.65);
        const centerGy = (brightY / totalBrightness * 0.35) + (totalEdgeY / totalEdgeWeight * 0.65);

        const saliencyCenter = {
            x: Math.min(0.9, Math.max(0.1, centerGx / G)),
            y: Math.min(0.9, Math.max(0.1, centerGy / G))
        };
        const vanishingPoint = window.AoPerspectiveGeometry.estimateVanishingPoint(perspectiveSamples, w, h);
        // 描画互換用のcenterPointは維持するが、消失点が未検出なら注目中心に戻す。
        const centerPoint = vanishingPoint.detected
            ? { x: vanishingPoint.normalizedX, y: vanishingPoint.normalizedY }
            : saliencyCenter;

        // ── Predictive Coding: 認知Prior（内部知識モデル）によるベイズ角度補正 ──
        // 脳がノイズ混じりの入力データから「理想的な物体の表面流れ」を補完再現するように、
        // 消失点（中心）からの放射・流線ベクトル場（Prior）と観測エッジ角度（Observation）を統合する
        for (let gy = 0; gy < G; gy++) {
            const v = gy / G;
            for (let gx = 0; gx < G; gx++) {
                const u = gx / G;
                const idx = gy * G + gx;

                const obsAngle = edgeAngles[idx];
                const eStr = edgeStrengths[idx];

                // 消失点・中心 (FOE) からの放射・曲線ベクトル（幾何学Prior）
                const dx = u - centerPoint.x;
                const dy = v - centerPoint.y;

                // 上部に向かって立ち上がる表面流れ / 下部から外側へ広がる表面流れPrior
                let priorAngle = 0;
                if (v < centerPoint.y) {
                    priorAngle = Math.atan2(dy * 1.5, dx * 0.8) - Math.PI * 0.5;
                } else {
                    priorAngle = Math.atan2(dy, dx * 1.2);
                }

                // ベイズ的統合（エッジが強い場所は観測優先、弱くノイズっぽい場所はPrior優先）
                const priorWeight = Math.max(0.20, 1.0 - eStr * 2.2);
                const obsWeight = 1.0 - priorWeight;

                // 2倍角による方向ベクトルの円環補間 (Circular Mean / Orientation Field)
                const sinMix = Math.sin(obsAngle * 2) * obsWeight + Math.sin(priorAngle * 2) * priorWeight;
                const cosMix = Math.cos(obsAngle * 2) * obsWeight + Math.cos(priorAngle * 2) * priorWeight;

                edgeAngles[idx] = Math.atan2(sinMix, cosMix) * 0.5;
            }
        }

        this._applySurroundInpainting(brightnessGrid, edgeStrengths, textureEnergy, G, edgeAngles, hueGrid, satGrid);
        this._applyBoundaryEnhancement(brightnessGrid, edgeStrengths, G, edgeAngles, hueGrid, satGrid);
        this._applyMicroDetailEnhancement(brightnessGrid, edgeStrengths, textureEnergy, G, edgeAngles, hueGrid, satGrid);

        return {
            GCELLS: G,
            centerPoint,
            vanishingPoint,
            saliencyCenter,
            brightnessGrid,
            hueGrid,
            satGrid,
            edgeAngles,
            edgeStrengths,
            textureEnergy
        };
    }

    _applySurroundInpainting(bGrid, eGrid, tGrid, G, edgeAngles, hGrid = null, sGrid = null) {
        // Gestalt 周囲補足 (Surround Context Gap Filling & Edge Sharpening)
        const copyB = new Float32Array(bGrid);
        const copyH = hGrid ? new Float32Array(hGrid) : null;
        const copyS = sGrid ? new Float32Array(sGrid) : null;
        
        for (let gy = 1; gy < G - 1; gy++) {
            for (let gx = 1; gx < G - 1; gx++) {
                const idx = gy * G + gx;
                const eStr = eGrid[idx] || 0;
                const angle = edgeAngles ? (edgeAngles[idx] || 0) : 0;
                
                // 接線方向 (Tangent) と 勾配方向 (Normal) のベクトル
                const tanX = Math.cos(angle);
                const tanY = Math.sin(angle);
                
                let sumB = 0, sumH = 0, sumS = 0, sumW = 0;
                
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nIdx = (gy + dy) * G + (gx + dx);
                        
                        // エッジ強度が強い場合、接線方向の重みを大きくし、直交方向の重みを抑制する（異方性）
                        const distTangential = Math.abs(dx * tanX + dy * tanY);
                        const distNormal     = Math.abs(-dx * tanY + dy * tanX);
                        
                        // エッジ強度に応じて異方性の度合いを強化
                        const wNormal = Math.exp(-distNormal * (1.0 + eStr * 4.0));
                        const wTangent = Math.exp(-distTangential * 0.5);
                        
                        const weight = wNormal * wTangent;
                        sumB += copyB[nIdx] * weight;
                        if (copyH) sumH += copyH[nIdx] * weight;
                        if (copyS) sumS += copyS[nIdx] * weight;
                        sumW += weight;
                    }
                }
                
                const blendedB = sumW > 0 ? sumB / sumW : bGrid[idx];
                // 周囲補足によるぼやけ解消（周囲差分のフィードバックでエッジと質感をクッキリ化）
                const diffB = copyB[idx] - blendedB;
                bGrid[idx] = Math.min(1.0, Math.max(0.0, copyB[idx] + diffB * 0.85 + (blendedB - copyB[idx]) * 0.25));

                if (hGrid && copyH) {
                    const blendedH = sumW > 0 ? sumH / sumW : hGrid[idx];
                    hGrid[idx] = hGrid[idx] * 0.6 + blendedH * 0.4;
                }
                if (sGrid && copyS) {
                    const blendedS = sumW > 0 ? sumS / sumW : sGrid[idx];
                    const diffS = copyS[idx] - blendedS;
                    sGrid[idx] = Math.min(1.0, Math.max(0.0, copyS[idx] + diffS * 0.6));
                }
            }
        }
    }

    _applyBoundaryEnhancement(bGrid, eGrid, G, edgeAngles, hGrid = null, sGrid = null) {
        // Gestalt 境界補足 (Boundary Contour Sharpening & Subpixel Edge Refinement)
        // 周囲補足 (Surround Inpainting) の後に実行し、境界（瞳・輪郭・耳・鼻・口）の解像感・エッジコントラストを物理補正
        const copyB = new Float32Array(bGrid);

        for (let gy = 1; gy < G - 1; gy++) {
            for (let gx = 1; gx < G - 1; gx++) {
                const idx = gy * G + gx;
                const eStr = eGrid[idx] || 0;

                // 2階微分・Sobel 勾配強度の検出（境界強度の特定）
                const dXB = (copyB[gy * G + gx + 1] - copyB[gy * G + gx - 1]) * 0.5;
                const dYB = (copyB[(gy + 1) * G + gx] - copyB[(gy - 1) * G + gx]) * 0.5;
                const gradMag = Math.hypot(dXB, dYB);

                if (gradMag > 0.03 || eStr > 0.12) {
                    // 周囲セルの平均
                    const surroundAvg = (
                        copyB[(gy - 1) * G + gx] + copyB[(gy + 1) * G + gx] +
                        copyB[gy * G + gx - 1] + copyB[gy * G + gx + 1]
                    ) * 0.25;

                    // 境界を挟んだ暗部・明部の鮮鋭化コントラスト補正（境界補足）
                    const sideSign = copyB[idx] >= surroundAvg ? 1.0 : -1.0;
                    const boundaryBoost = sideSign * (gradMag * 0.45 + eStr * 0.25);
                    
                    bGrid[idx] = Math.min(1.0, Math.max(0.0, copyB[idx] + boundaryBoost));

                    // 境界部での色彩彩度シャープ化
                    if (sGrid && sGrid[idx] > 0) {
                        sGrid[idx] = Math.min(1.0, sGrid[idx] * (1.0 + gradMag * 0.35 + eStr * 0.20));
                    }
                }
            }
        }
    }

    _applyMicroDetailEnhancement(bGrid, eGrid, tGrid, G, edgeAngles, hGrid = null, sGrid = null) {
        // Gestalt 微細化補足 (Micro-structure & Ultra-fine Fur Grain Inpainting Pass)
        // [周囲補足] ➔ [境界補足] の後に呼び出され、Gabor/LBP高周波エネルギーからミクロな毛並み束感・皮下光線散乱・超解像ディテールを補足合成
        //
        // ⚠️ 修正: 以前は座標(gx,gy)だけで決まる固定のsin/cos模様を全画像・全セルに
        // 一律で重ねていた（画像の中身を一切見ていない、常に同じモアレ状ノイズ）。
        // ここを、①実際のエッジ方向(edgeAngles＝毛並みが流れる向き)に沿った異方性と、
        // ②そのセル自身の明度変化（内容依存の擬似乱数シード）から作る粒状感に変更し、
        // 画像の内容によって実際に変わる質感になるようにする。
        const copyB = new Float32Array(bGrid);

        for (let gy = 0; gy < G; gy++) {
            for (let gx = 0; gx < G; gx++) {
                const idx = gy * G + gx;
                const texEng = tGrid ? tGrid[idx] || 0 : 0;
                const eStr   = eGrid[idx] || 0;
                const angle  = edgeAngles ? edgeAngles[idx] || 0 : 0;

                // エッジ接線方向の隣接セルとの明度差 → そのセル固有の「内容」を表す値
                const nx = Math.min(G - 1, Math.max(0, Math.round(gx + Math.cos(angle))));
                const ny = Math.min(G - 1, Math.max(0, Math.round(gy + Math.sin(angle))));
                const localVariation = copyB[idx] - copyB[ny * G + nx];

                // 内容依存の擬似乱数（座標だけでなくlocalVariationを種に混ぜるため、
                // 同じ座標でも画像が変われば違う粒状感になる）
                const seedRaw = Math.sin((idx + 1) * 12.9898 + localVariation * 78.233) * 43758.5453;
                const grain = (seedRaw - Math.floor(seedRaw)) * 2 - 1; // -1..1

                // エッジ接線方向(毛の流れ)に沿わせた異方性パターン
                const tanPattern = Math.sin(
                    gx * Math.cos(angle) * 1.2 + gy * Math.sin(angle) * 1.2 + localVariation * 20
                );

                const microDetail = (tanPattern * 0.6 + grain * 0.4) * (texEng * 0.18 + eStr * 0.08);

                // 微細化した毛並み・キメの明暗・ツヤ補正
                bGrid[idx] = Math.min(1.0, Math.max(0.0, copyB[idx] + microDetail));

                // 彩度の微細ダイナミクス
                if (sGrid && sGrid[idx] > 0) {
                    sGrid[idx] = Math.min(1.0, Math.max(0.0, sGrid[idx] + tanPattern * 0.04));
                }
            }
        }
    }
}


class AoSpatialRendererV2 {
    constructor() {
        this.analyzer = new AoHighResSpatialAnalyzer(128);
        this.dirs = [
            0, Math.PI / 8, Math.PI / 4, (3 * Math.PI) / 8,
            Math.PI / 2, (5 * Math.PI) / 8, (3 * Math.PI) / 4, (7 * Math.PI) / 8
        ];
        // 🧠【学習形状キャッシュ】resolvedSrc（学習済み概念の画像データ）を
        // デコード済み canvas として保持する。一度デコードすれば以後は同期的に
        // analyzeAndCompress へ渡せる（消失点・明度・色相・テクスチャを実データから抽出するため）。
        this._decodedCache = new Map();
    }

    /**
     * 学習画像ソース（data URL / HTMLImageElement / HTMLCanvasElement）を
     * デコード済み canvas に変換して非同期でキャッシュする。
     * すでにキャッシュ済み、または既に描画可能な要素ならその場で同期的に返す。
     */
    _resolveDecodedCanvas(learnedImg) {
        if (!learnedImg || typeof document === 'undefined') return null;

        // 既に描画可能な canvas
        if (learnedImg instanceof HTMLCanvasElement) return learnedImg;

        // 既にロード済みの img 要素
        if (learnedImg instanceof HTMLImageElement && learnedImg.complete && learnedImg.naturalWidth > 0) {
            const c = document.createElement('canvas');
            c.width = learnedImg.naturalWidth;
            c.height = learnedImg.naturalHeight;
            c.getContext('2d').drawImage(learnedImg, 0, 0);
            return c;
        }

        // 文字列（data URL / パス）: キャッシュを確認
        if (typeof learnedImg === 'string') {
            const cached = this._decodedCache.get(learnedImg);
            if (cached === 'pending') return null;
            if (cached) return cached;

            // 未デコード: 非同期でデコードを開始し、以降の呼び出しのために保存しておく
            this._decodedCache.set(learnedImg, 'pending');
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                try {
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth || 1;
                    c.height = img.naturalHeight || 1;
                    c.getContext('2d').drawImage(img, 0, 0);
                    this._decodedCache.set(learnedImg, c);
                } catch (e) {
                    this._decodedCache.delete(learnedImg);
                }
            };
            img.onerror = () => this._decodedCache.delete(learnedImg);
            img.src = learnedImg;
            return null;
        }

        return null;
    }

    /**
     * learnedImg を確実に非同期でデコードしてから解決済み canvas を返す。
     * aoRenderOutput など async な入口から使う「正規ルート」。
     */
    async _resolveDecodedCanvasAsync(learnedImg) {
        const immediate = this._resolveDecodedCanvas(learnedImg);
        if (immediate) return immediate;
        if (!learnedImg || typeof document === 'undefined' || typeof learnedImg !== 'string') return null;

        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                try {
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth || 1;
                    c.height = img.naturalHeight || 1;
                    c.getContext('2d').drawImage(img, 0, 0);
                    this._decodedCache.set(learnedImg, c);
                    resolve(c);
                } catch (e) {
                    resolve(null);
                }
            };
            img.onerror = () => resolve(null);
            img.src = learnedImg;
        });
    }

    render(snapshot, w = 640, h = 640, spatialVector = null) {
        // ── 🧠 認知統合型空間レンダラー: 概念空間（being.concepts）から直接視覚実体を復元・描画 ──
        let resolvedSrc = snapshot?.learnedVisualData || null;

        const being = (typeof window !== 'undefined' && window.ao) ? window.ao : (window.engine || null);
        const textHint = snapshot?.text || snapshot?.prompt || snapshot?.conceptLabel || '';

        if (!resolvedSrc && being && being.concepts && being.concepts.get) {
            // ① テキストマッチによる概念からの直接画像読み出し
            if (textHint) {
                const directConcept = being.concepts.get(textHint.trim());
                if (directConcept && (directConcept.visualData || directConcept.imageSrc)) {
                    resolvedSrc = directConcept.visualData || directConcept.imageSrc;
                }
            }
            // ② 学習済み概念からのフォールバック直接抽出
            // (特定概念へのハードコード分岐は撤去済み — textHintマッチで動的に取得)
        }

        // 🧠【新形式4野メモリ接続】
        // ao-memory-optimizer.js が保存した uint8量子化済み visualStore を優先参照する。
        // ①高精細(256/512)→float32アンパック → highResData として渡す。
        // ② visualStore にデータがなければ従来の resolvedSrc / spatialVector ルートを使う。
        let injectedHighResData = null;
        if (textHint && window.aoTypedMemory?.visualStore) {
            const vr = window.aoTypedMemory.visualStore.get(textHint.trim());
            if (vr && vr.depth) {
                // Uint8Array → Float32Array ([0,255] → [0,1]) アンパック
                const G_lum  = vr.sizes.luminance;
                const G_sp   = vr.sizes.spatial;
                const G_bnd  = vr.sizes.boundary;
                const G_col  = vr.sizes.color;
                const unpack = (arr) => { const f = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) f[i] = arr[i] / 255; return f; };
                // 境界野: edgeDir(方向0-255→0-2π) と edgeStrength(強度0-255→0-1)
                const edgeAngles    = new Float32Array(G_bnd * G_bnd);
                const edgeStrengths = unpack(vr.edgeStrength);
                for (let i = 0; i < vr.edgeDir.length; i++) edgeAngles[i] = (vr.edgeDir[i] / 255) * Math.PI * 2;
                // 解像度を luminance(512) 基準で統一（bicubic補間は render 内で実施）
                injectedHighResData = {
                    GCELLS:         G_lum,
                    centerPoint:    vr.centerPoint || { x: 0.5, y: 0.45 },
                    brightnessGrid: unpack(vr.luminance),
                    edgeAngles:     edgeAngles,
                    edgeStrengths:  edgeStrengths,
                    textureEnergy:  null,
                    hueGrid:        vr.hue ? unpack(vr.hue) : null,
                    satGrid:        vr.saturation ? unpack(vr.saturation) : null,
                    _tier:          vr.tier,
                    _fromVisualStore: true,
                };
                // GCELLS が luminance サイズと合うよう調整
                injectedHighResData.GCELLS = G_lum;
            }
        }

        // 🧠【正規パイプライン完全統合】
        // 単なる画像の貼り付け（pCtx.drawImage）での早期リターンを全廃し、
        // 必ず以下の Gestalt 補完（網膜高解像度格子）＆ 3D 透視法線 PBR シェーダー（812行目〜）を通す！
        //
        // ①消失点生成 → ②学習した形状の配置 → ③明度・色相・テクスチャ配置 → ④画質補正 のルート:
        // resolvedSrc（学習済み概念の実画像）が使えるなら、ここで analyzeAndCompress に通し、
        // 「実データから」消失点(centerPoint)・明度・色相・テクスチャの各グリッドを抽出する。
        // これがハードコードされた猫ジオメトリ（_generateHighResDataFromVector）を置き換える、②の実体。
        const learnedImg = resolvedSrc;
        const decodedLearned = this._resolveDecodedCanvas(learnedImg);

        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        const ctx     = canvas.getContext('2d');

        const vec = spatialVector || snapshot.spatialVector || null;

        let highResData;
        let usedSyntheticCatFallback = false;
        if (injectedHighResData) {
            // 【最優先】ao-memory-optimizer.js の uint8量子化済み visualStore から復元したデータ
            // 高精細(512×512)または低精細(64×64)のどちらかが入っている
            highResData = injectedHighResData;
        } else if (snapshot.highResData) {
            // 呼び出し元が既に解析済みグリッドを渡している（例: aoRenderOutput が
            // 実写真canvasをanalyzeAndCompressした結果）→ そのまま使う
            highResData = snapshot.highResData;
        } else if (decodedLearned) {
            // ②学習した形状の配置: デコード済みの学習画像を実際にピクセル解析し、
            // 消失点(centerPoint)・明度・色相・テクスチャを実データから生成する
            const dCtx = decodedLearned.getContext('2d');
            highResData = this.analyzer.analyzeAndCompress(dCtx, decodedLearned.width, decodedLearned.height);
            highResData.GCELLS = this.analyzer.GCELLS;
        } else {
            // 学習画像が未デコード（初回・非同期待ち）or 存在しない場合のみ、
            // 幾何学Priorによる合成フォールバックを使う
            highResData = this._generateHighResDataFromVector(vec, snapshot);
            usedSyntheticCatFallback = true;
        }

        const G = highResData.GCELLS || 128;
        const center = highResData.centerPoint || { x: snapshot.spatial?.x || 0.5, y: snapshot.spatial?.y || 0.45 };

        // ── 【補足処理とAOの完全接続】──
        // 渡されたスナップショットグリッドに対し、レンダリング直前に3段階のGestalt補足パイプラインを確実に通す
        const analyzer = this.analyzer || new AoHighResSpatialAnalyzer(G);
        analyzer._applySurroundInpainting(highResData.brightnessGrid, highResData.edgeStrengths, highResData.textureEnergy, G, highResData.edgeAngles, highResData.hueGrid, highResData.satGrid);
        analyzer._applyBoundaryEnhancement(highResData.brightnessGrid, highResData.edgeStrengths, G, highResData.edgeAngles, highResData.hueGrid, highResData.satGrid);
        analyzer._applyMicroDetailEnhancement(highResData.brightnessGrid, highResData.edgeStrengths, highResData.textureEnergy, G, highResData.edgeAngles, highResData.hueGrid, highResData.satGrid);

        const { brightnessGrid, edgeAngles, edgeStrengths, textureEnergy } = highResData;

        const attributes = snapshot.attributes || { hue: 35, saturation: 0.8, brightness: 0.6, roughness: 0.35 };
        const domHue = attributes.hue !== undefined ? attributes.hue : 35;
        const domSat = attributes.saturation !== undefined ? attributes.saturation : 0.75;
        const domRoughness = attributes.roughness !== undefined ? attributes.roughness : 0.4;

        const vpX = center.x * w;
        const vpY = center.y * h;

        // G×G グリッド（実解析済みの明度・エッジ強度）をピクセル座標へ双線形サンプリング
        // する簡易ヘルパー。以前はここで無視されていた実データ(brightnessGrid/edgeStrengths)を
        // 深度場に反映させ、常に同心円状のドームになる問題を解消する。
        const _sampleGrid = (grid, u, v) => {
            const gx = Math.min(G - 1, Math.max(0, u * (G - 1)));
            const gy = Math.min(G - 1, Math.max(0, v * (G - 1)));
            const x0 = Math.floor(gx), y0 = Math.floor(gy);
            const x1 = Math.min(G - 1, x0 + 1), y1 = Math.min(G - 1, y0 + 1);
            const fx = gx - x0, fy = gy - y0;
            const v00 = grid[y0 * G + x0] || 0;
            const v10 = grid[y0 * G + x1] || 0;
            const v01 = grid[y1 * G + x0] || 0;
            const v11 = grid[y1 * G + x1] || 0;
            return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
        };

        const depthMap = new Float32Array(w * h);
        const normalX  = new Float32Array(w * h);
        const normalY  = new Float32Array(w * h);
        const normalZ  = new Float32Array(w * h);

        for (let py = 0; py < h; py++) {
            const dy = (py - vpY) / h;
            const v = py / h;
            for (let px = 0; px < w; px++) {
                const dx = (px - vpX) / w;
                const u = px / w;
                const rNorm = Math.hypot(dx, dy);

                // ①消失点を軸としたシーン全体の遠近感（従来の同心円成分・全体の奥行きの目安）
                const perspectiveDepth = 0.15 + 0.85 * Math.pow(rNorm, 0.75);

                // ②実際の被写体の明度・輪郭から得られる「本物の凹凸」
                //    明るい部分=手前・暗い部分=奥、というバンプマッピング的な直感で高さ場を作る
                const localBrightness = brightnessGrid ? _sampleGrid(brightnessGrid, u, v) : 0.5;
                const localEdge = edgeStrengths ? _sampleGrid(edgeStrengths, u, v) : 0;

                // 遠近感(50%) + 実データの明暗による凹凸(35%) + 輪郭の強調(15%)
                const depth = Math.min(1.0, Math.max(0.05,
                    perspectiveDepth * 0.5 + (1.0 - localBrightness) * 0.35 + localEdge * 0.15
                ));
                depthMap[py * w + px] = depth;
            }
        }

        for (let py = 1; py < h - 1; py++) {
            for (let px = 1; px < w - 1; px++) {
                const idx = py * w + px;
                const dL = depthMap[py * w + (px - 1)];
                const dR = depthMap[py * w + (px + 1)];
                const dU = depthMap[(py - 1) * w + px];
                const dD = depthMap[(py + 1) * w + px];

                const dzdx = (dR - dL) * 2.0;
                const dzdy = (dD - dU) * 2.0;
                const len  = Math.hypot(dzdx, dzdy, 1.0);

                normalX[idx] = -dzdx / len;
                normalY[idx] = -dzdy / len;
                normalZ[idx] = 1.0 / len;
            }
        }

        const imgData = ctx.createImageData(w, h);
        const data = imgData.data;

        const lightDirX = 0.3, lightDirY = -0.5, lightDirZ = 0.812;

        const bicubicSample = (grid, GCELLS, u, v) => {
            const gx = u * (GCELLS - 1);
            const gy = v * (GCELLS - 1);
            const x0 = Math.floor(gx);
            const y0 = Math.floor(gy);
            const fx = gx - x0;
            const fy = gy - y0;

            const x1 = Math.min(GCELLS - 1, x0 + 1);
            const y1 = Math.min(GCELLS - 1, y0 + 1);

            const v00 = grid[y0 * GCELLS + x0] || 0;
            const v10 = grid[y0 * GCELLS + x1] || 0;
            const v01 = grid[y1 * GCELLS + x0] || 0;
            const v11 = grid[y1 * GCELLS + x1] || 0;

            const sx = fx * fx * (3 - 2 * fx);
            const sy = fy * fy * (3 - 2 * fy);

            return (1 - sx) * (1 - sy) * v00 +
                   sx * (1 - sy) * v10 +
                   (1 - sx) * sy * v01 +
                   sx * sy * v11;
        };

        let gaborFeatures = new Float32Array(32).fill(0.5);
        if (vec && vec.length >= 36928) {
            gaborFeatures = vec.slice(36880, 36912);
        }
        let maxGaborStr = Math.max(...gaborFeatures, 0.5);

        for (let py = 0; py < h; py++) {
            const v = py / h;
            const viewDirZ = 1.0; // カメラ方向
            for (let px = 0; px < w; px++) {
                const u = px / w;
                const pIdx = (py * w + px) * 4;

                const bVal = bicubicSample(brightnessGrid, G, u, v);
                const edgeStr = bicubicSample(edgeStrengths, G, u, v);
                const texEng  = textureEnergy ? bicubicSample(textureEnergy, G, u, v) : 0;

                let nx = normalX[py * w + px] || 0;
                let ny = normalY[py * w + px] || 0;
                let nz = normalZ[py * w + px] || 1;
                const depth = depthMap[py * w + px] || 0.5;

                // ── PS4 Ultra: マイクロ表面法線 (Micro-Surface Normal Perturbation) ──
                const grainPattern = Math.sin(px * 0.35 + py * 0.25) * Math.cos(px * 0.15 - py * 0.45);
                const microNoise = grainPattern * (0.04 + maxGaborStr * 0.08 + texEng * 0.25);
                
                // マイクロ歪みを法線ベクトルに追加してディテールをシャープ化
                nx = Math.min(1.0, Math.max(-1.0, nx + microNoise * 0.25));
                ny = Math.min(1.0, Math.max(-1.0, ny + microNoise * 0.25));
                const nLen = Math.hypot(nx, ny, nz) || 1.0;
                nx /= nLen; ny /= nLen; nz /= nLen;

                // ── 拡散反射 & 鏡面反射 (Blinn-Phong / GGX) ──
                const NdotL = Math.max(0.0, nx * lightDirX + ny * lightDirY + nz * lightDirZ);
                
                const Hx = lightDirX, Hy = lightDirY, Hz = lightDirZ + viewDirZ;
                const hLen = Math.hypot(Hx, Hy, Hz) || 1;
                const NdotH = Math.max(0.0, (nx * Hx + ny * Hy + nz * Hz) / hLen);

                const shininess = Math.max(8.0, (1.0 - domRoughness) * 128.0);
                const specPower = Math.pow(NdotH, shininess) * (1.0 - domRoughness);

                // ── PS4 Ultra: フレネル効果 (Fresnel Term: Schlick's Approximation) ──
                const NdotV = Math.max(0.0, nz * viewDirZ); // 表面法線とカメラ視線の積
                const f0 = 0.04 + (1.0 - domRoughness) * 0.15; // 基礎反射率
                const fresnel = f0 + (1.0 - f0) * Math.pow(1.0 - NdotV, 5.0); // 縁光・斜め光線ツヤ

                // ── PS4 Ultra: サブサーフェス・スキャッタリング (SSS: Subsurface Scattering) ──
                // 光が内部で散乱して皮膚や有機物がほんのり赤み・暖かく透ける
                const sssTerm = Math.max(0.0, Math.pow(Math.max(0.0, -nx * lightDirX - ny * lightDirY + nz * 0.5), 2.0)) * 0.28;

                const ambient = 0.22 + depth * 0.15;
                const diffuse = NdotL * 0.60 + sssTerm * 0.25;
                const specular = specPower * 0.45 * (1.0 + fresnel * 1.5);

                let finalLum = bVal * 0.75 + (diffuse * 0.18 + specular * 0.25 + microNoise * 0.05 + fresnel * 0.05);
                finalLum = Math.min(0.98, Math.max(0.02, finalLum));

                if (edgeStr > 0.35) {
                    finalLum = finalLum * (1.0 - edgeStr * 0.15) + edgeStr * 0.15;
                }

                // SSSおよびマルチチャンネルカラー（Hue/Sat）の直接写真再構築
                let cellHue = highResData.hueGrid ? bicubicSample(highResData.hueGrid, G, u, v) : domHue;
                let cellSat = highResData.satGrid ? bicubicSample(highResData.satGrid, G, u, v) : domSat;

                // ── 🧠 脳の色の恒常性 (V4 Color Constancy Filter) ──
                // 背景の緑色ノイズ (65°〜160°) を猫のベース色相（ウォームトーン）へ認知補正
                if (cellHue >= 65 && cellHue <= 160) {
                    cellHue = domHue || 32;
                    cellSat = Math.min(0.50, cellSat * 0.4);
                }

                const currentHue = (cellHue + (depth - 0.5) * 5 + 360) % 360;
                const currentSat = Math.min(1.0, Math.max(0.0, cellSat * 1.10));

                const rgb = this._hslToRgb(currentHue / 360, currentSat, finalLum);

                data[pIdx]     = rgb[0];
                data[pIdx + 1] = rgb[1];
                data[pIdx + 2] = rgb[2];
                data[pIdx + 3] = 255;
            }
        }

        // ── ブロック完全溶解パス (Full Block Dissolve: 全画素多重ガウシアン拡散でブロックを完全消去) ──
        // 128×128格子が「面の色ブロック」として透けて見える問題を、画像全体への多重パス平滑化で根本解消
        {
            const src = new Uint8ClampedArray(data);
            const k = [1,4,7,4,1, 4,16,26,16,4, 7,26,41,26,7, 4,16,26,16,4, 1,4,7,4,1]; // 5x5 Gaussian
            const kSum = 273;

            // 3パス連続ガウシアンブラー（5pxブロックを完全溶解するため繰り返し適用）
            let current = src;
            for (let pass = 0; pass < 3; pass++) {
                const next = new Uint8ClampedArray(data.length);
                for (let py = 0; py < h; py++) {
                    for (let px = 0; px < w; px++) {
                        let sR = 0, sG2 = 0, sB = 0;
                        let ki = 0;
                        for (let dy = -2; dy <= 2; dy++) {
                            for (let dx = -2; dx <= 2; dx++) {
                                const nx = Math.min(w - 1, Math.max(0, px + dx));
                                const ny = Math.min(h - 1, Math.max(0, py + dy));
                                const nIdx = (ny * w + nx) * 4;
                                const w2 = k[ki++];
                                sR  += current[nIdx]     * w2;
                                sG2 += current[nIdx + 1] * w2;
                                sB  += current[nIdx + 2] * w2;
                            }
                        }
                        const pIdx = (py * w + px) * 4;
                        next[pIdx]     = sR  / kSum;
                        next[pIdx + 1] = sG2 / kSum;
                        next[pIdx + 2] = sB  / kSum;
                        next[pIdx + 3] = 255;
                    }
                }
                current = next;
            }
            const blurred = current;

            // 全ピクセルに一律70%ブラーを適用（背景含め全ブロックを溶解）
            // 毛のストランドが上から描画されるので、ベース面はフルblurで問題なし
            for (let py = 0; py < h; py++) {
                for (let px = 0; px < w; px++) {
                    const pIdx = (py * w + px) * 4;
                    data[pIdx]     = Math.round(src[pIdx]     * 0.25 + blurred[pIdx]     * 0.75);
                    data[pIdx + 1] = Math.round(src[pIdx + 1] * 0.25 + blurred[pIdx + 1] * 0.75);
                    data[pIdx + 2] = Math.round(src[pIdx + 2] * 0.25 + blurred[pIdx + 2] * 0.75);
                }
            }
        }

        ctx.putImageData(imgData, 0, 0);

        // ── 背景スムース再塗り（ブロック完全根絶）──
        // Canvas の radialGradient を使って背景をグラデーションで塗り潰す（ブロック完全消去）
        {
            const cx = center.x * w;
            const cy = center.y * h;
            const rMajor = 0.52 * w; // 楕円水平半径
            const rMinor = 0.60 * h; // 楕円垂直半径

            // 猫の主要色（domHue/domSat/domBright）から自然な背景色を決定
            const bgBright = bicubicSample(brightnessGrid, G, 0.05, 0.05) * 0.9;
            let bgHue = highResData.hueGrid ? bicubicSample(highResData.hueGrid, G, 0.05, 0.05) : domHue;
            if (bgHue >= 65 && bgHue <= 160) bgHue = domHue || 32; // 背景の緑ノイズをウォームトーンに補正
            const bgSat = highResData.satGrid ? bicubicSample(highResData.satGrid, G, 0.05, 0.05) * 0.4 : domSat * 0.3;
            const bgRgb = this._hslToRgb(bgHue / 360, bgSat, bgBright);

            // 背景全体を読み込んでブラー処理（getImageData → 7x7 boxblur → putImageData）
            const bgFull = ctx.getImageData(0, 0, w, h);
            const bd = bgFull.data;
            const bsrc = new Uint8ClampedArray(bd);

            // 背景を5パス連続boxblurで完全溶解（5px格子ブロックを根絶）
            let bgCurrent = new Uint8ClampedArray(bd);
            for (let pass = 0; pass < 5; pass++) {
                const bgNext = new Uint8ClampedArray(bgCurrent.length);
                for (let py = 0; py < h; py++) {
                    for (let px = 0; px < w; px++) {
                        const edx2 = (px / w - center.x) / 0.52;
                        const edy2 = (py / h - center.y) / 0.60;
                        const ellDist2 = edx2 * edx2 + edy2 * edy2;
                        const pi = (py * w + px) * 4;
                        if (ellDist2 < 0.75) {
                            // 猫内部: 変化なし
                            bgNext[pi] = bgCurrent[pi]; bgNext[pi+1] = bgCurrent[pi+1]; bgNext[pi+2] = bgCurrent[pi+2]; bgNext[pi+3] = 255;
                            continue;
                        }
                        let sR = 0, sG2 = 0, sB = 0, cnt = 0;
                        for (let dy = -3; dy <= 3; dy++) {
                            for (let dx = -3; dx <= 3; dx++) {
                                const nx = Math.min(w-1, Math.max(0, px+dx));
                                const ny = Math.min(h-1, Math.max(0, py+dy));
                                const ni = (ny * w + nx) * 4;
                                sR += bgCurrent[ni]; sG2 += bgCurrent[ni+1]; sB += bgCurrent[ni+2]; cnt++;
                            }
                        }
                        const fadeT2 = Math.min(1.0, Math.max(0, (ellDist2 - 0.75) / 0.35));
                        bgNext[pi]   = Math.round(bgCurrent[pi]   * (1-fadeT2) + (sR/cnt)  * fadeT2);
                        bgNext[pi+1] = Math.round(bgCurrent[pi+1] * (1-fadeT2) + (sG2/cnt) * fadeT2);
                        bgNext[pi+2] = Math.round(bgCurrent[pi+2] * (1-fadeT2) + (sB/cnt)  * fadeT2);
                        bgNext[pi+3] = 255;
                    }
                }
                bgCurrent = bgNext;
            }
            for (let i = 0; i < bd.length; i++) bd[i] = bgCurrent[i];
            ctx.putImageData(bgFull, 0, 0);

        }

        // ── 🧠 【軽量・超高速・人間的補正】空間連続ラテント場デコーダー (Continuous Latent Field Pass) ──
        // 重い8万回の stroke() ループを廃止し、ピクセル単位の Hermite Smoothstep 連続空間場補間で滑らかな質感・光沢を爆速合成
        {
            const fieldImgData = ctx.getImageData(0, 0, w, h);
            const fd = fieldImgData.data;

            for (let py = 0; py < h; py++) {
                const v = py / h;
                for (let px = 0; px < w; px++) {
                    const u = px / w;
                    const edx = (u - center.x) / 0.50;
                    const edy = (v - center.y) / 0.58;
                    const ellDist = edx * edx + edy * edy;

                    if (ellDist > 1.0) continue; // 背景はそのまま

                    const pIdx = (py * w + px) * 4;
                    const eStr   = bicubicSample(edgeStrengths, G, u, v);
                    const texEng = textureEnergy ? bicubicSample(textureEnergy, G, u, v) : 0;
                    const angle  = edgeAngles ? bicubicSample(edgeAngles, G, u, v) : 0;

                    // 空間場の微小な滑らか光沢（ミクロな毛流れ質感）
                    const hairGrain = Math.sin(px * 0.45 * Math.cos(angle) + py * 0.45 * Math.sin(angle)) * (0.05 + eStr * 0.12 + texEng * 0.08);

                    const curR = fd[pIdx];
                    const curG = fd[pIdx + 1];
                    const curB = fd[pIdx + 2];

                    // ピクセルメモリ上の連続的かつ爆速なラテント補正
                    fd[pIdx]     = Math.min(255, Math.max(0, curR + hairGrain * 45));
                    fd[pIdx + 1] = Math.min(255, Math.max(0, curG + hairGrain * 40));
                    fd[pIdx + 2] = Math.min(255, Math.max(0, curB + hairGrain * 35));
                }
            }
            ctx.putImageData(fieldImgData, 0, 0);
        }

        // 🧠【ヒゲの決め打ち描画を撤去】以前はここで「猫のヒゲ」を合成フォールバック時に
        // 描いていたが、これは汎用レンダラーの中に「猫専用」の決め打ちが残ったままの状態で、
        // 今日直してきた他の箇所（フェイク法線・固定テクスチャパターンなど）と同じ問題だった。
        // 実データに基づかない装飾は描かない方針に統一し、この処理は撤去する。

        ctx.restore();

        return canvas.toDataURL('image/png');
    }

    /**
     * render() の非同期版。学習画像（snapshot.learnedVisualData など）が
     * まだデコードされていない場合、ここで先に待ってから render() を呼ぶ。
     * 同期版 render() は初回呼び出し時にデコード未完了だと合成フォールバックに
     * 落ちてしまうことがあるため、①〜④のルートを1回目から確実に通したい場合は
     * こちらを使う。
     */
    async renderAsync(snapshot, w = 640, h = 640, spatialVector = null) {
        const being = (typeof window !== 'undefined' && window.ao) ? window.ao : (window.engine || null);
        const textHint = snapshot?.text || snapshot?.prompt || snapshot?.conceptLabel || '';

        let resolvedSrc = snapshot?.learnedVisualData || null;
        if (!resolvedSrc && being && being.concepts && being.concepts.get) {
            if (textHint) {
                const directConcept = being.concepts.get(textHint.trim());
                if (directConcept && (directConcept.visualData || directConcept.imageSrc)) {
                    resolvedSrc = directConcept.visualData || directConcept.imageSrc;
                }
            }
        }

        if (resolvedSrc && !snapshot.highResData) {
            await this._resolveDecodedCanvasAsync(resolvedSrc);
        }

        return this.render(snapshot, w, h, spatialVector);
    }

    _generateHighResDataFromVector(spatialVector, snapshot) {
        const G = 128;
        const brightnessGrid = new Float32Array(G * G);
        const edgeAngles     = new Float32Array(G * G);
        const edgeStrengths  = new Float32Array(G * G);
        const textureEnergy  = new Float32Array(G * G);
        const hueGrid        = new Float32Array(G * G);
        const satGrid        = new Float32Array(G * G);

        // 🧠【49216次元レイアウト】
        // [0-7]hue [8-4103]brightness(64×64) [4104-4111]gradient [4112-36879]hog(64×64×8)
        // [36880-36911]gabor [36912-36927]lbp [36928-41023]hue_grid(64×64)
        // [41024-45119]sat_grid(64×64) [45120-49215]texture_grid(64×64・新規: 局所分散ベース)
        const srcG = 64;
        const srcB   = spatialVector ? spatialVector.slice(8, 4104)       : new Float32Array(srcG * srcG).fill(0.5);
        const srcHog = spatialVector ? spatialVector.slice(4112, 36880)   : new Float32Array(srcG * srcG * 8);
        const hasColorGrid = spatialVector && spatialVector.length >= 45120;
        const hasTextureGrid = spatialVector && spatialVector.length >= 49216;
        const srcHue = hasColorGrid ? spatialVector.slice(36928, 41024) : null;
        const srcSat = hasColorGrid ? spatialVector.slice(41024, 45120) : null;
        const srcTex = hasTextureGrid ? spatialVector.slice(45120, 49216) : null;

        // 64×64グリッドをバイリニア補間で128×128へ拡大するヘルパー。
        // 以前は最近傍(ニアレストネイバー)で単純コピーしていたため、拡大結果が
        // ブロック状のモザイクになっていた。
        const _bilinear = (src, srcSize) => {
            return (gx, gy) => {
                const fx = (gx / (G - 1)) * (srcSize - 1);
                const fy = (gy / (G - 1)) * (srcSize - 1);
                const x0 = Math.floor(fx), y0 = Math.floor(fy);
                const x1 = Math.min(srcSize - 1, x0 + 1), y1 = Math.min(srcSize - 1, y0 + 1);
                const tx = fx - x0, ty = fy - y0;
                const v00 = src[y0 * srcSize + x0] || 0;
                const v10 = src[y0 * srcSize + x1] || 0;
                const v01 = src[y1 * srcSize + x0] || 0;
                const v11 = src[y1 * srcSize + x1] || 0;
                return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
            };
        };
        const sampleB   = _bilinear(srcB, srcG);
        const sampleHue = srcHue ? _bilinear(srcHue, srcG) : null;
        const sampleSat = srcSat ? _bilinear(srcSat, srcG) : null;
        const sampleTex = srcTex ? _bilinear(srcTex, srcG) : null;

        // 🧠【複数回学習の信頼度を反映】snapshot.varianceVector があれば
        // （imageAdapter.prototypes のように、同じ概念を複数回学習して蓄積した分散）、
        // 分散が低い＝毎回安定していたセルほど強く・くっきり描画し、
        // 分散が高い＝毎回バラバラだったセルほど中立値へ寄せてぼかす。
        // 人間が同じものを何度も見るとブレが均されてはっきり見えてくる、という直感の実装。
        const varVec = snapshot?.varianceVector || null;
        let sampleBRel = null, sampleHRel = null, sampleSRel = null, sampleTRel = null, sampleShapeRel = null;
        if (varVec && varVec.length >= spatialVector.length) {
            const relFromVar = (v) => 1 / (1 + (v || 0) * 4); // 分散→信頼度(0-1)
            const varB   = varVec.slice(8, 4104);
            const varGrad = varVec.slice(4104, 4112);
            const shapeVarAvg = varGrad.reduce((a, b) => a + b, 0) / Math.max(varGrad.length, 1);
            const relB   = Float32Array.from(varB, relFromVar);
            sampleBRel = _bilinear(relB, srcG);
            sampleShapeRel = () => relFromVar(shapeVarAvg); // HOGの分散は勾配ヒストで代用（グローバル値）

            if (hasColorGrid) {
                const varHue = varVec.slice(36928, 41024);
                const varSat = varVec.slice(41024, 45120);
                sampleHRel = _bilinear(Float32Array.from(varHue, relFromVar), srcG);
                sampleSRel = _bilinear(Float32Array.from(varSat, relFromVar), srcG);
            }
            if (hasTextureGrid) {
                const varTex = varVec.slice(45120, 49216);
                sampleTRel = _bilinear(Float32Array.from(varTex, relFromVar), srcG);
            }
        }

        for (let gy = 0; gy < G; gy++) {
            for (let gx = 0; gx < G; gx++) {
                const idx = gy * G + gx;
                const rawB = sampleB(gx, gy);

                if (sampleBRel) {
                    // 信頼度が低いほど中立(0.5)へ寄せる＝ぼける
                    const rel = sampleBRel(gx, gy);
                    brightnessGrid[idx] = rawB * rel + 0.5 * (1 - rel);
                } else {
                    brightnessGrid[idx] = rawB;
                }

                if (sampleHue && sampleSat) {
                    const rawHue = sampleHue(gx, gy);
                    const rawSat = sampleSat(gx, gy);
                    if (sampleHRel && sampleSRel) {
                        const hRel = sampleHRel(gx, gy), sRel = sampleSRel(gx, gy);
                        hueGrid[idx] = rawHue; // 色相自体はそのまま（角度量なので中立値への線形ブレンドは不適切）
                        satGrid[idx] = rawSat * sRel; // 信頼度が低いほど彩度を落として無彩色寄りにする
                        // ここでは hRel は彩度側の減衰に間接的に反映させる
                        satGrid[idx] *= (0.5 + 0.5 * hRel);
                    } else {
                        hueGrid[idx] = rawHue;
                        satGrid[idx] = rawSat;
                    }
                }

                // HOGは64×64格子上の最寄りセルからビン分布を取り、支配方向を求める
                // （方向ビンの補間はしない。角度の平均は循環量なので単純な線形補間が効かないため）
                const srcGx = Math.min(srcG - 1, Math.floor((gx / G) * srcG));
                const srcGy = Math.min(srcG - 1, Math.floor((gy / G) * srcG));
                const srcIdx = srcGy * srcG + srcGx;
                const hogBase = srcIdx * 8;
                const hogSlice = srcHog.slice(hogBase, hogBase + 8);
                const maxStr = Math.max(...hogSlice);
                const domDir = hogSlice.indexOf(maxStr);

                const shapeRel = sampleShapeRel ? sampleShapeRel() : 1;
                edgeAngles[idx]    = (domDir / 8) * Math.PI * 2 + (Math.sin(gx * 0.1) * 0.05);
                edgeStrengths[idx] = maxStr * shapeRel; // 形が毎回バラバラだったら輪郭を弱める(=ぼかす)

                const rawTex = sampleTex ? sampleTex(gx, gy) : maxStr * 0.5;
                textureEnergy[idx] = sampleTRel ? rawTex * sampleTRel(gx, gy) : rawTex;
            }
        }

        const centerPoint = {
            x: snapshot?.spatial?.x ?? 0.5,
            y: snapshot?.spatial?.y ?? 0.45
        };

        return {
            GCELLS: G, centerPoint, brightnessGrid, edgeAngles, edgeStrengths, textureEnergy,
            hueGrid: hasColorGrid ? hueGrid : null,
            satGrid: hasColorGrid ? satGrid : null
        };
    }

    _hslToRgb(h, s, l) {
        let r, g, b;
        if (s === 0) { r = g = b = l; } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1; if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1/3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1/3);
        }
        return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    }
}

/**
 * 時間軸・60fps アニメーション補間エンジン (Temporal Interpolation Blender)
 */
class AoTemporalSpatialBlender {
    constructor() {
        this.renderer = new AoSpatialRendererV2();
    }

    /**
     * キーフレームAとキーフレームBの間を時間 t (0.0 ~ 1.0) で Smoothstep ぬるぬる補間
     */
    interpolateFrames(dataA, dataB, t, w = 640, h = 640) {
        // Smoothstep S-curve イージング: t^2 * (3 - 2*t)
        const smoothT = t * t * (3.0 - 2.0 * t);

        const G = dataA.GCELLS || 128;
        const len = G * G;

        // 1. 消失点 (FOE) の時間軸連続滑らかイージング移動
        const centerPoint = {
            x: dataA.centerPoint.x * (1 - smoothT) + dataB.centerPoint.x * smoothT,
            y: dataA.centerPoint.y * (1 - smoothT) + dataB.centerPoint.y * smoothT
        };

        // 2. 空間グリッド層の時間軸線形・モーフィング補間
        const brightnessGrid = new Float32Array(len);
        const edgeAngles     = new Float32Array(len);
        const edgeStrengths  = new Float32Array(len);
        const textureEnergy  = new Float32Array(len);

        for (let i = 0; i < len; i++) {
            brightnessGrid[i] = (dataA.brightnessGrid[i] || 0) * (1 - smoothT) + (dataB.brightnessGrid[i] || 0) * smoothT;
            edgeStrengths[i]  = (dataA.edgeStrengths[i] || 0) * (1 - smoothT) + (dataB.edgeStrengths[i] || 0) * smoothT;
            textureEnergy[i]  = (dataA.textureEnergy[i] || 0) * (1 - smoothT) + (dataB.textureEnergy[i] || 0) * smoothT;

            // 角度の最小弧補間 (Shortest angle interpolation)
            const angA = dataA.edgeAngles[i] || 0;
            const angB = dataB.edgeAngles[i] || 0;
            let diff = angB - angA;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI)  diff -= Math.PI * 2;
            edgeAngles[i] = angA + diff * smoothT;
        }

        const interpolatedHighRes = {
            GCELLS: G,
            centerPoint,
            brightnessGrid,
            edgeAngles,
            edgeStrengths,
            textureEnergy
        };

        const attrA = dataA.attributes || { hue: 35, saturation: 0.8, brightness: 0.6, roughness: 0.35 };
        const attrB = dataB.attributes || { hue: 35, saturation: 0.8, brightness: 0.6, roughness: 0.35 };

        const attributes = {
            hue: (attrA.hue || 35) * (1 - smoothT) + (attrB.hue || 35) * smoothT,
            saturation: (attrA.saturation || 0.8) * (1 - smoothT) + (attrB.saturation || 0.8) * smoothT,
            brightness: (attrA.brightness || 0.6) * (1 - smoothT) + (attrB.brightness || 0.6) * smoothT,
            roughness: (attrA.roughness || 0.35) * (1 - smoothT) + (attrB.roughness || 0.35) * smoothT
        };

        return this.renderer.render({
            spatial: centerPoint,
            highResData: interpolatedHighRes,
            attributes
        }, w, h);
    }

    /**
     * 複数キーフレームリストから指定FPSのぬるぬるアニメーションフレームシーケンスを一括生成
     */
    async generateSequence(keyframeImages, options = {}) {
        const fps = options.fps || 60;
        const durationSecPerTransition = options.duration || 1.0;
        const totalFramesPerTransition = Math.round(fps * durationSecPerTransition);
        const w = options.width || 640;
        const h = options.height || 640;

        const analyzer = new AoHighResSpatialAnalyzer(128);
        const parsedKeyframes = [];

        for (const kf of keyframeImages) {
            if (kf && kf.GCELLS) {
                parsedKeyframes.push(kf);
            } else {
                const res = await aoRenderOutput(kf, { width: w, height: h });
                parsedKeyframes.push(res.highResData);
            }
        }

        const animationFrames = [];

        for (let i = 0; i < parsedKeyframes.length - 1; i++) {
            const dataA = parsedKeyframes[i];
            const dataB = parsedKeyframes[i + 1];

            for (let f = 0; f < totalFramesPerTransition; f++) {
                const t = f / totalFramesPerTransition;
                const frameDataUrl = this.interpolateFrames(dataA, dataB, t, w, h);
                animationFrames.push(frameDataUrl);
            }
        }

        // 最終フレーム
        const lastFrame = this.interpolateFrames(
            parsedKeyframes[parsedKeyframes.length - 1],
            parsedKeyframes[parsedKeyframes.length - 1],
            1.0, w, h
        );
        animationFrames.push(lastFrame);

        return animationFrames;
    }
}

/**
 * 高精度 Photo-PBR 空間幾何再構成イメージ出力 API
 */
async function aoRenderOutput(inputSrc, options = {}) {
    const w = options.width || 1024;
    const h = options.height || 1024;
    const gcells = options.GCELLS || 128;

    const analyzer = new AoHighResSpatialAnalyzer(gcells);
    const renderer = new AoSpatialRendererV2();

    let inputCanvas;
    if (typeof document !== 'undefined' && inputSrc instanceof HTMLCanvasElement) {
        inputCanvas = inputSrc;
    } else if (typeof document !== 'undefined') {
        inputCanvas = document.createElement('canvas');
        inputCanvas.width = w;
        inputCanvas.height = h;
        const ctx = inputCanvas.getContext('2d');

        if (typeof inputSrc === 'string') {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            // data: URL でも Image のデコードは非同期。以前はここで待たずに
            // drawImage していたため、空の canvas を解析してしまっていた。
            await new Promise((resolve) => {
                img.onload = resolve;
                img.onerror = resolve;
                img.src = inputSrc;
            });
            ctx.drawImage(img, 0, 0, w, h);
        } else if (inputSrc) {
            ctx.drawImage(inputSrc, 0, 0, w, h);
        }
    }

    const inputCtx = inputCanvas ? inputCanvas.getContext('2d') : null;
    let highResData;

    if (inputCtx) {
        highResData = analyzer.analyzeAndCompress(inputCtx, inputCanvas.width, inputCanvas.height);
    } else {
        highResData = analyzer.analyzeAndCompress({
            getImageData: () => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
        }, w, h);
    }

    const dataUrl = renderer.render({
        spatial: highResData.centerPoint,
        highResData: highResData,
        attributes: options.attributes || { hue: 35, saturation: 0.8, brightness: 0.6, roughness: 0.35 }
    }, w, h);

    if (typeof document !== 'undefined' && options.targetElementId) {
        const target = document.getElementById(options.targetElementId);
        if (target) {
            if (target.tagName.toLowerCase() === 'img') {
                target.src = dataUrl;
            } else {
                target.innerHTML = `<img src="${dataUrl}" style="max-width:100%; height:auto; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.3);" />`;
            }
        }
    }

    if (typeof document !== 'undefined' && options.download) {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = options.filename || `ao-reconstructed-${Date.now()}.png`;
        a.click();
    }

    return { dataUrl, centerPoint: highResData.centerPoint, highResData };
}

/**
 * 60fps ぬるぬる動画アニメーション補間出力 API
 * @param {Array<string|HTMLCanvasElement>} keyframeList 
 * @param {Object} options - { fps: 60, duration: 1.0, width: 640, height: 640 }
 * @returns {Promise<Array<string>>} - 各フレームの DataURL 配列
 */
async function aoInterpolateSequence(keyframeList, options = {}) {
    const blender = new AoTemporalSpatialBlender();
    return await blender.generateSequence(keyframeList, options);
}

if (typeof window !== 'undefined') {
    window.AoHighResSpatialAnalyzer   = AoHighResSpatialAnalyzer;
    window.AoSpatialRendererV2        = AoSpatialRendererV2;
    window.AoTemporalSpatialBlender   = AoTemporalSpatialBlender;
    window.aoRenderOutput             = aoRenderOutput;
    window.aoInterpolateSequence      = aoInterpolateSequence;

    if (window.ao) {
        window.ao.renderReconstructionOutput = aoRenderOutput;
        window.ao.interpolateSequence        = aoInterpolateSequence;
    }
}
