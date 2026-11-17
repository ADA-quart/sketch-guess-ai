'use strict';
/**
 * 科普探针：用多输出 ONNX 模型（model-scope.onnx）抓取一次真实前向的各层激活，
 * 压缩成前端可绘制的热图数据。与对战引擎共用同一套 stroke 编码算法，
 * 因此对同一笔画，本模块抓到的 logits 与对战大屏的结果逐位一致。
 *
 * 输出给前端的每层结构：
 *   { key, name, kind, shape, grid, gridW, gridH, min, max, mean, act }
 *   - kind: 'sequence' 时间×通道序列热图 / 'attention' 注意力矩阵 / 'vector' 向量条
 *   - grid: 降采样到 gridW×gridH 的一维数组（行优先），值已归一化到 0..1
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

// 层的展示元信息（教学叙事顺序）—— key 对应 make_scope_model.py 里的输出名
const LAYER_META = [
  { key: 'input',        name: '输入编码',     sub: '把你的画变成 [dx,dy,抬笔] 序列', kind: 'sequence' },
  { key: 'cnn_multiscale', name: '多尺度卷积',   sub: '3 种宽度的卷积同时看笔画的局部形状', kind: 'sequence' },
  { key: 'se_channel1',  name: 'SE 通道注意力', sub: '网络自己判断哪些特征通道更重要', kind: 'sequence' },
  { key: 'cnn_deep',     name: '深层卷积',     sub: '更粗的卷积核，提取更抽象的结构', kind: 'sequence' },
  { key: 'bilstm1',      name: '双向 LSTM ①',  sub: '按顺序读笔画，记住「画到这里之前发生了什么」', kind: 'sequence' },
  { key: 'bilstm2',      name: '双向 LSTM ②',  sub: '再读一遍，理解更长的笔画依赖', kind: 'sequence' },
  { key: 'mha_attention',name: '多头自注意力',  sub: '让不同时刻的笔画互相「对照」', kind: 'attention' },
  { key: 'mha_out',      name: '注意力输出',   sub: '融合全局信息后的序列表示', kind: 'sequence' },
  { key: 'pool_fuse',    name: '池化汇总',     sub: '把整幅画压成一个 1024 维的「印象」', kind: 'vector' },
  { key: 'logits',       name: '分类头',       sub: '输出 345 个类别的分数', kind: 'vector' },
  { key: 'probs',        name: '最终答案',     sub: 'softmax 变成 345 类概率', kind: 'vector' }
];

// 输出名映射（和 make_scope_model.py 一致）
const OUTPUT_KEYS = {
  input: 'input_layer',
  cnn_multiscale: 'functional_1/concatenate_1/concat:0',
  se_channel1: 'functional_1/multiply_1/Mul:0',
  cnn_deep: 'functional_1/multiply_1_2/Mul:0',
  bilstm1: 'functional_1/bidirectional_1/concat:0',
  bilstm2: 'functional_1/bidirectional_1_2/concat:0',
  mha_out: 'functional_1/add_1/Add:0',
  mha_attention: 'functional_1/multi_head_attention_1/softmax_1/Softmax:0',
  pool_fuse: 'functional_1/concatenate_2_1/concat:0',
  logits: 'functional_1/dense_6_1/BiasAdd:0',
  probs: 'dense_6'
};

class Probe {
  constructor(engine, cfg, log) {
    this.engine = engine;       // 复用对战引擎的 encodeStrokes / labels / zhFor
    this.cfg = cfg;
    this.log = log || console.log;
    this.session = null;
    this.ready = false;
    this.meta = LAYER_META;
  }

  async init() {
    const modelPath = path.join(ROOT, 'model/seq/model-scope.onnx');
    if (!fs.existsSync(modelPath)) {
      this.log('[科普探针] 缺少 model-scope.onnx，科普页不可用（对战不受影响）');
      return false;
    }
    try {
      const ort = require('onnxruntime-node');
      this.session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'], graphOptimizationLevel: 'all'
      });
      // 确认关键输出都在
      const have = new Set(this.session.outputNames);
      for (const k of Object.keys(OUTPUT_KEYS)) {
        if (!have.has(OUTPUT_KEYS[k])) {
          this.log(`[科普探针] 输出缺失 ${k}，科普及可用性下降`);
        }
      }
      this.ready = true;
      this.log('[科普探针] 就绪：多输出模型 ' + this.session.outputNames.length + ' 个张量');
      return true;
    } catch (e) {
      this.log('[科普探针] 加载失败：' + e.message);
      return false;
    }
  }

  // 把张量压缩成 gridW×gridH 的归一化热图（取绝对值，突出激活强度）
  _toGrid(tensor, gw, gh) {
    const dims = tensor.dims;
    const data = tensor.data;
    const total = data.length;

    // attention 是 [1,8,32,32]：取 8 个头的平均 -> [32,32]
    if (dims.length === 4 && dims[1] === 8 && dims[2] === 32 && dims[3] === 32) {
      const N = 32, grid = new Array(N * N).fill(0);
      for (let h = 0; h < 8; h++) for (let i = 0; i < N * N; i++) {
        grid[i] += Math.abs(data[h * N * N + i]) / 8;
      }
      return this._normalizeGrid(grid, N, N);
    }

    // 序列热图 [B, C, T] 或 [B, T, C]：统一成 (通道 × 时间)
    if (dims.length === 3) {
      let C, T, get;
      const [b, d1, d2] = dims;
      // 已知层里 cnn_multiscale=[1,192,128], cnn_deep=[1,64,384], se=[1,128,192]...
      // 用「时间轴通常是 128 或 32/64，通道轴是 64/128/192/384/512」来判别
      const timeLike = v => (v === 128 || v === 64 || v === 32);
      if (timeLike(d2) && !timeLike(d1)) { C = d1; T = d2; get = (c,t)=>data[c*T+t]; }
      else if (timeLike(d1) && !timeLike(d2)) { C = d2; T = d1; get = (c,t)=>data[t*C+c]; }
      else { C = d1; T = d2; get = (c,t)=>data[c*T+t]; }
      // 通道极少（如输入层 dx/dy/pen 只有 3 个）时按真实通道数渲染，避免大片空行
      const ghEff = C < gh ? C : gh;
      // 降采样到 gw×ghEff（通道轴->行，时间轴->列）
      const grid = new Array(gw * ghEff).fill(0);
      for (let gy = 0; gy < ghEff; gy++) {
        const c0 = Math.floor(gy * C / ghEff), c1 = Math.max(c0 + 1, Math.floor((gy + 1) * C / ghEff));
        for (let gx = 0; gx < gw; gx++) {
          const t0 = Math.floor(gx * T / gw), t1 = Math.max(t0 + 1, Math.floor((gx + 1) * T / gw));
          let s = 0, n = 0;
          for (let c = c0; c < c1; c++) for (let t = t0; t < t1; t++) { s += Math.abs(get(c, t)); n++; }
          grid[gy * gw + gx] = n ? s / n : 0;
        }
      }
      return this._normalizeGrid(grid, gw, ghEff);
    }

    // 向量 [B, N] ：画成 1 行
    if (dims.length === 2) {
      const N = dims[1];
      const grid = new Array(N);
      for (let i = 0; i < N; i++) grid[i] = Math.abs(data[i]);
      return this._normalizeGrid(grid, N, 1);
    }
    return this._normalizeGrid([0], 1, 1);
  }

  _normalizeGrid(grid, w, h) {
    let mn = Infinity, mx = -Infinity, sum = 0;
    for (const v of grid) { if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
    const mean = grid.length ? sum / grid.length : 0;
    const range = (mx - mn) || 1;
    const norm = grid.map(v => (v - mn) / range);
    return { grid: norm, gridW: w, gridH: h, min: mn, max: mx, mean };
  }

  /**
   * 对 strokes 跑一次前向，返回各层热图 + 概率 + 笔画。
   * 复用对战引擎的 encodeStrokes，保证与对战结果一致。
   */
  async probe(strokes) {
    if (!this.ready) return null;
    const tensor = this.engine.encodeStrokes(strokes);
    const out = await this.session.run({ [this.engine.inputName]: tensor });

    const layers = [];
    for (const meta of this.meta) {
      const outName = OUTPUT_KEYS[meta.key];
      const t = out[outName];
      if (!t) continue;
      const gw = meta.kind === 'attention' ? 32 : 48;
      const gh = meta.kind === 'attention' ? 32 : 20;
      const g = this._toGrid(t, gw, gh);
      layers.push({
        key: meta.key, name: meta.name, sub: meta.sub, kind: meta.kind,
        shape: t.dims, grid: g.grid, gridW: g.gridW, gridH: g.gridH,
        min: g.min, max: g.max, mean: g.mean
      });
    }

    // 345 类概率 top10（中文）
    const probs = out['dense_6'];
    let top10 = [];
    if (probs) {
      const arr = Array.from(probs.data);
      top10 = arr.map((v, i) => ({ i, v, zh: this.engine.zhFor(i), en: this.engine.labels[i] }))
        .sort((a, b) => b.v - a.v).slice(0, 10)
        .map(x => ({ ...x, v: +x.v.toFixed(5) }));
    }
    return { layers, top10 };
  }
}

module.exports = { Probe, LAYER_META };
