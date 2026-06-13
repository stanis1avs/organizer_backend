const axios = require("axios");
const { Client } = require("@opensearch-project/opensearch");
const { getQueryEmbedding, getClipEmbedding } = require('./helpers');
const ocrService = require('./ocrService');

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const OPENSEARCH_URL = process.env.OPENSEARCH_URL || "http://localhost:9200";
const EMBEDDING_SERVICE_URL = process.env.EMBEDDING_SERVICE_URL || "http://localhost:8000";
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY || "";

const qdrant = axios.create({ baseURL: QDRANT_URL });
const osClient = new Client({ node: OPENSEARCH_URL });

// Индексация в OpenSearch
async function indexToOpenSearch(message) {
  try {
    // Validate and format date for OpenSearch
    let formattedDate = message.date;
    if (formattedDate) {
      // Try to parse and reformat as ISO date
      try {
        const dateObj = new Date(formattedDate);
        if (!isNaN(dateObj.getTime())) {
          formattedDate = dateObj.toISOString();
        } else {
          console.warn('Invalid date format, using current time:', formattedDate);
          formattedDate = new Date().toISOString();
        }
      } catch (e) {
        console.warn('Date parsing failed, using current time:', e.message);
        formattedDate = new Date().toISOString();
      }
    } else {
      formattedDate = new Date().toISOString();
    }
    
    await osClient.index({
      index: "messages_bm25",
      id: message.message_id,
      body: {
        message_id: message.message_id,
        text: message.text,
        type: message.type,
        date: formattedDate
      }
    });
    console.log(`Indexed to OpenSearch: ${message.message_id}`);
  } catch (error) {
    console.error("OpenSearch indexing error:", error.message);
    // Не прерываем процесс, если OpenSearch недоступен
  }
}

async function indexMessage({
  message_id,
  text,
  type = "text",
  date = null, // Изменили на null, чтобы использовать текущую дату
  imagePath = null
}) {
  // Используем текущую дату в формате ISO, если дата не предоставлена
  const messageDate = date || new Date().toISOString();
  
  const messageData = {
    message_id,
    text,
    type,
    date: messageDate
  };

  // 1) Index to OpenSearch (BM25)
  await indexToOpenSearch(messageData);

  // 2) Upsert vector to Qdrant based on type
  if (type === "text" && text) {
    // Text message — multilingual embedding (384D) for text queries
    try {
      const vector = await getQueryEmbedding(text, 384);
      await qdrant.put(
        `/collections/messages_text_vectors/points?wait=true`,
        { points: [{ id: message_id, vector, payload: messageData }] },
        { headers: { 'Content-Type': 'application/json' } }
      );
      console.log(`[indexMessage] Qdrant text upsert ok: ${message_id}`);
    } catch (e) {
      console.error('[indexMessage] Qdrant text vector upsert failed:', e.response?.data || e.message);
    }

    // CLIP text embedding (512D) — enables image→text cross-modal search
    try {
      const clipVector = await getClipEmbedding(text);
      await qdrant.put(
        `/collections/messages_clip_vectors/points?wait=true`,
        { points: [{ id: message_id, vector: clipVector, payload: messageData }] },
        { headers: { 'Content-Type': 'application/json' } }
      );
      console.log(`[indexMessage] Qdrant CLIP text upsert ok: ${message_id}`);
    } catch (e) {
      console.error('[indexMessage] Qdrant CLIP text vector upsert failed:', e.response?.data || e.message);
    }
  } else if (type === "image" && imagePath) {
    // Image message — OCR + text embedding + image embedding
    try {
      let ocrText = text && text.trim() ? text : null;
      if (!ocrText) {
        ocrText = await extractTextFromImage(imagePath);
      }

      if (ocrText && ocrText.trim()) {
        messageData.extracted_text = ocrText;
        const textVector = await getQueryEmbedding(ocrText, 384);
        await qdrant.put(
          `/collections/messages_text_vectors/points?wait=true`,
          { points: [{ id: message_id, vector: textVector, payload: messageData }] },
          { headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        console.log(`[indexMessage] OCR returned empty text for ${message_id}, skipping text vector`);
      }

      const embHeaders = EMBEDDING_API_KEY ? { "X-API-Key": EMBEDDING_API_KEY } : {};

      // ResNet-50 visual embedding → images_vectors (2048D)
      const imageVectorResponse = await axios.post(
        `${EMBEDDING_SERVICE_URL}/embed-image`,
        { image_path: imagePath, size: 512 },
        { timeout: 30000, headers: embHeaders }
      );

      const imageVector = imageVectorResponse.data?.embedding;
      if (!Array.isArray(imageVector) || imageVector.length === 0) {
        throw new Error(`Invalid image embedding response for ${message_id}`);
      }

      await qdrant.put(
        `/collections/images_vectors/points?wait=true`,
        { points: [{ id: message_id, vector: imageVector, payload: messageData }] },
        { headers: { 'Content-Type': 'application/json' } }
      );
      console.log(`[indexMessage] Qdrant ResNet image vector upsert ok: ${message_id}`);

      // CLIP embedding → images_clip_vectors (512D, same space as text queries)
      const clipResponse = await axios.post(
        `${EMBEDDING_SERVICE_URL}/embed-clip`,
        { image_path: imagePath },
        { timeout: 30000, headers: embHeaders }
      );

      const clipVector = clipResponse.data?.embedding;
      if (Array.isArray(clipVector) && clipVector.length > 0) {
        await qdrant.put(
          `/collections/images_clip_vectors/points?wait=true`,
          { points: [{ id: message_id, vector: clipVector, payload: messageData }] },
          { headers: { 'Content-Type': 'application/json' } }
        );
        console.log(`[indexMessage] Qdrant CLIP image vector upsert ok: ${message_id}`);
      } else {
        console.warn(`[indexMessage] CLIP returned no vector for ${message_id}`);
      }
    } catch (e) {
      console.error('[indexMessage] Qdrant image vectors upsert failed:', e.response?.data || e.message);
    }
  }

  console.log(`[indexMessage] Done: ${message_id}`);
}

// Extract text from image using local OCR service
async function extractTextFromImage(imagePath) {
  return await ocrService.extractTextFromImage(imagePath);
}

module.exports = {
  indexMessage,
  extractTextFromImage,
  indexToOpenSearch
};
