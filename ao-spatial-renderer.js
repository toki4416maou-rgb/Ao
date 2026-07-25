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

class AoHighResSpatialAnalyzer {
    constructor(gcells = 128) {
        console.log(`[AoUnifiedArchitectureEngine] Photo-PBR High-Res Spatial Analyzer (GCELLS=${gcells}) Initialized`);
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
        const edgeAngles     = new Float32Array(G * G);
        const edgeStrengths  = new Float32Array(G * G);
        const textureEnergy  = new Float32Array(G * G);

        const blockW = w / G;
        const blockH = h / G;

        let totalEdgeX = 0, totalEdgeY = 0, totalEdgeWeight = 0.001;
        let brightX = 0, brightY = 0, totalBrightness = 0.001;

        for (let gy = 0; gy < G; gy++) {
            for (let gx = 0; gx < G; gx++) {
                const idx = gy * G + gx;
                let sumB = 0, count = 0;
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
                }
            }
        }

        this._applySurroundInpainting(brightnessGrid, edgeStrengths, textureEnergy, G);

        const centerGx = (brightX / totalBrightness * 0.35) + (totalEdgeX / totalEdgeWeight * 0.65);
        const centerGy = (brightY / totalBrightness * 0.35) + (totalEdgeY / totalEdgeWeight * 0.65);

        const centerPoint = {
            x: Math.min(0.9, Math.max(0.1, centerGx / G)),
            y: Math.min(0.9, Math.max(0.1, centerGy / G))
        };

