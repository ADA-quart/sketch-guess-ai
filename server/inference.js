'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { ROOT } = require('./config');

/**
 * 膨胀（dilate）灰度笔画：白底黑线，取每个像素邻域内的最小值（最黑），
 * 让细线在源分辨率上变粗。这样用户在平板上用细笔刷（视觉好看）作画后，
 * 送进 DoodleNet 前能补到 QuickDraw 训练时的笔画宽度。
 * radius 是源像素半径，采用方形结构元（sepia：水平+垂直两遍 min filter）。
 */
function dilateGray(src, srcSize, radius) {
  if (!radius || radius < 1) return src;
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  // 水平方向 min filter
  for (let y = 0; y < srcSize; y++) {
    const row = y * srcSize;
    for (let x = 0; x < srcSize; x++) {
      let m = 255;
      const a = Math.max(0, x - radius), b = Math.min(srcSize - 1, x + radius);
      for (let xx = a; xx <= b; xx++) if (src[row + xx] < m) m = src[row + xx];
      tmp[row + x] = m;
    }
  }
  // 垂直方向 min filter
  for (let y = 0; y < srcSize; y++) {
    const a = Math.max(0, y - radius), b = Math.min(srcSize - 1, y + radius);
    for (let x = 0; x < srcSize; x++) {
      let m = 255;
      for (let yy = a; yy <= b; yy++) if (tmp[yy * srcSize + x] < m) m = tmp[yy * srcSize + x];
      out[y * srcSize + x] = m;
    }
  }
  return out;
}

/**
 * 把灰度图（0-255，白底黑线）下采样并反转成「笔画=1、背景=0」的 float32。
 * dilateRadius（源像素）默认 5：在 256 源图上把细线补到约 10px 宽，
 * 实测能把细笔刷涂鸦的 DoodleNet 识别率从"全部认成雨"提升到多数正确。
 * 用 opts.dilateRadius = 0 可关闭（对照实验用）。
 */
function resampleGray(src, srcSize, dstSize, opts = {}) {
  const dr = opts.dilateRadius === undefined ? 5 : opts.dilateRadius;
  // 膨胀半径按源图尺寸等比缩放，保证 160 和 256 输入表现一致
  const radius = Math.round(dr * (srcSize / 256));
  const work = dilateGray(src, srcSize, radius);
  const scale = srcSize / dstSize;
  const out = new Float32Array(dstSize * dstSize);
  for (let y = 0; y < dstSize; y++) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.min(srcSize, Math.ceil((y + 1) * scale));
    for (let x = 0; x < dstSize; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(srcSize, Math.ceil((x + 1) * scale));
      let sum = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * srcSize;
        for (let xx = x0; xx < x1; xx++) {
          sum += work[row + xx];
          n++;
        }
      }
      out[y * dstSize + x] = 1 - (n ? sum / n : 255) / 255;
    }
  }
  return out;
}

