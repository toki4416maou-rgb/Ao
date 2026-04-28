/*!
 * ao-gpu.js  v1.0 – Ao GPU加速モジュール
 *
 * 概要:
 *   ImageAdapter の重い知覚処理（HOG/Gabor/LBP/明度グリッド/色相ヒスト）を
 *   WebGL2 フラグメントシェーダーで完全並列化。
 *   全特徴量を1パイプラインで一括GPU処理するため低スペック機でも高速動作。
 *
 * 追加方法:
 *   index.html の ao-optimizer.js の直前に
 *     <script src="ao-gpu.js"></script>
 *   を1行追加するだけ。WebGL2 非対応 / EXT_color_buffer_float 非対応の場合は
 *   自動的にCPUフォールバックし、既存動作をそのまま維持。
 *
 * GPU化対象:
 *   ・HOGブロック計算   2048次元 (16×16グリッド × 8方向)
 *   ・明度グリッド       256次元 (16×16セル)
 *   ・色相ヒストグラム     8次元 (8 bin)
 *   ・Gaborフィルター     32次元 (4周波数 × 8角度)
 *   ・LBP特徴量          16次元
 *   ・グレースケール変換 (前処理)
 *   ・Sobelグラジェント  (前処理)
 *
 * visual_vector レイアウト(2368次元、既存コードと完全一致):
 *   [0-7]    hue_hist       (8)
 *   [8-263]  brightness_grid (256)
 *   [264-271] gradient_hist  (8)
 *   [272-2319] hog_blocks    (2048)
 *   [2320-2351] gabor_features (32)
 *   [2352-2367] lbp_features   (16)
 */

