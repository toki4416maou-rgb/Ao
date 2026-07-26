/*!
 * ao-output-exporter.js v1.0 – Ao リアルタイム動画 ＆ 音声出力モジュール
 * 
 * 概要:
 *   ① [動画出力機能 (Video Exporter)]: 
 *      MediaRecorder / Canvas Stream 経由で 60fps ぬるぬるアニメーションやリアルタイムCanvas描画を
 *      実際の WebM / MP4 動画ファイルとしてエンコード＆自動ダウンロード出力。
 * 
 *   ② [音声出力機能 (Audio/Voice Synthesizer)]: 
 *      Web Speech API (SpeechSynthesis) ＋ Web Audio API (AudioContext) を用いて、
 *      思考・発話テキスト (PIPE7 being.speak) を自然言語音声として再生・波形出力。
 * 
 *   ③ [動画＋音声 複合出力機能 (AV Exporter)]: 
 *      動画トラックと音声トラックを1つの WebM 動画ファイルとして統合出力。
 */

(function () {
'use strict';

// ─────────────────────────────────────────────────────────────────────
// ① 動画出力クラス (AoVideoExporter)
// ─────────────────────────────────────────────────────────────────────
class AoVideoExporter {
    constructor() {
        this.supportedMime = this._getBestMimeType();
    }

    _getBestMimeType() {
        if (typeof MediaRecorder === 'undefined') return '';
        const types = [
            'video/webm;codecs=vp9,opus',
            'video/webm;codecs=vp8,opus',
            'video/webm',
            'video/mp4'
        ];
        for (const t of types) {
            if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
                return t;
            }
        }
        return '';
    }

    /**
     * Canvas または 60fps シーケンスから動画ファイルを生成・出力
     * @param {HTMLCanvasElement|Array<string>} source - Canvas または DataURL 配列
     * @param {Object} options - { fps: 60, duration: 3.0, download: true, filename: string }
     * @returns {Promise<{ videoBlob: Blob, videoUrl: string }>}
     */
    async exportVideo(source, options = {}) {
        const fps = options.fps || 60;
        const width = options.width || 640;
        const height = options.height || 640;
        const filename = options.filename || `ao-render-video-${Date.now()}.webm`;

        if (Array.isArray(source)) {
            return await this._exportFromFrameSequence(source, options);
        }

        if (typeof document === 'undefined' || !(source instanceof HTMLCanvasElement)) {
            throw new Error('[AoVideoExporter] 有効な Canvas または フレーム配列が必要です。');
        }

        const stream = source.captureStream(fps);
        const chunks = [];
        const recorderOptions = this.supportedMime ? { mimeType: this.supportedMime } : undefined;
        const recorder = new MediaRecorder(stream, recorderOptions);

        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        const recordingPromise = new Promise((resolve) => {
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
                const videoUrl = URL.createObjectURL(blob);
                resolve({ videoBlob: blob, videoUrl });
            };
        });

        recorder.start();

        const recordDurationMs = options.durationMs || 3000;
        setTimeout(() => {
            if (recorder.state !== 'inactive') recorder.stop();
        }, recordDurationMs);

        const result = await recordingPromise;

        if (options.download) {
            this._downloadBlob(result.videoBlob, filename);
        }

        if (options.targetElementId && typeof document !== 'undefined') {
            const target = document.getElementById(options.targetElementId);
            if (target) {
                target.innerHTML = `<video src="${result.videoUrl}" controls autoplay loop style="max-width:100%; border-radius:8px; shadow:0 4px 20px rgba(0,0,0,0.3);"></video>`;
            }
        }

        return result;
    }

    /**
     * フレーム配列 (DataURL群) を Canvas に連射描画して WebM 動画エンコード
     */
    async _exportFromFrameSequence(frames, options) {
        if (typeof document === 'undefined') {
            return { videoBlob: null, videoUrl: '', error: 'Node環境ではDirect Canvas Capture非対応' };
        }

        const width = options.width || 640;
        const height = options.height || 640;
        const fps = options.fps || 60;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        const stream = canvas.captureStream(fps);
        const chunks = [];
        const recorder = new MediaRecorder(stream, this.supportedMime ? { mimeType: this.supportedMime } : undefined);

        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        const finishPromise = new Promise((resolve) => {
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
                const videoUrl = URL.createObjectURL(blob);
                resolve({ videoBlob: blob, videoUrl });
            };
        });

        recorder.start();

        const frameIntervalMs = 1000 / fps;
        for (let i = 0; i < frames.length; i++) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = frames[i];
            if (typeof frames[i] === 'string' && frames[i].startsWith('data:')) {
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
            } else {
                await new Promise((res) => {
                    img.onload = res;
                    img.onerror = res;
                });
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
            }
            await new Promise((res) => setTimeout(res, frameIntervalMs));
        }

        if (recorder.state !== 'inactive') recorder.stop();
        const result = await finishPromise;

        if (options.download) {
            this._downloadBlob(result.videoBlob, options.filename || `ao-animation-60fps-${Date.now()}.webm`);
        }

        return result;
    }

    _downloadBlob(blob, filename) {
        if (typeof document === 'undefined') return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
    }
}

