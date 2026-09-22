#!/usr/bin/env node
'use strict';
/* QwickSignal Phase 2.5: classification bridge for video discovery.

   The pipeline (Python) needs to judge a story exactly the way the app does on your phone:
   importance, country, sector, companies. That logic lives in app.js (Part 1: the engine, pure
   logic, no browser needed). This helper loads that same engine, so there is one set of rules
   and they can never drift apart. Edit the keywords in app.js and the pipeline follows.

   stdin : {"docs":[{"id":"a","headline":"...","text":"...","date":"2026-09-20"}]}
   stdout: {"a":{"importance":"High","country":"Japan","involved":["China"],"sector":"Banking","companies":["Toyota"]}}

   Nothing here touches the network or any secret. */

const path = require('path');

let Engine;
try {
  Engine = require(path.join(__dirname, 'app.js'));
} catch (e) {
  process.stderr.write('Could not load the engine from app.js: ' + e.message + '\n');
  process.exit(2);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let docs = [];
  try {
    docs = (JSON.parse(raw || '{}').docs) || [];
  } catch (e) {
    process.stderr.write('Input was not valid JSON: ' + e.message + '\n');
    process.exit(3);
  }
  const out = {};
  docs.forEach(d => {
    try {
      // Same call the app makes for live stories (mapRules in app.js)
      const r = Engine.analyze(d.text || d.headline || '', { headline: d.headline, date: d.date || '' });
      out[d.id] = {
        importance: r.importance,
        country: r.country,
        involved: r.involved || [],
        sector: r.sector,
        companies: (r.companies || []).map(c => (c && c.name) ? c.name : String(c))
      };
    } catch (e) {
      // one bad document must never stop the others
    }
  });
  process.stdout.write(JSON.stringify(out));
});
