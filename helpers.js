const axios = require("axios");

// --- helper: нормализация массива чисел ---
function normalizeArray(arr) {
  if (!arr || arr.length === 0) return [];
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  if (max === min) return arr.map(() => 1);
  return arr.map((v) => (v - min) / (max - min));
}

// --- helper: объединение (fuse) результатов ---
function fuseResults(bmHitsMap, vecHitsMap, alpha = 0.6) {
  // bmHitsMap: Map id -> { bmScore, doc }
  // vecHitsMap: Map id -> { vecScore, payload }
  const allIds = new Set([...bmHitsMap.keys(), ...vecHitsMap.keys()]);
  const ids = Array.from(allIds);

  const bmScores = ids.map((id) => bmHitsMap.get(id)?.bmScore ?? 0);
  const vecScores = ids.map((id) => vecHitsMap.get(id)?.vecScore ?? 0);

  const bmNorm = normalizeArray(bmScores);
  const vecNorm = normalizeArray(vecScores);

  const merged = ids
    .map((id, i) => {
      return {
        id,
        bmScore: bmScores[i],
        vecScore: vecScores[i],
        bmNorm: bmNorm[i],
        vecNorm: vecNorm[i],
        combined: alpha * vecNorm[i] + (1 - alpha) * bmNorm[i],
        doc: bmHitsMap.get(id)?.doc ?? null,
        payload: vecHitsMap.get(id)?.payload ?? null,
      };
    })
    .sort((a, b) => b.combined - a.combined);

  return merged;
}

function fakeEmbedding(size) {
  return Array.from({ length: size }, () => Math.random() * 2 - 1);
}

async function getQueryEmbedding(text, size = 384) {
  const url = "http://localhost:8000/embed";
  try {
    const resp = await axios.post(url, { text, size }, { timeout: 10000 });
    const emb = resp.data?.embedding;
    if (!Array.isArray(emb)) throw new Error("Bad embedding response");
    // validate length
    if (emb.length !== size) {
      console.warn("Embedding size mismatch", emb.length, "expected", size);
    }
    console.log("Embedding generated successfully");
    return emb;
  } catch (e) {
    console.error("Embedding service error:", e.response?.data || e.message);
    // fall back to random vector so search doesn't crash
    return fakeEmbedding(size);
  }
}

module.exports = {
  normalizeArray,
  fuseResults,
  getQueryEmbedding,
};
