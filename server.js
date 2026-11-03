const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3030;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'karaoke2026';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'karaoke.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Setup database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist TEXT NOT NULL,
    title TEXT NOT NULL,
    formation TEXT DEFAULT 'Solo',
    year INTEGER,
    language TEXT DEFAULT 'Français',
    available INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id INTEGER NOT NULL,
    singer_name TEXT NOT NULL,
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'waiting', -- waiting, current, done, cancelled
    position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(song_id) REFERENCES songs(id)
  );
`);

// Populate songs if table is empty
const songCount = db.prepare('SELECT COUNT(*) as count FROM songs').get().count;
if (songCount === 0) {
  const defaultSongsPath = path.join(__dirname, 'data', 'songs.json');
  if (fs.existsSync(defaultSongsPath)) {
    const rawSongs = JSON.parse(fs.readFileSync(defaultSongsPath, 'utf8'));
    const insertSong = db.prepare(`
      INSERT INTO songs (artist, title, formation, year, language, available)
      VALUES (?, ?, ?, ?, ?, 1)
    `);
    const insertMany = db.transaction((songs) => {
      for (const s of songs) {
        insertSong.run(s.artist, s.title, s.formation || 'Solo', s.year || null, s.language || 'Français');
      }
    });
    insertMany(rawSongs);
    console.log(`Seeded ${rawSongs.length} songs into database.`);
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Broadcast updates via WebSockets
function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Simple auth middleware for admin endpoints
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader === `Bearer ${ADMIN_PASSWORD}`) {
    return next();
  }
  const token = req.query.token;
  if (token && token === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ error: 'Accès non autorisé' });
}

// ----------------- Public APIs -----------------

// List available songs
app.get('/api/songs', (req, res) => {
  const search = req.query.q ? `%${req.query.q}%` : null;
  let songs;
  if (search) {
    songs = db.prepare(`
      SELECT * FROM songs 
      WHERE available = 1 AND (artist LIKE ? OR title LIKE ?)
      ORDER BY artist ASC, title ASC
    `).all(search, search);
  } else {
    songs = db.prepare(`
      SELECT * FROM songs 
      WHERE available = 1 
      ORDER BY artist ASC, title ASC
    `).all();
  }
  res.json(songs);
});

// Get current public queue
app.get('/api/queue', (req, res) => {
  const queue = db.prepare(`
    SELECT q.id, q.singer_name, q.status, q.position, q.created_at,
           s.artist, s.title, s.formation, s.language, s.year
    FROM queue q
    JOIN songs s ON q.song_id = s.id
    WHERE q.status IN ('waiting', 'current')
    ORDER BY CASE WHEN q.status = 'current' THEN 0 ELSE 1 END, q.position ASC, q.created_at ASC
  `).all();
  res.json(queue);
});

// Join queue
app.post('/api/queue', (req, res) => {
  const { song_id, singer_name, notes } = req.body;
  if (!song_id || !singer_name || !singer_name.trim()) {
    return res.status(400).json({ error: 'Chanson et nom du chanteur obligatoires.' });
  }

  const song = db.prepare('SELECT * FROM songs WHERE id = ? AND available = 1').get(song_id);
  if (!song) {
    return res.status(404).json({ error: 'Chanson non trouvée ou indisponible.' });
  }

  // Determine next position
  const maxPosRow = db.prepare("SELECT MAX(position) as maxPos FROM queue WHERE status = 'waiting'").get();
  const nextPos = (maxPosRow.maxPos || 0) + 1;

  const result = db.prepare(`
    INSERT INTO queue (song_id, singer_name, notes, status, position)
    VALUES (?, ?, ?, 'waiting', ?)
  `).run(song_id, singer_name.trim(), notes ? notes.trim() : '', nextPos);

  const newEntry = db.prepare(`
    SELECT q.id, q.singer_name, q.status, q.position, q.created_at,
           s.artist, s.title, s.formation, s.language, s.year
    FROM queue q
    JOIN songs s ON q.song_id = s.id
    WHERE q.id = ?
  `).get(result.lastInsertRowid);

  broadcast('QUEUE_UPDATED', newEntry);

  res.status(201).json(newEntry);
});

// ----------------- Admin APIs -----------------

// Verify admin login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Mot de passe incorrect' });
  }
});

// Get full queue for admin (including done/cancelled)
app.get('/api/admin/queue', authMiddleware, (req, res) => {
  const queue = db.prepare(`
    SELECT q.id, q.song_id, q.singer_name, q.notes, q.status, q.position, q.created_at,
           s.artist, s.title, s.formation, s.language, s.year
    FROM queue q
    JOIN songs s ON q.song_id = s.id
    ORDER BY 
      CASE q.status 
        WHEN 'current' THEN 0 
        WHEN 'waiting' THEN 1 
        WHEN 'done' THEN 2 
        ELSE 3 
      END,
      q.position ASC, q.created_at ASC
  `).all();
  res.json(queue);
});

// Update queue item status (current, done, cancelled, waiting)
app.patch('/api/admin/queue/:id/status', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['waiting', 'current', 'done', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide.' });
  }

  // If setting to current, set any previous current to done
  if (status === 'current') {
    db.prepare("UPDATE queue SET status = 'done' WHERE status = 'current'").run();
  }

  db.prepare('UPDATE queue SET status = ? WHERE id = ?').run(status, id);
  broadcast('QUEUE_UPDATED', { id, status });
  res.json({ success: true });
});

// Reorder waiting queue
app.post('/api/admin/queue/reorder', authMiddleware, (req, res) => {
  const { order } = req.body; // array of queue IDs in desired order
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'Format invalide.' });
  }

  const updatePos = db.prepare('UPDATE queue SET position = ? WHERE id = ?');
  const runTransaction = db.transaction((ids) => {
    ids.forEach((id, index) => {
      updatePos.run(index + 1, id);
    });
  });

  runTransaction(order);
  broadcast('QUEUE_UPDATED', { reordered: true });
  res.json({ success: true });
});

// Delete queue entry
app.delete('/api/admin/queue/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM queue WHERE id = ?').run(id);
  broadcast('QUEUE_UPDATED', { deleted: id });
  res.json({ success: true });
});

// Add new song to catalogue
app.post('/api/admin/songs', authMiddleware, (req, res) => {
  const { artist, title, formation, year, language } = req.body;
  if (!artist || !title) {
    return res.status(400).json({ error: 'Artiste et titre requis.' });
  }

  const result = db.prepare(`
    INSERT INTO songs (artist, title, formation, year, language, available)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(artist.trim(), title.trim(), formation || 'Solo', year ? parseInt(year) : null, language || 'Français');

  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(result.lastInsertRowid);
  broadcast('SONGS_UPDATED', song);
  res.status(201).json(song);
});

