const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// 1. Test legacy DB schema migration
console.log('--- Test 1: SQLite Schema Migration on legacy DB ---');
const testDbPath = path.join(__dirname, 'data', 'test_legacy.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const legacyDb = new Database(testDbPath);
legacyDb.exec(`
  CREATE TABLE songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artist TEXT NOT NULL,
    title TEXT NOT NULL,
    formation TEXT DEFAULT 'Solo',
    year INTEGER,
    language TEXT DEFAULT 'Français',
    available INTEGER DEFAULT 1
  );
  INSERT INTO songs (artist, title) VALUES ('Test Artist', 'Test Title');
`);
legacyDb.close();

// Set DB_PATH environment variable for server.js to use this DB
const testSongsJsonPath = path.join(__dirname, 'data', 'test_songs.json');
if (fs.existsSync(testSongsJsonPath)) fs.unlinkSync(testSongsJsonPath);

process.env.DB_PATH = testDbPath;
process.env.SONGS_JSON_PATH = testSongsJsonPath;
process.env.PORT = '3039';

const {
  app,
  server,
  db,
  searchMusic,
  searchCoverCandidates,
  fetchLyrics,
  getHdItunesCover,
  backfillMissingCovers
} = require('./server');
assert(typeof searchCoverCandidates === 'function', 'searchCoverCandidates must be exported as a function');
assert(typeof backfillMissingCovers === 'function', 'backfillMissingCovers must be exported as a function');

// Check that migration added the columns to the legacy DB
const tableCols = db.prepare('PRAGMA table_info(songs)').all().map(c => c.name);
console.log('Columns in legacy DB after migration:', tableCols);
const requiredCols = ['cover_url', 'lyrics', 'synced_lyrics', 'album', 'genre'];
for (const col of requiredCols) {
  assert(tableCols.includes(col), `Missing expected column ${col}`);
}
console.log('✓ Test 1 Passed: Legacy database successfully migrated with new columns.');

// 2. Test backward compatibility and seeding with data/songs.json
console.log('\n--- Test 2: Seeding & Backward Compatibility ---');
const rawSongs = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'songs.json'), 'utf8'));
assert(rawSongs.length === 51, `Expected 51 songs in data/songs.json, found ${rawSongs.length}`);
console.log(`✓ 51 songs verified in data/songs.json.`);

// 3. Test Music Indexer
console.log('\n--- Test 3: Music Indexer (iTunes / Deezer fallback) ---');
async function runIndexerTest() {
  const query = 'Queen Bohemian Rhapsody';
  const results = await searchMusic(query);
  assert(Array.isArray(results), 'Expected results to be an array');
  assert(results.length > 0, 'Expected at least 1 search result');
  const first = results[0];
  console.log('First search result:', first);
  assert(first.artist && first.title, 'Result must have artist and title');
  assert('album' in first, 'Result must have album property');
  assert('year' in first, 'Result must have year property');
  assert('genre' in first, 'Result must have genre property');
  assert('cover_url' in first, 'Result must have cover_url property');
  if (first.cover_url) {
    assert(first.cover_url.includes('600x600') || first.cover_url.includes('dzcdn'), 'Expected HD cover URL');
  }

  // Test searchCoverCandidates
  const candidates = await searchCoverCandidates(query);
  assert(Array.isArray(candidates), 'Expected candidates to be an array');
  assert(candidates.length > 0, 'Expected at least 1 candidate');
  assert(candidates[0].cover_url, 'First candidate must have cover_url');
  assert(candidates[0].provider === 'iTunes' || candidates[0].provider === 'Deezer', 'Expected iTunes or Deezer provider');
  // Verify deduplication
  const urls = candidates.map((c) => c.cover_url);
  assert(new Set(urls).size === urls.length, 'Candidates must be deduplicated by cover_url');
  console.log(`✓ Test 3 Passed: Music indexer & cover candidates (${candidates.length} candidates) verified.`);
}

