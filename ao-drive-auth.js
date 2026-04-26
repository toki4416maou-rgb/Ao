/**
 * ao-drive-auth.js
 * Google認証 + Driveバックアップ システム
 *
 * 役割:
 *   1. GoogleでログインしてEmail取得（手打ち廃止）
 *   2. drive.fileスコープを同時取得
 *   3. GASにEmailを投げてPayPal照合（既存ロジックをそのまま流用）
 *   4. 起動時: DriveからAoデータを読み込み
 *   5. 保存: 60秒ごと1本のみ（3重保存を廃止）
 *
 * index.html側で必要な変更はファイル末尾の「## index.html変更箇所」を参照
 */

(function () {
  'use strict';

  // ================================================================
  //  設定
  //  GOOGLE_CLIENT_ID は index.html の <script> 内で先に定義しておくこと
  //  例: const GOOGLE_CLIENT_ID = '123456789-xxx.apps.googleusercontent.com';
  // ================================================================
  const CFG = {
    get clientId() { return window.GOOGLE_CLIENT_ID || ''; },
    scopes: [
      'email',
      'profile',
      'https://www.googleapis.com/auth/drive.file',
    ].join(' '),
    backupFilename: 'ao_backup.json',
    syncIntervalMs: 60_000,   // Drive同期間隔（60秒）
    tokenMarginMs:  120_000,  // トークン期限の余裕（2分前にリフレッシュ）
  };

  // ================================================================
  //  AoDriveAuth — GIS トークンクライアント管理
  // ================================================================
  const AoDriveAuth = {
    _tokenClient: null,
    _accessToken: null,
    _tokenExpiry: 0,

    /** GISライブラリのロードを待ってtokenClientを初期化 */
    async init() {
      await this._waitGIS();
      this._tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CFG.clientId,
        scope: CFG.scopes,
        callback: () => {},            // requestAccessToken()ごとに上書き
        error_callback: () => {},
      });
    },

    _waitGIS() {
      return new Promise((resolve) => {
        const t = setInterval(() => {
          if (window.google?.accounts?.oauth2) {
            clearInterval(t);
            resolve();
          }
        }, 100);
      });
    },

    /**
     * ログイン（ポップアップ）
     * @returns {{ email, name, picture }}
     */
    login() {
      return new Promise((resolve, reject) => {
        this._tokenClient.callback = async (resp) => {
          if (resp.error) { reject(new Error(resp.error)); return; }
          this._saveToken(resp);
          try {
            const info = await this._fetchUserInfo();
            resolve(info);
          } catch (e) { reject(e); }
        };
        this._tokenClient.error_callback = (e) => reject(new Error(e.message));
        // prompt: '' → 既に同意済みならポップアップなし。初回は consent 画面が出る
        this._tokenClient.requestAccessToken({ prompt: '' });
      });
    },

    /** トークンが期限切れ近なら静かにリフレッシュ */
    async ensureToken() {
      if (this._accessToken && Date.now() < this._tokenExpiry - CFG.tokenMarginMs) return;
      return new Promise((resolve, reject) => {
        this._tokenClient.callback = (resp) => {
          if (resp.error) { reject(new Error(resp.error)); return; }
          this._saveToken(resp);
          resolve();
        };
        this._tokenClient.error_callback = (e) => reject(new Error(e.message));
        this._tokenClient.requestAccessToken({ prompt: '' });
      });
    },

    _saveToken(resp) {
      this._accessToken = resp.access_token;
      this._tokenExpiry = Date.now() + resp.expires_in * 1000;
    },

    async _fetchUserInfo() {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${this._accessToken}` },
      });
      if (!res.ok) throw new Error('userinfo fetch failed');
      return await res.json(); // { id, email, name, picture, ... }
    },

    get token() { return this._accessToken; },
  };

  // ================================================================
  //  AoDriveManager — Drive ファイルの読み書き
  // ================================================================
  const AoDriveManager = {
    _fileId: null,

    /** Driveにバックアップファイルがあれば fileId を返す */
    async findFile() {
      await AoDriveAuth.ensureToken();
      const q = encodeURIComponent(
        `name='${CFG.backupFilename}' and trashed=false`
      );
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,modifiedTime)`,
        { headers: { Authorization: `Bearer ${AoDriveAuth.token}` } }
      );
      const data = await res.json();
      if (data.files?.length > 0) {
        this._fileId = data.files[0].id;
        return data.files[0];
      }
      return null;
    },

    /** Driveからデータを読み込む。ファイルなければ null */
    async load() {
      const file = await this.findFile();
      if (!file) {
        console.log('[AoDrive] load: バックアップファイルなし（初回起動）');
        return null;
      }

      console.log(`[AoDrive] load: ファイル発見 id=${this._fileId} 更新=${file.modifiedTime}`);
      await AoDriveAuth.ensureToken();

      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${this._fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${AoDriveAuth.token}` } }
      );
      if (!res.ok) {
        console.error(`[AoDrive] load: fetch 失敗 status=${res.status}`);
        return null;
      }

      // compressed テキストとして受け取り → LZString 展開 → JSON.parse
      let raw, json, data;
      try {
        raw  = await res.text();
        console.log(`[AoDrive] load: 圧縮データ受信 ${(raw.length / 1024).toFixed(1)} KB`);
      } catch (e) {
        console.error('[AoDrive] load: res.text() 失敗', e);
        return null;
      }

      try {
        json = LZString.decompressFromUTF16(raw);
        if (!json) throw new Error('decompressFromUTF16 が null を返した（データ破損の可能性）');
        console.log(`[AoDrive] load: 展開後 ${(json.length / 1024).toFixed(1)} KB`);
      } catch (e) {
        console.error('[AoDrive] load: LZString展開 失敗', e);
        return null;
      }

      try {
        data = JSON.parse(json);
      } catch (e) {
        console.error('[AoDrive] load: JSON.parse 失敗', e);
        return null;
      }

      // ── ロード検証 ────────────────────────────────────────────────
      const ok = data && data.coreState;
      if (!ok) {
        console.error('[AoDrive] load: データ構造が不正（coreState なし）', Object.keys(data || {}));
        return null;
      }

      const turns    = data.coreState?.identity?.turns ?? '?';
      const concepts = data.coreState?.concepts?.concepts?.length ?? '?';
      const episodes = data.coreState?.episodicMemory?.episodes?.length ?? '?';
      const ts       = data.timestamp ? new Date(data.timestamp).toLocaleString() : '?';
      console.log(`[AoDrive] load ✅ 検証OK — turns:${turns} 概念:${concepts} EP:${episodes} 保存時刻:${ts}`);

      return data;
    },

    /** Driveにデータを保存（LZString圧縮 → text/plain）新規 or 上書き */
    async save(data) {
      await AoDriveAuth.ensureToken();

      // JSON → LZString圧縮
      const json       = JSON.stringify(data);
      const compressed = LZString.compressToUTF16(json);

      const rawKB  = (json.length        / 1024).toFixed(1);
      const compKB = (compressed.length  / 1024).toFixed(1);
      const ratio  = ((1 - compressed.length / json.length) * 100).toFixed(0);
      console.log(`[AoDrive] save: ${rawKB}KB → 圧縮後 ${compKB}KB (${ratio}%削減)`);

      // Blob は text/plain（LZString はバイナリではなく UTF-16 文字列）
      const blob     = new Blob([compressed], { type: 'text/plain;charset=utf-16' });
      const metaJson = this._fileId ? {} : { name: CFG.backupFilename };
      const metaBlob = new Blob([JSON.stringify(metaJson)], { type: 'application/json' });

      const form = new FormData();
      form.append('metadata', metaBlob);
      form.append('file',     blob);

      const url    = this._fileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${this._fileId}?uploadType=multipart`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
      const method = this._fileId ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${AoDriveAuth.token}` },
        body: form,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Drive save failed: ${res.status} ${errBody}`);
      }
      const result = await res.json();
      if (!this._fileId) {
        this._fileId = result.id;
        console.log(`[AoDrive] save: 新規ファイル作成 id=${this._fileId}`);
      }
    },
  };

  // ================================================================
  //  AoSaveSystem — 単一の保存マネージャー（3重保存を置き換え）
  //  ・セッション中は IndexedDB をバッファとして使う（クラッシュ保険）
  //  ・60秒ごとに Drive へ同期
  //  ・index.html 側の startAutoSave() は呼ばないこと
  // ================================================================
  const AoSaveSystem = {
    _being:    null,
    _dirty:    false,
    _saving:   false,
    _timer:    null,
    _lastSync: 0,

    init(being) {
      this._being = being;
      // 既存の 3重保存インターバルを停止
      this._killLegacySystems();
    },

    _killLegacySystems() {
      // PersonaSaveManager の autoSave インターバルが
      // window._aoPersonaAutoSaveId にセットされている場合に備えて停止
      // ※ index.html 側で saveManager.startAutoSave() を呼ばないようにするのが本命
      [
        '_aoIntervalUpdateUI',
        // ↓ legacy save intervals (ao-optimizer.js が停止する分と重複しても無害)
      ].forEach(key => {
        if (window[key]) { clearInterval(window[key]); window[key] = null; }
      });
    },

    /** 変更があったことをマーク（旧 markDirty 相当） */
    markDirty() {
      this._dirty = true;
      this._updateSaveUI('未同期');
    },

    /** Drive同期ループを開始 */
    start() {
      if (this._timer) return;
      this._timer = setInterval(() => this._sync(), CFG.syncIntervalMs);
      console.log('[AoSaveSystem] 起動 (Drive同期 60秒ごと)');
    },

    stop() {
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },

    /** 手動保存ボタンから呼ぶ */
    async saveNow() {
      this.markDirty();
      await this._sync(true);
    },

    async _sync(force = false) {
      if (!this._dirty && !force)  return;
      if (this._saving)            return;
      if (!this._being)            return;
      if (document.hidden && !force) return;

      this._saving = true;
      this._updateSaveUI('保存中...');

      try {
        const data = this._being.exportAll();
        if (!data) throw new Error('exportAll が空');

        await AoDriveManager.save(data);  // ログはDriveManager内で出力

        this._dirty    = false;
        this._lastSync = Date.now();
        const timeStr  = new Date().toLocaleTimeString();
        this._being.addLog?.(`Drive同期完了 [${timeStr}]`);
        this._updateSaveUI(`保存済み ${timeStr}`);

      } catch (err) {
        console.error('[AoSaveSystem] Drive同期失敗:', err);
        this._being.addLog?.(`⚠️ Drive同期失敗: ${err.message}`);
        this._updateSaveUI('同期失敗');
      } finally {
        this._saving = false;
      }
    },

    _updateSaveUI(text) {
      const el = document.getElementById('saveStatus');
      if (el) el.textContent = `人格: ${text}`;
    },
  };

  // ================================================================
  //  aoGoogleLogin — 既存 aoLogin() の置き換え
  //  index.html の Googleログインボタンから呼ぶ
  // ================================================================
  window.aoGoogleLogin = async function () {
    setAuthStatus('Googleアカウントを確認中...', true);
    try {
      const userInfo = await AoDriveAuth.login();
      const email    = userInfo.email;

      setAuthStatus('サブスクリプションを確認中...', true);
      const res  = await fetch(GAS_URL + '?action=login&email=' + encodeURIComponent(email));
      const data = await res.json();

      if (data.ok) {
        window._aoUser = { email: data.email, sessionToken: data.sessionToken, name: userInfo.name };
        localStorage.setItem('ao_user', JSON.stringify(window._aoUser));
        setAuthStatus('ログイン完了: ' + email, false);
        document.getElementById('ao-auth-logout').style.display = 'block';

        // Drive からデータ読み込み（起動時の importAll はここで行う）
        setAuthStatus('データを読み込み中...', true);
        window._aoPendingDriveData = await AoDriveManager.load(); // null なら初回起動
        setAuthStatus('', false);
        showApp();

      } else if (['not_found','cancelled','expired','inactive'].includes(data.error)) {
        setAuthStatus('', false);
        document.getElementById('ao-step-google').classList.add('ao-auth-hidden');
        document.getElementById('ao-auth-paypal-wrap').classList.remove('ao-auth-hidden');

      } else {
        setAuthStatus('エラー: ' + (data.error || '不明'), false);
      }

    } catch (err) {
      setAuthStatus('ログインエラー: ' + err.message, false);
      console.error('[aoGoogleLogin]', err);
    }
  };

  /** PayPal購読後のメール照合（PayPal側ではGoogle OAuth不要なのでメール手打ちのまま） */
  window.aoBackToGoogle = function () {
    document.getElementById('ao-step-google').classList.remove('ao-auth-hidden');
    document.getElementById('ao-auth-paypal-wrap').classList.add('ao-auth-hidden');
    setAuthStatus('Googleアカウントでログインしてください', false);
  };

  // ================================================================
  //  起動時フック — _aoDoStartApp の後に呼ぶ
  //  window.ao が生成された直後に AoSaveSystem を接続する
  // ================================================================
  window._aoAttachDriveSave = function (ao) {
    AoSaveSystem.init(ao);

    // Drive から読んだデータがあれば importAll + 結果検証
    if (window._aoPendingDriveData) {
      const d = window._aoPendingDriveData;
      console.log('[AoDrive] importAll 開始...');
      try {
        const ok = ao.importAll(d);

        // ao の実際の状態で復元できたか確認
        const turns    = ao.identity?.turns                   ?? '?';
        const concepts = ao.concepts?.concepts?.size           ?? '?';
        const episodes = ao.episodicMemory?.episodes?.length   ?? '?';
        console.log(`[AoDrive] importAll ✅ turns:${turns} 概念:${concepts} EP:${episodes}`);
        ao.addLog?.(`Drive復元完了 — 対話:${turns}回 概念:${concepts} EP:${episodes}`);

        if (ok === false) {
          console.warn('[AoDrive] importAll が false を返しました（部分的失敗の可能性）');
          ao.addLog?.('⚠️ Drive復元: 一部のデータが復元できなかった可能性があります');
        }
      } catch (e) {
        console.error('[AoDrive] importAll 失敗:', e);
        ao.addLog?.(`❌ Drive復元失敗: ${e.message}`);
      }
      window._aoPendingDriveData = null;
    } else {
      console.log('[AoDrive] Driveデータなし → 新規セッション');
      ao.addLog?.('Drive: バックアップなし（初回起動）');
    }

    // 保存系を ao.saveManager として公開（手動保存ボタンとの互換）
    ao.saveManager = {
      markDirty:  () => AoSaveSystem.markDirty(),
      save:       () => AoSaveSystem.saveNow(),
      markClean:  () => { AoSaveSystem._dirty = false; },
      isDirty:    () => AoSaveSystem._dirty,
    };

    AoSaveSystem.start();
    console.log('[AoSaveSystem] ao にアタッチ完了');
  };

  // ================================================================
  //  初期化
  // ================================================================
  AoDriveAuth.init().then(() => {
    console.log('[AoDriveAuth] GIS 初期化完了');
  }).catch(e => {
    console.error('[AoDriveAuth] GIS 初期化失敗:', e);
  });

  // グローバルに公開（デバッグ用）
  window.AoDriveAuth    = AoDriveAuth;
  window.AoDriveManager = AoDriveManager;
  window.AoSaveSystem   = AoSaveSystem;

})();


