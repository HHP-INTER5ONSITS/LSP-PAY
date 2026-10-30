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
  // Atlas ends the TLS handshake with alert 80 when the caller's IP isn't on its access list.
  if (/alert internal error|SSL alert number 80|tlsv1 alert|ECONNRESET/i.test(m))
    return 'MongoDB Atlas refused the connection, almost always because Render is not on its IP Access List. In Atlas → Network Access, add 0.0.0.0/0 (Allow access from anywhere), wait until it shows Active, then redeploy. Also check the cluster is not Paused.';
  if (/Server selection timed out|ETIMEDOUT|timed out/i.test(m)) return 'Could not reach MongoDB in time. In Atlas → Network Access → IP Access List, add 0.0.0.0/0 (Allow access from anywhere).';
  if (/Invalid scheme|Invalid connection string|URI/i.test(m)) return 'MONGODB_URI is not a valid link. It must start with mongodb+srv:// and have no spaces, < > or extra characters.';
  return 'Check MONGODB_URI and Atlas Network Access (allow 0.0.0.0/0).';
}

if (persist.enabled()) console.log('[persist] Connecting to MongoDB…');

persist
  .restore(DATA_DIR)
  .catch((err) => {
    // Don't fail the deploy. Start without saving instead, and never upload, so
    // an empty database here can't overwrite the good copy in MongoDB.
    persist.disable();
    console.error('[persist] Could not load the saved database from MongoDB: ' + ((err && err.message) || err));
    console.error('[persist] ' + explain(err));
    console.error('[persist] Starting WITHOUT saving. Data from this run will not be kept. Fix MONGODB_URI and redeploy.');
  })
  .then(() => {
    require('./server');
    persist.start(require('./db').db);
  });
