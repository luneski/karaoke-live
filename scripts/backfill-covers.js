#!/usr/bin/env node
const path = require('path');
const { db, searchMusic, fetchLyrics, backfillMissingCovers } = require('../server');

async function main() {
  console.log('🎤 Starting cover art & metadata backfill...');
  const songsJsonPath = path.join(__dirname, '..', 'data', 'songs.json');

  const startTime = Date.now();
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

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✨ Backfill completed in ${durationSec}s:`);
  console.log(`   Total songs missing covers: ${result.totalMissing}`);
  console.log(`   Successfully enriched: ${result.enrichedCount}`);

  const remaining = db.prepare("SELECT count(1) as count FROM songs WHERE cover_url IS NULL OR cover_url = ''").get().count;
  console.log(`   Remaining songs without cover: ${remaining}`);

  if (remaining > 0) {
    console.warn(`⚠️ Warning: ${remaining} songs still lack covers.`);
  } else {
    console.log(`✅ All songs in database now have high-quality cover art!`);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Fatal error during backfill:', err);
      process.exit(1);
    });
}

module.exports = { main };
