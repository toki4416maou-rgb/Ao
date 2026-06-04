// ═══════════════════════════════════════════════════════════════════════
// PIPE 5: SensoryAssetBridge
//         素材ファイル → 感覚器官（gpu.js / AudioContext） → CIR
//
// 役割：
//   動画プロジェクト作成時にフォルダ内の素材ファイルを
//   実際に感覚器官に通して特徴量を抽出し、CIRに感覚データとして記録する。
//   これにより因果推論野がファイル名ではなく映像・音声の内容で判断できる。
//
// 処理の流れ：
//   画像ファイル  → canvas → aoGPU.computeFeatures() → visual_vector
//   動画ファイル  → 3フレームサンプリング → 平均visual_vector
//   音声ファイル  → AudioContext.decodeAudioData() → 音響特徴量
//   全ファイル    → CIR.record() で感覚イベントとして蓄積
//
// 接続場所：
//   ao-pipe4.js の直後に読み込む
//   VideoEditingIntegration.createProject() をフックして自動起動
//
// 使い方：
//   attachPipe5(being)  または 自動アタッチ（pollForPipe5）
//
// ao-loader.js への追記も忘れずに：
//   JS_FILES 配列に 'ao-pipe5.js' を追加する
// ═══════════════════════════════════════════════════════════════════════

'use strict';

// ─────────────────────────────────────────────────────────────────────
// SensoryAssetBridge
// 素材ファイルを感覚器官に通してCIRへ届けるブリッジ
// ─────────────────────────────────────────────────────────────────────
class SensoryAssetBridge {
    constructor(being) {
        this.being    = being;
        this.cir      = being.causalInterventionReasoner;
        this.gpu      = window.aoGPU || null;
        this._cache   = new Map(); // filename → 感覚サマリ（重複処理防止）
    }

