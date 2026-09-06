'use strict';

// 本機靜態伺服器：讓瀏覽器能以 HTTP 讀取 Judge.md。
//
// 為什麼需要這支程式：瀏覽器的 CORS 政策會阻擋 file:// 協定下的 fetch()，
// 因此直接雙擊 index.html 無法取得 Judge.md。必須透過 HTTP 提供頁面。
//
// 文件根目錄是「專案根目錄」而非 site/，因為 Judge.md 位於上一層；
// 若以 site/ 為根，頁面就無法向上讀取到它。
//
// 只使用 Node 內建模組，不依賴任何 npm 套件。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOST = '127.0.0.1';
const PORT_FIRST = 8080;
const PORT_LAST = 8090;

// 專案根目錄（site/ 的上一層）
const ROOT = path.resolve(__dirname, '..');
const ENTRY_PATH = '/site/index.html';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * 將請求 URL 對應到根目錄底下的實體檔案路徑。
 * 解析後必須仍位於根目錄內，否則視為路徑穿越攻擊而拒絕（回傳 null）。
 */
function resolveRequestPath(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  } catch {
    return null; // URL 編碼有誤
  }

  if (pathname.endsWith('/')) {
    pathname += 'index.html';
  }

  const resolved = path.resolve(ROOT, '.' + pathname);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    return null; // 越出根目錄
  }
  return resolved;
}

function sendPlain(res, statusCode, message) {
  const body = Buffer.from(message, 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendPlain(res, 405, '405 Method Not Allowed');
    return;
  }

  const filePath = resolveRequestPath(req.url);
  if (filePath === null) {
    sendPlain(res, 400, '400 Bad Request');
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      // 讓頁面端的錯誤區塊能分辨「檔案不存在」與其他失敗
      sendPlain(res, 404, '404 Not Found');
      return;
    }

    // 一律 no-store。這是「編輯 Judge.md 後按 F5 就看到新內容」的必要條件——
    // 任何快取都可能讓重新整理拿到舊副本，而那正是這個專案要消滅的問題。
    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': stats.size,
      'Cache-Control': 'no-store',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      res.destroy();
    });
    stream.pipe(res);
  });
});

// 依序嘗試 PORT_FIRST..PORT_LAST。全部占用時印出訊息並以非零狀態碼結束，
// 不靜默失敗。
//
// 監聽器只各註冊一次：若改用 server.listen(port, host, callback) 的形式，
// 每次重試都會多掛一個一次性的 listening 監聽器，而失敗那次的監聽器不會被
// 清除，等到某個埠成功時全部一起觸發，導致重複輸出並重複開啟瀏覽器。
let currentPort = PORT_FIRST;
let listening = false;

server.on('error', (err) => {
  if (!listening && err.code === 'EADDRINUSE') {
    currentPort += 1;
    if (currentPort > PORT_LAST) {
      console.error(
        `無法啟動伺服器：連接埠 ${PORT_FIRST} 至 ${PORT_LAST} 全部被占用。\n` +
          '請關閉占用這些連接埠的程式後再試一次。'
      );
      process.exit(1);
    }
    server.listen(currentPort, HOST);
    return;
  }

  console.error(`伺服器錯誤：${err.message}`);
  process.exit(1);
});

server.on('listening', () => {
  listening = true;
  const port = server.address().port;
  const url = `http://${HOST}:${port}${ENTRY_PATH}`;
  console.log('Judge 文件閱讀器已啟動');
  console.log(`  網址：${url}`);
  console.log(`  根目錄：${ROOT}`);
  console.log('');
  console.log('關閉此視窗或按 Ctrl+C 即可停止伺服器。');
  openInBrowser(url);
});

function openInBrowser(url) {
  let command;
  let args;

  if (process.platform === 'win32') {
    // start 的第一個引數會被當成視窗標題，因此補一個空字串佔位
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    // 開啟瀏覽器失敗不是致命錯誤——使用者仍可自行複製上方網址
    child.on('error', () => {
      console.log('（無法自動開啟瀏覽器，請手動開啟上方網址）');
    });
    child.unref();
  } catch {
    console.log('（無法自動開啟瀏覽器，請手動開啟上方網址）');
  }
}

server.listen(currentPort, HOST);