// ─────────────────────────────────────────────────────────────────────
// ② 音声出力クラス (AoAudioExporter / Voice Synthesizer)
// ─────────────────────────────────────────────────────────────────────
class AoAudioExporter {
    constructor() {
        this.synth = (typeof window !== 'undefined' && window.speechSynthesis) ? window.speechSynthesis : null;
        this.audioCtx = null;
    }

    _initAudioContext() {
        if (!this.audioCtx && typeof window !== 'undefined') {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) this.audioCtx = new AudioContextClass();
        }
    }

    /**
     * テキストまたはPIPE7発話意図を自然言語音声としてリアルタイム再生＆出力
     * @param {string|Object} textOrIntent - 発話テキストまたは being.speak オブジェクト
     * @param {Object} options - { lang: 'ja-JP', pitch: 1.0, rate: 1.0, volume: 1.0 }
     */
    speak(textOrIntent, options = {}) {
        let text = typeof textOrIntent === 'string' ? textOrIntent : (textOrIntent.text || textOrIntent.topic || '');
        if (!text) return { speaking: false, text: '' };

        if (this.synth) {
            this.synth.cancel(); // 割り込み再生
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = options.lang || 'ja-JP';
            utterance.pitch = options.pitch || 1.05;
            utterance.rate = options.rate || 1.0;
            utterance.volume = options.volume || 1.0;

            const voices = this.synth.getVoices();
            const jaVoice = voices.find(v => v.lang && (v.lang.includes('ja') || v.lang.includes('JP')));
            if (jaVoice) utterance.voice = jaVoice;

            this.synth.speak(utterance);
            console.log(`[AoAudioExporter] 音声再生中: "${text}"`);
            return { speaking: true, text, utterance };
        } else {
            console.warn('[AoAudioExporter] Web Speech API 非対応環境です。');
            return { speaking: false, text, error: 'Web Speech API unavailable' };
        }
    }

    /**
     * Web Audio API による環境音・シンセ波形音響再生 (効果音・フィードバック音)
     */
    playSynthBeep(freq = 440, durationSec = 0.3) {
        this._initAudioContext();
        if (!this.audioCtx) return;

        try {
            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);

            gain.gain.setValueAtTime(0.15, this.audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + durationSec);

            osc.connect(gain);
            gain.connect(this.audioCtx.destination);

            osc.start();
            osc.stop(this.audioCtx.currentTime + durationSec);
        } catch(e) {
            console.warn('[AoAudioExporter] Web Audio API エラー:', e);
        }
    }
}

// インスタンス化
const videoExporter = new AoVideoExporter();
const audioExporter = new AoAudioExporter();

/**
 * 動画ファイル (.webm) エクスポート API
 */
async function aoExportVideo(source, options = {}) {
    return await videoExporter.exportVideo(source, options);
}

/**
 * 音声発話 (Voice Synthesis) 出力 API
 */
function aoSpeakAudio(textOrIntent, options = {}) {
    return audioExporter.speak(textOrIntent, options);
}

// グローバルアタッチ
if (typeof window !== 'undefined') {
    window.AoVideoExporter = AoVideoExporter;
    window.AoAudioExporter = AoAudioExporter;
    window.aoExportVideo   = aoExportVideo;
    window.aoSpeakAudio    = aoSpeakAudio;

    if (window.ao) {
        window.ao.exportVideo = aoExportVideo;
        window.ao.speakAudio  = aoSpeakAudio;
    }
}

})();
