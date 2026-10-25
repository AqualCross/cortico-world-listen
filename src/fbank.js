/**
 * Kaldi 兼容的 fbank（16k、25ms/10ms、80 维、snip_edges）+ CMVN。
 *
 * 只实现 FireRed VAD 需要的那一份：去直流、预加重 0.97、povey 窗、取功率谱、
 * mel 三角滤波、取自然对数。参数与 kaldi_native_fbank 的默认值对齐，帧数与
 * `1 + (样本数 - 400) / 160` 一致。
 */

const FRAME_SAMPLES = 400;
const FRAME_SHIFT = 160;
const FFT_SIZE = 512;
const LOG_FLOOR = 1.19209290e-07;

const melOf = (hz) => 1127 * Math.log(1 + hz / 700);
const invMel = (mel) => 700 * (Math.exp(mel / 1127) - 1);

/** 原地 radix-2 FFT（长度必须是 2 的幂）。 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let j = 0; j < len / 2; j += 1) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** 解析 kaldi 的双精度矩阵（cmvn.ark）；只认我们下载的这一个来源。 */
export function parseCmvnMatrix(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  if (bytes.length < 24 || bytes.toString('latin1', 0, 4) !== '\0BDM') {
    throw new Error('cmvn.ark 不是 kaldi 的双精度矩阵');
  }
  // kaldiio 写入时每个维度前有一个长度字节（4）；也兼容没有它的写法。
  const layouts = [
    { rowsAt: 6, colsAt: 11, dataAt: 15 },
    { rowsAt: 5, colsAt: 9, dataAt: 13 },
  ];
  for (const layout of layouts) {
    const rows = bytes.readInt32LE(layout.rowsAt);
    const cols = bytes.readInt32LE(layout.colsAt);
    if (rows > 0 && rows <= 16 && cols > 1 && cols <= 4096
      && layout.dataAt + rows * cols * 8 === bytes.length) {
      const values = new Float64Array(rows * cols);
      for (let i = 0; i < values.length; i += 1) values[i] = bytes.readDoubleLE(layout.dataAt + i * 8);
      return { rows, cols, values };
    }
  }
  throw new Error('cmvn.ark 的尺寸与文件长度对不上');
}

/** cmvn.ark → 每维的均值与 1/标准差。 */
export function cmvnFromMatrix(matrix) {
  const { rows, cols, values } = matrix;
  if (rows < 2 || cols < 2) throw new Error('cmvn.ark 至少要有两行统计量');
  const dim = cols - 1;
  const count = values[dim];
  if (!(count >= 1)) throw new Error('cmvn.ark 的帧数不合法');
  const means = new Float64Array(dim);
  const istd = new Float64Array(dim);
  for (let d = 0; d < dim; d += 1) {
    const mean = values[d] / count;
    const variance = Math.max(values[cols + d] / count - mean * mean, 1e-20);
    means[d] = mean;
    istd[d] = 1 / Math.sqrt(variance);
  }
  return { dim, means, istd };
}

/**
 * 流式 fbank。`accept()` 追加 16k PCM16 样本，返回新产生的帧（每帧 80 个 float）。
 */
export class KaldiFbank {
  #tail = new Int16Array(0);
  #tailStart = 0;
  #frames = 0;
  #window;
  #mel;

  constructor({ sampleRate = 16000, numBins = 80, lowFreq = 20, highFreq = 0 } = {}) {
    if (sampleRate !== 16000) throw new Error('fbank 只支持 16 kHz');
    this.numBins = numBins;
    this.#window = new Float64Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      this.#window[i] = (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SAMPLES - 1))) ** 0.85;
    }
    this.#mel = this.#buildMel(numBins, lowFreq, highFreq || sampleRate / 2, sampleRate);
  }

  get frameCount() {
    return this.#frames;
  }

  #buildMel(numBins, lowFreq, highFreq, sampleRate) {
    const melLow = melOf(lowFreq);
    const melHigh = melOf(highFreq);
    const spacing = (melHigh - melLow) / (numBins + 1);
    const binWidth = sampleRate / FFT_SIZE;
    const bins = [];
    for (let i = 0; i < numBins; i += 1) {
      const left = melLow + i * spacing;
      const center = melLow + (i + 1) * spacing;
      const right = melLow + (i + 2) * spacing;
      const weights = new Float64Array(FFT_SIZE / 2 + 1);
      for (let k = 0; k <= FFT_SIZE / 2; k += 1) {
        const mel = melOf(k * binWidth);
        if (mel > left && mel < right) {
          weights[k] = mel <= center
            ? (mel - left) / (center - left)
            : (right - mel) / (right - center);
        }
      }
      bins.push(weights);
    }
    return bins;
  }

  reset() {
    this.#tail = new Int16Array(0);
    this.#tailStart = 0;
    this.#frames = 0;
  }

  /** @param {Int16Array} samples */
  accept(samples) {
    if (!samples || !samples.length) return [];
    const merged = new Int16Array(this.#tail.length + samples.length);
    merged.set(this.#tail, 0);
    merged.set(samples, this.#tail.length);
    this.#tail = merged;

    const out = [];
    while (this.#tailStart + this.#tail.length >= this.#frames * FRAME_SHIFT + FRAME_SAMPLES) {
      const at = this.#frames * FRAME_SHIFT - this.#tailStart;
      out.push(this.#frame(this.#tail.subarray(at, at + FRAME_SAMPLES)));
      this.#frames += 1;
    }
    const keepFrom = this.#frames * FRAME_SHIFT - this.#tailStart;
    if (keepFrom > 0) {
      this.#tail = this.#tail.slice(keepFrom);
      this.#tailStart += keepFrom;
    }
    return out;
  }

  #frame(samples) {
    const x = new Float64Array(FRAME_SAMPLES);
    let mean = 0;
    for (let i = 0; i < FRAME_SAMPLES; i += 1) mean += samples[i];
    mean /= FRAME_SAMPLES;
    for (let i = 0; i < FRAME_SAMPLES; i += 1) x[i] = samples[i] - mean;
    for (let i = FRAME_SAMPLES - 1; i > 0; i -= 1) x[i] -= 0.97 * x[i - 1];
    x[0] -= 0.97 * x[0];

    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) re[i] = x[i] * this.#window[i];
    fft(re, im);

    const power = new Float64Array(FFT_SIZE / 2 + 1);
    for (let k = 0; k <= FFT_SIZE / 2; k += 1) power[k] = re[k] * re[k] + im[k] * im[k];

    const feat = new Float32Array(this.numBins);
    for (let b = 0; b < this.numBins; b += 1) {
      const weights = this.#mel[b];
      let sum = 0;
      for (let k = 0; k < weights.length; k += 1) sum += power[k] * weights[k];
      feat[b] = Math.log(Math.max(sum, LOG_FLOOR));
    }
    return feat;
  }
}

/** 对一帧做 CMVN（原地或返回新数组）。 */
export function applyCmvn(feat, cmvn, out = new Float32Array(feat.length)) {
  for (let i = 0; i < feat.length; i += 1) {
    out[i] = (feat[i] - cmvn.means[i]) * cmvn.istd[i];
  }
  return out;
}