    // ── 画像ファイル（File または dataURL）→ visual_vector ─────────────
    async _extractImageFeatures(src) {
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

                    // aoGPU が使えればGPU処理、なければCPUフォールバック
                    if (this.gpu && this.gpu.computeFeatures) {
                        const features = this.gpu.computeFeatures(imgData);
                        resolve(features || this._cpuFallback(imgData));
                    } else {
                        resolve(this._cpuFallback(imgData));
                    }
                } catch (e) {
                    resolve(null);
                }
            };
            img.onerror = () => resolve(null);

            // File オブジェクトの場合はObjectURL経由で読む
            if (src instanceof File) {
                img.src = URL.createObjectURL(src);
            } else {
                img.src = src;
            }
        });
    }

    // ── CPU フォールバック（aoGPU が使えない場合）───────────────────────
    // hue_hist / brightness_grid / gradient_hist の3種だけ簡易計算
    _cpuFallback(imgData) {
        const data = imgData.data;
        const len  = data.length / 4;

        const hue_hist       = new Array(8).fill(0);
        const brightness_grid = new Array(256).fill(0); // 16×16
        let   edgeSum        = 0;

        for (let i = 0; i < len; i++) {
            const r = data[i * 4]     / 255;
            const g = data[i * 4 + 1] / 255;
            const b = data[i * 4 + 2] / 255;

            // 明度
            const bright = 0.299 * r + 0.587 * g + 0.114 * b;
            edgeSum     += bright;

            // hue（簡易版）
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            if (max > 0.01) {
                let h = 0;
                const d = max - min;
                if (max === r) h = ((g - b) / d + 6) % 6;
                else if (max === g) h = (b - r) / d + 2;
                else h = (r - g) / d + 4;
                hue_hist[Math.floor(h / 6 * 8) % 8] += 1 / len;
            }

            // brightness_grid（16×16セル）
            const W    = Math.sqrt(len) || 256;
            const gx   = Math.floor((i % W) / W * 16);
            const gy   = Math.floor(Math.floor(i / W) / W * 16);
            const gi   = Math.min(gy * 16 + gx, 255);
            brightness_grid[gi] += bright / (len / 256);
        }

        // gradient_hist は簡易エッジ強度で均等分配
        const avgEdge    = edgeSum / len;
        const gradient_hist = new Array(8).fill(avgEdge / 8);

        return {
            hue_hist,
            brightness_grid,
            gradient_hist,
            hog_blocks:     new Array(2048).fill(0),
            gabor_features: new Array(32).fill(0),
            lbp_features:   new Array(16).fill(0),
        };
    }

    // ── 動画ファイル → 3フレームサンプリング → 平均 visual_vector ────────
    async _extractVideoFeatures(file) {
        return new Promise((resolve) => {
            const video = document.createElement('video');
            video.muted    = true;
            video.preload  = 'metadata';
            const url      = URL.createObjectURL(file);
            video.src      = url;

            video.onloadedmetadata = async () => {
                const duration = video.duration || 1;
                // 先頭・中間・末尾の3点をサンプリング
                const seekPoints = [
                    duration * 0.05,
                    duration * 0.5,
                    duration * 0.95,
                ];

                const allFeatures = [];

                for (const t of seekPoints) {
                    const feat = await new Promise((res) => {
                        video.currentTime = t;
                        video.onseeked = async () => {
                            try {
                                const SIZE = 256;
                                const cv   = document.createElement('canvas');
                                cv.width   = SIZE;
                                cv.height  = SIZE;
                                cv.getContext('2d').drawImage(video, 0, 0, SIZE, SIZE);
                                const imgData = cv.getContext('2d').getImageData(0, 0, SIZE, SIZE);

                                if (this.gpu && this.gpu.computeFeatures) {
                                    res(this.gpu.computeFeatures(imgData) || this._cpuFallback(imgData));
                                } else {
                                    res(this._cpuFallback(imgData));
                                }
                            } catch (e) {
                                res(null);
                            }
                        };
                    });
                    if (feat) allFeatures.push(feat);
                }

                URL.revokeObjectURL(url);

                if (allFeatures.length === 0) { resolve(null); return; }

                // 3フレームの特徴量を平均して1本の感覚ベクトルにする
                resolve(this._averageFeatures(allFeatures));
            };

            video.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        });
    }

    // ── 複数フレームの特徴量を平均 ────────────────────────────────────────
    _averageFeatures(featList) {
        const keys = ['hue_hist', 'brightness_grid', 'gradient_hist',
                      'hog_blocks', 'gabor_features', 'lbp_features'];
        const result = {};
        for (const key of keys) {
            const arrs = featList.map(f => f[key]).filter(Boolean);
            if (arrs.length === 0) { result[key] = []; continue; }
            const len  = arrs[0].length;
            result[key] = Array.from({ length: len }, (_, i) =>
                arrs.reduce((s, a) => s + (a[i] || 0), 0) / arrs.length
            );
        }
        return result;
    }

    // ── 音声ファイル → 音響特徴量 ────────────────────────────────────────
    // pitch_mean / energy_mean / tempo / brightness を簡易推定
    async _extractAudioFeatures(file) {
        try {
            const ctx    = new (window.AudioContext || window.webkitAudioContext)();
            const buf    = await file.arrayBuffer();
            const decoded = await ctx.decodeAudioData(buf);
            ctx.close();

            const ch   = decoded.getChannelData(0);
            const len  = ch.length;
            const sr   = decoded.sampleRate;

            // エネルギー（RMS）
            let rms = 0;
            for (let i = 0; i < len; i++) rms += ch[i] * ch[i];
            rms = Math.sqrt(rms / len);

            // ゼロ交差率（テンポ・周波数の簡易推定）
            let zc = 0;
            for (let i = 1; i < len; i++) {
                if ((ch[i] >= 0) !== (ch[i - 1] >= 0)) zc++;
            }
            const zcr = zc / len;

            // 簡易テンポ推定（ゼロ交差率 × サンプルレート / 2）
            const pitch_mean = zcr * sr / 2;

            // スペクトル重心（明るさ）：FFTなしの簡易版
            let weightedSum = 0;
            let totalWeight = 0;
            const blockSize = 1024;
            for (let i = 0; i < Math.min(len, blockSize * 100); i += blockSize) {
                const block = ch.slice(i, i + blockSize);
                const energy = block.reduce((s, v) => s + Math.abs(v), 0) / blockSize;
                const pos    = i / len;
                weightedSum += pos * energy;
                totalWeight += energy;
            }
            const brightness = totalWeight > 0 ? weightedSum / totalWeight : 0.5;

            // テンポ推定（エネルギー変化の頻度）
            let peaks = 0;
            const windowSize = Math.floor(sr * 0.1); // 100ms窓
            for (let i = windowSize; i < len - windowSize; i += windowSize) {
                const cur  = Math.abs(ch[i]);
                const prev = Math.abs(ch[i - windowSize]);
                if (cur > prev * 1.5 && cur > 0.05) peaks++;
            }
            const tempo = peaks / (decoded.duration || 1) * 60; // BPM概算

            return { pitch_mean, energy_mean: rms, tempo, brightness };

        } catch (e) {
            console.warn('[PIPE5] 音声特徴量抽出失敗:', e);
            return null;
        }
    }

    // ── 特徴量 → 感覚サマリ（CIRに渡す形式に変換）──────────────────────
    // 高次元のベクトルを因果推論野が扱いやすいサマリに圧縮する
    _toSensorySummary(features, fileType) {
        if (!features) return null;

        if (fileType === 'audio') {
            // 音声：4つの感覚値をそのまま使う
            return {
                type:        'audio',
                energy:      features.energy_mean || 0,
                pitch:       Math.min(1, (features.pitch_mean || 0) / 4000),
                tempo:       Math.min(1, (features.tempo || 0) / 200),
                brightness:  features.brightness || 0,
                // CIR用感情マッピング
                tension:     Math.min(1, (features.energy_mean || 0) * 2),
                curiosity:   features.brightness || 0.5,
            };
        }

        // 画像・動画
        const hue       = features.hue_hist       || [];
        const bright    = features.brightness_grid || [];
        const hog       = features.hog_blocks      || [];
        const gabor     = features.gabor_features  || [];

        // 支配的な色相
        const domHueIdx = hue.indexOf(Math.max(...hue, 0));
        const domHue    = domHueIdx / 8; // 0〜1

        // 平均明度
        const avgBright = bright.length > 0
            ? bright.reduce((s, v) => s + v, 0) / bright.length
            : 0.5;

        // エッジ強度（HOGの平均）
        const edgeEnergy = hog.length > 0
            ? hog.reduce((s, v) => s + Math.abs(v), 0) / hog.length
            : 0;

        // Gaborによる質感（周波数エネルギー）
        const textureScore = gabor.length > 0
            ? gabor.reduce((s, v) => s + Math.abs(v), 0) / gabor.length
            : 0;

        return {
            type:         fileType,
            domHue,
            avgBright,
            edgeEnergy,
            textureScore,
            // CIR用感情マッピング
            // 明るい映像 → joy高め / 暗い映像 → tension高め
            joy:      avgBright,
            tension:  edgeEnergy * 5,
            curiosity: textureScore * 10,
        };
    }

    // ── メイン処理：1ファイルを感覚器官に通してCIRに記録 ─────────────────
    async processFile(file) {
        if (!file || !this.cir) return null;

        const name = file.name || 'unknown';
        if (this._cache.has(name)) return this._cache.get(name); // キャッシュ済み

        const type = file.type || '';
        let features   = null;
        let fileType   = 'unknown';

        if (type.startsWith('image/')) {
            features = await this._extractImageFeatures(file);
            fileType = 'image';
        } else if (type.startsWith('video/')) {
            features = await this._extractVideoFeatures(file);
            fileType = 'video';
        } else if (type.startsWith('audio/')) {
            features = await this._extractAudioFeatures(file);
            fileType = 'audio';
        } else {
            return null; // 非対応ファイル
        }

        const summary = this._toSensorySummary(features, fileType);
        if (!summary) return null;

        // ── CIRに感覚イベントとして記録 ──────────────────────────────────
        // action: 「どの素材を感知したか」
        // stateBefore: 感知前（未知）
        // stateAfter:  感知した感覚内容
        const action = `感覚[${fileType}]::${name}`;

        const stateBefore = {
            emotionalState: 'sensing',
            known:          false,
            tension:        0.5,
        };

        const stateAfter = {
            emotionalState: 'sensed',
            known:          true,
            fileType,
            fileName:       name,
            // 感覚値（因果推論野が編集判断に使う）
            joy:            summary.joy       || 0,
            tension:        summary.tension   || 0,
            curiosity:      summary.curiosity || 0,
            // 映像・音声固有の感覚値
            ...summary,
        };

        this.cir.record(action, stateBefore, stateAfter);

        // spatialState にも登録（空間野との連携）
        const sp = this.being.spatialState;
        if (sp && sp.update) {
            try {
                sp.update(name, {
                    motionType:    summary.edgeEnergy > 0.05 ? 'fast' : 'still',
                    poseDiversity: summary.curiosity || 0,
                    avgBright:     summary.avgBright || 0.5,
                });
            } catch (e) { /* silent */ }
        }

        this._cache.set(name, summary);

        this.being.addLog && this.being.addLog(
            `[PIPE5] 感覚 ${fileType}: ${name} ` +
            `joy=${(summary.joy||0).toFixed(2)} ` +
            `tension=${(summary.tension||0).toFixed(2)} ` +
            `curiosity=${(summary.curiosity||0).toFixed(2)}`
        );

        return summary;
    }

    // ── 複数ファイルをまとめて処理 ────────────────────────────────────────
    async processFiles(files) {
        const results = [];
        for (const file of files) {
            const r = await this.processFile(file);
            if (r) results.push({ name: file.name, summary: r });
        }
        this.being.addLog && this.being.addLog(
            `[PIPE5] 感覚処理完了: ${results.length}/${files.length}ファイル → CIR記録済み`
        );
        return results;
    }
}


