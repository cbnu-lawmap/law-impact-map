/*
 * 직접 학습한 Keras Dense 모델을 서버에서 그대로 계산하기 (TensorFlow 없이)
 *
 * 노트북(notebooks/*.ipynb)이 학습을 마치면 web/data/models/<이름>.json 으로 내보낸다. 형식:
 * {
 *   "name": "field_classifier",
 *   "input": { "type": "tfidf_char_wb", "ngram": [2, 3], "lowercase": true, "sublinear_tf": true, "norm": "l2",
 *              "vocab": { "글자묶음": 열번호, ... }, "idf": [ ... ] }      // 글 → 숫자 (sklearn TfidfVectorizer 와 같은 계산)
 *          또는 { "type": "dense", "features": ["이름", ...], "mean": [...], "scale": [...] }   // 표준화한 숫자 특징
 *   "layers": [ { "units": 128, "activation": "relu", "W": "<base64 float32, 행=입력 열=출력>", "b": [ ... ] }, ... ],
 *   "labels": [ "1", "2", ... ],            // 출력 자리마다 이름
 *   "metrics": { ... }                       // 노트북 결과표 숫자 (화면·에이전트가 그대로 보여 줌)
 * }
 */

function decodeMatrix(b64, rows, cols) {
  const buf = Buffer.from(b64, "base64");
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (f.length !== rows * cols) throw new Error("가중치 크기가 맞지 않습니다: " + f.length + " ≠ " + rows + "×" + cols);
  return f;
}

/** sklearn TfidfVectorizer(analyzer="char_wb") 와 같은 방식으로 글 → 희소 벡터 {열: 값} */
function tfidfCharWb(text, spec) {
  let t = String(text || "");
  if (spec.lowercase !== false) t = t.toLowerCase();
  const counts = new Map();
  const [lo, hi] = spec.ngram;
  // char_wb: 공백으로 나눈 낱말마다 앞뒤에 공백 한 칸을 붙이고 그 안에서만 n-gram 을 만든다
  t.split(/\s+/).filter(Boolean).forEach((w) => {
    const pw = " " + w + " ";
    for (let n = lo; n <= hi; n++) {
      if (pw.length < n) break;
      for (let i = 0; i + n <= pw.length; i++) {
        const g = pw.slice(i, i + n);
        const col = spec.vocab[g];
        if (col !== undefined) counts.set(col, (counts.get(col) || 0) + 1);
      }
      if (n >= pw.length) break;
    }
  });
  const v = new Map();
  let ss = 0;
  counts.forEach((c, col) => {
    const tf = spec.sublinear_tf ? 1 + Math.log(c) : c;
    const x = tf * spec.idf[col];
    v.set(col, x);
    ss += x * x;
  });
  if (spec.norm === "l2" && ss > 0) {
    const n = Math.sqrt(ss);
    v.forEach((x, col) => v.set(col, x / n));
  }
  return v;
}

function act(name, z) {
  if (name === "relu") return z.map((x) => (x > 0 ? x : 0));
  if (name === "sigmoid") return z.map((x) => 1 / (1 + Math.exp(-x)));
  if (name === "softmax") {
    const m = Math.max(...z);
    const e = z.map((x) => Math.exp(x - m));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / s);
  }
  return z; // linear
}

/** 모델 JSON 을 읽어 predict(입력) → 출력 확률 배열 을 만든다 */
function loadModel(json) {
  let inDim = json.input.type === "tfidf_char_wb" ? json.input.idf.length : json.input.features.length;
  const layers = json.layers.map((L) => {
    const W = decodeMatrix(L.W, inDim, L.units);
    const layer = { W, b: L.b, inDim, units: L.units, activation: L.activation };
    inDim = L.units;
    return layer;
  });

  function forwardSparse(first, sparse) {
    const z = first.b.slice();
    sparse.forEach((x, i) => {
      const row = i * first.units;
      for (let j = 0; j < first.units; j++) z[j] += x * first.W[row + j];
    });
    return act(first.activation, z);
  }
  function forwardDense(L, x) {
    const z = L.b.slice();
    for (let i = 0; i < L.inDim; i++) {
      const xi = x[i];
      if (!xi) continue;
      const row = i * L.units;
      for (let j = 0; j < L.units; j++) z[j] += xi * L.W[row + j];
    }
    return act(L.activation, z);
  }

  function features(input) {
    if (json.input.type === "tfidf_char_wb") return tfidfCharWb(input, json.input);
    // 숫자 특징: { 이름: 값 } → 표준화한 배열 (없는 값은 평균 = 0)
    const f = json.input.features.map((name, i) => {
      const v = input[name];
      if (v === undefined || v === null || Number.isNaN(Number(v))) return 0;
      return (Number(v) - json.input.mean[i]) / (json.input.scale[i] || 1);
    });
    return f;
  }

  return {
    name: json.name,
    labels: json.labels,
    metrics: json.metrics || {},
    predict(input) {
      const x = features(input);
      let h = x instanceof Map ? forwardSparse(layers[0], x) : forwardDense(layers[0], x);
      for (let k = 1; k < layers.length; k++) h = forwardDense(layers[k], h);
      return h;
    },
  };
}

module.exports = { loadModel, tfidfCharWb, decodeMatrix };
