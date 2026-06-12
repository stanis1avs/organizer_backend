const axios = require("axios");

const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || "http://localhost:8000";
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || "";


function normalizeArray(arr) {
  if (!arr || arr.length === 0) return [];
  let min = arr[0];
  let max = arr[0];
  for (const v of arr) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === min) return arr.map(() => (max === 0 ? 0 : 1));
  return arr.map((v) => (v - min) / (max - min));
}

// --- helper: объединение (fuse) результатов ---
function fuseResults(bmHitsMap, vecHitsMap, alpha = 0.6) {
  // bmHitsMap: Map id -> { bmScore, doc }
  // vecHitsMap: Map id -> { vecScore, payload }
  // vecScore — cosine similarity, already in [0,1], no normalization needed.
  // bmScore — TF-IDF (arbitrary scale), normalize to [0,1] across results.
  const allIds = new Set([...bmHitsMap.keys(), ...vecHitsMap.keys()]);
  const ids = Array.from(allIds);

  const bmScores = ids.map((id) => bmHitsMap.get(id)?.bmScore ?? 0);
  const vecScores = ids.map((id) => vecHitsMap.get(id)?.vecScore ?? 0);

  const bmNorm = normalizeArray(bmScores);
  const hasBM25 = bmScores.some((s) => s > 0);

  return ids
    .map((id, i) => ({
      id,
      bmScore: bmScores[i],
      vecScore: vecScores[i],
      // When BM25 has no results vecScore is already in [0,1] — use it directly.
      // When BM25 has results blend both sources with alpha weight.
      combined: hasBM25
        ? alpha * vecScores[i] + (1 - alpha) * bmNorm[i]
        : vecScores[i],
      doc: bmHitsMap.get(id)?.doc ?? null,
      payload: vecHitsMap.get(id)?.payload ?? null,
    }))
    .sort((a, b) => b.combined - a.combined);
}

async function getQueryEmbedding(text, size = 384) {
  const url = `${EMBEDDING_SERVICE_URL}/embed`;
  const headers = EMBEDDING_API_KEY ? { "X-API-Key": EMBEDDING_API_KEY } : {};
  const resp = await axios.post(url, { text, size }, { timeout: 10000, headers });
  const emb = resp.data?.embedding;
  if (!Array.isArray(emb) || emb.length === 0) {
    throw new Error(`Bad embedding response from service (size=${size})`);
  }
  if (emb.length !== size) {
    console.warn(`[getQueryEmbedding] Size mismatch: got ${emb.length}, expected ${size}`);
  }
  return emb;
}

module.exports = {
  normalizeArray,
  fuseResults,
  getQueryEmbedding,
};
