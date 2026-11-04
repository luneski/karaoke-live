require('dotenv').config();
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
const SONGS_JSON_PATH = process.env.SONGS_JSON_PATH || path.join(__dirname, 'data', 'songs.json');
const USER_AGENT = 'KaraokeLive/1.0 (https://karaoke.lafraternelledemareau.fr)';

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
    cover_url TEXT,
    lyrics TEXT,
    synced_lyrics TEXT,
    album TEXT,
    genre TEXT,
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
    passed_at DATETIME,
    FOREIGN KEY(song_id) REFERENCES songs(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist TEXT NOT NULL,
    title TEXT NOT NULL,
    suggested_by TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'pending', -- pending, accepted, dismissed
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Default settings
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('registrations_open', '1')").run();

// Settings helpers
function getSetting(key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Backup directory
const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Lightweight in-memory rate limiter per IP
const ipRateLimitMap = new Map();
function checkIpRateLimit(ip, maxRequests = 3, windowMs = 120000) {
  const now = Date.now();
  let timestamps = ipRateLimitMap.get(ip) || [];
  timestamps = timestamps.filter(t => now - t < windowMs);
  if (timestamps.length >= maxRequests) {
    return false;
  }
  timestamps.push(now);
  ipRateLimitMap.set(ip, timestamps);
  return true;
}

// ----------------- SQLite Schema Migration -----------------
// Check existing columns in 'songs' table and add missing ones
const expectedSongColumns = [
  { name: 'cover_url', type: 'TEXT' },
  { name: 'lyrics', type: 'TEXT' },
  { name: 'synced_lyrics', type: 'TEXT' },
  { name: 'album', type: 'TEXT' },
  { name: 'genre', type: 'TEXT' }
];

const songTableInfo = db.prepare('PRAGMA table_info(songs)').all();
const existingSongColumns = new Set(songTableInfo.map((col) => col.name));

for (const col of expectedSongColumns) {
  if (!existingSongColumns.has(col.name)) {
    db.prepare(`ALTER TABLE songs ADD COLUMN ${col.name} ${col.type}`).run();
    console.log(`[Migration] Added column '${col.name}' to 'songs' table.`);
  }
}

// Check existing columns in 'queue' table
const queueTableInfo = db.prepare('PRAGMA table_info(queue)').all();
const existingQueueColumns = new Set(queueTableInfo.map((col) => col.name));
if (!existingQueueColumns.has('passed_at')) {
  db.prepare('ALTER TABLE queue ADD COLUMN passed_at DATETIME').run();
  console.log("[Migration] Added column 'passed_at' to 'queue' table.");
}

// Populate songs if table is empty
const songCount = db.prepare('SELECT COUNT(*) as count FROM songs').get().count;
if (songCount === 0) {
  const defaultSongsPath = path.join(__dirname, 'data', 'songs.json');
  if (fs.existsSync(defaultSongsPath)) {
    const rawSongs = JSON.parse(fs.readFileSync(defaultSongsPath, 'utf8'));
    const insertSong = db.prepare(`
      INSERT INTO songs (
        artist, title, formation, year, language,
        cover_url, lyrics, synced_lyrics, album, genre,
        available
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const insertMany = db.transaction((songs) => {
      for (const s of songs) {
        insertSong.run(
          s.artist,
          s.title,
          s.formation || 'Solo',
          s.year ? parseInt(s.year, 10) : null,
          s.language || 'Français',
          s.cover_url || null,
          s.lyrics || null,
          s.synced_lyrics || null,
          s.album || null,
          s.genre || null
        );
      }
    });
    insertMany(rawSongs);
    console.log(`Seeded ${rawSongs.length} songs into database.`);
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Healthcheck endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

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

// ----------------- External Services (Indexer & Lyrics) -----------------

/**
 * Helper to upgrade iTunes artwork to HD (600x600)
 */
function getHdItunesCover(artworkUrl) {
  if (!artworkUrl) return null;
  return artworkUrl.replace(/\/\d+x\d+bb\./, '/600x600bb.');
}

/**
 * Resilient music indexer using iTunes Search API with Deezer API fallback.
 * Returns: artist, title, album, year, genre, cover_url (HD 600x600)
 */
async function searchMusic(query) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  const cleanQuery = query.trim();

  // 1. Try iTunes Search API
  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanQuery)}&entity=song&limit=15`;
    const response = await fetch(itunesUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(6000)
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data.results) && data.results.length > 0) {
        return data.results.map((track) => ({
          artist: track.artistName || 'Artiste inconnu',
          title: track.trackName || 'Titre inconnu',
          album: track.collectionName || null,
          year: track.releaseDate ? new Date(track.releaseDate).getFullYear() : null,
          genre: track.primaryGenreName || null,
          cover_url: getHdItunesCover(track.artworkUrl100)
        }));
      }
    }
  } catch (err) {
    console.warn(`[Indexer] iTunes search failed for "${cleanQuery}": ${err.message}. Trying Deezer fallback.`);
  }

  // 2. Deezer API Fallback
  try {
    const deezerUrl = `https://api.deezer.com/search?q=${encodeURIComponent(cleanQuery)}&limit=15`;
    const deezerResponse = await fetch(deezerUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(6000)
    });

    if (deezerResponse.ok) {
      const data = await deezerResponse.json();
      if (Array.isArray(data.data) && data.data.length > 0) {
        return data.data.map((item) => ({
          artist: item.artist?.name || 'Artiste inconnu',
          title: item.title || 'Titre inconnu',
          album: item.album?.title || null,
          year: null,
          genre: null,
          cover_url:
            item.album?.cover_xl ||
            item.album?.cover_big ||
            item.album?.cover_medium ||
            item.album?.cover ||
            null
        }));
      }
    }
  } catch (err) {
    console.warn(`[Indexer] Deezer fallback search failed for "${cleanQuery}": ${err.message}`);
  }

  return [];
}

