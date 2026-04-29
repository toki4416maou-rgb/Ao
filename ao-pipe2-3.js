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

    // CIR.record() をラップ：is-a 系パターンが来たら即 ConceptGraph に登録
    const origRecord = cir.record.bind(cir);
    cir.record = function(action, stateBefore, stateAfter) {
        origRecord(action, stateBefore, stateAfter);

        try {
            const rel = stateAfter && stateAfter.relationType;
            const sub = stateAfter && stateAfter.subject;
            const obj = stateAfter && stateAfter.predicate;
            if (!sub || !obj) return;

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

        // is-a でカテゴリが更新されたとき
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

    console.log('[PIPE3] 抽象概念Map → 12軸/空間野/CIR パイプ接続完了');
    being.addLog && being.addLog('[PIPE3] 抽象概念Map→12軸・空間野・因果推論野 パイプ3 接続完了');
}

// ───────────────────────────────────────────────────────────────────────
// SaveManager フック
// ───────────────────────────────────────────────────────────────────────
function _hookSaveManager(being, conceptGraph) {
    function tryHook() {
        const sm = being.saveManager;
        if (!sm || sm._conceptGraphHooked) return;
        sm._conceptGraphHooked = true;

        // export フック
        const exportMethod = sm._buildExportData ? '_buildExportData' : 'exportPersona';
        const origExport = sm[exportMethod] && sm[exportMethod].bind(sm);
        if (origExport) {
            sm[exportMethod] = async function(...args) {
                const data = await origExport(...args);
                try {
                    if (data && data.coreState) {
                        data.coreState.conceptGraph = conceptGraph.exportState();
                    }
                } catch(e) { console.warn('[SAVE-HOOK] export error:', e); }
                return data;
            };
        }

        // import フック
        const importMethod = sm._applyImportData ? '_applyImportData' : 'importPersona';
        const origImport = sm[importMethod] && sm[importMethod].bind(sm);
        if (origImport) {
            sm[importMethod] = async function(data, ...args) {
                const result = await origImport(data, ...args);
                try {
                    if (data && data.coreState && data.coreState.conceptGraph) {
                        conceptGraph.importState(data.coreState.conceptGraph);
                        being.addLog && being.addLog(
                            `[SAVE-HOOK] ConceptGraph復元: ${conceptGraph.groups.size}カテゴリ`
                        );
                    }
                } catch(e) { console.warn('[SAVE-HOOK] import error:', e); }
                return result;
            };
        }

        // ConceptGraph 更新時に自動 markDirty
        const origAddRel = conceptGraph.addRelation.bind(conceptGraph);
        conceptGraph.addRelation = function(...args) {
            origAddRel(...args);
            try { sm.markDirty && sm.markDirty(); } catch(_) {}
        };

        being.addLog && being.addLog('[SAVE-HOOK] ConceptGraph → SaveManager 永続化接続完了');
        console.log('[SAVE-HOOK] SaveManager フック完了');
    }

    if (being.saveManager) {
        tryHook();
    } else {
        const interval = setInterval(() => {
            if (being.saveManager) { clearInterval(interval); tryHook(); }
        }, 1000);
    }
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
        }, 2000); // pipe1(1500ms)の後

    } else {
        setTimeout(pollForPipe2and3, 1000);
    }
})();

window.ConceptGraph  = ConceptGraph;
window.attachPipe2   = attachPipe2;
window.attachPipe3   = attachPipe3;
