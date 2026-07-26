// ═══════════════════════════════════════════════════════════════════════
// PIPE 2: 因果推論野（CIR）→ 抽象化処理（AbstractConceptFormer）
//
// 役割：
//   CIRが蓄積した言語構造パターン（is-a, has-property, cause）を
//   AbstractConceptFormer に渡し、概念を階層的に纏める。
//   例：「犬 is-a イヌ科」「狼 is-a イヌ科」→「イヌ科」ノードに纏める
//
// ═══════════════════════════════════════════════════════════════════════
// PIPE 3: 抽象概念Map → 12軸（WorldViewModel）/ 空間野 / 因果推論野
//
// 役割：
//   纏まった抽象概念を12軸でスコアリングして分類し
//   worldView・conceptSpace・CIRから参照・推論できるようにする。
//   例：「イヌ科」→ hierarchy軸が成長 → 空間野が鼻の利く動物カテゴリを保持
//
// ═══════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────
// ConceptGraph: is-a / has-property / cause 関係を保持するグラフ
// AbstractConceptFormer の上に乗る薄いラッパー
// ───────────────────────────────────────────────────────────────────────
class ConceptGraph {
    constructor() {
        // { subject → Map{ relation → Set{object} } }
        this.edges  = new Map();
        // { category → Set{member} }
        this.groups = new Map();
        // { concept → Set{property} }
        this.properties = new Map();
    }

    addRelation(subject, relation, object) {
        if (!subject || !object) return;
        if (!this.edges.has(subject)) this.edges.set(subject, new Map());
        const rels = this.edges.get(subject);
        if (!rels.has(relation)) rels.set(relation, new Set());
        rels.get(relation).add(object);

        // is-a ならグループにも記録
        if (relation === 'is-a') {
            if (!this.groups.has(object)) this.groups.set(object, new Set());
            this.groups.get(object).add(subject);
        }
        // has-property なら properties にも記録
        if (relation === 'has-property') {
            if (!this.properties.has(subject)) this.properties.set(subject, new Set());
            this.properties.get(subject).add(object);
        }
    }

    // subject の親カテゴリ一覧
    getParents(subject) {
        const rels = this.edges.get(subject);
        if (!rels) return new Set();
        return rels.get('is-a') || new Set();
    }

    // 2概念の共通親カテゴリ → 因果推論の根拠になる
    inferSharedCategories(a, b) {
        const pa = this.getParents(a);
        const pb = this.getParents(b);
        return [...pa].filter(p => pb.has(p));
    }

    // カテゴリのメンバーが持つ共通プロパティを推論
    // 例：イヌ科メンバー全員が「嗅覚が鋭い」を持っていればカテゴリ属性とする
    inferCategoryProperties(category) {
        const members = this.groups.get(category);
        if (!members || members.size === 0) return [];

        // 全メンバーのプロパティ集計
        const propCount = new Map();
        for (const m of members) {
            const props = this.properties.get(m) || new Set();
            for (const p of props) {
                propCount.set(p, (propCount.get(p) || 0) + 1);
            }
        }

        // 過半数のメンバーが持つプロパティをカテゴリ属性とする
        const threshold = members.size / 2;
        return [...propCount.entries()]
            .filter(([_, count]) => count >= threshold)
            .map(([prop]) => prop);
    }

    // 「Bはイヌ科なのに鼻が利くプロパティが未記録」→推論して補完
    inferMissingProperties(subject) {
        const parents = this.getParents(subject);
        const inferred = [];
        for (const category of parents) {
            const categoryProps = this.inferCategoryProperties(category);
            const ownProps = this.properties.get(subject) || new Set();
            for (const p of categoryProps) {
                if (!ownProps.has(p)) {
                    inferred.push({ property: p, via: category, confidence: 0.7 });
                }
            }
        }
        return inferred;
    }

    dump() {
        return {
            groups: Object.fromEntries(
                [...this.groups.entries()].map(([k,v]) => [k, [...v]])
            ),
            properties: Object.fromEntries(
                [...this.properties.entries()].map(([k,v]) => [k, [...v]])
            ),
            edgeCount: [...this.edges.values()]
                .reduce((s, m) => s + [...m.values()].reduce((s2,v) => s2 + v.size, 0), 0),
        };
    }

