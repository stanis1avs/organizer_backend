// node indexMessage.js
const axios = require("axios");
const { Client } = require("@opensearch-project/opensearch");
const { v4: uuidv4 } = require("uuid");
const fs = require('fs').promises;
const path = require('path');
const { getQueryEmbedding } = require('./helpers');
const ocrService = require('./ocrService');

const qdrant = axios.create({ baseURL: "http://localhost:6333" });
const osClient = new Client({ node: "http://localhost:9200" });

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


  console.log(type, imagePath)

  // 2) Upsert vector to Qdrant based on type
  if (type === "text" && text) {
    // Text message - use real text embedding
    const vector = await getQueryEmbedding(text, 384);
    if (vector.length !== 384) {
      throw new Error('Vector length mismatch: ' + vector.length);
    }
    
    try {
      const qRes = await qdrant.put(
        `/collections/messages_text_vectors/points?wait=true`,
        { points: [{ id: message_id, vector, payload: messageData }] },
        { headers: { 'Content-Type': 'application/json' } }
      );
      console.log('Qdrant text vector upsert ok:', qRes.status, qRes.data);
    } catch (e) {
      console.error('Qdrant text vector upsert failed:', e.response?.data || e.message);
    }
  } else if (type === "image" && imagePath) {
    // Image message - extract text and create both text and image embeddings
    try {
      // Extract text from image using OCR service
      const extractedText = await extractTextFromImage(imagePath);

      console.log("extractedText", extractedText)
      
      // Update message data with extracted text
      messageData.extracted_text = extractedText;
      
      // Create text embedding from extracted text
      const textVector = await getQueryEmbedding(extractedText, 384);
      await qdrant.put(
        `/collections/messages_text_vectors/points?wait=true`,
        { points: [{ id: message_id, vector: textVector, payload: messageData }] },
        { headers: { 'Content-Type': 'application/json' } }
      );
      
      // Create image embedding (512D) using image embedding service
      const imageVectorResponse = await axios.post('http://localhost:8000/embed-image', {
        image_path: imagePath,
        size: 512
      }, { timeout: 30000 });
      
      const imageVector = imageVectorResponse.data.embedding;
      await qdrant.put(
        `/collections/images_vectors/points?wait=true`,
        { points: [{ id: message_id, vector: imageVector, payload: messageData }] },
        { headers: { 'Content-Type': 'application/json' } }
      );
      
      console.log('Qdrant image vectors upsert ok for:', message_id);
    } catch (e) {
      console.error('Qdrant image vectors upsert failed:', e.response?.data || e.message);
    }
  }

  console.log("Indexed message", message_id);
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