/**
 * Search cover candidates across iTunes (limit 25) and Deezer (limit 15).
 * Deduplicates by cover_url, filters null/empty covers.
 * Returns array of:
 * { cover_url, artist, title, album, year, provider: 'iTunes' | 'Deezer' }
 */
async function searchCoverCandidates(query) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }

  const cleanQuery = query.trim();

  const [itunesRes, deezerRes] = await Promise.allSettled([
    // 1. iTunes Search API (limit=25)
    (async () => {
      const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanQuery)}&entity=song&limit=25`;
      const response = await fetch(itunesUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok) return [];
      const data = await response.json();
      if (!Array.isArray(data.results)) return [];
      return data.results.map((track) => ({
        cover_url: getHdItunesCover(track.artworkUrl100),
        artist: track.artistName || 'Artiste inconnu',
        title: track.trackName || 'Titre inconnu',
        album: track.collectionName || null,
        year: track.releaseDate ? new Date(track.releaseDate).getFullYear() : null,
        provider: 'iTunes'
      }));
    })(),

    // 2. Deezer Search API (limit=15)
    (async () => {
      const deezerUrl = `https://api.deezer.com/search?q=${encodeURIComponent(cleanQuery)}&limit=15`;
      const response = await fetch(deezerUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok) return [];
      const data = await response.json();
      if (!Array.isArray(data.data)) return [];
      return data.data.map((item) => ({
        cover_url:
          item.album?.cover_xl ||
          item.album?.cover_big ||
          item.album?.cover_medium ||
          item.album?.cover ||
          null,
        artist: item.artist?.name || 'Artiste inconnu',
        title: item.title || 'Titre inconnu',
        album: item.album?.title || null,
        year: null,
        provider: 'Deezer'
      }));
    })()
  ]);

  const rawItunes = itunesRes.status === 'fulfilled' ? itunesRes.value : [];
  if (itunesRes.status === 'rejected') {
    console.warn(`[Cover Candidates] iTunes search failed for "${cleanQuery}": ${itunesRes.reason?.message}`);
  }

  const rawDeezer = deezerRes.status === 'fulfilled' ? deezerRes.value : [];
  if (deezerRes.status === 'rejected') {
    console.warn(`[Cover Candidates] Deezer search failed for "${cleanQuery}": ${deezerRes.reason?.message}`);
  }

  const seenCovers = new Set();
  const candidates = [];

  for (const item of [...rawItunes, ...rawDeezer]) {
    if (item && item.cover_url && typeof item.cover_url === 'string') {
      const trimmedUrl = item.cover_url.trim();
      if (trimmedUrl && !seenCovers.has(trimmedUrl)) {
        seenCovers.add(trimmedUrl);
        candidates.push({
          cover_url: trimmedUrl,
          artist: item.artist,
          title: item.title,
          album: item.album,
          year: item.year,
          provider: item.provider
        });
      }
    }
  }

  return candidates;
}

