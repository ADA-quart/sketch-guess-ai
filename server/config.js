'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readJson(rel, fallback) {
  const file = path.join(ROOT, rel);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`[config] 读取 ${rel} 失败，使用内置默认值：${e.message}`);
    return fallback;
  }
}

const DEFAULT = {
  server: { host: '0.0.0.0', port: 3000, publicBaseUrl: '' },
  round: {
    seconds: 70, minSeconds: 60, maxSeconds: 75,
    lockThreshold: 0.72, lockStableFrames: 4, lockHoldMs: 1400,
    lockGraceMs: 8000, lockMinStrokes: 1, lockMinPoints: 8,
    scoringMode: 'fair', judgeTimeoutMs: 45000
  },
  inference: {
    engine: 'sequence',
    intervalMs: 400, topK: 5, inputSize: 28, dilateRadius: 5,
    decoyMode: false, decoySuppressFactor: 0.05,
    onnxInputName: '', onnxOutputName: '', onnxInputLayout: 'NCHW',
    seqModelPath: 'model/seq/model.onnx',
    seqLabelsPath: 'model/seq/labels.json',
    seqLength: 128,
    simplifyEps: 0.01
  },
  tablet: { canvasSize: 256, brushRadius: 2, brushMin: 1, brushMax: 8, thumbSize: 72 },
  display: { title: 'AI 猜画大挑战', subtitle: '平板作画 · AI 实时竞猜' }
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

const config = deepMerge(DEFAULT, readJson('config/config.json', {}));
config.round.seconds = Math.min(config.round.maxSeconds, Math.max(config.round.minSeconds, Number(config.round.seconds) || 70));

const categories = readJson('config/categories.zh.json', { byName: {}, indexFallback: [] });
const words = readJson('config/words.json', []);

module.exports = { ROOT, config, categories, words };
