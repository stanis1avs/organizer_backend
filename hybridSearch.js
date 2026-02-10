// pseudocode/hybridSearch.js (упрощённый)
const axios = require("axios");
const { Client } = require("@opensearch-project/opensearch");
const { getQueryEmbedding, fuseResults } = require("./helpers");

const qdrant = axios.create({ baseURL: "http://localhost:6333" });
const os = new Client({ node: "http://localhost:9200" });

async function searchHybrid(query, topK = 10, searchType = 'all') {
  try {
    // Check services availability
    console.log('Checking services availability...');
    
    // Check Qdrant
    try {
      await qdrant.get('/collections');
      console.log('Qdrant is available');
    } catch (e) {
      console.error('Qdrant is not available:', e.message);
      throw new Error('Qdrant service is not available');
    }
    
    // Check embedding service
    try {
      await getQueryEmbedding('test', 384);
      console.log('Embedding service is available');
    } catch (e) {
      console.error('Embedding service is not available:', e.message);
      throw new Error('Embedding service is not available');
    }
    
    console.log('All services are available, starting search...');
    
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
    bmRes.body.hits.hits.forEach((h, i) => {
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
            with_payload: false,
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
  
  if (searchType === 'all' || searchType === 'image') {
    // Image vector search - need 512D vector for image search
    try {
      // Get 512D vector for image search
      console.log('Getting 512D vector for image search...');
      const imgVec = await getQueryEmbedding(query, 512);
      console.log(`Image vector size: ${imgVec.length}`);
      
      // Validate vector before sending
      if (!imgVec || imgVec.length === 0) {
        console.warn('Empty image vector, skipping image search');
      } else {
        console.log(`Performing image vector search...`);
        const imgRes = await qdrant.post(
          "/collections/images_vectors/points/search",
          {
            vector: imgVec, // Use 512D vector for image collection
            top: topK,
            with_payload: true,
            with_vector: false,
            search_params: {
              exact: false  // Use approximate search for better performance
            }
          }
        );
        
        console.log(`Image search returned ${imgRes.data.result?.length || 0} results`);
        imgRes.data.result.forEach((p) => {
          const id = p.id;
          const existing = results.get(id) || { id, payload: p.payload };
          existing.imgVecScore = p.score;
          results.set(id, existing);
        });
      }
    } catch (e) {
      console.error('Image search failed:', e.response?.data || e.message);
      if (e.response?.data?.status?.error?.includes('OutputTooSmall')) {
        console.warn('Image collection appears to be empty. This is normal if no images have been indexed yet.');
      }
    }
  }

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
    const bmScore = bmMap.get(id)?.bmScore || 0;
    const textScore = textVecMap.get(id)?.vecScore || 0;
    const imgScore = imgVecMap.get(id)?.vecScore || 0;
    const bestScore = Math.max(textScore, imgScore);
    const payload = textVecMap.get(id)?.payload || imgVecMap.get(id)?.payload || bmMap.get(id)?.doc;
    
    if (bestScore > 0) {
      bestVecMap.set(id, { vecScore: bestScore, payload });
    }
  });

  // Use fuseResults for final merging
  const merged = fuseResults(bmMap, bestVecMap, 0.6);

  return merged.slice(0, topK);
  } catch (error) {
    console.error('Search failed:', error);
    throw error;
  }
}

module.exports = {
  searchHybrid
};
