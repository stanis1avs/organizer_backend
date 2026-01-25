const http = require("http");
const WS = require("ws");
const Koa = require("koa");
const koaBody = require("koa-body");
const koaStatic = require("koa-static");
const Router = require("koa-router");
const cors = require("koa2-cors");
const path = require("path");
const Storage = require("./Storage");
const axios = require("axios");
const { Client: OpenSearchClient } = require("@opensearch-project/opensearch");
const { fuseResults, getQueryEmbedding } = require("./helpers");

const app = new Koa();
const router = new Router();

// Qdrant + OpenSearch клиенты
const qdrant = axios.create({
  baseURL: process.env.QDRANT_URL || "http://localhost:6333",
});
const osClient = new OpenSearchClient({
  node: process.env.OS_URL || "http://localhost:9200",
  // если у тебя включена auth:
  // auth: { username: process.env.OS_USER, password: process.env.OS_PASSWORD }
});

const filesDir = path.join(__dirname, "files");

app.use(
  koaBody({
    multipart: true,
    formidable: {
      uploadDir: filesDir,
      keepExtensions: true,
      filename: (name, ext, part, form) => {
        return part.originalFilename || part.name || `${Date.now()}${ext}`;
      },
    },
  })
);

app.use(koaStatic(filesDir));

// CORS
app.use(
  cors({
    origin: "*",
    credentials: true,
    "Access-Control-Allow-Origin": true,
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
  })
);

app.use(router.routes()).use(router.allowedMethods());

const port = process.env.PORT || 7000;
const server = http.createServer(app.callback());
const wsServer = new WS.Server({ server });

//=======================================

