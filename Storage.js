const uuid = require("uuid");
const path = require("path");
const fs = require("fs").promises;
const cassandra = require("cassandra-driver");

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
      file_path: newPath,
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

    return data;
  }
};