/**
 * Resilient lyrics fetcher using LRCLIB API.
 * Tries /api/get first, falls back to /api/search.
 * Returns: { artist, title, lyrics, synced_lyrics, found }
 */
async function fetchLyrics(artist, title) {
  if (!artist || !title) {
    return {
      artist: artist || '',
      title: title || '',
      lyrics: null,
      synced_lyrics: null,
      found: false
    };
  }

  const cleanArtist = artist.trim();
  const cleanTitle = title.trim();

  // 1. Try LRCLIB exact get
  try {
    const getUrl = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(cleanArtist)}&track_name=${encodeURIComponent(cleanTitle)}`;
    const res = await fetch(getUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(6000)
    });

    if (res.ok) {
      const data = await res.json();
      if (data && (data.plainLyrics || data.syncedLyrics)) {
        return {
          artist: data.artistName || cleanArtist,
          title: data.trackName || cleanTitle,
          lyrics: data.plainLyrics || null,
          synced_lyrics: data.syncedLyrics || null,
          found: true
        };
      }
    }
  } catch (err) {
    console.warn(`[Lyrics] LRCLIB get failed for "${cleanArtist} - ${cleanTitle}": ${err.message}`);
  }

  // 2. Try LRCLIB search by track_name & artist_name
  try {
    const searchUrl = `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(cleanArtist)}`;
    const searchRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(6000)
    });

    if (searchRes.ok) {
      const list = await searchRes.json();
      if (Array.isArray(list) && list.length > 0) {
        const match = list.find((item) => item.plainLyrics || item.syncedLyrics);
        if (match) {
          return {
            artist: match.artistName || cleanArtist,
            title: match.trackName || cleanTitle,
            lyrics: match.plainLyrics || null,
            synced_lyrics: match.syncedLyrics || null,
            found: true
          };
        }
      }
    }
  } catch (err) {
    console.warn(`[Lyrics] LRCLIB search failed for "${cleanArtist} - ${cleanTitle}": ${err.message}`);
  }

  // 3. Try LRCLIB general query search
  try {
    const queryUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanArtist} ${cleanTitle}`)}`;
    const queryRes = await fetch(queryUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(6000)
    });

    if (queryRes.ok) {
      const list = await queryRes.json();
      if (Array.isArray(list) && list.length > 0) {
        const match = list.find((item) => item.plainLyrics || item.syncedLyrics);
        if (match) {
          return {
            artist: match.artistName || cleanArtist,
            title: match.trackName || cleanTitle,
            lyrics: match.plainLyrics || null,
            synced_lyrics: match.syncedLyrics || null,
            found: true
          };
        }
      }
    }
  } catch (err) {
    console.warn(`[Lyrics] LRCLIB general query search failed for "${cleanArtist} ${cleanTitle}": ${err.message}`);
  }

  return {
    artist: cleanArtist,
    title: cleanTitle,
    lyrics: null,
    synced_lyrics: null,
    found: false
  };
}

/**
 * Backfill covers, album, genre, year, and lyrics for songs missing covers.
 * Rate-limited to prevent external API throttling.
 */
async function backfillMissingCovers({
  dbInstance = db,
  indexer = searchMusic,
  lyricsFetcher = fetchLyrics,
  songsJsonPath = SONGS_JSON_PATH,
  delayMs = 250,
  onProgress = null
} = {}) {
  const missingSongs = dbInstance.prepare(`
    SELECT * FROM songs 
    WHERE cover_url IS NULL OR cover_url = ''
    ORDER BY id ASC
  `).all();

  const totalMissing = missingSongs.length;
  let enrichedCount = 0;

  for (let i = 0; i < missingSongs.length; i++) {
    const song = missingSongs[i];
    let isEnriched = false;

    try {
      // 1. Music Indexer search (iTunes with Deezer fallback)
      let match = null;
      let results = await indexer(`${song.artist} ${song.title}`);
      if (!results || results.length === 0) {
        results = await indexer(song.title);
      }
      if (results && results.length > 0) {
        match = results.find((r) => r.cover_url) || results[0];
      }

      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      // 2. Lyrics fetch if missing
      let newLyrics = song.lyrics || null;
      let newSyncedLyrics = song.synced_lyrics || null;
      if (!newLyrics || !newLyrics.trim()) {
        try {
          const lyricsRes = await lyricsFetcher(song.artist, song.title);
          if (lyricsRes && lyricsRes.found && lyricsRes.lyrics) {
            newLyrics = lyricsRes.lyrics;
            newSyncedLyrics = lyricsRes.synced_lyrics || newSyncedLyrics;
            isEnriched = true;
          }
        } catch (lErr) {
          console.warn(`[Backfill] Lyrics fetch error for ${song.artist} - ${song.title}: ${lErr.message}`);
        }

        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      // 3. Metadata updates
      const updatedCoverUrl = (match && match.cover_url) ? match.cover_url : (song.cover_url || null);
      const updatedAlbum = (match && match.album) ? match.album : (song.album || null);
      const updatedGenre = (match && match.genre) ? match.genre : (song.genre || null);
      const updatedYear = song.year ? song.year : (match && match.year ? match.year : null);

      if (match) {
        isEnriched = true;
      }

      if (isEnriched) {
        dbInstance.prepare(`
          UPDATE songs
          SET cover_url = ?, album = ?, genre = ?, year = ?, lyrics = ?, synced_lyrics = ?
          WHERE id = ?
        `).run(
          updatedCoverUrl,
          updatedAlbum,
          updatedGenre,
          updatedYear,
          newLyrics,
          newSyncedLyrics,
          song.id
        );
        enrichedCount++;
      }

      if (onProgress) {
        onProgress({
          index: i + 1,
          total: totalMissing,
          artist: song.artist,
          title: song.title,
          status: isEnriched ? 'Done' : 'No match'
        });
      }
    } catch (err) {
      console.error(`[Backfill] Error enriching ${song.artist} - ${song.title}:`, err.message);
      if (onProgress) {
        onProgress({
          index: i + 1,
          total: totalMissing,
          artist: song.artist,
          title: song.title,
          status: `Failed: ${err.message}`
        });
      }
    }
  }

  // Synchronize data/songs.json if path provided and directory exists
  if (songsJsonPath && fs.existsSync(path.dirname(songsJsonPath))) {
    try {
      const allSongs = dbInstance.prepare('SELECT * FROM songs ORDER BY id ASC').all();
      fs.writeFileSync(songsJsonPath, JSON.stringify(allSongs, null, 2), 'utf8');
      console.log(`[Backfill] Synchronized ${allSongs.length} songs to ${songsJsonPath}`);
    } catch (syncErr) {
      console.error(`[Backfill] Failed to synchronize songs.json:`, syncErr.message);
    }
  }

  return { totalMissing, enrichedCount };
}

// ----------------- Public APIs -----------------

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

// List available songs (includes cover_url, album, genre)
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

// Get lyrics and cover for a specific song
app.get('/api/songs/:id/lyrics', (req, res) => {
  const { id } = req.params;
  const song = db.prepare(`
    SELECT id, artist, title, lyrics, synced_lyrics, cover_url
    FROM songs
    WHERE id = ?
  `).get(id);

  if (!song) {
    return res.status(404).json({ error: 'Chanson non trouvée' });
  }

  res.json(song);
});

// Get current public queue
app.get('/api/queue', (req, res) => {
  const queue = db.prepare(`
    SELECT q.id, q.singer_name, q.status, q.position, q.created_at,
           s.artist, s.title, s.formation, s.language, s.year, s.cover_url
    FROM queue q
    JOIN songs s ON q.song_id = s.id
    WHERE q.status IN ('waiting', 'current')
    ORDER BY CASE WHEN q.status = 'current' THEN 0 ELSE 1 END, q.position ASC, q.created_at ASC
  `).all();
  res.json(queue);
});

// Public settings
app.get('/api/settings', (req, res) => {
  res.json({
    registrations_open: getSetting('registrations_open', '1') === '1'
  });
});

// Submit public song suggestion
app.post('/api/suggestions', (req, res) => {
  const { artist, title, suggested_by, notes, website_trap } = req.body;
  if (website_trap) {
    return res.status(400).json({ error: 'Comportement suspect détecté.' });
  }

  if (!artist || !title || !artist.trim() || !title.trim()) {
    return res.status(400).json({ error: 'Artiste et titre requis pour suggérer un morceau.' });
  }

  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
  if (!checkIpRateLimit(`sug_${clientIp}`, 5, 300000)) {
    return res.status(429).json({ error: 'Trop de suggestions envoyées. Merci de patienter quelques minutes.' });
  }

  const result = db.prepare(`
    INSERT INTO suggestions (artist, title, suggested_by, notes)
    VALUES (?, ?, ?, ?)
  `).run(
    artist.trim(),
    title.trim(),
    suggested_by ? suggested_by.trim() : '',
    notes ? notes.trim() : ''
  );

  const suggestion = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(result.lastInsertRowid);
  broadcast('SUGGESTION_ADDED', suggestion);

  res.status(201).json({ success: true, suggestion });
});

// Join queue
app.post('/api/queue', (req, res) => {
  // Check if session is currently accepting registrations
  if (getSetting('registrations_open', '1') !== '1') {
    return res.status(403).json({ error: 'Les inscriptions sont actuellement en pause pour cette session.' });
  }

  const { song_id, singer_name, notes, website_trap, submit_delay } = req.body;

  // Honeypot check
  if (website_trap) {
    return res.status(400).json({ error: 'Comportement suspect détecté.' });
  }

  // Timing check
  if (submit_delay !== undefined && Number(submit_delay) < 800) {
    return res.status(400).json({ error: 'Soumission trop rapide.' });
  }

  if (!song_id || !singer_name || !singer_name.trim()) {
    return res.status(400).json({ error: 'Chanson et nom du chanteur obligatoires.' });
  }

  // IP Rate limiting (max 4 per 2 minutes)
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
  if (!checkIpRateLimit(clientIp, 4, 120000)) {
    return res.status(429).json({ error: 'Trop de requêtes. Veuillez patienter 2 minutes avant de soumettre un autre titre.' });
  }

  // Active queue throttling for the singer (max 2 songs waiting)
  const singerCount = db.prepare("SELECT COUNT(*) as count FROM queue WHERE LOWER(TRIM(singer_name)) = LOWER(TRIM(?)) AND status = 'waiting'").get(singer_name.trim()).count;
  if (singerCount >= 2) {
    return res.status(400).json({ error: 'Vous avez déjà 2 chansons en attente. Attendez votre tour avant d\'en rajouter une !' });
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
    SELECT q.id, q.singer_name, q.status, q.position, q.created_at, q.passed_at,
           s.artist, s.title, s.formation, s.language, s.year, s.cover_url
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

// Music indexer search (iTunes + Deezer fallback)
app.get('/api/admin/indexer/search', authMiddleware, async (req, res) => {
  const query = req.query.q;
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'Paramètre de recherche (q) requis' });
  }

  try {
    const results = await searchMusic(query.trim());
    res.json(results);
  } catch (err) {
    console.error('[Admin Indexer] Error:', err);
    res.status(500).json({ error: 'Erreur lors de la recherche musicale' });
  }
});

// Music indexer lyrics fetch (LRCLIB)
app.get('/api/admin/indexer/lyrics', authMiddleware, async (req, res) => {
  const { artist, title } = req.query;
  if (!artist || !title || !artist.trim() || !title.trim()) {
    return res.status(400).json({ error: 'Paramètres artist et title requis' });
  }

  try {
    const result = await fetchLyrics(artist.trim(), title.trim());
    res.json(result);
  } catch (err) {
    console.error('[Admin Lyrics] Error:', err);
    res.status(500).json({ error: 'Erreur lors de la récupération des paroles' });
  }
});

// Get full queue for admin (including done/cancelled)
app.get('/api/admin/queue', authMiddleware, (req, res) => {
  const queue = db.prepare(`
    SELECT q.id, q.song_id, q.singer_name, q.notes, q.status, q.position, q.created_at, q.passed_at,
           s.artist, s.title, s.formation, s.language, s.year, s.cover_url
    FROM queue q
    JOIN songs s ON q.song_id = s.id
    ORDER BY 
      CASE q.status 
        WHEN 'current' THEN 0 
        WHEN 'waiting' THEN 1 
        WHEN 'done' THEN 2 
        ELSE 3 
      END,
      CASE WHEN q.status = 'waiting' THEN q.position END ASC,
      CASE WHEN q.status IN ('done', 'cancelled') THEN COALESCE(q.passed_at, q.created_at) END DESC,
      q.created_at ASC
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
    db.prepare("UPDATE queue SET status = 'done', passed_at = CURRENT_TIMESTAMP WHERE status = 'current'").run();
    db.prepare("UPDATE queue SET status = ?, passed_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, id);
  } else if (['done', 'cancelled'].includes(status)) {
    db.prepare("UPDATE queue SET status = ?, passed_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, id);
  } else {
    db.prepare('UPDATE queue SET status = ? WHERE id = ?').run(status, id);
  }

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
  const {
    artist,
    title,
    formation,
    year,
    language,
    cover_url,
    lyrics,
    synced_lyrics,
    album,
    genre
  } = req.body;

  if (!artist || !title) {
    return res.status(400).json({ error: 'Artiste et titre requis.' });
  }

  const result = db.prepare(`
    INSERT INTO songs (
      artist, title, formation, year, language,
      cover_url, lyrics, synced_lyrics, album, genre,
      available
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    artist.trim(),
    title.trim(),
    formation || 'Solo',
    year ? parseInt(year, 10) : null,
    language || 'Français',
    cover_url ? cover_url.trim() : null,
    lyrics || null,
    synced_lyrics || null,
    album ? album.trim() : null,
    genre ? genre.trim() : null
  );

  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(result.lastInsertRowid);
  broadcast('SONGS_UPDATED', song);
  res.status(201).json(song);
});

// Update existing song in catalogue
app.put('/api/admin/songs/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const {
    artist,
    title,
    formation,
    year,
    language,
    available,
    cover_url,
    lyrics,
    synced_lyrics,
    album,
    genre
  } = req.body;

  if (!artist || !title) {
    return res.status(400).json({ error: 'Artiste et titre requis.' });
  }

  const existing = db.prepare('SELECT id FROM songs WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Chanson non trouvée' });
  }

  db.prepare(`
    UPDATE songs 
    SET artist = ?, title = ?, formation = ?, year = ?, language = ?, available = ?,
        cover_url = ?, lyrics = ?, synced_lyrics = ?, album = ?, genre = ?
    WHERE id = ?
  `).run(
    artist.trim(),
    title.trim(),
    formation || 'Solo',
    year ? parseInt(year, 10) : null,
    language || 'Français',
    available !== undefined ? (available ? 1 : 0) : 1,
    cover_url !== undefined ? (cover_url ? cover_url.trim() : null) : null,
    lyrics !== undefined ? (lyrics || null) : null,
    synced_lyrics !== undefined ? (synced_lyrics || null) : null,
    album !== undefined ? (album ? album.trim() : null) : null,
    genre !== undefined ? (genre ? genre.trim() : null) : null,
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

// Enrich/backfill missing covers for catalogue songs
app.post('/api/admin/songs/backfill-covers', authMiddleware, async (req, res) => {
  try {
    const songsJsonPath = SONGS_JSON_PATH;
    const result = await backfillMissingCovers({
      dbInstance: db,
      indexer: searchMusic,
      lyricsFetcher: fetchLyrics,
      songsJsonPath,
      delayMs: 250,
      onProgress: ({ index, total, artist, title, status }) => {
        console.log(`[${index}/${total}] Enriching: ${artist} - ${title} ... ${status}`);
      }
    });

    broadcast('SONGS_UPDATED', { backfilled: true, enrichedCount: result.enrichedCount });
    res.json({
      message: 'Enrichissement terminé',
      enrichedCount: result.enrichedCount,
      totalMissing: result.totalMissing
    });
  } catch (err) {
    console.error('[Backfill] Error in backfill-covers:', err);
    res.status(500).json({ error: "Erreur lors de l'enrichissement des pochettes." });
  }
});

// Search cover candidates for a specific song
app.get('/api/admin/songs/:id/cover-candidates', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const song = db.prepare('SELECT id, artist, title, cover_url FROM songs WHERE id = ?').get(id);
  if (!song) {
    return res.status(404).json({ error: 'Chanson non trouvée' });
  }

  const query = (req.query.q && typeof req.query.q === 'string' && req.query.q.trim())
    ? req.query.q.trim()
    : `${song.artist} ${song.title}`;

  try {
    const candidates = await searchCoverCandidates(query);
    res.json({
      song: {
        id: song.id,
        artist: song.artist,
        title: song.title,
        cover_url: song.cover_url
      },
      candidates
    });
  } catch (err) {
    console.error('[Admin Cover Candidates] Error:', err);
    res.status(500).json({ error: 'Erreur lors de la recherche de pochettes' });
  }
});

// Update song cover & metadata from cover picker
app.patch('/api/admin/songs/:id/cover', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { cover_url, album, year } = req.body;
  const existing = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ error: 'Chanson non trouvée' });
  }

  const updatedCover = (cover_url !== undefined && cover_url !== null) ? cover_url.trim() : existing.cover_url;
  const updatedAlbum = (album !== undefined && album !== null && album !== '') ? String(album).trim() : existing.album;
  const updatedYear = (year !== undefined && year !== null && year !== '') ? parseInt(year, 10) : existing.year;

  db.prepare(`
    UPDATE songs
    SET cover_url = ?,
        album = ?,
        year = ?
    WHERE id = ?
  `).run(
    updatedCover,
    updatedAlbum,
    updatedYear,
    id
  );

  const updatedSong = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
  broadcast('SONGS_UPDATED', updatedSong);
  res.json({ ...updatedSong, success: true, song: updatedSong });
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

// ----------------- System Settings API -----------------

// Toggle/update system settings (e.g. registrations open/closed)
app.patch('/api/admin/settings', authMiddleware, (req, res) => {
  const { registrations_open } = req.body;
  if (registrations_open !== undefined) {
    setSetting('registrations_open', registrations_open ? '1' : '0');
  }

  const updatedSettings = {
    registrations_open: getSetting('registrations_open', '1') === '1'
  };

  broadcast('SETTINGS_UPDATED', updatedSettings);
  res.json({ success: true, settings: updatedSettings });
});

// ----------------- Suggestions API -----------------

// Get all suggestions
app.get('/api/admin/suggestions', authMiddleware, (req, res) => {
  const suggestions = db.prepare(`
    SELECT id, artist, title, suggested_by, notes, status, created_at
    FROM suggestions
    ORDER BY created_at DESC
  `).all();
  res.json(suggestions);
});

// Update suggestion status (pending, accepted, dismissed)
app.patch('/api/admin/suggestions/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['pending', 'accepted', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide.' });
  }

  db.prepare('UPDATE suggestions SET status = ? WHERE id = ?').run(status, id);
  res.json({ success: true });
});

// Delete suggestion
app.delete('/api/admin/suggestions/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM suggestions WHERE id = ?').run(id);
  res.json({ success: true });
});

// ----------------- Catalogue Backup & Restore API -----------------

// Export entire catalogue as JSON backup
app.get('/api/admin/catalogue/export', authMiddleware, (req, res) => {
  const songs = db.prepare(`
    SELECT id, artist, title, formation, year, language, cover_url, lyrics, synced_lyrics, album, genre, available
    FROM songs
    ORDER BY id ASC
  `).all();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const filename = `karaoke-catalogue-${timestamp}.json`;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(songs, null, 2));
});

// Restore catalogue from JSON backup (merge or replace)
app.post('/api/admin/catalogue/restore', authMiddleware, (req, res) => {
  const { mode = 'merge', songs } = req.body;
  if (!Array.isArray(songs) || songs.length === 0) {
    return res.status(400).json({ error: 'Fichier ou liste de chansons vide ou invalide.' });
  }

  // Safety backup before restore
  try {
    const currentSongs = db.prepare('SELECT * FROM songs').all();
    const backupName = `pre-restore-${Date.now()}.json`;
    fs.writeFileSync(path.join(BACKUP_DIR, backupName), JSON.stringify(currentSongs, null, 2), 'utf8');
  } catch (err) {
    console.error('[Backup Error]', err);
  }

  const insertStmt = db.prepare(`
    INSERT INTO songs (
      artist, title, formation, year, language,
      cover_url, lyrics, synced_lyrics, album, genre, available
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateStmt = db.prepare(`
    UPDATE songs
    SET formation = COALESCE(?, formation),
        year = COALESCE(?, year),
        language = COALESCE(?, language),
        cover_url = COALESCE(?, cover_url),
        lyrics = COALESCE(?, lyrics),
        synced_lyrics = COALESCE(?, synced_lyrics),
        album = COALESCE(?, album),
        genre = COALESCE(?, genre),
        available = COALESCE(?, available)
    WHERE id = ? OR (LOWER(TRIM(artist)) = LOWER(TRIM(?)) AND LOWER(TRIM(title)) = LOWER(TRIM(?)))
  `);

  const insertWithIdStmt = db.prepare(`
    INSERT INTO songs (
      id, artist, title, formation, year, language,
      cover_url, lyrics, synced_lyrics, album, genre, available
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const runRestore = db.transaction((songsList) => {
    if (mode === 'replace') {
      db.prepare('DELETE FROM songs').run();
      for (const s of songsList) {
        if (!s.artist || !s.title) continue;
        if (s.id) {
          insertWithIdStmt.run(
            s.id,
            s.artist.trim(),
            s.title.trim(),
            s.formation || 'Solo',
            s.year ? parseInt(s.year, 10) : null,
            s.language || 'Français',
            s.cover_url || null,
            s.lyrics || null,
            s.synced_lyrics || null,
            s.album || null,
            s.genre || null,
            s.available !== undefined ? (s.available ? 1 : 0) : 1
          );
        } else {
          insertStmt.run(
            s.artist.trim(),
            s.title.trim(),
            s.formation || 'Solo',
            s.year ? parseInt(s.year, 10) : null,
            s.language || 'Français',
            s.cover_url || null,
            s.lyrics || null,
            s.synced_lyrics || null,
            s.album || null,
            s.genre || null,
            s.available !== undefined ? (s.available ? 1 : 0) : 1
          );
        }
      }
    } else {
      // Merge mode
      for (const s of songsList) {
        if (!s.artist || !s.title) continue;
        const existing = db.prepare('SELECT * FROM songs WHERE LOWER(TRIM(artist)) = LOWER(TRIM(?)) AND LOWER(TRIM(title)) = LOWER(TRIM(?))').get(s.artist.trim(), s.title.trim());
        if (existing) {
          updateStmt.run(
            s.formation || null,
            s.year ? parseInt(s.year, 10) : null,
            s.language || null,
            s.cover_url || null,
            s.lyrics || null,
            s.synced_lyrics || null,
            s.album || null,
            s.genre || null,
            s.available !== undefined ? (s.available ? 1 : 0) : null,
            existing.id,
            s.artist.trim(),
            s.title.trim()
          );
        } else {
          insertStmt.run(
            s.artist.trim(),
            s.title.trim(),
            s.formation || 'Solo',
            s.year ? parseInt(s.year, 10) : null,
            s.language || 'Français',
            s.cover_url || null,
            s.lyrics || null,
            s.synced_lyrics || null,
            s.album || null,
            s.genre || null,
            s.available !== undefined ? (s.available ? 1 : 0) : 1
          );
        }
      }
    }
  });

  try {
    db.pragma('foreign_keys = OFF');
    runRestore(songs);
  } catch (err) {
    console.error('[Restore Error]', err);
    return res.status(500).json({ error: "Erreur lors de la restauration: " + err.message });
  } finally {
    db.pragma('foreign_keys = ON');
  }

  // Synchronize to songs.json
  const allUpdated = db.prepare('SELECT * FROM songs ORDER BY artist ASC, title ASC').all();
  try {
    fs.writeFileSync(SONGS_JSON_PATH, JSON.stringify(allUpdated, null, 2), 'utf8');
  } catch (err) {
    console.error('[Songs JSON Sync Error]', err);
  }

  broadcast('SONGS_UPDATED', { count: allUpdated.length, restored: true });
  res.json({ success: true, count: allUpdated.length, mode });
});

// Export app, server, and functions for testing
module.exports = {
  app,
  server,
  db,
  searchMusic,
  searchCoverCandidates,
  fetchLyrics,
  getHdItunesCover,
  backfillMissingCovers,
  getSetting,
  setSetting
};

// Start server if executed directly
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎤 Karaoke Live Server running on http://0.0.0.0:${PORT}`);
  });
}
