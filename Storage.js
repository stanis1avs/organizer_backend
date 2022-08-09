const uuid = require('uuid');
const path = require('path');
const fs = require('fs');

module.exports = class Storage {
  constructor(dB, filesDir, categorydB, favoritesdB, ws, clients) {
    this.ws = ws;
    this.clients = clients;
    this.dB = dB;
    this.category = categorydB;
    this.favorites = favoritesdB;
    this.filesDir = filesDir;
    this.allowedTypes = ['image', 'video', 'audio'];
  }

  init() {
    this.ws.on('message', (message) => {
      const command = JSON.parse(message);

      //Запрос на данные из БД
      if (command.event === 'load') {
        this.eventLoad(command.message);
      }

      // Новое сообщение
      if (command.event === 'showMessage') {
        this.eventMessage(command.message);
      }

      // Удалить сообщение
      if (command.event === 'deleteMessage') {
        this.eventDelete(command.message.id);
      }

      // Добавить в избранное
      if (command.event === 'favoriteAppend') {
        this.eventFavoriteAppend(command.message);
      }

      // Удалить из избранного
      if (command.event === 'favoriteDelete') {
        this.eventFavoriteDelete(command.message);
      }

      // Закрепить сообщение
      if (command.event === 'appendPin') {
        this.eventPin(command.message.id);
      }
    });
  }

  // Запрос на данные из БД
  eventLoad(position) {
    // Для "ленивой" подгрузки
    const startPosition = position || this.dB.length;
    const itemCounter = startPosition > 10 ? 10 : startPosition;
    const returnDB = [];
    for (let i = 0; i < itemCounter; i += 1) {
      returnDB.push(this.dB[i]);
    }

    const data = {
      event: 'load',
      dB: returnDB,
      favorites: [...this.favorites],
      position: startPosition - 10,
    };
    this.wsSend(data);
  }

  // Новое сообщение
  eventMessage(message) {
    const data = {
      id: uuid.v1(),
      message: message.body,
      date: message.date,
      type: message.type,
      geo: message.geo,
    };
    this.dB.push(data);
    this.wsAllSend({...data, event: 'showMessage'});
  }

  // Удаление сообщения
  eventDelete(id) {
    const unlinkFiles = new Set();
    [...this.allowedTypes, 'file', 'links'].forEach((type) => {
      const filesInCategory = this.category[type].filter((item) => item.id === id).map((item) => item.name);
      filesInCategory.forEach((fileName) => unlinkFiles.add(fileName));
      this.category[type] = this.category[type].filter((item) => item.id !== id);
    });
    unlinkFiles.forEach((fileName) => {
      fs.unlink(path.join(this.filesDir, fileName), () => {});
    });

    this.favorites.delete(id);

    const messageIndex = this.dB.findIndex((item) => item.id === id);
    this.dB.splice(messageIndex, 1);
    this.wsAllSend({ id, event: 'deleteMessage' });
  }

  // Добавление в избранное
  eventFavoriteAppend(id) {
    this.favorites.add(id);
    this.wsAllSend({ id, event: 'favoriteAppend'});
  }

  // Удаление из избранного
  eventFavoriteDelete(id) {
    this.favorites.delete(id);
    this.wsAllSend({ id, event: 'favoriteDelete'});
  }

  // Закрепление сообщения
  eventPin(id) {
    const hasPinned = this.dB.find((message) => message.pinned);
    if (hasPinned) {
      delete hasPinned.pinned;
    }

    const pinnedMessage = this.dB.find((message) => message.id === id);
    pinnedMessage.pinned = true;
    this.wsAllSend({id, event: 'appendPin' });
  }

  // Отправка ответа сервера
  wsSend(data) {
    this.ws.send(JSON.stringify(data));
  }

  // Рассылка ответов всем клиента сервера (для поддержки синхронизации)
  wsAllSend(data) {
    for(const client of this.clients) {
      client.send(JSON.stringify(data));
    }
  }

  // Получение и обработка файлов
  loadFile(file, infoMessg) {
    return new Promise((resolve, reject) => {
      const fileName = infoMessg.name;
      const oldPath = file.path;
      const newPath = path.join(this.filesDir, fileName);

      const callback = (error) => reject(error);

      const readStream = fs.createReadStream(oldPath);
      const writeStream = fs.createWriteStream(newPath);

      readStream.on('error', callback);
      writeStream.on('error', callback);

      readStream.on('close', () => {
        fs.unlink(oldPath, callback);

        const data = {
          id: uuid.v1(),
          message: fileName,
          date: infoMessg.date,
          type: infoMessg.type,
          geo: infoMessg.geo
        };
        this.dB.push(data);

        this.category[infoMessg.type].push({ name: fileName, id: data.id });

        resolve({ ...data});
      });

      readStream.pipe(writeStream);
    });
  }
}