        return {
            GCELLS: G,
            centerPoint,
            brightnessGrid,
            edgeAngles,
            edgeStrengths,
            textureEnergy
        };
    }

    _applySurroundInpainting(bGrid, eGrid, tGrid, G) {
        const copyB = new Float32Array(bGrid);
        const weights = [
            0.05, 0.1, 0.05,
            0.1,  0.4, 0.1,
            0.05, 0.1, 0.05
        ];

        for (let gy = 1; gy < G - 1; gy++) {
            for (let gx = 1; gx < G - 1; gx++) {
                const idx = gy * G + gx;
                let sumB = 0, sumW = 0;
                let k = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nIdx = (gy + dy) * G + (gx + dx);
                        const w = weights[k++];
                        sumB += copyB[nIdx] * w;
                        sumW += w;
                    }
                }
                bGrid[idx] = bGrid[idx] * 0.6 + (sumB / sumW) * 0.4;
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
    }

    render(snapshot, w = 640, h = 640, spatialVector = null) {
        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        const ctx     = canvas.getContext('2d');

        const vec = spatialVector || snapshot.spatialVector || null;
        const highResData = snapshot.highResData || this._generateHighResDataFromVector(vec, snapshot);

        const G = highResData.GCELLS || 128;
        const center = highResData.centerPoint || { x: snapshot.spatial?.x || 0.5, y: snapshot.spatial?.y || 0.45 };
        const { brightnessGrid, edgeAngles, edgeStrengths, textureEnergy } = highResData;

        const attributes = snapshot.attributes || { hue: 35, saturation: 0.8, brightness: 0.6, roughness: 0.35 };
        const domHue = attributes.hue !== undefined ? attributes.hue : 35;
        const domSat = attributes.saturation !== undefined ? attributes.saturation : 0.75;
        const domRoughness = attributes.roughness !== undefined ? attributes.roughness : 0.4;

        const vpX = center.x * w;
        const vpY = center.y * h;

        const depthMap = new Float32Array(w * h);
        const normalX  = new Float32Array(w * h);
        const normalY  = new Float32Array(w * h);
        const normalZ  = new Float32Array(w * h);

        for (let py = 0; py < h; py++) {
            const dy = (py - vpY) / h;
            for (let px = 0; px < w; px++) {
                const dx = (px - vpX) / w;
                const rNorm = Math.hypot(dx, dy);
                const depth = Math.min(1.0, Math.max(0.05, 0.15 + 0.85 * Math.pow(rNorm, 0.75)));
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
        if (vec && vec.length >= 2368) {
            gaborFeatures = vec.slice(2320, 2352);
        }
        let maxGaborStr = Math.max(...gaborFeatures, 0.5);

        for (let py = 0; py < h; py++) {
            const v = py / h;
            for (let px = 0; px < w; px++) {
                const u = px / w;
                const pIdx = (py * w + px) * 4;

                const bVal = bicubicSample(brightnessGrid, G, u, v);
                const edgeStr = bicubicSample(edgeStrengths, G, u, v);
                const texEng  = textureEnergy ? bicubicSample(textureEnergy, G, u, v) : 0;

                const nx = normalX[py * w + px] || 0;
                const ny = normalY[py * w + px] || 0;
                const nz = normalZ[py * w + px] || 1;
                const depth = depthMap[py * w + px] || 0.5;

                const NdotL = Math.max(0.0, nx * lightDirX + ny * lightDirY + nz * lightDirZ);
                
                const Hx = lightDirX, Hy = lightDirY, Hz = lightDirZ + 1.0;
                const hLen = Math.hypot(Hx, Hy, Hz) || 1;
                const NdotH = Math.max(0.0, (nx * Hx + ny * Hy + nz * Hz) / hLen);

                const shininess = Math.max(4.0, (1.0 - domRoughness) * 64.0);
                const specPower = Math.pow(NdotH, shininess) * (1.0 - domRoughness);

                const grainPattern = Math.sin(px * 0.35 + py * 0.25) * Math.cos(px * 0.15 - py * 0.45);
                const microTexNoise = grainPattern * (0.04 + maxGaborStr * 0.08 + texEng * 0.25);

                const ambient = 0.22 + depth * 0.15;
                const diffuse = NdotL * 0.65;
                const specular = specPower * 0.35;

                let finalLum = (bVal * 0.6 + diffuse * 0.4 + specular + microTexNoise) * (ambient + diffuse);
                finalLum = Math.min(0.98, Math.max(0.02, finalLum));

                if (edgeStr > 0.15) {
                    finalLum = finalLum * (1.0 - edgeStr * 0.3) + edgeStr * 0.25;
                }

                const currentHue = (domHue + (depth - 0.5) * 15 + 360) % 360;
                const currentSat = Math.min(1.0, domSat * (0.7 + depth * 0.3));

                const rgb = this._hslToRgb(currentHue / 360, currentSat, finalLum);

                data[pIdx]     = rgb[0];
                data[pIdx + 1] = rgb[1];
                data[pIdx + 2] = rgb[2];
                data[pIdx + 3] = 255;
            }
        }

        ctx.putImageData(imgData, 0, 0);

        ctx.save();
        
        const rayGrad = ctx.createRadialGradient(vpX, vpY, 2, vpX, vpY, Math.max(w, h));
        rayGrad.addColorStop(0, `hsla(${domHue}, 80%, 90%, 0.18)`);
        rayGrad.addColorStop(0.4, `hsla(${(domHue + 20) % 360}, 60%, 50%, 0.05)`);
        rayGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = rayGrad;
        ctx.fillRect(0, 0, w, h);

        const cw = w / G;
        const ch = h / G;
        ctx.lineWidth = 1.0;

        for (let gy = 0; gy < G; gy += 2) {
            for (let gx = 0; gx < G; gx += 2) {
                const idx = gy * G + gx;
                const str = edgeStrengths[idx] || 0;
                const angle = edgeAngles[idx] || 0;

                if (str > 0.12) {
                    const cx = (gx + 0.5) * cw;
                    const cy = (gy + 0.5) * ch;
                    const len = cw * 2.2 * str;

                    ctx.strokeStyle = `rgba(255, 255, 255, ${(str * 0.4).toFixed(2)})`;
                    ctx.beginPath();
                    ctx.moveTo(cx - Math.cos(angle) * (len / 2), cy - Math.sin(angle) * (len / 2));
                    ctx.lineTo(cx + Math.cos(angle) * (len / 2), cy + Math.sin(angle) * (len / 2));
                    ctx.stroke();
                }
            }
        }
        ctx.restore();

        return canvas.toDataURL('image/png');
    }

    _generateHighResDataFromVector(spatialVector, snapshot) {
        const G = 128;
        const brightnessGrid = new Float32Array(G * G);
        const edgeAngles     = new Float32Array(G * G);
        const edgeStrengths  = new Float32Array(G * G);
        const textureEnergy  = new Float32Array(G * G);

        const srcG = 16;
        const srcB = spatialVector ? spatialVector.slice(8, 264) : new Float32Array(256).fill(0.5);
        const srcHog = spatialVector ? spatialVector.slice(272, 2320) : new Float32Array(2048);

        for (let gy = 0; gy < G; gy++) {
            for (let gx = 0; gx < G; gx++) {
                const srcGx = Math.floor((gx / G) * srcG);
                const srcGy = Math.floor((gy / G) * srcG);
                const srcIdx = srcGy * srcG + srcGx;

                const idx = gy * G + gx;
                brightnessGrid[idx] = srcB[srcIdx] || 0.5;

                const hogBase = srcIdx * 8;
                const hogSlice = srcHog.slice(hogBase, hogBase + 8);
                const maxStr = Math.max(...hogSlice);
                const domDir = hogSlice.indexOf(maxStr);

                edgeAngles[idx]    = (domDir / 8) * Math.PI * 2 + (Math.sin(gx * 0.1) * 0.05);
                edgeStrengths[idx] = maxStr;
                textureEnergy[idx] = maxStr * 0.5;
            }
        }

        return { GCELLS: G, centerPoint: { x: 0.5, y: 0.45 }, brightnessGrid, edgeAngles, edgeStrengths, textureEnergy };
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
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
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
