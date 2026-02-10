# Organizer Backend

Новые фичи приложения [тут](https://github.com/users/stanis1avs/projects/1)

[frontend](https://github.com/Stanislavsus-prj/organizer_frontend) 
[Функционал работы приложения](https://github.com/stanis1avs/organizer_frontend/blob/main/FUNCTIONAL.md)

## О проекте

**Organizer** - это система для организации личных данных с умным поиском сообщений.

### Основная функциональность:
- Сохранение текстовых сообщений
- Загрузка и хранение изображений  
- Запись и хранение аудио файлов
- Запись и хранение видео файлов
- **Умный поиск** (точное совпадение и семантический поиск)
- Избранные сообщения
- Закрепленные сообщения

### Умный поиск:
Система использует гибридный поиск:
- **BM25** (OpenSearch) - точный поиск по ключевым словам
- **Dense Vectors** (Qdrant) - семантический поиск по смыслу
- **OCR** - извлечение текста из изображений для поиска

---

## Технический стэк

### Backend
1. **WebSocket** - реальное время
2. **Koa** - веб-фреймворк
3. **Cassandra** - основная БД
4. **BM25 (OpenSearch)** - полнотекстовый поиск
5. **Dense Vectors (Qdrant, 384D и 512D)** - семантический поиск
6. **Tesseract OCR** - распознавание текста с изображений

### В разработке
- Redis (кэширование)
- Chrome Extensions API
- Background script


### Микросервис эмбеддингов
- **FastAPI** - веб-фреймворк
- **sentence-transformers/all-MiniLM-L6-v2** - модель эмбеддингов

### Frontend
1. **Нативный JavaScript** 
2. **WebSocket** 
3. **Webpack** 
4. **ESLint** 
5. **Appveyor** - CI/CD
6. **MediaRecorder API**


### В разработке
- Jest
- Puppeteer
- Cache API
- Web Crypto API
- Streams API
- Service Worker API

---

