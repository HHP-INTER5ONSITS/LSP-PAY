'use strict';

/*
 * Keeps the SQLite database alive across Render restarts.
 *
 * Render's free plan has no persistent disk, so the lsp-pay.db file is wiped
 * on every deploy, restart or spin-down. When MONGODB_URI is set, this module:
 *   - on boot, downloads the latest saved copy of the database before SQLite opens it;
 *   - a few seconds after any change, uploads a fresh copy (GridFS, so size is no issue);
 *   - on shutdown (SIGTERM from Render), uploads one last copy.
 *
 * During a deploy Render runs the old and new instance side by side for a few
 * seconds. The newest instance claims "leadership" when it boots, and an
 * instance that is no longer the leader stops saving, so an old instance can
 * never overwrite the new one's data.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'lsp-pay.db';
const SAVE_AFTER_MS = Number(process.env.SNAPSHOT_DELAY_MS || 3000);
const KEEP = 3; // how many recent copies to keep in MongoDB

let client = null;
let bucket = null;
let meta = null;
const myToken = crypto.randomBytes(12).toString('hex');

let db = null;
let lastSavedChanges = 0;
let saving = null;
let timer = null;
let isLeader = true;

const enabled = () => !!process.env.MONGODB_URI;

async function connect() {
  const { MongoClient, GridFSBucket } = require('mongodb');
  const uri = String(process.env.MONGODB_URI).trim();
  if (/[<>]/.test(uri) || /db_password|db_username/.test(uri))
    throw new Error('MONGODB_URI still contains <db_username> or <db_password>. Replace them (and the < > around them) with your real Atlas username and password. Invalid connection string');
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const mdb = client.db(process.env.MONGODB_DB || 'lsppay');
  bucket = new GridFSBucket(mdb, { bucketName: 'snapshots' });
  meta = mdb.collection('meta');
}

/** Download the latest saved database into dataDir. Call BEFORE opening SQLite. */
async function restore(dataDir) {
  if (!enabled()) {
    console.warn('[persist] MONGODB_URI not set: the database lives only on Render\'s temporary disk and is WIPED on every restart. Users, wallets and gateway keys will disappear.');
    return;
  }
  await connect();
  // Claim leadership: from now on, older instances stop saving.
  await meta.updateOne({ _id: 'leader' }, { $set: { token: myToken, at: new Date() } }, { upsert: true });

  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, FILE);
  const [latest] = await bucket.find({ filename: FILE }).sort({ uploadDate: -1 }).limit(1).toArray();
  if (!latest) {
    console.log('[persist] No saved database in MongoDB yet. Starting fresh; it will be saved after the first change.');
    return;
  }
  // Remove any leftover local files so SQLite opens exactly the restored copy.
  for (const f of [target, target + '-wal', target + '-shm']) fs.rmSync(f, { force: true });
  const tmp = target + '.restore';
  await new Promise((ok, bad) => {
    bucket.openDownloadStream(latest._id).pipe(fs.createWriteStream(tmp)).on('finish', ok).on('error', bad);
  });
  fs.renameSync(tmp, target);
  console.log(`[persist] Restored database from MongoDB (${(latest.length / 1024).toFixed(1)} KB, saved ${latest.uploadDate.toISOString()}).`);
}

const changesNow = () => db.prepare('SELECT total_changes() AS n').get().n;

async function stillLeader() {
  const doc = await meta.findOne({ _id: 'leader' });
  return !doc || doc.token === myToken;
}

async function saveNow(reason) {
  if (!enabled() || !db || !isLeader) return;
  if (saving) return saving;
  saving = (async () => {
    try {
      const changes = changesNow();
      if (changes === lastSavedChanges && reason !== 'force') return;
      if (!(await stillLeader())) {
        isLeader = false;
        console.warn('[persist] A newer instance has started. This instance stops saving.');
        return;
      }
      const buf = db.serialize();
      await new Promise((ok, bad) => {
        const up = bucket.openUploadStream(FILE, { metadata: { token: myToken, reason, changes } });
        up.on('finish', ok).on('error', bad);
        up.end(buf);
      });
      lastSavedChanges = changes;
      // Keep only the newest few copies.
      const old = await bucket.find({ filename: FILE }).sort({ uploadDate: -1 }).skip(KEEP).toArray();
      for (const f of old) await bucket.delete(f._id).catch(() => {});
    } catch (e) {
      console.error('[persist] Saving the database failed:', e.message);
    } finally {
      saving = null;
    }
  })();
  return saving;
}

/** Start watching the open database for changes. */
function start(openDb) {
  db = openDb;
  if (!enabled()) return;
  lastSavedChanges = changesNow();
  // Cheap check: total_changes() only moves when something was written.
  timer = setInterval(() => {
    if (changesNow() !== lastSavedChanges) saveNow('change');
  }, SAVE_AFTER_MS);
  timer.unref();

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`[persist] ${sig} received, saving the database before exit…`);
    clearInterval(timer);
    if (saving) await saving;
    await saveNow('shutdown');
    try { await client.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  console.log(`[persist] Saving the database to MongoDB ${SAVE_AFTER_MS / 1000}s after each change.`);
}

module.exports = { restore, start, saveNow, enabled };
