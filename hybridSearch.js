const axios = require("axios");
const { Client } = require("@opensearch-project/opensearch");
const { getQueryEmbedding, fuseResults } = require("./helpers");

const qdrant = axios.create({ baseURL: process.env.QDRANT_URL || "http://localhost:6333" });
const os = new Client({ node: process.env.OPENSEARCH_URL || "http://localhost:9200" });

const serviceHealth = {
  qdrant: { ok: false, checkedAt: 0 },
  embeddings: { ok: false, checkedAt: 0 },
};
const HEALTH_TTL_MS = 30_000;

async function checkQdrantHealth() {
  const now = Date.now();
  if (now - serviceHealth.qdrant.checkedAt < HEALTH_TTL_MS) return serviceHealth.qdrant.ok;
  try {
    await qdrant.get('/collections');
    serviceHealth.qdrant = { ok: true, checkedAt: now };
    return true;
  } catch (e) {
    serviceHealth.qdrant = { ok: false, checkedAt: now };
    console.error('Qdrant health check failed:', e.message);
    return false;
  }
}

async function checkEmbeddingsHealth() {
  const now = Date.now();
  if (now - serviceHealth.embeddings.checkedAt < HEALTH_TTL_MS) return serviceHealth.embeddings.ok;
  try {
    await axios.get((process.env.EMBEDDING_SERVICE_URL || "http://localhost:8000") + "/health", { timeout: 3000 });
    serviceHealth.embeddings = { ok: true, checkedAt: now };
    return true;
  } catch {
    // Fallback: попробуем /docs (FastAPI всегда отдаёт /docs если жив)
    try {
      await axios.get((process.env.EMBEDDING_SERVICE_URL || "http://localhost:8000") + "/docs", { timeout: 3000 });
      serviceHealth.embeddings = { ok: true, checkedAt: now };
      return true;
    } catch (e) {
      serviceHealth.embeddings = { ok: false, checkedAt: now };
      console.error('Embedding service health check failed:', e.message);
      return false;
    }
  }
}

async function searchHybrid(query, topK = 10, searchType = 'all', alpha = 0.6, minScore = 0) {
  try {
    const qdrantOk = await checkQdrantHealth();
    const embeddingsOk = await checkEmbeddingsHealth();

    if (!qdrantOk) throw new Error('Qdrant service is not available');
    if (!embeddingsOk) throw new Error('Embedding service is not available');

    console.log('All services available, starting search...');
    
    // 1) BM25 search
    const bmRes = await os.search({
      index: "messages_bm25",
      body: {
        query: {
          match: { text: { query } },
        },
        size: topK,
      },
    });

    const bmMap = new Map();
    bmRes.body.hits.hits.forEach((h) => {
      bmMap.set(h._id, { bmScore: h._score, doc: h._source });
    });

    console.log(`BM25 search returned ${bmRes.body.hits.hits.length} results`);

    // 2) get query vector from embedding model
    const qVec = await getQueryEmbedding(query, 384);
    console.log(`Generated text embedding vector with size: ${qVec.length}`);

    // 3) Vector searches based on type
    const results = new Map();
  
  if (searchType === 'all' || searchType === 'text') {
    // Text vector search
    try {
      console.log(`Performing text vector search with vector size: ${qVec.length}`);
      
      // Validate vector before sending
      if (!qVec || qVec.length === 0) {
        console.warn('Empty vector, skipping text search');
      } else {
        const qdrRes = await qdrant.post(
          "/collections/messages_text_vectors/points/search",
          {
            vector: qVec,
            top: topK,
            with_payload: true,
            with_vector: false,
          }
        );
        
        console.log(`Text search returned ${qdrRes.data.result?.length || 0} results`);
        qdrRes.data.result.forEach((p) => {
          const id = p.id;
          const existing = results.get(id) || { id, payload: p.payload };
          existing.textVecScore = p.score;
          results.set(id, existing);
        });
      }
    } catch (e) {
      console.error('Text vector search failed:', e.response?.data || e.message);
      if (e.response?.data?.status?.error?.includes('OutputTooSmall')) {
        console.warn('Collection appears to be empty. This is normal if no messages have been indexed yet.');
      }
    }
  }
  
  // Image vector search runs only when an explicit image embedding is provided.
  // Text queries cannot search image vectors (different embedding spaces — ResNet-50 2048D vs text 384D).
  // searchType === 'image' is reserved for future cross-modal (CLIP-style) queries.

  // 4) Merge BM25 results with vector results using fuseResults
  const textVecMap = new Map();
  const imgVecMap = new Map();
  
  // Separate text and image vector results
  results.forEach((item) => {
    if (item.textVecScore !== undefined) {
      textVecMap.set(item.id, { vecScore: item.textVecScore, payload: item.payload });
    }
    if (item.imgVecScore !== undefined) {
      imgVecMap.set(item.id, { vecScore: item.imgVecScore, payload: item.payload });
    }
  });
  
  // Use the best vector score (text or image) for fusion
  const bestVecMap = new Map();
  const allIds = new Set([...bmMap.keys(), ...textVecMap.keys(), ...imgVecMap.keys()]);
  
  allIds.forEach(id => {
    const textScore = textVecMap.get(id)?.vecScore || 0;
    const imgScore = imgVecMap.get(id)?.vecScore || 0;
    const bestScore = Math.max(textScore, imgScore);
    const payload = textVecMap.get(id)?.payload || imgVecMap.get(id)?.payload || bmMap.get(id)?.doc;

    if (bestScore > 0) {
      bestVecMap.set(id, { vecScore: bestScore, payload });
    }
  });

  const merged = fuseResults(bmMap, bestVecMap, alpha);

  return merged.filter((item) => item.combined >= minScore).slice(0, topK);
  } catch (error) {
    console.error('Search failed:', error);
    throw error;
  }
}

module.exports = {
  searchHybrid
};