    // ── SaveManager 連携 ─────────────────────────────────────────────
    exportState() {
        const edges = {};
        for (const [subj, relMap] of this.edges) {
            edges[subj] = {};
            for (const [rel, objSet] of relMap) {
                edges[subj][rel] = [...objSet];
            }
        }
        return {
            edges,
            groups:     Object.fromEntries([...this.groups.entries()].map(([k,v])=>[k,[...v]])),
            properties: Object.fromEntries([...this.properties.entries()].map(([k,v])=>[k,[...v]])),
        };
    }

    importState(data) {
        if (!data) return;
        try {
            this.edges = new Map();
            for (const [subj, relObj] of Object.entries(data.edges || {})) {
                const relMap = new Map();
                for (const [rel, objArr] of Object.entries(relObj)) {
                    relMap.set(rel, new Set(objArr));
                }
                this.edges.set(subj, relMap);
            }
            this.groups = new Map();
            for (const [k, arr] of Object.entries(data.groups || {})) {
                this.groups.set(k, new Set(arr));
            }
            this.properties = new Map();
            for (const [k, arr] of Object.entries(data.properties || {})) {
                this.properties.set(k, new Set(arr));
            }
        } catch(e) {
            console.warn('[ConceptGraph] importState error:', e);
        }
    }
}

// ───────────────────────────────────────────────────────────────────────
// PIPE 2
// ───────────────────────────────────────────────────────────────────────
function attachPipe2(being, conceptGraph) {
    if (!being) return;
    if (being._pipe2Attached) return;
    being._pipe2Attached = true;

    const cir          = being.causalInterventionReasoner;
    const abstractFormer = being.abstractFormer;
    const concepts     = being.concepts; // ConceptSpace

    if (!cir || !abstractFormer) {
        console.warn('[PIPE2] CIR or abstractFormer 未接続 - リトライ');
        setTimeout(() => { being._pipe2Attached = false; attachPipe2(being, conceptGraph); }, 2000);
        return;
    }

    // ── PIPE2が ConceptGraph に二重書きしないよう除外する relationType ──
    // 視覚野・空間野・因果野パイプ（PIPE6等）は自ら ConceptGraph を更新する。
    // PIPE2がここで再度書くと二重登録になるため、_source または relationType で判定してスキップ。
    const _P2_SKIP_RELATION_TYPES = new Set([
        'pose-recognized',   // PIPE6: 姿勢・動作認識
        'category-update',   // PIPE3自身が発行する更新イベント（循環防止）
        'shared-category',   // PIPE3: 共通カテゴリ推論
    ]);

    // CIR.record() をラップ：is-a 系パターンが来たら即 ConceptGraph に登録
    const origRecord = cir.record.bind(cir);
    cir.record = function(action, stateBefore, stateAfter) {
        origRecord(action, stateBefore, stateAfter);

        try {
            const rel = stateAfter && stateAfter.relationType;
            const sub = stateAfter && stateAfter.subject;
            const obj = stateAfter && stateAfter.predicate;
            if (!sub || !obj) return;

            // 視覚野・空間野由来のレコードはここでは処理しない
            if (_P2_SKIP_RELATION_TYPES.has(rel)) return;
            if (stateAfter._source === 'pipe6') return;

            if (rel === 'is-a') {
                conceptGraph.addRelation(sub, 'is-a', obj);

                // AbstractConceptFormer の概念空間にも反映
                if (concepts) {
                    // カテゴリ概念がなければ作成
                    if (!concepts.concepts.has(obj)) {
                        concepts.createAbstract(obj, [sub], stateAfter.grammarConf || 0.5);
                    } else {
                        // 既存抽象概念にメンバー追加
                        const node = concepts.concepts.get(obj);
                        if (node) {
                            node.relate && node.relate(sub, 0.8);
                        }
                    }
                }

                being.addLog && being.addLog(
                    `[PIPE2] is-a登録: ${sub} → ${obj} | graph=${JSON.stringify(conceptGraph.dump())}`
                );

            } else if (rel === 'has-property') {
                conceptGraph.addRelation(sub, 'has-property', obj);
                being.addLog && being.addLog(`[PIPE2] has-prop登録: ${sub} → ${obj}`);

            } else if (rel === 'cause') {
                conceptGraph.addRelation(sub, 'causes', obj);
                being.addLog && being.addLog(`[PIPE2] cause登録: ${sub} → ${obj}`);
            }
        } catch(e) {
            console.warn('[PIPE2] record hook error:', e);
        }
    };

    // CIR に「概念グラフを使った推論」メソッドを追加
    cir.inferFromGraph = function(querySubject) {
        // 共通カテゴリを持つ仲間を探す
        const parents = conceptGraph.getParents(querySubject);
        const siblings = [];
        for (const p of parents) {
            const members = conceptGraph.groups.get(p) || new Set();
            for (const m of members) {
                if (m !== querySubject) siblings.push({ concept: m, sharedCategory: p });
            }
        }
        // 推論で補完されるプロパティ
        const inferred = conceptGraph.inferMissingProperties(querySubject);

        return {
            subject:    querySubject,
            parents:    [...parents],
            siblings,
            inferred,
            summary: inferred.length > 0
                ? inferred.map(i => `${querySubject}は${i.via}なので${i.property}のはず`).join('、')
                : `${querySubject}の推論プロパティなし`
        };
    };

    console.log('[PIPE2] CIR → AbstractConceptFormer パイプ接続完了');
    being.addLog && being.addLog('[PIPE2] 因果推論野→抽象化処理 パイプ2 接続完了');
}