const clients = [];
wsServer.on("connection", (ws) => {
  clients.push(ws);
  const storage = new Storage(ws, clients, filesDir);
  storage.init();

  router.post("/upload", async (ctx) => {
    const file = ctx.request.files?.file || ctx.request.files?.body;
    await storage.loadFile(file, ctx.request.body).then((result) => {
      storage.wsAllSend({ ...result, event: "showFile" });
    });
    ctx.response.status = 204;
  });

  router.post("/search", async (ctx) => {
    try {
      const {
        query,
        topK = 10,
        alpha = 0.6,
        vector_size = 384,
      } = ctx.request.body || {};
      if (!query || typeof query !== "string" || !query.trim()) {
        ctx.status = 400;
        ctx.body = { error: "Query text is required" };
        return;
      }

      console.log("Search request:", { query, topK, alpha });

      // 1) BM25 поиск в OpenSearch
      let bmRes;
      try {
        bmRes = await osClient.search({
          index: "messages_bm25",
          body: {
            query: { match: { text: { query } } },
            size: topK,
          },
        });
      } catch (e) {
        console.error("OpenSearch error:", e);
        // не фаталим — продолжаем с векторным поиском
        bmRes = { body: { hits: { hits: [] } } };
      }

      // map id -> { bmScore, doc }
      const bmMap = new Map();
      for (const h of bmRes.body.hits.hits || []) {
        const id = h._id?.toString();
        bmMap.set(id, { bmScore: h._score, doc: h._source || h._source });
      }

      // 2) Получаем эмбеддинг запроса
      const qVec = await getQueryEmbedding(query, vector_size);
      if (!Array.isArray(qVec) || qVec.length === 0) {
        throw new Error("Failed to obtain query embedding");
      }

      console.log("Query vector length =", qVec?.length);
      console.log("First 8 elements:", qVec?.slice?.(0, 8));

      // 3) Векторный поиск в Qdrant
      // try {
      //   // Валидация вектора
      //   if (!Array.isArray(qVec) || qVec.length !== Number(vector_size)) {
      //     console.warn("Invalid vector — skip Qdrant search", {
      //       length: qVec?.length,
      //     });
      //     qRes = { data: { result: [] } };
      //   } else if (qVec.some((v) => !isFinite(v))) {
      //     console.warn(
      //       "Vector contains non-finite values — skip Qdrant search"
      //     );
      //     qRes = { data: { result: [] } };
      //   } else {
      //     // Логируем размер тела запроса для диагностики
      //     const body = {
      //       vector: qVec,
      //       top: topK,
      //       with_payload: false,
      //       with_vector: false,
      //     };
      //     try {
      //       console.log(
      //         "Qdrant request body bytes:",
      //         Buffer.byteLength(JSON.stringify(body))
      //       );
      //       qRes = await qdrant.post(
      //         "/collections/messages_text_vectors/points/search",
      //         body,
      //         {
      //           headers: { "Content-Type": "application/json" },
      //         }
      //       );
      //     } catch (firstErr) {
      //       console.error(
      //         "Qdrant first attempt failed:",
      //         firstErr.response?.data || firstErr.message
      //       );

      //       // Если это та самая внутренняя паника OutputTooSmall — пробуем РЕЖИМ-ДИАГНОСТИКИ:
      //       const errData = firstErr.response?.data;
      //       if (
      //         errData &&
      //         errData.status &&
      //         String(errData.status.error).includes("OutputTooSmall")
      //       ) {
      //         // 1) лог — поможем понять состояние Qdrant
      //         console.warn(
      //           "Detected OutputTooSmall from Qdrant, trying simplified request for diagnosis"
      //         );

      //         // 2) Попытка без with_payload (меньшее тело) — проверить, пройдет ли
      //         try {
      //           qRes = await qdrant.post(
      //             "/collections/messages_text_vectors/points/search",
      //             {
      //               vector: qVec,
      //               top: topK,
      //             },
      //             { headers: { "Content-Type": "application/json" } }
      //           );
      //           console.log("Qdrant simplified search succeeded (no payload).");
      //         } catch (secondErr) {
      //           console.error(
      //             "Qdrant simplified attempt also failed:",
      //             secondErr.response?.data || secondErr.message
      //           );
      //           // отдаем пустой результат — но не фатал
      //           qRes = { data: { result: [] } };
      //         }
      //       } else {
      //         // иные ошибки — fallback пустой результат
      //         qRes = { data: { result: [] } };
      //       }
      //     }
      //   }
      // } catch (err) {
      //   console.error("Unexpected error around Qdrant call:", err);
      //   qRes = { data: { result: [] } };
      // }

      let qRes;
      try {
        qRes = await qdrant.post(
          "/collections/messages_text_vectors/points/search",
          { vector: qVec, top: topK, with_payload: false, with_vector: false }
        );
      } catch (err) {
        console.error(
          "Qdrant search error:",
          err.response?.data || err.message
        );
        qRes = { data: { result: [] } };
      }

      // map id -> { vecScore, payload }
      const vecMap = new Map();
      for (const p of qRes.data?.result || []) {
        const id = String(p.id);
        vecMap.set(id, { vecScore: p.score, payload: p.payload || {} });
      }

      console.log(vecMap);

      // 4) Fuse / объединяем
      const fused = fuseResults(bmMap, vecMap, Number(alpha));

      // 5) Подгружаем полные записи из Cassandra (messages) по id (оптимально — batch)
      const ids = fused.map((item) => item.id);
      let rowsMap = new Map();
      if (ids.length) {
        try {
          // В Cassandra IN ? работает, но если не — можно выполнить параллельно несколько запросов.
          const cassRes = await storage.getMesgByIds(ids);
          for (const r of cassRes.rows) {
            rowsMap.set(String(r.id), r);
          }
        } catch (err) {
          // fall back: делаем по одному запросу (медленнее, но надёжно)
          console.warn(
            "Cassandra IN query failed, falling back to per-id queries:",
            err.message
          );
          for (const id of ids) {
            try {
              const r = await storage.getMesgByIds(ids);
              if (r.rows.length) rowsMap.set(id, r.rows[0]);
            } catch (e) {
              /* игнорируем */
            }
          }
        }
      }

      // 6) Собираем финальный ответ: привязываем cassandra row + payload + scores
      const results = fused.map((item) => {
        const cassRow = rowsMap.get(item.id) || null;
        return {
          id: item.id,
          combinedScore: item.combined,
          bmScore: item.bmScore,
          vecScore: item.vecScore,
          payload: item.payload,
          doc: item.doc, // OpenSearch _source if present
          row: cassRow, // полная запись messages из Cassandra (может содержать file_path и т.д.)
        };
      });

      ctx.body = { results };
    } catch (err) {
      console.error("Search endpoint error:", err);
      ctx.status = 500;
      ctx.body = { error: err.message || "Internal error" };
    }
  });

  ws.on("close", () => {
    const wsIndex = clients.indexOf(ws);
    if (wsIndex !== -1) {
      clients.splice(wsIndex, 1);
    }
  });
});

server.listen(port, () => console.log("Server started"));

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    process.exit(1);
  } else {
    throw err;
  }
});
