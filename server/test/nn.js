/*
 * lib/nn.js 시험: 손으로 만든 작은 모델로 계산이 맞는지, 그리고 노트북이 내보낸 모델이 있으면
 * 노트북이 함께 저장한 기준 예측(check)과 서버 계산이 같은지 본다.
 *   node test/nn.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadModel, tfidfCharWb } = require("../lib/nn");

const b64 = (arr) => Buffer.from(new Float32Array(arr).buffer).toString("base64");
let fail = 0;
function test(name, fn) {
  try { fn(); console.log("통과  " + name); } catch (e) { fail++; console.log("실패  " + name + "\n      " + e.message); }
}

test("숫자 특징 Dense: 표준화 → relu → softmax 손계산과 같음", () => {
  const m = loadModel({
    name: "t", labels: ["a", "b"],
    input: { type: "dense", features: ["x", "y"], mean: [1, 0], scale: [2, 1] },
    layers: [
      { units: 2, activation: "relu", W: b64([1, 0, 0, 1]), b: [0, 0] },
      { units: 2, activation: "softmax", W: b64([1, -1, 0, 0]), b: [0, 0] },
    ],
  });
  const p = m.predict({ x: 3, y: -5 }); // 표준화 (1, -5) → relu (1, 0) → (1, -1) → softmax
  const e1 = Math.exp(1), e2 = Math.exp(-1);
  assert.ok(Math.abs(p[0] - e1 / (e1 + e2)) < 1e-6 && Math.abs(p[1] - e2 / (e1 + e2)) < 1e-6, JSON.stringify(p));
});

test("char_wb TF-IDF: 낱말 앞뒤 공백, 2~3글자, sublinear, l2", () => {
  const spec = { ngram: [2, 3], lowercase: true, sublinear_tf: true, norm: "l2", vocab: { " 소": 0, "소방": 1, "방 ": 2, "소방 ": 3, "없음": 4 }, idf: [1, 2, 1, 1, 5] };
  const v = tfidfCharWb("소방 소방", spec); // " 소방 " 두 번: " 소"×2, "소방"×2, "방 "×2, " 소방"(없음), "소방 "×2
  const raw = [1 + Math.log(2), 2 * (1 + Math.log(2)), 1 + Math.log(2), 1 + Math.log(2)];
  const n = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
  [0, 1, 2, 3].forEach((c) => assert.ok(Math.abs(v.get(c) - raw[c] / n) < 1e-9, c + " " + v.get(c)));
  assert.ok(!v.has(4));
});

// 노트북이 내보낸 모델: check 칸에 넣어 둔 입력과 Keras 예측을 서버 계산과 비교
const dir = path.join(__dirname, "..", "..", "web", "data", "models");
if (fs.existsSync(dir)) {
  fs.readdirSync(dir).filter((f) => f.endsWith(".json")).forEach((f) => {
    test("내보낸 모델 " + f + ": Keras 예측과 서버 계산이 같음", () => {
      const json = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      assert.ok(Array.isArray(json.check) && json.check.length, "check 예시가 없음");
      const m = loadModel(json);
      json.check.forEach((c) => {
        const p = m.predict(c.input);
        c.output.forEach((v, i) => assert.ok(Math.abs(p[i] - v) < 1e-3, `${f} 예시 ${i}: 서버 ${p[i]} ≠ Keras ${v}`));
      });
    });
  });
}

console.log(fail ? "실패 " + fail + "개" : "모두 통과");
process.exit(fail ? 1 : 0);
