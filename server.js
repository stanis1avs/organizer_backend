require("dotenv").config();
const http = require("http");
const crypto = require("crypto");
const WS = require("ws");
const Koa = require("koa");
const koaBody = require("koa-body");
const koaStatic = require("koa-static");
const Router = require("koa-router");
const cors = require("koa2-cors");
const path = require("path");
const Storage = require("./Storage");
const { searchHybrid } = require("./hybridSearch");

// S-08: токен доступа к статическим файлам.
// Задаётся через FILES_TOKEN env; если не задан — генерируется случайно при старте.
const FILES_TOKEN = process.env.FILES_TOKEN || crypto.randomBytes(32).toString("hex");

const app = new Koa();
const router = new Router();

const filesDir = path.join(__dirname, "files");

app.use(
  koaBody({
    multipart: true,
    formidable: {
      uploadDir: filesDir,
      keepExtensions: true,
      filename: (_name, ext, part) => {
        const safe = path.basename(part.originalFilename || part.name || `${Date.now()}${ext}`);
        return safe;
      },
    },
  })
);

// S-08: защита статических файлов токеном.
// API-маршруты (/upload, /search) пропускаются без проверки.
// Если FILES_TOKEN не задан в env — механизм отключён (не должно быть в prod).
app.use(async (ctx, next) => {
  const isApiRoute = ctx.path === "/upload" || ctx.path === "/search";
  if (!isApiRoute && ctx.query.token !== FILES_TOKEN) {
    ctx.status = 401;
    ctx.body = { error: "Unauthorized" };
    return;
  }
  return next();
});
app.use(koaStatic(filesDir));

app.use(
  cors({
    origin: (ctx) => {
      const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:8080,http://127.0.0.1:8080").split(",");
      const requestOrigin = ctx.request.headers.origin;
      if (!requestOrigin) return allowedOrigins[0];
      return allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
  })
);

app.on("error", (err, ctx) => {
  console.error("Koa app error:", err.message, ctx?.path);
});

// Глобальный обработчик необработанных отклонений промисов
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

app.use(router.routes()).use(router.allowedMethods());

const port = process.env.PORT || 7000;
const server = http.createServer(app.callback());
const wsServer = new WS.Server({ server });

//=======================================

const clients = [];

const sharedStorage = new Storage(null, clients, filesDir, FILES_TOKEN);

router.post("/upload", async (ctx) => {
  try {
    const file = ctx.request.files?.file || ctx.request.files?.body;
    if (!file) {
      ctx.status = 400;
      ctx.body = { error: "No file provided" };
      return;
    }
    const result = await sharedStorage.loadFile(file, ctx.request.body);
    sharedStorage.wsAllSend({ ...result, event: "showFile" });
    ctx.response.status = 204;
  } catch (err) {
    console.error("Upload error:", err.message);
    ctx.status = 500;
    ctx.body = { error: "Upload failed", details: err.message };
  }
});

router.post("/search", async (ctx) => {
  try {
    const {
      query,
      topK = 10,
      alpha = 0.6,
      searchType = "all", // 'all', 'text', 'image'
    } = ctx.request.body || {};

    if (!query || typeof query !== "string" || !query.trim()) {
      ctx.status = 400;
      ctx.body = { error: "Query text is required" };
      return;
    }

    const effectiveAlpha = Number(alpha) || 0.6;
    const searchResults = await searchHybrid(query, topK, searchType, effectiveAlpha, effectiveAlpha);

    const messageIds = searchResults.map((result) => result.id);

    let rowsMap = new Map();
    if (messageIds.length > 0) {
      try {
        const cassandraResult = await sharedStorage.getMesgByIds(messageIds);
        cassandraResult.rows.forEach((row) => {
          rowsMap.set(row.id.toString(), row);
        });
      } catch (err) {
        console.error("Cassandra query failed:", err.message);
        for (const id of messageIds) {
          try {
            const r = await sharedStorage.getMesgByIds([id]);
            if (r.rows.length) rowsMap.set(id.toString(), r.rows[0]);
          } catch (e) {
            console.error("Failed to fetch message:", id, e.message);
          }
        }
      }
    }

    const results = searchResults.map((item) => {
      const cassRow = rowsMap.get(item.id.toString());
      return {
        id: item.id,
        combinedScore: item.combined,
        bmScore: item.bmScore,
        vecScore: item.vecScore,
        message: cassRow?.message || item.payload?.text || "",
        date: cassRow?.date || item.payload?.date,
        type: cassRow?.type || item.payload?.type || "unknown",
        geo: cassRow?.geo || null,
        file_path: cassRow?.file_path || null,
      };
    });

    ctx.body = { results };
  } catch (error) {
    console.error("Search error:", error);
    ctx.status = 500;
    ctx.body = { error: "Search failed", details: error.message };
  }
});

wsServer.on("connection", (ws) => {
  clients.push(ws);
  // Каждое WS-соединение получает свой Storage для wsSend (ответ только этому клиенту)
  const storage = new Storage(ws, clients, filesDir, FILES_TOKEN);
  storage.init();

  ws.on("close", () => {
    const wsIndex = clients.indexOf(ws);
    if (wsIndex !== -1) {
      clients.splice(wsIndex, 1);
    }
  });
});

server.listen(port, () => console.log(`Server started on port ${port}`));

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use.`);
    process.exit(1);
  } else {
    throw err;
  }
});
