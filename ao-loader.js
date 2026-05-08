// ═══════════════════════════════════════════════════════════════════════
// ao-loader.js
// GitHub Pages の転送量を節約するキャッシュシステム
//
// 仕組み：
//   初回アクセス：GitHubからファイルをfetchしてIndexedDBに保存
//   2回目以降：IndexedDBから読み込む（GitHubにアクセスしない）
//
// 保存先：
//   index.html   → localStorage（即時アクセス用）
//   JSファイル群 → IndexedDB（大容量）
//   ao-loader.js → IndexedDB（自己保存）
//
// このファイル自体は毎回GitHubから読み込まれるが
// 他のファイルはキャッシュから読み込まれる
// ═══════════════════════════════════════════════════════════════════════

(async function() {
    const DB_NAME    = 'ao-cache';
    const DB_VERSION = 1;
    const STORE_NAME = 'files';
    const BASE_URL   = 'https://toki4416maou-rgb.github.io/Ao-/';

    // キャッシュするJSファイル一覧
    const JS_FILES = [
        'ao-gpu.js',
        'ao-worker.js',
        'ao-neural.js',
        'ao-pipe1.js',
        'ao-pipe2-3.js',
        'ao-pipe4.js',
        'ao-pipe6.js',
        'ao-pipe7.js',
        'ao-optimizer.js',
        'ao-loader.js',  // 自己保存
    ];

    // ─────────────────────────────────────────────────────────────────
    // IndexedDB を開く
    // ─────────────────────────────────────────────────────────────────
    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'name' });
                }
            };
            req.onsuccess = e => resolve(e.target.result);
            req.onerror   = e => reject(e.target.error);
        });
    }

    function dbGet(db, name) {
        return new Promise((resolve, reject) => {
            const tx  = db.transaction(STORE_NAME, 'readonly');
            const req = tx.objectStore(STORE_NAME).get(name);
            req.onsuccess = e => resolve(e.target.result);
            req.onerror   = e => reject(e.target.error);
        });
    }

    function dbPut(db, name, content, version) {
        return new Promise((resolve, reject) => {
            const tx  = db.transaction(STORE_NAME, 'readwrite');
            const req = tx.objectStore(STORE_NAME).put({ name, content, version, timestamp: Date.now() });
            req.onsuccess = e => resolve(e.target.result);
            req.onerror   = e => reject(e.target.error);
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // バージョン管理（index.htmlのversionタグから取得）
    // ─────────────────────────────────────────────────────────────────
    function getCurrentVersion() {
        // index.htmlのtitleタグからバージョンを取得
        const title = document.title || '';
        const match = title.match(/v(\d+\.\d+\.\d+)/);
        return match ? match[1] : '0.0.0';
    }

    // ─────────────────────────────────────────────────────────────────
    // JSファイルをBlobURLとして動的に読み込む
    // ─────────────────────────────────────────────────────────────────
    function loadScriptFromBlob(content, filename) {
        return new Promise((resolve, reject) => {
            const blob = new Blob([content], { type: 'application/javascript' });
            const url  = URL.createObjectURL(blob);
            const script = document.createElement('script');
            script.src = url;
            script.onload  = () => { URL.revokeObjectURL(url); resolve(); };
            script.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${filename} load failed`)); };
            document.head.appendChild(script);
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // GitHubからfetchしてDBに保存
    // ─────────────────────────────────────────────────────────────────
    async function fetchAndCache(db, filename, version) {
        try {
            const url = BASE_URL + filename + '?v=' + version;
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const content = await res.text();
            await dbPut(db, filename, content, version);
            console.log(`[ao-loader] キャッシュ保存: ${filename}`);
            return content;
        } catch(e) {
            console.warn(`[ao-loader] fetch失敗: ${filename}`, e);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // メイン処理
    // ─────────────────────────────────────────────────────────────────
    async function main() {
        const version = getCurrentVersion();
        console.log(`[ao-loader] バージョン: ${version}`);

        let db;
        try {
            db = await openDB();
        } catch(e) {
            console.warn('[ao-loader] IndexedDB開けず → 通常読み込みにフォールバック');
            return;
        }

        // index.html を localStorage にキャッシュ
        const cachedHtmlVersion = localStorage.getItem('ao-html-version');
        if (cachedHtmlVersion !== version) {
            try {
                const res = await fetch(BASE_URL + 'index.html?v=' + version, { cache: 'no-store' });
                if (res.ok) {
                    const html = await res.text();
                    localStorage.setItem('ao-html-cache', html);
                    localStorage.setItem('ao-html-version', version);
                    console.log('[ao-loader] index.html → localStorage 保存完了');
                }
            } catch(e) {
                console.warn('[ao-loader] index.html fetch失敗:', e);
            }
        } else {
            console.log('[ao-loader] index.html → localStorage キャッシュ済み');
        }

        // JSファイル群をIndexedDBにキャッシュしてBlobURLで読み込む
        // ただしao-loader.js自身はすでに読み込まれているのでスキップ
        const loadOrder = JS_FILES.filter(f => f !== 'ao-loader.js');

        for (const filename of loadOrder) {
            try {
                let content = null;

                // DBからキャッシュを確認
                const cached = await dbGet(db, filename);
                if (cached && cached.version === version) {
                    content = cached.content;
                    console.log(`[ao-loader] キャッシュから読み込み: ${filename}`);
                } else {
                    // キャッシュなし or バージョン違い → GitHubからfetch
                    console.log(`[ao-loader] GitHubからfetch: ${filename}`);
                    content = await fetchAndCache(db, filename, version);
                }

                if (content) {
                    await loadScriptFromBlob(content, filename);
                }
            } catch(e) {
                console.warn(`[ao-loader] ${filename} 読み込み失敗:`, e);
            }
        }

        // ao-loader.js自身もDBに保存（次回の自己参照用）
        try {
            const selfCached = await dbGet(db, 'ao-loader.js');
            if (!selfCached || selfCached.version !== version) {
                await fetchAndCache(db, 'ao-loader.js', version);
            }
        } catch(e) {}

        console.log('[ao-loader] 全ファイル読み込み完了');
        window._aoCacheReady = true;
        window.dispatchEvent(new CustomEvent('ao-cache-ready'));
    }

    // ─────────────────────────────────────────────────────────────────
    // キャッシュ強制更新API（デバッグ用）
    // ─────────────────────────────────────────────────────────────────
    window.aoClearCache = async function() {
        localStorage.removeItem('ao-html-cache');
        localStorage.removeItem('ao-html-version');
        try {
            const db = await openDB();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).clear();
            console.log('[ao-loader] キャッシュ全削除完了');
        } catch(e) {
            console.warn('[ao-loader] キャッシュ削除失敗:', e);
        }
    };

    main().catch(e => console.error('[ao-loader] 初期化エラー:', e));
})();