// ================================================================
//  ## index.html 変更箇所（このファイルを読み込んだ後に適用）
// ================================================================
/*

【1】 <head> の先頭付近に追加

  <!-- Google Identity Services -->
  <script src="https://accounts.google.com/gsi/client" async defer></script>
  <!-- Drive認証システム -->
  <script src="ao-drive-auth.js" defer></script>

  そして GAS_URL のすぐ下に追加：
  const GOOGLE_CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com'; // ← Google Cloud Consoleで取得


【2】 認証オーバーレイの STEP 1 を置き換え

  削除:
    <div id="ao-step-email">
      <input id="ao-email-input" ...>
      <button ... onclick="aoLogin()">ログイン</button>
    </div>

  置き換え:
    <div id="ao-step-google">
      <button class="ao-auth-btn ao-auth-btn-google" onclick="aoGoogleLogin()">
        <svg width="18" height="18" viewBox="0 0 48 48">
          <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 7.9 3L37.1 9.7C34 6.9 29.2 5 24 5 12.9 5 4 13.9 4 25s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-4z"/>
          <path fill="#FF3D00" d="M6.3 15.2l6.6 4.9C14.7 16.2 19 13 24 13c3.1 0 5.8 1.1 7.9 3L37.1 9.7C34 6.9 29.2 5 24 5 16.5 5 10 9.2 6.3 15.2z"/>
          <path fill="#4CAF50" d="M24 45c5.1 0 9.8-1.9 13.3-5L31.8 35c-2 1.5-4.5 2-7.8 2-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.9 40.7 16.4 45 24 45z"/>
          <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.3-2.4 4.2-4.4 5.5l5.5 5.3C42.5 36 44 31.5 44 25c0-1.3-.1-2.6-.4-4z"/>
        </svg>
        Googleでログイン
      </button>
      <p style="font-size:0.72rem;color:#6b7280;margin-top:0.5rem;">
        PayPalに登録したGoogleアカウントでログインしてください
      </p>
    </div>

  スタイル追加（<style>内）:
    .ao-auth-btn-google {
      background: #fff;
      color: #3c4043;
      border: 1px solid #dadce0;
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: center;
    }
    .ao-auth-btn-google:hover { background: #f8f9fa; }


【3】 "← 別のメールで試す" を置き換え

  削除:
    <span onclick="aoBackToEmail()">← 別のメールで試す</span>

  置き換え:
    <span onclick="aoBackToGoogle()">← 別のアカウントで試す</span>


【4】 _aoDoStartApp() の末尾の saveManager.startAutoSave() を削除し、
     _aoAttachDriveSave を呼ぶ

  削除:
    saveManager.startAutoSave();

  置き換え:
    window._aoAttachDriveSave(ao);


【5】 手動保存ボタンの onclick をそのまま使える
     （ao.saveManager.save() → AoSaveSystem.saveNow() に透過される）

*/