// ───────────────────────────────────────────────────────────────────────
// PIPE 3
// ───────────────────────────────────────────────────────────────────────
function attachPipe3(being, conceptGraph) {
    if (!being) return;
    if (being._pipe3Attached) return;
    being._pipe3Attached = true;

    const worldView = being.worldView;
    const cir       = being.causalInterventionReasoner;

    if (!worldView) {
        console.warn('[PIPE3] worldView 未接続 - リトライ');
        setTimeout(() => { being._pipe3Attached = false; attachPipe3(being, conceptGraph); }, 2000);
        return;
    }

    // ── 抽象概念を12軸に射影するマッパー ──────────────────────────────
    // 概念グラフの構造（is-a深さ・プロパティ数・メンバー数）から
    // どの軸を成長させるか決める
    function mapConceptToAxes(category) {
        const members = conceptGraph.groups.get(category) || new Set();
        const props   = conceptGraph.inferCategoryProperties(category);
        const depth   = members.size; // メンバーが多いほど階層が深い

        const updates = [];

        // 階層関係がある → hierarchy軸
        if (depth >= 2) {
            worldView.growAxis('hierarchy', 0.02 * Math.min(depth, 5));
            updates.push('hierarchy');
        }
        // プロパティが推論できる → causality軸（因果的理解が深まった）
        if (props.length > 0) {
            worldView.growAxis('causality', 0.02 * props.length);
            updates.push('causality');
        }
        // カテゴリに情報量がある → information軸
        if (depth >= 1 || props.length >= 1) {
            worldView.growAxis('information', 0.01);
            updates.push('information');
        }

        return { category, members: [...members], props, updatedAxes: updates };
    }

    // ── ConceptGraph にリスナーを設定：新規グループ登録時に12軸を更新 ──
    const origAddRelation = conceptGraph.addRelation.bind(conceptGraph);
    conceptGraph.addRelation = function(subject, relation, object) {
        origAddRelation(subject, relation, object);

        // ── is-a: 既存処理（カテゴリ構造 → hierarchy/causality/information軸）──
        if (relation === 'is-a') {
            try {
                const result = mapConceptToAxes(object);
                being.addLog && being.addLog(
                    `[PIPE3] 12軸更新: ${object}(${result.members.length}members) → ${result.updatedAxes.join(',')}`
                );

                // CIRにもカテゴリ更新イベントを記録（因果推論の素材として）
                if (cir) {
                    cir.record(
                        `概念グラフ更新[${object}]`,
                        { categorySize: result.members.length - 1 },
                        {
                            categorySize:    result.members.length,
                            inferredProps:   result.props.length,
                            updatedAxes:     result.updatedAxes,
                            relationType:    'category-update',
                            subject:         object,
                            predicate:       `${result.members.length}members`,
                            grammarConf:     0.8,
                        }
                    );
                }
            } catch(e) {
                console.warn('[PIPE3] mapConceptToAxes error:', e);
            }
        }

        // ── instance-of（PIPE6: identity → 概念クラス）→ hierarchy軸 ──────
        // 個体が概念に属するという認識が増えるほど分類構造が育つ
        else if (relation === 'instance-of') {
            try {
                worldView.growAxis('hierarchy', 0.005);
                being.addLog && being.addLog(
                    `[PIPE3] hierarchy軸+: ${subject} instance-of ${object}`
                );
            } catch(e) { console.warn('[PIPE3] instance-of axis error:', e); }
        }

        // ── has-identity（PIPE6: 概念 → identity）→ social軸 ────────────
        // 概念を個体レベルで識別できるようになるほど社会認識が育つ
        else if (relation === 'has-identity') {
            try {
                worldView.growAxis('social', 0.008);
                being.addLog && being.addLog(
                    `[PIPE3] social軸+: ${subject} has-identity ${object}`
                );
            } catch(e) { console.warn('[PIPE3] has-identity axis error:', e); }
        }

        // ── has-motion（PIPE6: identity → 動作種別）→ evolution/constraint軸 ──
        // 動いている → evolution（変化・動態の理解）
        // 静止している → constraint（安定・制約の理解）
        else if (relation === 'has-motion') {
            try {
                const dynamicMotions = new Set(['walking', 'fast', 'rotating', 'slow']);
                const updatedAxes    = [];

                if (dynamicMotions.has(object)) {
                    // 動的な動作が観測されるほど「変化する世界」の理解が深まる
                    const gain = object === 'fast' ? 0.015 : 0.010;
                    worldView.growAxis('evolution', gain);
                    worldView.growAxis('causality', gain * 0.5);
                    updatedAxes.push('evolution', 'causality');
                } else if (object === 'still') {
                    // 静止が観測されるほど「制約・安定」の理解が深まる
                    worldView.growAxis('constraint', 0.005);
                    updatedAxes.push('constraint');
                }

                if (updatedAxes.length > 0) {
                    being.addLog && being.addLog(
                        `[PIPE3] ${updatedAxes.join('/')}軸+: ${subject} has-motion ${object}`
                    );
                }
            } catch(e) { console.warn('[PIPE3] has-motion axis error:', e); }
        }

        // ── has-view（PIPE6: identity → 視点ラベル）→ boundary軸 ───────
        // 多様な視点から観測できるほど「対象の境界・外界との接触面」の理解が育つ
        else if (relation === 'has-view') {
            try {
                // unknown や overhead は視点情報として薄いので小さめ
                const gain = object === 'unknown' ? 0.002 : 0.008;
                worldView.growAxis('boundary', gain);
                // 横顔(profile)まで観測できると対象の3D構造理解が深まる
                if (object.includes('profile')) {
                    worldView.growAxis('information', 0.005);
                }
                being.addLog && being.addLog(
                    `[PIPE3] boundary軸+: ${subject} has-view ${object}`
                );
            } catch(e) { console.warn('[PIPE3] has-view axis error:', e); }
        }
    };

    // ── 「AとBの共通点は？」クエリへの推論パスを追加 ───────────────────
    // being.process() の前に介入するクエリパターンを拡張
    const origProcess = being.process && being.process.bind(being);
    if (origProcess) {
        being.process = async function(text, ...args) {
            if (text) {
                // 「AとBの共通点」「AはBと同じ？」パターン
                const m = text.match(/(.+?)と(.+?)の共通|(.+?)と(.+?)は同じ/);
                if (m) {
                    const a = (m[1] || m[3] || '').trim();
                    const b = (m[2] || m[4] || '').trim();
                    if (a && b) {
                        const shared = conceptGraph.inferSharedCategories(a, b);
                        if (shared.length > 0) {
                            being.addLog && being.addLog(
                                `[PIPE3] 共通推論: ${a}と${b} → 共通カテゴリ=[${shared.join(',')}]`
                            );
                            // CIRにも記録して学習素材に
                            if (cir) {
                                cir.record(
                                    `共通カテゴリ推論[${a}×${b}]`,
                                    { query: text },
                                    {
                                        subjectA:        a,
                                        subjectB:        b,
                                        sharedCategories: shared,
                                        relationType:    'shared-category',
                                        grammarConf:     0.9,
                                    }
                                );
                            }
                        }
                    }
                }

                // 「Aは〜なはず」「Aも〜できる？」パターン → 推論補完
                const m2 = text.match(/(.+?)は.+?はず|(.+?)も.+?できる/);
                if (m2) {
                    const subject = (m2[1] || m2[2] || '').trim();
                    if (subject) {
                        const inferred = conceptGraph.inferMissingProperties(subject);
                        if (inferred.length > 0) {
                            being.addLog && being.addLog(
                                `[PIPE3] プロパティ推論: ${subject} → ${inferred.map(i=>i.property).join(',')}`
                            );
                        }
                    }
                }
            }
            return origProcess(text, ...args);
        };
    }

    // ── 外部から参照できるように公開 ──────────────────────────────────
    being.conceptGraph = conceptGraph;
    window._aoConceptGraph = conceptGraph;

    // ── SaveManager 連携 ──────────────────────────────────────────────
    _hookSaveManager(being, conceptGraph);

    // ★重要な追加修正: ao-pipe2-3.js は ao-loader.js 経由で非同期に読み込まれるため、
    //   index.html 内の起動時ロード(saveManager.load() @ ~31736行目)は
    //   このファイルが読み込まれて _hookSaveManager が importAll をパッチする
    //   *前に* もう実行を終えてしまっている。
    //   つまり「パッチする」だけでは起動直後の復元には間に合わない。
    //   なので、パッチのタイミングに依存せず、ここで直接ストレージを読んで
    //   conceptGraph を復元する。
    _selfRestoreConceptGraph(being, conceptGraph);

    console.log('[PIPE3] 抽象概念Map → 12軸/空間野/CIR パイプ接続完了');
    being.addLog && being.addLog('[PIPE3] 抽象概念Map→12軸・空間野・因果推論野 パイプ3 接続完了');
}