// ─────────────────────────────────────────────────────────────────────
// attachPipe5
// VideoEditingIntegration.createProject() をフックして
// 素材ファイルを感覚器官に通してからCIRに渡す
// ─────────────────────────────────────────────────────────────────────
function attachPipe5(being) {
    if (!being) return;
    if (being._pipe5Attached) return;
    being._pipe5Attached = true;

    const cir = being.causalInterventionReasoner;
    const ve  = being.videoEditing;

    if (!cir || !ve) {
        console.warn('[PIPE5] CIR または VideoEditing が未接続 - リトライ');
        setTimeout(() => {
            being._pipe5Attached = false;
            attachPipe5(being);
        }, 2000);
        return;
    }

    const bridge = new SensoryAssetBridge(being);
    being.sensoryAssetBridge = bridge; // グローバルからアクセス可能に

    // ── createProject() をフック ─────────────────────────────────────────
    // 既存の createProject の前に感覚処理を挟む
    const origCreate = ve.createProject.bind(ve);

    ve.createProject = async function(intent, folderPath, projectName, format) {
        // folderPath が File[] の場合（モーダルから渡される実ファイル）
        if (Array.isArray(folderPath) && folderPath.length > 0) {
            being.addLog && being.addLog(
                `[PIPE5] 素材${folderPath.length}件を感覚器官に通します...`
            );
            try {
                // 感覚処理（CIRへの記録も内部で完了）
                await bridge.processFiles(folderPath);
            } catch (e) {
                console.warn('[PIPE5] 感覚処理エラー（処理は継続）:', e);
            }
        }

        // 感覚処理が終わってから既存のcreateProjectを呼ぶ
        // → CIRに感覚データが入った状態でSTEP2（因果推論）が走る
        return origCreate(intent, folderPath, projectName, format);
    };

    console.log('[PIPE5] SensoryAssetBridge 接続完了');
    being.addLog && being.addLog(
        '[PIPE5] 素材感覚パイプ5 接続完了（感覚器官 → CIR）'
    );
}


// ─────────────────────────────────────────────────────────────────────
// 自動アタッチ
// pipe4 完了後（being.videoEditing と CIR が存在する）を待つ
// ─────────────────────────────────────────────────────────────────────
(function pollForPipe5() {
    const being = window.ao;
    if (being &&
        being.causalInterventionReasoner &&
        being.videoEditing) {

        setTimeout(() => {
            try {
                attachPipe5(being);
            } catch (e) {
                console.error('[PIPE5] attachPipe5 error:', e);
            }
        }, 0); // ao-pipe-orchestrator.js が順序を管理するためdelayなし

    } else {
        setTimeout(pollForPipe5, 1000);
    }
})();


// グローバル公開
window.SensoryAssetBridge = SensoryAssetBridge;
window.attachPipe5        = attachPipe5;
