'use strict';
/**
 * 序列推理引擎（CRNN V2 / ONNX）
 *
 * 模型：DucTai368/AI_sketch-recognition-v2（345 类 QuickDraw，~85% top-1）
 * 输入：[1, 128, 3] float32，每点 [dx, dy, pen]
 *   编码（用官方样本反推验证，84.7% 准确率）：
 *   1) 每笔先做 RDP 路径简化（关键！平板密集采样必须稀疏化到 QuickDraw 风格，
 *      否则模型 0% 命中；简化后恢复到 83.5%，与官方样本一致）
 *   2) 收集所有笔画点 (x, y)，笔画最后一点 pen=1（抬笔），其余 pen=0
 *   3) 坐标用 bounding box 的「统一 scale」(max(width,height)) 归一化到 [0,1]，保持宽高比
 *   4) 计算相邻点 delta：d[i]=p[i]-p[i-1]，首点 delta=0；pen 原样保留
 *   5) 超长取前 128 点，不足补零到 128
 * 输出：[1, 345] softmax
 *
 * 与栅格引擎（inference.js）并存，由 config.inference.engine 选择。
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

/**
 * Ramer-Douglas-Peucker 路径简化：把密集采样的折线压成稀疏关键点。
 * QuickDraw 官方简化笔画就是类似结果；模型只认这种稀疏输入。
 * @param {number[][]} pts [[x,y],...]
 * @param {number} eps 距离阈值（像素），越大简化越狠
 */
function rdp(pts, eps) {
  if (pts.length <= 2) return pts;
  const [x1, y1] = pts[0];
  const [x2, y2] = pts[pts.length - 1];
  const dx = x2 - x1, dy = y2 - y1;
  const denom = Math.hypot(dx, dy);
  let maxD = -1, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const px = pts[i][0], py = pts[i][1];
    let d;
    if (denom === 0) d = Math.hypot(px - x1, py - y1);
    else d = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / denom;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
  }
  return [pts[0], pts[pts.length - 1]];
}

class SequenceEngine {
  constructor(cfg, categories, log) {
    this.cfg = cfg;
    this.categories = categories;
    this.log = log || console.log;
    this.route = 'none';
    this.seqLength = Number(cfg.inference.seqLength) || 128;
    // RDP 简化阈值：相对包围盒尺寸的比例。0.01 验证可把密集采样恢复到官方识别率。
    this.simplifyEps = Number(cfg.inference.simplifyEps);
    if (!Number.isFinite(this.simplifyEps)) this.simplifyEps = 0.01;
    this.topK = Number(cfg.inference.topK) || 5;
    this.decoyMode = !!cfg.inference.decoyMode;
    this.decoyFactor = Number(cfg.inference.decoySuppressFactor) || 0.05;
    this.ort = null;
    this.session = null;
    this.inputName = '';
    this.outputName = '';
    this.labels = [];
    this.canonicalLabels = [];
    this.aliases = categories.aliases || {};
    this.byName = categories.byName || {};
    this.attempts = [];
  }

