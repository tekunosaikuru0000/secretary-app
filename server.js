// 自分専用の秘書アプリ - サーバー本体
// Node.js標準モジュールのみを使用(npm install不要で動作します)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const PRIORITIES = ['高', '中', '低'];
const CATEGORIES = ['仕事', '勉強', '趣味', '買い物', 'その他'];

// ---------- データ永続化まわり ----------

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, '[]', 'utf-8');
  if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '[]', 'utf-8');
  if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, '[]', 'utf-8');
}

function readJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function getNotes() {
  return readJSON(NOTES_FILE);
}

function saveNotes(notes) {
  writeJSON(NOTES_FILE, notes);
}

// タスクは古いデータ形式(項目が足りない場合)にも対応できるよう、
// 読み込み時に不足項目をデフォルト値で補う
function getTasks() {
  const tasks = readJSON(TASKS_FILE);
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    dueDate: t.dueDate || null,
    priority: PRIORITIES.includes(t.priority) ? t.priority : '中',
    category: CATEGORIES.includes(t.category) ? t.category : 'その他',
    done: !!t.done,
    createdAt: t.createdAt,
  }));
}

function saveTasks(tasks) {
  writeJSON(TASKS_FILE, tasks);
}

function getEvents() {
  const events = readJSON(EVENTS_FILE);
  return events.map((e) => ({
    id: e.id,
    title: e.title,
    details: e.details || '',
    date: e.date,
    createdAt: e.createdAt,
  }));
}

function saveEvents(events) {
  writeJSON(EVENTS_FILE, events);
}

// ---------- リクエストボディの読み取り ----------

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// 日付文字列(YYYY-MM-DD)かどうかの簡易チェック
function isValidDateString(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str);
}

// ---------- 静的ファイル配信 ----------

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(PUBLIC_DIR, filePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- APIハンドラ ----------

async function handleApi(req, res, pathname) {
  const method = req.method;

  // ===== メモ =====
  if (pathname === '/api/notes' && method === 'GET') {
    return sendJSON(res, 200, getNotes());
  }

  if (pathname === '/api/notes' && method === 'POST') {
    const body = await readRequestBody(req);
    const title = (body.title || '').toString().trim();
    const content = (body.content || '').toString().trim();
    if (!title && !content) {
      return sendJSON(res, 400, { error: 'タイトルまたは本文を入力してください' });
    }
    const notes = getNotes();
    const newNote = {
      id: crypto.randomUUID(),
      title: title || '(無題)',
      content,
      createdAt: new Date().toISOString(),
    };
    notes.unshift(newNote);
    saveNotes(notes);
    return sendJSON(res, 201, newNote);
  }

  const noteMatch = pathname.match(/^\/api\/notes\/([^/]+)$/);
  if (noteMatch && method === 'DELETE') {
    const id = noteMatch[1];
    let notes = getNotes();
    const before = notes.length;
    notes = notes.filter((n) => n.id !== id);
    saveNotes(notes);
    if (notes.length === before) {
      return sendJSON(res, 404, { error: 'メモが見つかりません' });
    }
    return sendJSON(res, 200, { success: true });
  }

  // ===== タスク =====
  if (pathname === '/api/tasks' && method === 'GET') {
    return sendJSON(res, 200, getTasks());
  }

  if (pathname === '/api/tasks' && method === 'POST') {
    const body = await readRequestBody(req);
    const title = (body.title || '').toString().trim();
    if (!title) {
      return sendJSON(res, 400, { error: 'タスク名を入力してください' });
    }
    const dueDate = isValidDateString(body.dueDate) ? body.dueDate : null;
    const priority = PRIORITIES.includes(body.priority) ? body.priority : '中';
    const category = CATEGORIES.includes(body.category) ? body.category : 'その他';

    const tasks = getTasks();
    const newTask = {
      id: crypto.randomUUID(),
      title,
      dueDate,
      priority,
      category,
      done: false,
      createdAt: new Date().toISOString(),
    };
    tasks.unshift(newTask);
    saveTasks(tasks);
    return sendJSON(res, 201, newTask);
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && method === 'PATCH') {
    const id = taskMatch[1];
    const body = await readRequestBody(req);
    const tasks = getTasks();
    const task = tasks.find((t) => t.id === id);
    if (!task) {
      return sendJSON(res, 404, { error: 'タスクが見つかりません' });
    }
    if (typeof body.done === 'boolean') task.done = body.done;
    if (typeof body.title === 'string' && body.title.trim()) task.title = body.title.trim();
    if (body.dueDate === null || isValidDateString(body.dueDate)) task.dueDate = body.dueDate;
    if (PRIORITIES.includes(body.priority)) task.priority = body.priority;
    if (CATEGORIES.includes(body.category)) task.category = body.category;
    saveTasks(tasks);
    return sendJSON(res, 200, task);
  }

  if (taskMatch && method === 'DELETE') {
    const id = taskMatch[1];
    let tasks = getTasks();
    const before = tasks.length;
    tasks = tasks.filter((t) => t.id !== id);
    saveTasks(tasks);
    if (tasks.length === before) {
      return sendJSON(res, 404, { error: 'タスクが見つかりません' });
    }
    return sendJSON(res, 200, { success: true });
  }

  // ===== 予定(カレンダー用) =====
  if (pathname === '/api/events' && method === 'GET') {
    return sendJSON(res, 200, getEvents());
  }

  if (pathname === '/api/events' && method === 'POST') {
    const body = await readRequestBody(req);
    const title = (body.title || '').toString().trim();
    const details = (body.details || '').toString().trim();
    if (!title) {
      return sendJSON(res, 400, { error: '予定の内容を入力してください' });
    }
    const date = isValidDateString(body.date)
      ? body.date
      : new Date().toISOString().slice(0, 10);
    const events = getEvents();
    const newEvent = {
      id: crypto.randomUUID(),
      title,
      details,
      date,
      createdAt: new Date().toISOString(),
    };
    events.unshift(newEvent);
    saveEvents(events);
    return sendJSON(res, 201, newEvent);
  }

  const eventMatch = pathname.match(/^\/api\/events\/([^/]+)$/);
  if (eventMatch && method === 'DELETE') {
    const id = eventMatch[1];
    let events = getEvents();
    const before = events.length;
    events = events.filter((e) => e.id !== id);
    saveEvents(events);
    if (events.length === before) {
      return sendJSON(res, 404, { error: '予定が見つかりません' });
    }
    return sendJSON(res, 200, { success: true });
  }

  // ===== ダッシュボード用サマリー =====
  if (pathname === '/api/summary' && method === 'GET') {
    const notes = getNotes();
    const tasks = getTasks();
    const incomplete = tasks.filter((t) => !t.done).length;
    return sendJSON(res, 200, {
      noteCount: notes.length,
      taskCount: tasks.length,
      incompleteTaskCount: incomplete,
    });
  }

  sendJSON(res, 404, { error: 'Not Found' });
}

// ---------- サーバー起動 ----------

ensureDataFiles();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => {
      sendJSON(res, 500, { error: err.message || 'Internal Server Error' });
    });
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`秘書アプリを起動しました: http://localhost:${PORT}`);
});
