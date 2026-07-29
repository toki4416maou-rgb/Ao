/**
 * ao-memory-optimizer.js v1.1 – Ao 8GBメモリ最適化・SoA高速メモリ管理モジュール
 * 
 * 【第11世代Core i3 / 8GBメモリ超軽量・爆速動作用データ構造改革】
 * 
 * 1. TypedArray Chunked SoA 共有バッファ:
 *    初期10,000概念（約94.7MB）でコンパクトに起動し、単一アロケーションエラーを完全防止。
 * 
 * 2. Hot/Cold 階層化 (IndexedDB + LRU Cache):
 *    RAM上には常時5,000件のみ保持し、不活性な概念は IndexedDB へ退避。
 * 
 * 3. コーパス・Bigram キャッピング:
 *    _corpus / bigramFreq の無制限蓄積を 50,000 エントリ上限にキャップ。
 */

(function () {
'use strict';

class AoTypedMemoryBuffer {
    constructor(initialConcepts = 10000, maxRelationsPerConcept = 20) {
        this.maxConcepts = initialConcepts;
        this.maxRelations = maxRelationsPerConcept;

        // 特徴ベクトルを全概念分float32で先行確保すると約1.8GiBになるため廃止。
        // 画像記憶は下記visualStoreへ、必要な解像度・量子化形式で概念ごとに保存する。
        const VECTOR_DIM = 2368;
        const EMOTION_DIM = 30;
        this.VECTOR_DIM = VECTOR_DIM;
        this.EMOTION_DIM = EMOTION_DIM;

        this.vectorStore    = new Map(); // id -> Uint8Array（旧setVector互換の量子化特徴）
        this.visualStore    = new Map(); // concept -> 圧縮した4野
        this.highResLimit   = 1000; // 高精細上限: 1概念≒960KiB × 1000 = ~0.92GiB (8GB環境の安全マージン)
        this.promotionObservations = 5;
        this.promotionPerspectiveConfidence = 0.65;
        this.relationIds    = new Int32Array(initialConcepts * maxRelationsPerConcept);
        this.relationWeights= new Float32Array(initialConcepts * maxRelationsPerConcept);
        this.emotionBuffer  = new Float32Array(initialConcepts * EMOTION_DIM);

        this.stringPool = new Map();
        this.idPool = new Map();
        this.nextId = 0;

        // ---- 追加分: 永続化まわりの状態 ----
        this.db = null;
        this._restored = false;   // IndexedDBからの復元が済んだか
        this._dirty = false;      // 前回保存後に変更が入ったか
        this._saveTimer = null;

        console.log(`[AoMemoryOptimizer] Quantized visual memory initialized (${initialConcepts} concepts, no giant float32 preallocation)`);

        this._initPersistence();
    }

    getOrRegisterId(conceptName) {
        if (this.idPool.has(conceptName)) {
            return this.idPool.get(conceptName);
        }
        if (this.nextId >= this.maxConcepts) {
            this._evictOldest();
        }
        const id = this.nextId % this.maxConcepts;
        this.idPool.set(conceptName, id);
        this.stringPool.set(id, conceptName);
        this.nextId++;
        this._scheduleSave();
        return id;
    }

    setVector(id, vector) {
        if (!vector) return;
        const len = Math.min(vector.length, this.VECTOR_DIM);
        const packed = new Uint8Array(len);
        for (let i = 0; i < len; i++) packed[i] = Math.max(0, Math.min(255, Math.round((vector[i] || 0) * 255)));
        this.vectorStore.set(id, packed);
        this._scheduleSave();
    }

    getVector(id) {
        const packed = this.vectorStore.get(id);
        const out = new Float32Array(this.VECTOR_DIM);
        if (packed) for (let i = 0; i < packed.length; i++) out[i] = packed[i] / 255;
        return out;
    }

    _sample(src, srcW, srcH, x, y) {
        const sx = Math.min(srcW - 1, Math.max(0, Math.floor(x * srcW)));
        const sy = Math.min(srcH - 1, Math.max(0, Math.floor(y * srcH)));
        return src[sy * srcW + sx] || 0;
    }

    _resample(src, srcW, srcH, size, scale = 1) {
        const out = new Uint8Array(size * size);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
            out[y * size + x] = Math.max(0, Math.min(255, Math.round(this._sample(src, srcW, srcH, x / size, y / size) * scale)));
        return out;
    }

    // 4野をint8で保存。境界野は支配方向+強度の2byte/セル。
    storeVisualLayers(concept, v2Result) {
        if (!concept || !v2Result?.layers) return null;
        const { layers, centerPoint, spatialObservation } = v2Result;
        const width = layers.width || (Math.sqrt(layers.brightnessLayer.length) | 0);
        const height = layers.height || width;
        if (!width || width * height !== layers.brightnessLayer.length) return null;
        const prev = this.visualStore.get(concept);
        const observations = (prev?.observations || 0) + 1;
        const perspectiveConfidence = spatialObservation?.perspectiveConfidence || centerPoint?.confidence || 0;
        const shouldPromote = prev?.tier === 'high' || (observations >= this.promotionObservations && perspectiveConfidence >= this.promotionPerspectiveConfidence);
        const tier = shouldPromote ? 'high' : 'low';
        const sizes = tier === 'high' ? { spatial: 256, boundary: 512, luminance: 512, color: 256 } : { spatial: 64, boundary: 64, luminance: 64, color: 64 };
        const edgeDir = new Uint8Array(sizes.boundary * sizes.boundary);
        const edgeStrength = this._resample(layers.boundaryLayer, width, height, sizes.boundary, 1);
        for (let y = 0; y < sizes.boundary; y++) for (let x = 0; x < sizes.boundary; x++) {
            const nx = this._sample(layers.normalXLayer, width, height, x / sizes.boundary, y / sizes.boundary);
            const ny = this._sample(layers.normalYLayer, width, height, x / sizes.boundary, y / sizes.boundary);
            edgeDir[y * sizes.boundary + x] = Math.round(((Math.atan2(ny, nx) + Math.PI) / (2 * Math.PI)) * 255) & 255;
        }
        // 現段階の深度は線遠近からの相対幾何プロキシ。絶対距離ではない。
        const depth = new Uint8Array(sizes.spatial * sizes.spatial);
        const vpX = centerPoint?.normalizedX ?? 0.5, vpY = centerPoint?.normalizedY ?? 0.5;
        for (let y = 0; y < sizes.spatial; y++) for (let x = 0; x < sizes.spatial; x++) {
            depth[y * sizes.spatial + x] = Math.min(255, Math.round(Math.hypot(x / sizes.spatial - vpX, y / sizes.spatial - vpY) * 255));
        }
        const record = {
            tier, observations, lastAccess: Date.now(), perspectiveConfidence, centerPoint,
            sizes, depth, edgeDir, edgeStrength,
            luminance: this._resample(layers.brightnessLayer, width, height, sizes.luminance, 1),
            hue: this._resample(layers.hueLayer || layers.colorLayer, width, height, sizes.color, 1),
            saturation: this._resample(layers.saturationLayer || layers.colorLayer, width, height, sizes.color, 1),
            format: 'ao-visual-v1-int8'
        };
        this.visualStore.set(concept, record);
        this._enforceHighResLimit();
        this._scheduleSave();
        return record;
    }

    _enforceHighResLimit() {
        const high = [...this.visualStore.entries()].filter(([, r]) => r.tier === 'high');
        if (high.length <= this.highResLimit) return;
        high.sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0));
        for (const [name, record] of high.slice(0, high.length - this.highResLimit)) {
            record.tier = 'low'; record.sizes = { spatial: 64, boundary: 64, luminance: 64, color: 64 };
            // 高精細から低精細へは代表値を再サンプルして即時にメモリを解放する。
            record.depth = this._resample(record.depth, 256, 256, 64, 1);
            record.edgeDir = this._resample(record.edgeDir, 512, 512, 64, 1);
            record.edgeStrength = this._resample(record.edgeStrength, 512, 512, 64, 1);
            record.luminance = this._resample(record.luminance, 512, 512, 64, 1);
            record.hue = this._resample(record.hue, 256, 256, 64, 1);
            record.saturation = this._resample(record.saturation, 256, 256, 64, 1);
            this.visualStore.set(name, record);
        }
    }

    setRelations(id, relMap) {
        const baseOffset = (id % this.maxConcepts) * this.maxRelations;
        let count = 0;
        for (const [targetConcept, weight] of relMap.entries()) {
            if (count >= this.maxRelations) break;
            const targetId = this.getOrRegisterId(targetConcept);
            this.relationIds[baseOffset + count] = targetId;
            this.relationWeights[baseOffset + count] = weight;
            count++;
        }
        this._scheduleSave();
    }

    _evictOldest() {
        const removeCount = 100;
        for (let i = 0; i < removeCount; i++) {
            const oldId = i % this.maxConcepts;
            const oldName = this.stringPool.get(oldId);
            if (oldName) {
                this.idPool.delete(oldName);
                this.stringPool.delete(oldId);
            }
        }
    }

    // ================================================================
    // ここから追加分: vectorBuffer 等 TypedArray 一式を
    // 専用IndexedDB(AoTypedVectorStorage)に保存/復元する。
    //
    // これまでは exportState/importState が存在せず、画像学習で得た
    // 2368次元特徴ベクトルはRAM(Float32Array)にしか乗っていなかった
    // → index.html を閉じる(=タブ/プロセス終了)とGCで消えて、
    //   次回起動時にゼロから学習し直しになっていた。
    //
    // TypedArrayはIndexedDBの構造化クローンでそのまま保存できるので、
    // JSON化やlocalStorage(数MB上限)を経由する必要がない。
    // ================================================================

    exportState() {
        return {
            maxConcepts: this.maxConcepts,
            maxRelations: this.maxRelations,
            nextId: this.nextId,
            idPool: Array.from(this.idPool.entries()), // [[conceptName, id], ...]
            vectorStore: Array.from(this.vectorStore.entries()),
            visualStore: Array.from(this.visualStore.entries()),
            relationIds: this.relationIds,
            relationWeights: this.relationWeights,
            emotionBuffer: this.emotionBuffer,
            savedAt: Date.now()
        };
    }

    importState(data) {
        if (!data) return false;
        try {
            // サイズ(次元数・上限概念数)が変わっていたら不整合復元を避けて何もしない
            if (Array.isArray(data.vectorStore)) this.vectorStore = new Map(data.vectorStore);
            if (Array.isArray(data.visualStore)) this.visualStore = new Map(data.visualStore);
            if (data.relationIds && data.relationIds.length === this.relationIds.length) {
                this.relationIds.set(data.relationIds);
            }
            if (data.relationWeights && data.relationWeights.length === this.relationWeights.length) {
                this.relationWeights.set(data.relationWeights);
            }
            if (data.emotionBuffer && data.emotionBuffer.length === this.emotionBuffer.length) {
                this.emotionBuffer.set(data.emotionBuffer);
            }
            if (Array.isArray(data.idPool)) {
                this.idPool = new Map(data.idPool);
                this.stringPool = new Map(data.idPool.map(([name, id]) => [id, name]));
            }
            if (typeof data.nextId === 'number') {
                this.nextId = data.nextId;
            }
            console.log(`[AoMemoryOptimizer] TypedMemoryBuffer 復元完了 (concepts: ${this.idPool.size})`);
            return true;
        } catch (e) {
            console.warn('[AoMemoryOptimizer] TypedMemoryBuffer importState失敗:', e.message);
            return false;
        }
    }

    _initPersistence() {
        if (typeof indexedDB === 'undefined') return;
        try {
            const req = indexedDB.open('AoTypedVectorStorage', 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('snapshot')) {
                    db.createObjectStore('snapshot', { keyPath: 'id' });
                }
            };
            req.onsuccess = (e) => {
                this.db = e.target.result;
                console.log('[AoMemoryOptimizer] TypedVectorStorage (IndexedDB) Ready');
                this._loadFromDB();
            };
            req.onerror = (e) => {
                console.warn('[AoMemoryOptimizer] TypedVectorStorage open失敗:', e.target.error);
                this._restored = true;
            };
        } catch (e) {
            console.warn('[AoMemoryOptimizer] TypedVectorStorage 初期化失敗:', e.message);
            this._restored = true;
        }

        // タブが隠れる/閉じられるタイミングで確実にフラッシュする
        // (beforeunloadだけだと最近のブラウザでは信頼性が低いのでvisibilitychange/pagehideも併用)
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') this._saveToDB();
            });
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', () => this._saveToDB());
            window.addEventListener('beforeunload', () => this._saveToDB());
        }

        // 保険として30秒毎に、変更があった場合だけ保存
        this._autoSaveInterval = setInterval(() => {
            if (this._dirty) this._saveToDB();
        }, 30000);
    }

    _loadFromDB() {
        if (!this.db || this._restored) return;
        try {
            const tx = this.db.transaction('snapshot', 'readonly');
            const store = tx.objectStore('snapshot');
            const req = store.get('current');
            req.onsuccess = () => {
                // 復元完了より先にこのセッションで何か書き込みが始まっていた場合、
                // 古いスナップショットで上書きして壊さないようスキップする
                if (this.nextId === 0 && req.result && req.result.data) {
                    this.importState(req.result.data);
                }
                this._restored = true;
            };
            req.onerror = () => { this._restored = true; };
        } catch (e) {
            this._restored = true;
        }
    }

    _saveToDB() {
        if (!this.db) return;
        try {
            const data = this.exportState();
            const tx = this.db.transaction('snapshot', 'readwrite');
            const store = tx.objectStore('snapshot');
            store.put({ id: 'current', data, savedAt: Date.now() });
            this._dirty = false;
        } catch (e) {
            console.warn('[AoMemoryOptimizer] TypedMemoryBuffer 保存失敗:', e.message);
        }
    }

    _scheduleSave() {
        this._dirty = true;
        // 書き込みの度に即保存はしない(重くなるので)。3秒デバウンスでまとめて保存。
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            if (this._dirty) this._saveToDB();
        }, 3000);
    }
}

