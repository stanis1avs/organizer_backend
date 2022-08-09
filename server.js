const http = require('http');
const WS = require('ws');
const Koa = require('koa');
const koaBody = require('koa-body');
const koaStatic = require('koa-static');
const Router = require('koa-router');
const cors = require('koa2-cors');
const path = require('path');
const Storage = require('./Storage');

const app = new Koa();
const router = new Router();

// Body Parsers
app.use(koaBody({ json: true, text: true, urlencoded: true, multipart: true}));

// CORS
app.use(
  cors({
    origin: '*',
    credentials: true,
    'Access-Control-Allow-Origin': true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
  })
);

app.use(router.routes()).use(router.allowedMethods());

const filesDir = path.join(__dirname, '/files');
app.use(koaStatic(filesDir));

const port = process.env.PORT || 7129;
const server = http.createServer(app.callback());
const wsServer = new WS.Server({ server });

//=======================================
let dB = [
  {id: '123', message: 'Тестовый текст', date: '01:01:2022, 18:15', geo: '', type: 'text'},
  {id: '124', message: 'Треугольник строится снизу-вверх отрисовкой линиями', date: '14:02:2022, 18:00', geo: '', type: 'text', pinned: true},
  {id: '125', message: 'Fiona_Flower__Di_Young.MP4', date: '21:01:2022, 01:15', type: 'video'},
  {id: '126', message: 'gosoundtrack.mp3', date: '19:03:2022, 12:15', geo: '51.692493, 37.607834', type: 'audio'},
  {id: '127', message: 'js.jpg', date: '19:03:2022, 12:16', geo: '51.692493, 37.607834', type: 'image'},
  {id: '128', message: 'alphabet.pdf', date: '19:03:2022, 12:17', geo: '51.692493, 37.607834', type: 'file'},
  {id: '129', message: 'https://yandex.ru', date: '19:03:2022, 12:18', geo: '51.692493, 37.607834', type: 'links'}
];

const category = {
  video: [
    { name: 'Fiona_Flower__Di_Young.MP4', id: '125' },
  ],
  audio: [
    { name: 'gosoundtrack.mp3', id: '126' },
  ],
  image: [
    { name: 'js.jpg', id: '127' },
  ],
  file: [
    { name: 'alphabet.pdf', id: '128' },
  ],
  links: [
    { name: 'https://yandex.ru', id: '129' },
  ]
};
const favorites = new Set(['123', '125']);

const clients = [];
wsServer.on('connection', (ws) => {
  clients.push(ws);
  const storage = new Storage(dB, filesDir, category, favorites, ws, clients);
  storage.init();

  router.post('/upload', async (ctx) => {
    storage.loadFile(ctx.request.files.body, ctx.request.body).then((result) => {
      storage.wsAllSend({ ...result, event: 'showFile' });
    });
    ctx.response.status = 204;
  });

  ws.on('close', () => {
    const wsIndex = clients.indexOf(ws);
    if (wsIndex !== -1) {
      clients.splice(wsIndex, 1);
    }
  });
});

server.listen(port, () => console.log('Server started'));