const http = require("http");
const WS = require("ws");
const Koa = require("koa");
const koaBody = require("koa-body");
const koaStatic = require("koa-static");
const Router = require("koa-router");
const cors = require("koa2-cors");
const path = require("path");
const Storage = require("./Storage");
const { searchHybrid } = require("./hybridSearch");

const app = new Koa();
const router = new Router();

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
        searchType = 'all' // 'all', 'text', 'image'
      } = ctx.request.body || {};
      if (!query || typeof query !== "string" || !query.trim()) {
        ctx.status = 400;
        ctx.body = { error: "Query text is required" };
        return;
      }

      // Use hybrid search function
      const searchResults = await searchHybrid(query, topK, searchType);
      
      // Get message IDs from search results
      const messageIds = searchResults.map(result => result.id);
      
      // Fetch full messages from Cassandra
      let rowsMap = new Map();
      if (messageIds.length > 0) {
        try {
          const cassandraResult = await storage.getMesgByIds(messageIds);
          cassandraResult.rows.forEach(row => {
            rowsMap.set(row.id.toString(), row);
          });
        } catch (err) {
          console.error("Cassandra query failed:", err.message);
          // Fallback to individual queries
          for (const id of messageIds) {
            try {
              const r = await storage.getMesgByIds([id]);
              if (r.rows.length) rowsMap.set(id, r.rows[0]);
            } catch (e) {
              console.error("Failed to fetch message:", id, e.message);
            }
          }
        }
      }

      // Combine search results with Cassandra data
      const results = searchResults.map(item => {
        const cassRow = rowsMap.get(item.id);
        return {
          id: item.id,
          combinedScore: item.combined,
          bmScore: item.bmScore,
          vecScore: item.vecScore,
          message: cassRow?.message || item.payload?.text || '',
          date: cassRow?.date || item.payload?.date,
          type: cassRow?.type || item.payload?.type || 'unknown',
          geo: cassRow?.geo || null,
          file_path: cassRow?.file_path || null
        };
      });

      ctx.body = { results };
    } catch (error) {
      console.error("Search error:", error);
      ctx.status = 500;
      ctx.body = { error: "Search failed", details: error.message };
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