// ───────────────────────────────────────────────────────────────────────
// 起動タイミング競合対策: PersonaSaveManager の保存キーを直接読んで
// ConceptGraph だけを先に復元する。
// (being.importAll の完全な差し替えを待たずに済むので、
//  ao-pipe2-3.js の読み込みが起動時ロードより遅れても復元できる)
// ───────────────────────────────────────────────────────────────────────
async function _selfRestoreConceptGraph(being, conceptGraph) {
    try {
        const sm = being.saveManager;

        // PersonaSaveManager の保存キーと同じ優先順位で探す
        const keys = sm && sm.saveKeys
            ? [sm.saveKeys.current, 'ao_persona_current', 'ao_state', sm.saveKeys.prev, sm.saveKeys.backup]
            : ['ao_persona_v24_0', 'ao_persona_current', 'ao_state', 'ao_persona_v24_0_prev', 'ao_persona_v24_0_backup'];

        let raw = null;

        // IndexedDB(AoPersonaDB) 優先
        if (sm && sm.useIndexedDB && sm.indexedDB) {
            for (const k of keys) {
                try {
                    raw = await sm.indexedDB.get(k);
                    if (raw) break;
                } catch (_) {}
            }
        }
        // localStorage フォールバック
        if (!raw) {
            for (const k of keys) {
                raw = localStorage.getItem(k);
                if (raw) break;
            }
        }
        if (!raw) {
            console.log('[PIPE2/3] 起動時復元: 保存データなし(初回起動扱い)');
            return;
        }

        const json = (typeof LZString !== 'undefined')
            ? (LZString.decompressFromUTF16(raw) || raw)
            : raw;
        const data = JSON.parse(json);

        if (data && data.coreState && data.coreState.conceptGraph) {
            conceptGraph.importState(data.coreState.conceptGraph);
            being.addLog && being.addLog(
                `[PIPE2/3] 起動時ConceptGraph直接復元: ${conceptGraph.groups.size}カテゴリ`
            );
            console.log(`[PIPE2/3] ConceptGraph 直接復元完了 (${conceptGraph.groups.size}カテゴリ) — 起動タイミング競合対策`);
        } else {
            console.log('[PIPE2/3] 起動時復元: 保存データにconceptGraphが無い(初回保存前 or 旧データ)');
        }
    } catch (e) {
        console.warn('[PIPE2/3] ConceptGraph 直接復元失敗:', e.message);
    }
}

