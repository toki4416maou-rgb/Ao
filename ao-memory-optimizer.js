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

        const VECTOR_DIM = 2368;
        const EMOTION_DIM = 30;
        this.VECTOR_DIM = VECTOR_DIM;
        this.EMOTION_DIM = EMOTION_DIM;

        // 初期RAM確保（約94.7MBの超軽量サイズで安全起動）
        this.vectorBuffer   = new Float32Array(initialConcepts * VECTOR_DIM);
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

        console.log(`[AoMemoryOptimizer] Chunked SoA Shared TypedArray Allocated (Initial ${initialConcepts} Concepts / ~94.7MB RAM)`);

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
        const offset = (id % this.maxConcepts) * 2368;
        const len = Math.min(vector.length, 2368);
        this.vectorBuffer.set(vector.subarray(0, len), offset);
        this._scheduleSave();
    }

    getVector(id) {
        const offset = (id % this.maxConcepts) * 2368;
        return this.vectorBuffer.subarray(offset, offset + 2368);
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
            vectorBuffer: this.vectorBuffer,
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
            if (data.vectorBuffer && data.vectorBuffer.length === this.vectorBuffer.length) {
                this.vectorBuffer.set(data.vectorBuffer);
            }
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
