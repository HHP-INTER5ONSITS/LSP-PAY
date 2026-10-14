'use strict';

// Entry point: restore the saved database first, then start the app.
require('dotenv').config();

const path = require('path');
const persist = require('./persist');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function explain(err) {
  const m = String((err && err.message) || err);
  if (/auth|bad auth|authentication/i.test(m)) return 'MongoDB rejected the username or password in MONGODB_URI. Check them in Atlas → Database Access, and make sure <db_username> and <db_password> (with the < >) were replaced.';
  if (/ENOTFOUND|querySrv|ENODATA/i.test(m)) return 'The cluster address in MONGODB_URI was not found. Copy the link again from Atlas → Connect → Drivers.';
  if (/Server selection timed out|ETIMEDOUT|timed out/i.test(m)) return 'Could not reach MongoDB in time. In Atlas → Network Access → IP Access List, add 0.0.0.0/0 (Allow access from anywhere).';
  if (/Invalid scheme|Invalid connection string|URI/i.test(m)) return 'MONGODB_URI is not a valid link. It must start with mongodb+srv:// and have no spaces, < > or extra characters.';
  return 'Check MONGODB_URI and Atlas Network Access (allow 0.0.0.0/0).';
}

if (persist.enabled()) console.log('[persist] Connecting to MongoDB…');

persist
  .restore(DATA_DIR)
  .then(
    () => {
      require('./server');
      persist.start(require('./db').db);
    },
    (err) => {
      // Refuse to start on an empty database when one should exist: starting fresh
      // would hand out new keys and then overwrite the real saved copy.
      console.error('[persist] Could not load the saved database from MongoDB: ' + ((err && err.message) || err));
      console.error('[persist] ' + explain(err));
      console.error('[persist] Exiting. Render keeps the previous version running until this is fixed.');
      // Give the log lines time to reach Render before exiting.
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 1000);
    }
  );