(function () {
'use strict';

// ================================================================
// 定数
// ================================================================
const IMG_SIZE  = 256;   // 画像処理サイズ（既存コードと一致）
const HOG_GRID  = 16;    // HOGグリッド分割数
const HOG_BINS  = 8;     // HOG方向ビン数
const HOG_DIM   = HOG_GRID * HOG_GRID * HOG_BINS; // 2048
const BRIGHT_DIM = 256;  // 16×16 明度グリッド
const HUE_DIM   = 8;
const GABOR_DIM = 32;    // 4freqs × 8angles
const LBP_DIM   = 16;
const GRAD_DIM  = 8;


// ================================================================
// WebGL2 シェーダーソース
// ================================================================

// ---- 共通頂点シェーダー（フルスクリーンクワッド）----
const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
    gl_Position = vec4(a_pos, 0.0, 1.0);
    v_uv = a_pos * 0.5 + 0.5;
}`;

// ---- Pass 1: RGBA8 → グレースケール (RGBA32F, R=luma) ----
const FS_GRAY = `#version 300 es
precision highp float;
uniform sampler2D u_img;
in vec2 v_uv;
out vec4 o;
void main() {
    vec4 c = texture(u_img, v_uv);
    float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
    o = vec4(luma, 0.0, 0.0, 1.0);
}`;

// ---- Pass 2: Sobel グラジェント (RGBA32F: R=mag, G=bin/7.0) ----
const FS_SOBEL = `#version 300 es
precision highp float;
uniform sampler2D u_gray;
uniform vec2 u_inv;  // 1/width, 1/height
in vec2 v_uv;
out vec4 o;
void main() {
    float dx = u_inv.x, dy = u_inv.y;
    float tl = texture(u_gray, v_uv + vec2(-dx,-dy)).r;
    float tc = texture(u_gray, v_uv + vec2(  0,-dy)).r;
    float tr = texture(u_gray, v_uv + vec2( dx,-dy)).r;
    float cl = texture(u_gray, v_uv + vec2(-dx,  0)).r;
    float cr = texture(u_gray, v_uv + vec2( dx,  0)).r;
    float bl = texture(u_gray, v_uv + vec2(-dx, dy)).r;
    float bc = texture(u_gray, v_uv + vec2(  0, dy)).r;
    float br = texture(u_gray, v_uv + vec2( dx, dy)).r;
    float gx = -tl + tr - 2.0*cl + 2.0*cr - bl + br;
    float gy = -tl - 2.0*tc - tr  + bl + 2.0*bc  + br;
    float mag  = sqrt(gx*gx + gy*gy);
    float ang  = degrees(atan(gy, gx)) + 180.0;  // 0~360
    float binf = clamp(floor(ang / 45.0), 0.0, 7.0);
    o = vec4(mag, binf / 7.0, 0.0, 1.0);
}`;

// ---- Pass 3: HOG (2048×1 output, RGBA32F) ----
// フラグメントx座標 = block_idx*8 + bin_idx
// 各フラグメントが担当ブロック内のpixelをループして当該binを集計
const FS_HOG = `#version 300 es
precision highp float;
uniform sampler2D u_sobel;
uniform int u_W;
uniform int u_H;
in vec2 v_uv;
out vec4 o;
const int GRID = 16;
const int BINS = 8;
void main() {
    int fx      = int(gl_FragCoord.x);        // 0~2047
    int blk     = fx / BINS;                   // 0~255
    int bin_i   = fx - blk * BINS;             // 0~7
    int bx      = blk % GRID;
    int by      = blk / GRID;
    int blkW    = u_W / GRID;
    int blkH    = u_H / GRID;
    int startX  = bx * blkW;
    int startY  = by * blkH;
    float fw    = float(u_W);
    float fh    = float(u_H);
    float sum   = 0.0;
    // 境界1px除いてループ
    for (int py = 1; py < blkH - 1; py++) {
        for (int px = 1; px < blkW - 1; px++) {
            vec2 uv = vec2(
                (float(startX + px) + 0.5) / fw,
                (float(startY + py) + 0.5) / fh
            );
            vec4 s   = texture(u_sobel, uv);
            float mag = s.r;
            int   sb  = int(round(s.g * 7.0));
            if (mag > 0.03 && sb == bin_i) sum += mag;
        }
    }
    float total = float((blkW - 2) * (blkH - 2));
    o = vec4(sum / max(total, 1.0), 0.0, 0.0, 1.0);
}`;

// ---- Pass 4: 明度グリッド (256×1, RGBA32F) ----
const FS_BRIGHT = `#version 300 es
precision highp float;
uniform sampler2D u_gray;
uniform int u_W;
uniform int u_H;
in vec2 v_uv;
out vec4 o;
const int GCELLS = 16;
void main() {
    int ci     = int(gl_FragCoord.x);   // 0~255
    int cx     = ci % GCELLS;
    int cy     = ci / GCELLS;
    int cellW  = u_W / GCELLS;
    int cellH  = u_H / GCELLS;
    int startX = cx * cellW;
    int startY = cy * cellH;
    float fw   = float(u_W);
    float fh   = float(u_H);
    float sum  = 0.0;
    float cnt  = 0.0;
    for (int py = 0; py < cellH; py++) {
        for (int px = 0; px < cellW; px++) {
            vec2 uv = vec2(
                (float(startX + px) + 0.5) / fw,
                (float(startY + py) + 0.5) / fh
            );
            sum += texture(u_gray, uv).r;
            cnt += 1.0;
        }
    }
    o = vec4(sum / max(cnt, 1.0), 0.0, 0.0, 1.0);
}`;

// ---- Pass 5: 色相ヒストグラム (8×1, RGBA32F) ----
// サンプリングステップでピクセル数を削減（統計的に十分）
const FS_HUE = `#version 300 es
precision highp float;
uniform sampler2D u_img;
uniform int u_W;
uniform int u_H;
in vec2 v_uv;
out vec4 o;
void main() {
    int  bin_i = int(gl_FragCoord.x);  // 0~7
    float fw   = float(u_W);
    float fh   = float(u_H);
    float cnt  = 0.0;
    float tot  = 0.0;
    int step   = max(1, u_W / 32);    // ~32×32 サンプル
    for (int py = 0; py < u_H; py += step) {
        for (int px = 0; px < u_W; px += step) {
            vec2 uv = vec2((float(px)+0.5)/fw, (float(py)+0.5)/fh);
            vec4 c  = texture(u_img, uv);
            float r = c.r, g = c.g, b = c.b;
            float mx = max(r, max(g, b));
            float mn = min(r, min(g, b));
            float d  = mx - mn;
            float s  = mx > 0.0 ? d/mx : 0.0;
            if (s > 0.15) {
                float h = 0.0;
                if      (mx == r) h = 60.0 * mod((g-b)/d, 6.0);
                else if (mx == g) h = 60.0 * ((b-r)/d + 2.0);
                else              h = 60.0 * ((r-g)/d + 4.0);
                if (h < 0.0) h += 360.0;
                int hb = clamp(int(h/45.0), 0, 7);
                if (hb == bin_i) cnt += 1.0;
            }
            tot += 1.0;
        }
    }
    o = vec4(tot > 0.0 ? cnt/tot : 0.0, 0.0, 0.0, 1.0);
}`;

// ---- Pass 6: Gaborフィルター (32×1, RGBA32F) ----
// 4周波数 × 8角度 = 32次元
// sigmaを定数にしてksも固定（GLSL最適化のため）
const FS_GABOR = `#version 300 es
precision highp float;
uniform sampler2D u_gray;
uniform int u_W;
uniform int u_H;
in vec2 v_uv;
out vec4 o;
const float PI     = 3.14159265;
const float SIGMA  = 2.0;
const int   KS     = 6;           // ceil(SIGMA*3) = 6, clamp to 8 → 6
const float FREQS[4] = float[](2.0, 4.0, 8.0, 16.0);
const float ANGLES[8] = float[](
    0.0, PI/8.0, PI/4.0, 3.0*PI/8.0,
    PI/2.0, 5.0*PI/8.0, 3.0*PI/4.0, 7.0*PI/8.0
);
void main() {
    int   idx    = int(gl_FragCoord.x);   // 0~31
    int   fi     = idx / 8;
    int   ai     = idx - fi * 8;
    float freq   = FREQS[fi];
    float angle  = ANGLES[ai];
    float lambda = float(u_W) / freq;
    float cosA   = cos(angle);
    float sinA   = sin(angle);
    float fw     = float(u_W);
    float fh     = float(u_H);
    float resp   = 0.0;
    float cnt    = 0.0;
    int step     = max(1, u_W / 16);
    for (int py = KS; py < u_H - KS; py += step) {
        for (int px = KS; px < u_W - KS; px += step) {
            float real = 0.0;
            for (int ky = -KS; ky <= KS; ky++) {
                for (int kx = -KS; kx <= KS; kx++) {
                    vec2 uv = vec2(
                        (float(px+kx)+0.5)/fw,
                        (float(py+ky)+0.5)/fh
                    );
                    float g   = texture(u_gray, uv).r;
                    float xp  =  float(kx)*cosA + float(ky)*sinA;
                    float yp  = -float(kx)*sinA + float(ky)*cosA;
                    float gau = exp(-(xp*xp + yp*yp)/(2.0*SIGMA*SIGMA));
                    float wav = cos(2.0*PI*xp/lambda);
                    real += g * gau * wav;
                }
            }
            resp += abs(real);
            cnt  += 1.0;
        }
    }
    o = vec4(cnt > 0.0 ? resp/cnt : 0.0, 0.0, 0.0, 1.0);
}`;

// ---- Pass 7: LBP (16×1, RGBA32F) ----
const FS_LBP = `#version 300 es
precision highp float;
uniform sampler2D u_gray;
uniform int u_W;
uniform int u_H;
in vec2 v_uv;
out vec4 o;
const int DX[8] = int[]( 1, 1, 0,-1,-1,-1, 0, 1);
const int DY[8] = int[]( 0, 1, 1, 1, 0,-1,-1,-1);
void main() {
    int  bin_i = int(gl_FragCoord.x);   // 0~15
    float fw   = float(u_W);
    float fh   = float(u_H);
    float cnt  = 0.0;
    float tot  = 0.0;
    for (int py = 1; py < u_H-1; py++) {
        for (int px = 1; px < u_W-1; px++) {
            vec2 cuv = vec2((float(px)+0.5)/fw,(float(py)+0.5)/fh);
            float center = texture(u_gray, cuv).r;
            int code = 0;
            for (int k = 0; k < 8; k++) {
                vec2 nuv = vec2(
                    (float(px+DX[k])+0.5)/fw,
                    (float(py+DY[k])+0.5)/fh
                );
                if (texture(u_gray, nuv).r >= center) code |= (1<<k);
            }
            int binn = code / 16;   // 0~15
            if (binn == bin_i) cnt += 1.0;
            tot += 1.0;
        }
    }
    o = vec4(tot > 0.0 ? cnt/tot : 0.0, 0.0, 0.0, 1.0);
}`;


// ================================================================
// WebGL2 ユーティリティ
// ================================================================

function _mkShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error('Shader compile error: ' + log);
    }
    return s;
}

function _mkProg(gl, vsSrc, fsSrc) {
    const vs   = _mkShader(gl, gl.VERTEX_SHADER,   vsSrc);
    const fs   = _mkShader(gl, gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error('Program link error: ' + log);
    }
    return prog;
}

// RGBA32F テクスチャ作成
function _mkTex(gl, w, h, data = null) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    return t;
}

// RGBA8 テクスチャ作成（入力画像用）
function _mkTexRGBA8(gl, w, h, data) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return t;
}

// FBO作成 + テクスチャアタッチ
function _mkFBO(gl, tex) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('FBO not complete: 0x' + st.toString(16));
    }
    return fbo;
}

// プログラム・テクスチャをバインドしてフルクワッドを描画
function _draw(gl, prog, vao, textures, uniforms, outFBO, vpW, vpH) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFBO);
    gl.viewport(0, 0, vpW, vpH);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);

    // テクスチャバインド
    textures.forEach(({ unit, tex, name }) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const loc = gl.getUniformLocation(prog, name);
        if (loc !== null) gl.uniform1i(loc, unit);
    });

    // Uniform設定
    for (const [name, val] of Object.entries(uniforms)) {
        const loc = gl.getUniformLocation(prog, name);
        if (loc === null) continue;
        if (Array.isArray(val))         gl.uniform2f(loc, val[0], val[1]);
        else if (Number.isInteger(val)) gl.uniform1i(loc, val);
        else                            gl.uniform1f(loc, val);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
}

// FBOからR channelをFloat32Arrayとして読み出し
function _readR(gl, fbo, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const buf = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
    // RチャンネルのみをFloat32Arrayで返す
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = buf[i * 4];
    return out;
}


// ================================================================
// AoGPUAccelerator クラス
// ================================================================

class AoGPUAccelerator {
    constructor() {
        this.ready    = false;
        this._gl      = null;
        this._vao     = null;
        this._progs   = {};
        this._canvas  = null;
        this._stats   = { calls: 0, totalMs: 0, errors: 0 };
    }

    // ---- 初期化 ----
    async init() {
        try {
            this._canvas = document.createElement('canvas');
            this._canvas.width  = IMG_SIZE;
            this._canvas.height = IMG_SIZE;
            const gl = this._canvas.getContext('webgl2', {
                antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false
            });
            if (!gl) { console.warn('[AoGPU] WebGL2 非対応'); return false; }

            // float color buffer 拡張
            const ext = gl.getExtension('EXT_color_buffer_float');
            if (!ext) { console.warn('[AoGPU] EXT_color_buffer_float 非対応'); return false; }

            this._gl = gl;

            // フルスクリーンクワッド VAO
            this._vao = gl.createVertexArray();
            gl.bindVertexArray(this._vao);
            const vbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.bufferData(gl.ARRAY_BUFFER,
                new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

            // シェーダープログラムをコンパイル
            const defs = { gray: FS_GRAY, sobel: FS_SOBEL, hog: FS_HOG,
                           bright: FS_BRIGHT, hue: FS_HUE, gabor: FS_GABOR, lbp: FS_LBP };
            for (const [key, fsSrc] of Object.entries(defs)) {
                const prog = _mkProg(gl, VS, fsSrc);
                // a_pos 頂点属性設定
                const loc = gl.getAttribLocation(prog, 'a_pos');
                gl.useProgram(prog);
                gl.enableVertexAttribArray(loc);
                gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
                this._progs[key] = prog;
            }
            gl.bindVertexArray(null);

            this.ready = true;
            console.log('[AoGPU] 初期化完了 – WebGL2 GPU加速 ON');
            return true;
        } catch (e) {
            console.warn('[AoGPU] 初期化失敗（CPUフォールバック）:', e.message);
            return false;
        }
    }

    // ----------------------------------------------------------------
    // メイン: ImageDataから全特徴量を一括GPU計算
    // 戻り値は既存 ImageAdapter.extractMeaning と同じ構造
    // ----------------------------------------------------------------
    computeFeatures(imgData) {
        if (!this.ready) return null;
        const gl = this._gl;
        const W  = imgData.width;
        const H  = imgData.height;
        const t0 = performance.now();

        // リソースをまとめて管理してfinallyで確実に解放
        const textures = [];
        const fbos     = [];
        const mk   = (w, h)         => { const t = _mkTex(gl, w, h);         textures.push(t); return t; };
        const mkFBO = (tex)          => { const f = _mkFBO(gl, tex);          fbos.push(f);     return f; };

        try {
            // =====================================================
            // Step 1: 入力画像テクスチャ (RGBA8)
            // =====================================================
            const imgTex = _mkTexRGBA8(gl, W, H, imgData.data);
            textures.push(imgTex);

            // =====================================================
            // Step 2: グレースケール (W×H, R=luma)
            // =====================================================
            const grayTex = mk(W, H);
            const grayFBO = mkFBO(grayTex);
            _draw(gl, this._progs.gray, this._vao,
                [{ unit: 0, tex: imgTex, name: 'u_img' }],
                {}, grayFBO, W, H);

            // =====================================================
            // Step 3: Sobelグラジェント (W×H, R=mag G=bin/7)
            // =====================================================
            const sobelTex = mk(W, H);
            const sobelFBO = mkFBO(sobelTex);
            _draw(gl, this._progs.sobel, this._vao,
                [{ unit: 0, tex: grayTex, name: 'u_gray' }],
                { u_inv: [1.0 / W, 1.0 / H] },
                sobelFBO, W, H);

            // =====================================================
            // Step 4: HOG (HOG_DIM×1 = 2048×1)
            // =====================================================
            const hogTex = mk(HOG_DIM, 1);
            const hogFBO = mkFBO(hogTex);
            _draw(gl, this._progs.hog, this._vao,
                [{ unit: 0, tex: sobelTex, name: 'u_sobel' }],
                { u_W: W, u_H: H },
                hogFBO, HOG_DIM, 1);
            const hogResult = _readR(gl, hogFBO, HOG_DIM, 1);

            // =====================================================
            // Step 5: 明度グリッド (256×1)
            // =====================================================
            const brightTex = mk(BRIGHT_DIM, 1);
            const brightFBO = mkFBO(brightTex);
            _draw(gl, this._progs.bright, this._vao,
                [{ unit: 0, tex: grayTex, name: 'u_gray' }],
                { u_W: W, u_H: H },
                brightFBO, BRIGHT_DIM, 1);
            const brightResult = _readR(gl, brightFBO, BRIGHT_DIM, 1);

            // =====================================================
            // Step 6: 色相ヒストグラム (8×1)
            // =====================================================
            const hueTex = mk(HUE_DIM, 1);
            const hueFBO = mkFBO(hueTex);
            _draw(gl, this._progs.hue, this._vao,
                [{ unit: 0, tex: imgTex, name: 'u_img' }],
                { u_W: W, u_H: H },
                hueFBO, HUE_DIM, 1);
            const hueRaw = _readR(gl, hueFBO, HUE_DIM, 1);
            // 正規化
            const hueSum = Array.from(hueRaw).reduce((a, b) => a + b, 0) || 1;
            const hueResult = Array.from(hueRaw).map(v => v / hueSum);

            // =====================================================
            // Step 7: Gaborフィルター (32×1)
            // =====================================================
            const gaborTex = mk(GABOR_DIM, 1);
            const gaborFBO = mkFBO(gaborTex);
            _draw(gl, this._progs.gabor, this._vao,
                [{ unit: 0, tex: grayTex, name: 'u_gray' }],
                { u_W: W, u_H: H },
                gaborFBO, GABOR_DIM, 1);
            const gaborRaw = _readR(gl, gaborFBO, GABOR_DIM, 1);
            const gaborMax = Math.max(...gaborRaw, 1e-6);
            const gaborResult = Array.from(gaborRaw).map(v => v / gaborMax);

            // =====================================================
            // Step 8: LBP (16×1)
            // =====================================================
            const lbpTex = mk(LBP_DIM, 1);
            const lbpFBO = mkFBO(lbpTex);
            _draw(gl, this._progs.lbp, this._vao,
                [{ unit: 0, tex: grayTex, name: 'u_gray' }],
                { u_W: W, u_H: H },
                lbpFBO, LBP_DIM, 1);
            const lbpResult = _readR(gl, lbpFBO, LBP_DIM, 1);

            // =====================================================
            // Step 9: グラジェントヒストグラム(8次元)をHOGから導出
            //   全256ブロックの各bin値を合計→正規化
            // =====================================================
            const gradArr = new Float32Array(GRAD_DIM);
            for (let i = 0; i < HOG_DIM; i++) gradArr[i % GRAD_DIM] += hogResult[i];
            const gradSum = Array.from(gradArr).reduce((a, b) => a + b, 0) || 1;
            const gradResult = Array.from(gradArr).map(v => v / gradSum);

            // =====================================================
            // 統計更新
            // =====================================================
            this._stats.calls++;
            this._stats.totalMs += performance.now() - t0;

            return {
                hue_hist:        hueResult,                  //  8次元 Array
                brightness_grid: Array.from(brightResult),  // 256次元
                gradient_hist:   gradResult,                 //  8次元
                hog_blocks:      Array.from(hogResult),      // 2048次元
                gabor_features:  gaborResult,                //  32次元
                lbp_features:    Array.from(lbpResult)       //  16次元
            };

        } catch (e) {
            this._stats.errors++;
            console.error('[AoGPU] computeFeatures 失敗:', e);
            return null;
        } finally {
            // リソース解放
            fbos.forEach(f => gl.deleteFramebuffer(f));
            textures.forEach(t => gl.deleteTexture(t));
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        }
    }

    // ---- パフォーマンス統計 ----
    getStats() {
        const avg = this._stats.calls > 0
            ? (this._stats.totalMs / this._stats.calls).toFixed(1)
            : '—';
        return { ...this._stats, avgMs: avg };
    }
}


// ================================================================
// ImageAdapter への自動パッチ
// ================================================================

function patchImageAdapter(gpu) {
    // window.ao が来るまでポーリング
    const poll = setInterval(() => {
        const ao = window.ao;
        if (!ao || !ao.imageAdapter) return;
        clearInterval(poll);

        const adapter = ao.imageAdapter;
        const origExtract = adapter.extractMeaning?.bind(adapter);

        // extractMeaning を GPU版に差し替え
        adapter.extractMeaning = async function (imageData) {
            if (!imageData) return _fallback(origExtract, imageData);
            try {
                // SIZE計算（既存の_fastModeロジックを踏襲）
                const SIZE = adapter._fastMode ? 64 : IMG_SIZE;

                // base64/URL → Canvas → ImageData
                const imgD = await _srcToImageData(imageData, SIZE);
                if (!imgD) return _fallback(origExtract, imageData);

                const features = gpu.computeFeatures(imgD);
                if (!features) return _fallback(origExtract, imageData);

                return _buildResult(adapter, features, imageData, imgD);
            } catch (e) {
                console.warn('[AoGPU] extractMeaning GPU失敗, CPU退避:', e.message);
                return _fallback(origExtract, imageData);
            }
        };

        console.log('[AoGPU] ImageAdapter GPU加速パッチ適用完了');
    }, 800);
}

// ---- base64/URL → Canvas → ImageData 変換 ----
function _srcToImageData(src, size) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const cv  = document.createElement('canvas');
            cv.width  = size;
            cv.height = size;
            cv.getContext('2d').drawImage(img, 0, 0, size, size);
            resolve(cv.getContext('2d').getImageData(0, 0, size, size));
        };
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

// ---- GPU特徴量 → extractMeaning 戻り値オブジェクト構築 ----
function _buildResult(adapter, features, originalSrc, imgData) {
    const { hue_hist, brightness_grid, gradient_hist, hog_blocks, gabor_features, lbp_features } = features;

    // visual_vector: 2368次元 (既存コードの layout と完全一致)
    const visual_vector = [
        ...hue_hist,          //   8
        ...brightness_grid,   // 256
        ...gradient_hist,     //   8
        ...hog_blocks,        // 2048
        ...gabor_features,    //  32
        ...lbp_features       //  16
    ]; // 合計 2368

    // 既存コードが参照するグローバルバッファを更新
    window._aoRawFeaturesBuf = {
        visualVector: visual_vector,
        hogBlocks:    hog_blocks
    };

    // spatial vector (仮説テーブル用)
    const spatialVec = [...gradient_hist, ...hog_blocks, ...gabor_features, ...lbp_features];

    // プロトタイプ照合
    let semantics = [];
    try {
        const protoMatches = adapter.matchPrototype ? adapter.matchPrototype(visual_vector) : [];
        protoMatches.forEach(m => {
            if (m.similarity > 0.6) semantics.push({ concept: m.concept, weight: m.similarity });
        });
    } catch (e) { /* ignore */ }

    // 仮説テーブル照合
    try {
        const hypoMatches = adapter.hypothesisTable
            ? adapter.hypothesisTable.matchHypotheses(hue_hist, brightness_grid, spatialVec)
            : [];
        hypoMatches.forEach(m => {
            if (m.defined && m.weight > 0.5)
                semantics.unshift({ concept: m.concept, weight: m.weight, fromHypothesis: true, channel: m.channel });
            else if (m.weight > 0.55)
                semantics.push({ concept: m.concept, weight: m.weight, fromHypothesis: true, channel: m.channel });
        });
    } catch (e) { /* ignore */ }

    // 共起照合
    try {
        const coMatches = adapter.matchCoOccurrence ? adapter.matchCoOccurrence(features) : [];
        coMatches.forEach(m => {
            if (m.score > 0.55) semantics.push({ concept: m.concept, weight: m.score, fromCoOccurrence: true });
        });
    } catch (e) { /* ignore */ }

    // AxisCodec
    try {
        if (window._aoAxisCodec) {
            const axisDist = window._aoAxisCodec.encode(visual_vector, 'image');
            const top = window._aoAxisCodec.summary(axisDist).slice(0, 3)
                .map(a => `${a.axis}:${a.mu.toFixed(2)}(σ${a.sigma.toFixed(2)})`).join(' ');
            console.log(`[AxisCodec/image-gpu] ${top}`);
            if (window.ao?.worldView) {
                for (const [ax, d] of Object.entries(axisDist)) {
                    if (d.mu > 0.6) window.ao.worldView.growAxis(ax, d.mu * 0.01);
                }
            }
            if (window._aoRegisterModalFeature) window._aoRegisterModalFeature('image', visual_vector);
        }
    } catch (e) { /* codec未準備時は無視 */ }

    // 補助値
    const avgBrightness = brightness_grid.reduce((a, b) => a + b, 0) / 16;
    const hueLabels = adapter.hueLabels || ['赤','橙','黄','黄緑','緑','水色','青','紫'];
    const dirLabels = adapter.dirLabels || ['水平','斜め右下','垂直','斜め左下','水平','斜め右上','垂直','斜め左上'];
    const dominantHue = hueLabels[hue_hist.indexOf(Math.max(...hue_hist))];
    const dominantDir = dirLabels[gradient_hist.indexOf(Math.max(...gradient_hist))];

    return {
        semantic_candidates: semantics.slice(0, 6),
        modality:     'visual',
        visual_vector: visual_vector,
        features: {
            brightness:       avgBrightness,
            hue_hist:         hue_hist,
            brightness_grid:  brightness_grid,
            gradient_hist:    gradient_hist,
            hog_blocks:       hog_blocks,
            gabor_features:   gabor_features,
            lbp_features:     lbp_features,
            dominant_hue:     dominantHue,
            dominant_dir:     dominantDir,
        },
        raw_descriptor: `色:${dominantHue} 明度:${(avgBrightness*100).toFixed(0)}% 輪郭:${dominantDir}`,
        _gpu: true   // GPU処理フラグ（デバッグ用）
    };
}

// ---- CPUフォールバック ----
async function _fallback(origFn, arg) {
    if (!origFn) return null;
    return origFn(arg);
}


// ================================================================
// VideoAdapter への補助パッチ
// (imageAdapter注入のみ。フレームloop自体はCPUだが
//  各フレームのImageAdapter処理がGPU化される)
// ================================================================

function patchVideoAdapter() {
    const poll = setInterval(() => {
        const ao = window.ao;
        if (!ao || !ao.videoAdapter) return;
        clearInterval(poll);
        if (!ao.videoAdapter.imageAdapter && ao.imageAdapter) {
            ao.videoAdapter.imageAdapter = ao.imageAdapter;
        }
        console.log('[AoGPU] VideoAdapter imageAdapter 注入完了');
    }, 800);
}


// ================================================================
// ステータス表示（ヘッダーインジケーター更新）
// ================================================================

function updateStatusIndicator(ok) {
    // GPU インジケーターを探して更新
    const indicators = document.querySelectorAll('.gpu-indicator');
    indicators.forEach(el => {
        el.textContent = ok ? '⚡ GPU On' : 'GPU Off';
        el.style.background = ok
            ? 'rgba(16,185,129,0.2)'
            : 'rgba(107,114,128,0.2)';
        el.style.color = ok ? '#6ee7b7' : '#9ca3af';
    });
}


// ================================================================
// メイン起動
// ================================================================

const gpu = new AoGPUAccelerator();

async function boot() {
    const ok = await gpu.init();
    window.aoGPU = ok ? gpu : null;
    updateStatusIndicator(ok);

    if (ok) {
        patchImageAdapter(gpu);
        patchVideoAdapter();

        // 定期ログ（デバッグ用、開発時のみ）
        if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
            setInterval(() => {
                if (gpu._stats.calls > 0) {
                    const s = gpu.getStats();
                    console.log(`[AoGPU] 処理回数:${s.calls} 平均:${s.avgMs}ms エラー:${s.errors}`);
                }
            }, 30000);
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

// グローバル公開（デバッグ・拡張用）
window.AoGPUAccelerator = AoGPUAccelerator;

})();