// Update existing song in catalogue
app.put('/api/admin/songs/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { artist, title, formation, year, language, available } = req.body;
  if (!artist || !title) {
    return res.status(400).json({ error: 'Artiste et titre requis.' });
  }

  db.prepare(`
    UPDATE songs 
    SET artist = ?, title = ?, formation = ?, year = ?, language = ?, available = ?
    WHERE id = ?
  `).run(
    artist.trim(),
    title.trim(),
    formation || 'Solo',
    year ? parseInt(year) : null,
    language || 'Français',
    available !== undefined ? (available ? 1 : 0) : 1,
    id
  );

  const updatedSong = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
  broadcast('SONGS_UPDATED', updatedSong);
  res.json(updatedSong);
});

// Delete song from catalogue
app.delete('/api/admin/songs/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM songs WHERE id = ?').run(id);
  broadcast('SONGS_UPDATED', { deleted: id });
  res.json({ success: true });
});

// List ALL songs for admin (including unavailable)
app.get('/api/admin/songs', authMiddleware, (req, res) => {
  const songs = db.prepare('SELECT * FROM songs ORDER BY artist ASC, title ASC').all();
  res.json(songs);
});

// Toggle song availability
app.patch('/api/admin/songs/:id/toggle', authMiddleware, (req, res) => {
  const { id } = req.params;
  const song = db.prepare('SELECT available FROM songs WHERE id = ?').get(id);
  if (!song) return res.status(404).json({ error: 'Chanson non trouvée' });

  const newStatus = song.available ? 0 : 1;
  db.prepare('UPDATE songs SET available = ? WHERE id = ?').run(newStatus, id);
  broadcast('SONGS_UPDATED', { id, available: newStatus });
  res.json({ success: true, available: newStatus });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎤 Karaoke Live Server running on http://0.0.0.0:${PORT}`);
});
