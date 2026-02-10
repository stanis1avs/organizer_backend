const uuid = require("uuid");
const path = require("path");
const fs = require("fs").promises;
const cassandra = require("cassandra-driver");
const axios = require("axios");
const { getQueryEmbedding } = require("./helpers");
const { indexMessage, extractTextFromImage } = require("./indexMessage");
const { Client } = require("@opensearch-project/opensearch");

const client = new cassandra.Client({
  contactPoints: ["127.0.0.1"],
  localDataCenter: "datacenter1",
  keyspace: "chat_app",
});

module.exports = class Storage {
  constructor(ws, clients, filesDir) {
    this.ws = ws;
    this.clients = clients;
    this.filesDir = filesDir;
    
    // Qdrant клиент
    this.qdrant = axios.create({
      baseURL: process.env.QDRANT_URL || "http://localhost:6333",
    });
    
    // OpenSearch клиент
    this.osClient = new Client({
      node: process.env.OPENSEARCH_URL || "http://localhost:9200",
    });
  }

  init() {
    this.ws.on("message", async (message) => {
      const command = JSON.parse(message);

      //Запрос на данные из БД
      if (command.event === "load") {
        await this.eventLoad();
      }

      // Новое сообщение
      if (command.event === "showMessage") {
        await this.eventMessage(command.message);
      }

      // Удалить сообщение
      if (command.event === "deleteMessage") {
        await this.eventDelete(command.message.id);
      }

      // Добавить в избранное
      if (command.event === "favoriteAppend") {
        await this.eventFavoriteAppend(command.message);
      }

      // Удалить из избранного
      if (command.event === "favoriteDelete") {
        await this.eventFavoriteDelete(command.message);
      }

      // Закрепить сообщение
      if (command.event === "appendPin") {
        await this.eventPin(command.message.id);
      }
    });
  }

  // Запрос на данные из БД
  async eventLoad() {
    const result = await client.execute("SELECT * FROM messages LIMIT 20");
    const favorites = await client.execute("SELECT * FROM favorites");
    const pinned = await client.execute(
      "SELECT id FROM pinned_message WHERE singleton = ?",
      ["pinned"],
      { prepare: true }
    );

    const data = {
      event: "load",
      dB: result.rows,
      favorites: favorites.rows.map((row) => row.id.toString()),
      pinned: pinned.rowLength > 0 ? pinned.rows[0].id.toString() : null,
      position: 0,
    };
    this.wsSend(data);
  }

  // Новое сообщение
  async eventMessage(message) {
    const id = cassandra.types.Uuid.random();
    const query = `INSERT INTO messages (id, message, date, geo, type)
                   VALUES (?, ?, ?, ?, ?)`;

    await client.execute(
      query,
      [id, message.body, message.date, message.geo, message.type],
      { prepare: true }
    );

    // Индексация в поисковых системах
    await this.indexMessageToSearch(id.toString(), message);

    const data = {
      id: id.toString(),
      message: message.body,
      date: message.date,
      type: message.type,
      geo: message.geo,
      event: "showMessage",
    };

    this.wsAllSend(data);
  }

  // Удаление сообщения
  async eventDelete(id) {
    const selectQuery = "SELECT file_path FROM messages WHERE id = ?";
    const result = await client.execute(selectQuery, [id], { prepare: true });

    let filePath = null;
    if (result.rows.length && result.rows[0].file_path) {
      filePath = result.rows[0].file_path;
    }

    await client.execute("DELETE FROM messages WHERE id = ?", [id], {
      prepare: true,
    });
    await client.execute("DELETE FROM favorites WHERE id = ?", [id], {
      prepare: true,
    });

    if (filePath) {
      try {
        await fs.unlink(filePath);
        console.log(`Файл ${filePath} удалён`);
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.error("Ошибка при удалении файла:", err);
        }
      }
    }

    this.wsAllSend({ id, event: "deleteMessage" });
  }

  // Добавление в избранное
  async eventFavoriteAppend(id) {
    await client.execute("INSERT INTO favorites (id) VALUES (?)", [id], {
      prepare: true,
    });
    this.wsAllSend({ id, event: "favoriteAppend" });
  }

  // Удаление из избранного
  async eventFavoriteDelete(id) {
    await client.execute("DELETE FROM favorites WHERE id = ?", [id], {
      prepare: true,
    });
    this.wsAllSend({ id, event: "favoriteDelete" });
  }

  // Закрепление сообщения
  async eventPin(id) {
    await client.execute(
      "INSERT INTO pinned_message (singleton, id) VALUES (?, ?)",
      ["pinned", id],
      { prepare: true }
    );
    this.wsAllSend({ id, event: "appendPin" });
  }

  // Закрепление сообщения
  async getMesgByIds(ids) {
    const cassRes = await client.execute(
      "SELECT * FROM messages WHERE id IN ?",
      [ids],
      { prepare: true }
    );
    return cassRes;
  }

  // Сохранение эмбеддинга в Qdrant
  async saveEmbeddingToQdrant(id, text, vectorSize = 384) {
    try {
      // Получаем эмбеддинг текста
      const embedding = await getQueryEmbedding(text, vectorSize);
      
      // Сохраняем в Qdrant
      await this.qdrant.put(
        "/collections/messages_text_vectors/points",
        {
          points: [
            {
              id: id.toString(),
              vector: embedding,
              payload: { text }
            }
          ]
        },
        {
          headers: { "Content-Type": "application/json" }
        }
      );
      
      console.log(`Embedding saved to Qdrant for message ${id}`);
    } catch (error) {
      console.error("Failed to save embedding to Qdrant:", error.response?.data || error.message);
      // Не прерываем процесс, если Qdrant недоступен
    }
  }

  // Отправка ответа сервера
  wsSend(data) {
    this.ws.send(JSON.stringify(data));
  }

  // Рассылка ответов всем клиента сервера (для поддержки синхронизации)
  wsAllSend(data) {
    for (const client of this.clients) {
      client.send(JSON.stringify(data));
    }
  }

  // Получение и обработка файлов
  async loadFile(file, infoMessg) {
    const oldPath = file.filepath || file.path;
    if (!file || !oldPath) {
      return reject(new Error("Файл не найден в запросе"));
    }

    const fileName = file.originalFilename || file.name;
    const newPath = path.join(this.filesDir, fileName);

    if (oldPath !== newPath) {
      await fs.rename(oldPath, newPath);
    }

    const data = {
      id: uuid.v1(),
      message: fileName,
      date: infoMessg.date,
      type: infoMessg.type,
      geo: infoMessg.geo,
      file_path: fileName, // Сохраняем только имя файла, не полный путь
    };

    const query = `
      INSERT INTO messages (id, message, date, type, geo, file_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    const params = [
      data.id,
      data.message,
      data.date,
      data.type,
      data.geo,
      data.file_path,
    ];

    await client.execute(query, params, { prepare: true });

    // Индексируем сообщение в поисковых системах (включая OCR и эмбеддинги)
    await this.indexMessageToSearch(data.id.toString(), {
      body: data.message,
      type: data.type,
      date: data.date,
      file_path: data.file_path,
      geo: data.geo
    });

    return data;
  }
  // Индексация сообщения в поисковых системах
  async indexMessageToSearch(messageId, message) {
    try {
      let imagePath = null;
      let text = message.body || '';
      
      // Если это изображение, получаем путь к файлу и извлекаем текст
      if (message.type === 'image' && message.file_path) {
        // file_path - это относительный путь, нужно добавить filesDir
        imagePath = path.join(this.filesDir, message.file_path);
        
        // Извлекаем текст из изображения с помощью OCR
        try {
          const ocrService = require('./ocrService');
          const extractedText = await ocrService.extractTextFromImage(imagePath);
          console.log("extractedText", extractedText)
          if (extractedText) {
            text = extractedText;
            console.log(`OCR extracted ${extractedText.length} characters from image ${messageId}`);
          }
        } catch (error) {
          console.warn('OCR failed for image:', error.message);
        }
      }
      
      // Форматируем дату для OpenSearch
      let formattedDate = message.date;
      if (formattedDate) {
        try {
          const dateObj = new Date(formattedDate);
          if (!isNaN(dateObj.getTime())) {
            formattedDate = dateObj.toISOString();
          } else {
            console.warn('Invalid date format in message, using current time');
            formattedDate = new Date().toISOString();
          }
        } catch (e) {
          console.warn('Date parsing failed in message, using current time:', e.message);
          formattedDate = new Date().toISOString();
        }
      } else {
        formattedDate = new Date().toISOString();
      }
      
      await indexMessage({
        message_id: messageId,
        text: text,
        type: message.type,
        date: formattedDate,
        imagePath: imagePath
      });
      
      console.log(`Message ${messageId} indexed to search systems`);
    } catch (error) {
      console.error('Failed to index message:', error.message);
    }
  }
  
};