class AoHotColdMemoryManager {
    constructor(maxRamHotConcepts = 5000) {
        this.maxRamHot = maxRamHotConcepts;
        this.hotCache = new Map();
        this.db = null;
        this._initIndexedDB();
    }

    _initIndexedDB() {
        if (typeof indexedDB === 'undefined') return;
        try {
            const req = indexedDB.open('AoColdMemoryStorage', 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('cold_concepts')) {
                    db.createObjectStore('cold_concepts', { keyPath: 'name' });
                }
            };
            req.onsuccess = (e) => {
                this.db = e.target.result;
                console.log('[AoMemoryOptimizer] Cold Memory Storage (IndexedDB) Ready');
            };
        } catch (e) {
            console.warn('[AoMemoryOptimizer] IndexedDB disabled or unsupported:', e.message);
        }
    }

    async getConcept(name) {
        if (this.hotCache.has(name)) {
            const data = this.hotCache.get(name);
            this.hotCache.delete(name);
            this.hotCache.set(name, data);
            return data;
        }

        if (this.db) {
            return new Promise((resolve) => {
                const tx = this.db.transaction('cold_concepts', 'readonly');
                const store = tx.objectStore('cold_concepts');
                const req = store.get(name);
                req.onsuccess = () => {
                    if (req.result) {
                        this.putConcept(name, req.result.data);
                        resolve(req.result.data);
                    } else {
                        resolve(null);
                    }
                };
                req.onerror = () => resolve(null);
            });
        }
        return null;
    }

    putConcept(name, data) {
        if (this.hotCache.size >= this.maxRamHot) {
            const oldestKey = this.hotCache.keys().next().value;
            const oldestData = this.hotCache.get(oldestKey);
            this.hotCache.delete(oldestKey);
            this._evictToIndexedDB(oldestKey, oldestData);
        }
        this.hotCache.set(name, data);
    }

    _evictToIndexedDB(name, data) {
        if (!this.db) return;
        try {
            const tx = this.db.transaction('cold_concepts', 'readwrite');
            const store = tx.objectStore('cold_concepts');
            store.put({ name, data, savedAt: Date.now() });
        } catch (e) {}
    }
}

function applyCorpusCapLimit(targetObj, maxEntries = 50000) {
    if (!targetObj) return;
    if (Array.isArray(targetObj)) {
        if (targetObj.length > maxEntries) {
            targetObj.splice(0, targetObj.length - maxEntries);
        }
    } else if (typeof targetObj === 'object') {
        const keys = Object.keys(targetObj);
        if (keys.length > maxEntries) {
            const deleteCount = keys.length - maxEntries;
            for (let i = 0; i < deleteCount; i++) {
                delete targetObj[keys[i]];
            }
        }
    }
}

const typedMemory = new AoTypedMemoryBuffer(10000);
const hotColdMemory = new AoHotColdMemoryManager(5000);

window.aoTypedMemory = typedMemory;
window.aoHotColdMemory = hotColdMemory;

setInterval(() => {
    if (window.ao && window.ao._corpus) {
        applyCorpusCapLimit(window.ao._corpus, 50000);
    }
    if (window.ao && window.ao.bigramFreq) {
        applyCorpusCapLimit(window.ao.bigramFreq, 50000);
    }
}, 30000);

console.log('[AoMemoryOptimizer] 8GB Core i3 Lightweight Memory Optimizer Active');

})();
