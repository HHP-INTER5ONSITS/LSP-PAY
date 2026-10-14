'use strict';

// Entry point: restore the saved database first, then start the app.
require('dotenv').config();

const path = require('path');
const persist = require('./persist');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

persist
  .restore(DATA_DIR)
  .catch((err) => {
    // Refuse to start on an empty database when one should exist: starting fresh
    // would hand out new keys and then overwrite the real saved copy.
    console.error('[persist] Could not load the saved database from MongoDB:', err.message);
    console.error('[persist] Check MONGODB_URI and Atlas Network Access (allow 0.0.0.0/0). Exiting so Render retries.');
    process.exit(1);
  })
  .then(() => {
    require('./server');
    persist.start(require('./db').db);
  });