  _normalize(s) {
    return String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^the\s+/, '').replace(/\s+/g, ' ').trim();
  }
  _canon(en) {
    const n = this._normalize(en);
    const a = this.aliases[n];
    return a ? this._normalize(a) : n;
  }

  async init() {
    try {
      this.log('[序列推理] 加载 CRNN V2 ONNX 模型 ...');
      const modelPath = path.join(ROOT, this.cfg.inference.seqModelPath || 'model/seq/model.onnx');
      const labelPath = path.join(ROOT, this.cfg.inference.seqLabelsPath || 'model/seq/labels.json');
      if (!fs.existsSync(modelPath)) throw new Error('缺少 ' + modelPath);
      if (!fs.existsSync(labelPath)) throw new Error('缺少 ' + labelPath);

      const ort = require('onnxruntime-node');
      this.ort = ort;
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all'
      });
      this.session = session;
      this.inputName = this.cfg.inference.onnxInputName || session.inputNames[0];
      this.outputName = this.cfg.inference.onnxOutputName || session.outputNames[0];

      // 标签：labels.json 是 {"0":"name",...}，按索引转数组
      const raw = JSON.parse(fs.readFileSync(labelPath, 'utf8'));
      this.labels = Object.keys(raw).sort((a, b) => Number(a) - Number(b)).map(k => raw[k]);
      this.canonicalLabels = this.labels.map(en => this._canon(en));

      // 预热
      const warm = new ort.Tensor('float32', new Float32Array(this.seqLength * 3), [1, this.seqLength, 3]);
      await session.run({ [this.inputName]: warm });

      this.route = 'sequence';
      this.attempts.push({ route: 'sequence', ok: true, note: `CRNN V2 ONNX，${this.labels.length} 类` });
      this.log(`[序列推理] 成功：CRNN V2 ONNX（${this.labels.length} 类，输入 ${this.inputName}）`);
      return this.route;
    } catch (e) {
      const note = `失败：${e && e.message ? e.message : String(e)}`;
      this.attempts.push({ route: 'sequence', ok: false, note });
      this.log(`[序列推理] ${note}`);
      throw e;
    }
  }

  /**
   * 把平板上传的笔画序列编码成 [1, 128, 3] 的 ONNX Tensor。
   * strokes: [{ points: [[x,y],...] }, ...]  坐标是画布像素（任意分辨率）
   */
  encodeStrokes(strokes) {
    const n = this.seqLength;

    // 1) 先算整幅画的包围盒，得到统一 scale（用于 RDP 阈值与归一化）
    let lox = Infinity, loy = Infinity, hix = -Infinity, hiy = -Infinity;
    for (const s of (strokes || [])) {
      for (const p of (s.points || [])) {
        const x = Number(p[0]) || 0, y = Number(p[1]) || 0;
        if (x < lox) lox = x; if (x > hix) hix = x;
        if (y < loy) loy = y; if (y > hiy) hiy = y;
      }
    }
    if (!isFinite(lox)) return new this.ort.Tensor('float32', new Float32Array(n * 3), [1, n, 3]);
    const scale = Math.max(hix - lox, hiy - loy) || 1;

    // 2) 每条笔画做 RDP 简化（关键）：平板密集采样 -> QuickDraw 风格稀疏点
    //    eps 按包围盒等比缩放，与画布分辨率无关
    const eps = this.simplifyEps * scale;
    const pts = [];
    for (const s of (strokes || [])) {
      const raw = (s.points || []).map(p => [Number(p[0]) || 0, Number(p[1]) || 0]);
      if (raw.length < 2) {
        if (raw.length === 1) pts.push([raw[0][0], raw[0][1], 1]);
        continue;
      }
      const simp = rdp(raw, eps);
      for (let i = 0; i < simp.length; i++) {
        pts.push([simp[i][0], simp[i][1], i === simp.length - 1 ? 1 : 0]);
      }
    }
    if (!pts.length) return new this.ort.Tensor('float32', new Float32Array(n * 3), [1, n, 3]);

    // 3) bounding box 统一 scale 归一化到 [0,1]
    const norm = pts.map(p => [(p[0] - lox) / scale, (p[1] - loy) / scale, p[2]]);

    // 4) delta
    const data = new Float32Array(n * 3);
    const count = Math.min(n, norm.length);
    for (let i = 0; i < count; i++) {
      const base = i * 3;
      if (i === 0) {
        data[base] = 0; data[base + 1] = 0;
      } else {
        data[base] = norm[i][0] - norm[i - 1][0];
        data[base + 1] = norm[i][1] - norm[i - 1][1];
      }
      data[base + 2] = norm[i][2];
    }
    // 5) 不足补零（Float32Array 已初始化为 0）
    return new this.ort.Tensor('float32', data, [1, n, 3]);
  }

  indexOfClass(en) {
    const target = this._canon(en);
    let i = this.canonicalLabels.indexOf(target);
    if (i >= 0) return i;
    i = (this.categories.indexFallback || []).findIndex(x => this._canon(x) === target);
    return i;
  }

  zhFor(index) {
    const raw = this.labels[index];
    if (!raw) return `类别${index}`;
    const canon = this.canonicalLabels[index];
    return this.byName[canon] || this.byName[this._normalize(raw)] || this.byName[raw] || raw;
  }

  labelsForApi() {
    return this.labels.map((en, index) => ({ index, en, zh: this.zhFor(index) }));
  }

  _topK(scores, suppressIndex) {
    if (!scores || !scores.length) return [];
    if (this.decoyMode && suppressIndex >= 0 && suppressIndex < scores.length) {
      scores[suppressIndex] *= this.decoyFactor;
    }
    const idx = Array.from(scores.keys()).sort((a, b) => scores[b] - scores[a]);
    return idx.slice(0, this.topK).map(i => ({
      index: i,
      en: this.labels[i] || `class_${i}`,
      zh: this.zhFor(i),
      score: Math.max(0, Math.min(1, Number(scores[i]) || 0))
    }));
  }

  /** strokes -> { scores, top5 } */
  async infer(strokes, opts = {}) {
    const tensor = this.encodeStrokes(strokes);
    const out = await this.session.run({ [this.inputName]: tensor });
    const scores = Float32Array.from(out[this.outputName].data);
    return { scores, top5: this._topK(scores, opts.suppressIndex) };
  }
}

module.exports = { SequenceEngine };