function loadLabels(categories) {
  const labelFile = path.join(ROOT, 'model', 'labels.txt');
  try {
    if (fs.existsSync(labelFile)) {
      const labels = fs.readFileSync(labelFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (labels.length) return labels;
    }
  } catch (e) {
    console.warn(`[model] 读取 labels.txt 失败：${e.message}`);
  }
  return (categories.indexFallback || []).slice();
}

// 模型标签可能是下划线命名（alarm_clock），也可能与词库用词不同（motorbike / motorcycle）。
// 统一归一化后再做中文映射和判分，避免"显示对了但判错"。
function normalizeLabel(s) {
  return String(s || '').toLowerCase().replace(/_/g, ' ').replace(/^the\s+/, '').replace(/\s+/g, ' ').trim();
}

class InferenceEngine {
  constructor(cfg, categories, log) {
    this.cfg = cfg;
    this.categories = categories;
    this.log = log || console.log;
    this.route = 'none';
    this.attempts = [];
    this.labels = loadLabels(categories);
    this.aliases = categories.aliases || {};
    this._canon = en => {
      const n = normalizeLabel(en);
      const a = this.aliases[n];
      return a ? normalizeLabel(a) : n;
    };
    this.canonicalLabels = this.labels.map(en => this._canon(en));
    this.size = Number(cfg.inference.inputSize) || 28;
    this.topK = Number(cfg.inference.topK) || 5;
    this.decoyMode = !!cfg.inference.decoyMode;
    this.decoyFactor = Number(cfg.inference.decoySuppressFactor) || 0.05;
    this.model = null;
    this.tf = null;
    this.ort = null;
    this.session = null;
    this.inputName = '';
    this.outputName = '';
  }

  async init() {
    // ---------- 路线 ①：@tensorflow/tfjs-node + file:// DoodleNet ----------
    try {
      this.log('[推理①] 尝试加载 @tensorflow/tfjs-node ...');
      const tf = require('@tensorflow/tfjs-node');
      this.tf = tf;
      let model;
      try {
        // 优先字面量形式，与需求中的 tf.loadLayersModel('file://model/model.json') 一致
        model = await tf.loadLayersModel('file://model/model.json');
      } catch (e1) {
        this.log(`[推理①] 相对 file:// 失败（${e1.message}），改用绝对路径 file URL`);
        const abs = path.join(ROOT, 'model', 'model.json');
        if (!fs.existsSync(abs)) throw new Error('缺少 model/model.json');
        model = await tf.loadLayersModel(pathToFileURL(abs).href);
      }
      this.model = model;
      // 预热：把首次 JIT / 内核选择开销放在启动阶段
      const warm = new Float32Array(this.size * this.size);
      const t = tf.tensor4d(warm, [1, this.size, this.size, 1]);
      let pred = null;
      try {
        pred = model.predict(t);
        await pred.data();
      } finally {
        t.dispose();
        if (pred) pred.dispose();
      }
      this.route = 'tfjs-node';
      this.attempts.push({ route: 'tfjs-node', ok: true, note: '已加载本地 DoodleNet (Keras TFJS)' });
      this.log(`[推理①] 成功：tfjs-node，输入尺寸 ${this.size}×${this.size}`);
      return this.route;
    } catch (e) {
      const note = `失败：${e && e.message ? e.message : String(e)}`;
      this.attempts.push({ route: 'tfjs-node', ok: false, note });
      this.log(`[推理①] ${note}，降级到 ②`);
    }

    // ---------- 路线 ②：onnxruntime-node + TFLite→ONNX 345 类 ----------
    try {
      this.log('[推理②] 尝试加载 onnxruntime-node ...');
      const ort = require('onnxruntime-node');
      const modelPath = path.join(ROOT, 'model', 'model.onnx');
      if (!fs.existsSync(modelPath)) throw new Error('缺少 model/model.onnx');
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all'
      });
      this.ort = ort;
      this.session = session;
      this.inputName = this.cfg.inference.onnxInputName || session.inputNames[0];
      this.outputName = this.cfg.inference.onnxOutputName || session.outputNames[0];
      const dims = this._onnxDims();
      const warm = new this.ort.Tensor('float32', new Float32Array(this.size * this.size), dims);
      await session.run({ [this.inputName]: warm });
      this.route = 'onnx';
      this.attempts.push({ route: 'onnxruntime-node', ok: true, note: '已加载 TFLite→ONNX 345 类模型' });
      this.log(`[推理②] 成功：onnxruntime-node，输入 ${this.inputName} ${JSON.stringify(dims)}，输出 ${this.outputName}`);
      return this.route;
    } catch (e) {
      const note = `失败：${e && e.message ? e.message : String(e)}`;
      this.attempts.push({ route: 'onnxruntime-node', ok: false, note });
      this.log(`[推理②] ${note}，降级到 ③`);
    }

    // ---------- 路线 ③：平板端 TensorFlow.js，后端只转发 ----------
    this.route = 'browser';
    this.attempts.push({ route: 'browser', ok: true, note: '后端不推理；平板加载 /model/model.json 并上报 Top-5' });
    this.log('[推理③] 启用浏览器端推理转发模式。若平板也加载失败，将显示录屏 + 人工裁判提示。');
    return this.route;
  }

  _onnxDims() {
    return this.cfg.inference.onnxInputLayout === 'NHWC'
      ? [1, this.size, this.size, 1]
      : [1, 1, this.size, this.size];
  }

  indexOfClass(en) {
    const target = this._canon(en);
    let i = this.canonicalLabels.indexOf(target);
    if (i >= 0) return i;
    i = this.labels.indexOf(en);
    if (i >= 0) return i;
    i = (this.categories.indexFallback || []).findIndex(x => this._canon(x) === target);
    return i;
  }

  zhFor(index) {
    const raw = this.labels[index];
    if (!raw) return `类别${index}`;
    const canon = this.canonicalLabels[index];
    const byName = this.categories.byName || {};
    // 依次尝试：规范化别名 → 规范化原名 → 原始名；末级兜底仍是原名。
    return byName[canon] || byName[normalizeLabel(raw)] || byName[raw] || raw;
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

  /** gray: Uint8Array(srcSize*srcSize)，白底黑线。返回 { scores, top5 } */
  async infer(gray, opts = {}) {
    const floatData = resampleGray(gray, opts.srcSize || 160, this.size, {
      dilateRadius: this.cfg.inference.dilateRadius === undefined ? 5 : this.cfg.inference.dilateRadius
    });
    let scores;

    if (this.route === 'tfjs-node') {
      const t = this.tf.tensor4d(floatData, [1, this.size, this.size, 1]);
      let pred = null;
      try {
        pred = this.model.predict(t);
        scores = Float32Array.from(await pred.data());
      } finally {
        // 每帧强制释放临时张量，避免 2 小时运行后显存/内存持续增长
        t.dispose();
        if (pred) pred.dispose();
      }
    } else if (this.route === 'onnx') {
      const tensor = new this.ort.Tensor('float32', floatData, this._onnxDims());
      const out = await this.session.run({ [this.inputName]: tensor });
      scores = Float32Array.from(out[this.outputName].data);
    } else {
      throw new Error('当前为浏览器推理路线，服务端不执行 infer()');
    }

    return { scores, top5: this._topK(scores, opts.suppressIndex) };
  }
}

module.exports = { InferenceEngine, resampleGray };