// ───────────────────────────────────────────────────────────────────────
// SaveManager フック
// ───────────────────────────────────────────────────────────────────────
function _hookSaveManager(being, conceptGraph) {
    // ★修正: 以前は being.saveManager(PersonaSaveManager) の
    //   `_buildExportData` / `exportPersona` という存在しないメソッド名を
    //   探していたため、if (origExport) が常にfalseになりフックが
    //   一度も刺さっていなかった(ConceptGraphが毎回まっさらに戻る原因)。
    //
    //   実際に呼ばれているのは:
    //     PersonaSaveManager.save() → being.exportAll()
    //     PersonaSaveManager.load() → being.importAll(personaData)
    //     AutoSaveManager._performAutoSave() → being.exportAll() (ネイティブ側)
    //   なので saveManager ではなく being.exportAll / being.importAll 自体を
    //   直接ラップする。saveManagerが後から生成される場合にも対応するため
    //   ポーリングは残しつつ、実体は being 側をフックする。
    if (being._conceptGraphPersistHooked) return;
    being._conceptGraphPersistHooked = true;

    if (typeof being.exportAll === 'function') {
        const origExportAll = being.exportAll.bind(being);
        being.exportAll = function(...args) {
            const data = origExportAll(...args);
            try {
                if (data && data.coreState) {
                    data.coreState.conceptGraph = conceptGraph.exportState();
                }
            } catch (e) { console.warn('[SAVE-HOOK] export error:', e); }
            return data;
        };
    } else {
        console.warn('[SAVE-HOOK] being.exportAll が見つからずフックできませんでした');
    }

    if (typeof being.importAll === 'function') {
        const origImportAll = being.importAll.bind(being);
        being.importAll = function(data, ...args) {
            const result = origImportAll(data, ...args);
            try {
                if (data && data.coreState && data.coreState.conceptGraph) {
                    conceptGraph.importState(data.coreState.conceptGraph);
                    being.addLog && being.addLog(
                        `[SAVE-HOOK] ConceptGraph復元: ${conceptGraph.groups.size}カテゴリ`
                    );
                }
            } catch (e) { console.warn('[SAVE-HOOK] import error:', e); }
            return result;
        };
    } else {
        console.warn('[SAVE-HOOK] being.importAll が見つからずフックできませんでした');
    }

    being.addLog && being.addLog('[SAVE-HOOK] ConceptGraph → exportAll/importAll 永続化接続完了');
    console.log('[SAVE-HOOK] exportAll/importAll フック完了(being直接パッチ版)');

    // ConceptGraph 更新時に saveManager.markDirty() も呼ぶ(保存トリガー用)。
    // saveManagerがまだ生成されていない場合があるのでポーリングして後付けする。
    const origAddRel = conceptGraph.addRelation.bind(conceptGraph);
    conceptGraph.addRelation = function(...args) {
        origAddRel(...args);
        try { being.saveManager && being.saveManager.markDirty && being.saveManager.markDirty(); } catch(_) {}
    };
}

// ───────────────────────────────────────────────────────────────────────
// 自動アタッチ（pipe1完了後を待ってから）
// ───────────────────────────────────────────────────────────────────────
(function pollForPipe2and3() {
    const being = window.ao;
    if (being &&
        being.causalInterventionReasoner &&
        being.abstractFormer &&
        being.worldView) {

        setTimeout(() => {
            try {
                const conceptGraph = new ConceptGraph();
                attachPipe2(being, conceptGraph);
                attachPipe3(being, conceptGraph);
            } catch(e) {
                console.error('[PIPE2/3] attach error:', e);
            }
        }, 0); // ao-pipe-orchestrator.js が順序を管理するためdelayなし

    } else {
        setTimeout(pollForPipe2and3, 1000);
    }
})();

window.ConceptGraph  = ConceptGraph;
window.attachPipe2   = attachPipe2;
window.attachPipe3   = attachPipe3;