// 4. Test Lyrics Service
console.log('\n--- Test 4: Lyrics Service (LRCLIB) ---');
async function runLyricsTest() {
  // Test existing track
  const lyricsData = await fetchLyrics('Alain Souchon', 'Foule sentimentale');
  console.log('Lyrics result:', {
    artist: lyricsData.artist,
    title: lyricsData.title,
    hasLyrics: !!lyricsData.lyrics,
    hasSynced: !!lyricsData.synced_lyrics,
    found: lyricsData.found
  });
  assert(lyricsData.found === true, 'Expected lyrics to be found for Alain Souchon - Foule sentimentale');
  assert(typeof lyricsData.lyrics === 'string' && lyricsData.lyrics.length > 0, 'Expected non-empty plainLyrics');

  // Test non-existent track
  const nonExistent = await fetchLyrics('FakeArtistXYZ999', 'FakeTitleXYZ999');
  assert(nonExistent.found === false, 'Expected non-existent track to return found: false');
  assert(nonExistent.lyrics === null, 'Expected null lyrics');
  console.log('✓ Test 4 Passed: Lyrics fetcher handled existing and non-existent songs cleanly.');
}

// 5. Test Express Endpoints
console.log('\n--- Test 5: Endpoints Verification ---');
async function runEndpointsTest() {
  const listenPromise = new Promise((resolve) => {
    server.listen(3039, '127.0.0.1', () => {
      resolve();
    });
  });
  await listenPromise;

  const baseUrl = 'http://127.0.0.1:3039';

  // 5.1 GET /health
  const healthRes = await fetch(`${baseUrl}/health`);
  assert(healthRes.status === 200, 'Health endpoint should return 200');
  const healthData = await healthRes.json();
  assert(healthData.status === 'ok', 'Health status should be ok');
  assert(typeof healthData.uptime === 'number', 'Health uptime should be number');
  assert(typeof healthData.timestamp === 'number', 'Health timestamp should be number');
  console.log('✓ GET /health verified:', healthData);

  // 5.2 GET /api/songs
  const songsRes = await fetch(`${baseUrl}/api/songs`);
  assert(songsRes.status === 200, 'GET /api/songs should return 200');
  const songsData = await songsRes.json();
  assert(Array.isArray(songsData), 'Expected songs array');
  assert(songsData.length > 0, 'Expected at least 1 song');
  assert('cover_url' in songsData[0], 'Songs must include cover_url');
  assert('album' in songsData[0], 'Songs must include album');
  assert('genre' in songsData[0], 'Songs must include genre');
  console.log('✓ GET /api/songs verified, includes cover_url, album, genre.');

  // 5.3 Admin Indexer Search with & without auth
  const unauthorizedSearch = await fetch(`${baseUrl}/api/admin/indexer/search?q=queen`);
  assert(unauthorizedSearch.status === 401, 'Indexer search without auth should return 401');

  const authorizedSearch = await fetch(`${baseUrl}/api/admin/indexer/search?q=queen`, {
    headers: { Authorization: 'Bearer karaoke2026' }
  });
  assert(authorizedSearch.status === 200, 'Authorized search should return 200');
  const searchResults = await authorizedSearch.json();
  assert(Array.isArray(searchResults), 'Search results should be an array');
  console.log('✓ GET /api/admin/indexer/search verified (auth & results).');

  // 5.4 Admin Indexer Lyrics with & without auth
  const unauthorizedLyrics = await fetch(`${baseUrl}/api/admin/indexer/lyrics?artist=Alain%20Souchon&title=Foule%20sentimentale`);
  assert(unauthorizedLyrics.status === 401, 'Lyrics without auth should return 401');

  const authorizedLyrics = await fetch(`${baseUrl}/api/admin/indexer/lyrics?artist=Alain%20Souchon&title=Foule%20sentimentale`, {
    headers: { Authorization: 'Bearer karaoke2026' }
  });
  assert(authorizedLyrics.status === 200, 'Authorized lyrics should return 200');
  const lyricsResp = await authorizedLyrics.json();
  assert(lyricsResp.found === true, 'Authorized lyrics should find song');
  console.log('✓ GET /api/admin/indexer/lyrics verified.');

  // 5.5 POST /api/admin/songs (create with new fields)
  const newSongPayload = {
    artist: 'Test Singer',
    title: 'Test Song With Lyrics',
    formation: 'Solo',
    year: 2024,
    language: 'Français',
    cover_url: 'https://example.com/cover600.jpg',
    lyrics: 'Ligne 1\nLigne 2\nLigne 3',
    synced_lyrics: '[00:01.00] Ligne 1\n[00:05.00] Ligne 2',
    album: 'Greatest Hits',
    genre: 'Chanson'
  };

  const createRes = await fetch(`${baseUrl}/api/admin/songs`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer karaoke2026',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(newSongPayload)
  });
  assert(createRes.status === 201, 'POST /api/admin/songs should return 201');
  const createdSong = await createRes.json();
  assert(createdSong.id, 'Created song should have an ID');
  assert(createdSong.cover_url === newSongPayload.cover_url, 'Cover URL preserved');
  assert(createdSong.lyrics === newSongPayload.lyrics, 'Lyrics preserved');
  assert(createdSong.synced_lyrics === newSongPayload.synced_lyrics, 'Synced lyrics preserved');
  assert(createdSong.album === newSongPayload.album, 'Album preserved');
  assert(createdSong.genre === newSongPayload.genre, 'Genre preserved');
  console.log('✓ POST /api/admin/songs verified.');

  // 5.6 GET /api/songs/:id/lyrics (public)
  const songLyricsRes = await fetch(`${baseUrl}/api/songs/${createdSong.id}/lyrics`);
  assert(songLyricsRes.status === 200, 'GET /api/songs/:id/lyrics should return 200');
  const fetchedLyrics = await songLyricsRes.json();
  assert(fetchedLyrics.id === createdSong.id, 'ID must match');
  assert(fetchedLyrics.lyrics === newSongPayload.lyrics, 'Lyrics must match');
  assert(fetchedLyrics.synced_lyrics === newSongPayload.synced_lyrics, 'Synced lyrics must match');
  assert(fetchedLyrics.cover_url === newSongPayload.cover_url, 'Cover URL must match');
  console.log('✓ GET /api/songs/:id/lyrics verified.');

  // 5.7 PUT /api/admin/songs/:id (update with new fields)
  const updatePayload = {
    ...createdSong,
    album: 'Updated Album Edition',
    genre: 'Pop/Rock',
    year: 2025
  };
  const updateRes = await fetch(`${baseUrl}/api/admin/songs/${createdSong.id}`, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer karaoke2026',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updatePayload)
  });
  assert(updateRes.status === 200, 'PUT /api/admin/songs/:id should return 200');
  const updatedSong = await updateRes.json();
  assert(updatedSong.album === 'Updated Album Edition', 'Updated album verified');
  assert(updatedSong.genre === 'Pop/Rock', 'Updated genre verified');
  assert(updatedSong.year === 2025, 'Updated year verified');
  console.log('✓ PUT /api/admin/songs/:id verified.');

  // 5.7b PATCH /api/admin/songs/:id/cover (Cover Picker endpoint)
  const patchCoverRes = await fetch(`${baseUrl}/api/admin/songs/${createdSong.id}/cover`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer karaoke2026',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      cover_url: 'https://example.com/picked-cover.jpg',
      album: 'Picked Album',
      year: 2026
    })
  });
  assert(patchCoverRes.status === 200, 'PATCH /api/admin/songs/:id/cover should return 200');
  const patchedSong = await patchCoverRes.json();
  assert(patchedSong.cover_url === 'https://example.com/picked-cover.jpg', 'Patched cover_url verified');
  assert(patchedSong.album === 'Picked Album', 'Patched album verified');
  assert(patchedSong.year === 2026, 'Patched year verified');
  console.log('✓ PATCH /api/admin/songs/:id/cover verified.');

  // 5.8 POST /api/admin/songs/backfill-covers
  const unauthBackfill = await fetch(`${baseUrl}/api/admin/songs/backfill-covers`, {
    method: 'POST'
  });
  assert(unauthBackfill.status === 401, 'Unauthorized backfill must return 401');

  const authBackfill = await fetch(`${baseUrl}/api/admin/songs/backfill-covers`, {
    method: 'POST',
    headers: { Authorization: 'Bearer karaoke2026' }
  });
  assert(authBackfill.status === 200, 'Authorized backfill must return 200');
  const backfillBody = await authBackfill.json();
  assert(backfillBody.message === 'Enrichissement terminé', 'Must return expected message');
  assert('enrichedCount' in backfillBody, 'Must return enrichedCount');
  assert('totalMissing' in backfillBody, 'Must return totalMissing');
  console.log('✓ POST /api/admin/songs/backfill-covers verified.');

  // 5.9 GET /api/admin/songs/:id/cover-candidates
  const unauthCandidates = await fetch(`${baseUrl}/api/admin/songs/${createdSong.id}/cover-candidates`);
  assert(unauthCandidates.status === 401, 'Unauthorized candidates request must return 401');

  const notFoundCandidates = await fetch(`${baseUrl}/api/admin/songs/999999/cover-candidates`, {
    headers: { Authorization: 'Bearer karaoke2026' }
  });
  assert(notFoundCandidates.status === 404, 'Non-existent song must return 404');

  const authCandidates = await fetch(`${baseUrl}/api/admin/songs/${createdSong.id}/cover-candidates?q=Queen+Bohemian`, {
    headers: { Authorization: 'Bearer karaoke2026' }
  });
  assert(authCandidates.status === 200, 'Authorized candidates request must return 200');
  const candidatesBody = await authCandidates.json();
  assert(candidatesBody.song && candidatesBody.song.id === createdSong.id, 'Response must include song object');
  assert(Array.isArray(candidatesBody.candidates), 'Response must include candidates array');
  assert(candidatesBody.candidates.length > 0, 'Candidates array should have items');
  console.log('✓ GET /api/admin/songs/:id/cover-candidates verified.');

  // 5.10 PATCH /api/admin/songs/:id/cover
  const unauthPatchCover = await fetch(`${baseUrl}/api/admin/songs/${createdSong.id}/cover`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cover_url: 'https://example.com/custom-cover.jpg' })
  });
  assert(unauthPatchCover.status === 401, 'Unauthorized cover patch must return 401');

  const notFoundPatchCover = await fetch(`${baseUrl}/api/admin/songs/999999/cover`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer karaoke2026',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ cover_url: 'https://example.com/custom-cover.jpg' })
  });
  assert(notFoundPatchCover.status === 404, 'Non-existent song patch must return 404');

  const patchPayload = {
    cover_url: 'https://example.com/new-hd-cover.jpg',
    album: 'Selected Album 2026',
    year: 2026
  };
  const authPatchCover = await fetch(`${baseUrl}/api/admin/songs/${createdSong.id}/cover`, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer karaoke2026',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(patchPayload)
  });
  assert(authPatchCover.status === 200, 'Authorized cover patch must return 200');
  const patchBody = await authPatchCover.json();
  assert(patchBody.success === true, 'Response must include success: true');
  assert(patchBody.song && patchBody.song.cover_url === patchPayload.cover_url, 'Cover URL updated');
  assert(patchBody.song.album === patchPayload.album, 'Album updated');
  assert(patchBody.song.year === patchPayload.year, 'Year updated');
  console.log('✓ PATCH /api/admin/songs/:id/cover verified.');

  // 5.11 Cleanup test song
  const delRes = await fetch(`${baseUrl}/api/admin/songs/${createdSong.id}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer karaoke2026' }
  });
  assert(delRes.status === 200, 'DELETE song should return 200');

  // Close server
  server.close();
  console.log('\n=========================================');
  console.log('🎉 ALL BACKEND TESTS PASSED SUCCESSFULLY!');
  console.log('=========================================');
}

(async () => {
  let exitCode = 0;
  try {
    await runIndexerTest();
    await runLyricsTest();
    await runEndpointsTest();
  } catch (err) {
    console.error('❌ TEST FAILED:', err);
    exitCode = 1;
  } finally {
    // cleanup test legacy db and test songs json
    try {
      db.close();
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(testSongsJsonPath)) fs.unlinkSync(testSongsJsonPath);
    } catch (e) {}
    process.exit(exitCode);
  }
})();
