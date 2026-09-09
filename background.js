'use strict';

// Clicking the toolbar icon just opens the options page — no popup.
chrome.action.onClicked.addListener(function () {
  chrome.runtime.openOptionsPage();
});

// ---- Tier 2 (LLM fallback) --------------------------------------------
// Content scripts can't safely hold an API key or make the cross-origin
// call themselves, so they ask the background worker to do it. Results
// are cached per hostname + form structure so a given site only ever
// costs one API call.

var ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var MAX_CACHE_ENTRIES = 300;

var SYSTEM_PROMPT = [
  'You match web form fields to a fixed set of profile keys for a browser',
  'autofill extension. You will receive a JSON object with:',
  '- "fields": an array of { index, text }, where text is a short signal',
  '  from the field (label, placeholder, or attribute name), possibly in a',
  '  non-English language.',
  '- "allowedKeys": an array of { id, description } — the only valid keys.',
  '',
  'For each field, pick the single allowedKeys id that best matches it, or',
  'null if none fit with reasonable confidence. Respond with ONLY a raw JSON',
  'object mapping each field\'s index (as a string) to the matched id or',
  'null. No prose, no markdown code fences, no explanation.'
].join('\n');

function getSettings() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(['settings'], function (result) {
      resolve(result.settings || {});
    });
  });
}

function getTier2Cache() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(['tier2Cache'], function (result) {
      resolve(result.tier2Cache || {});
    });
  });
}

function setTier2CacheEntry(key, mapping) {
  return getTier2Cache().then(function (cache) {
    cache[key] = { mapping: mapping, timestamp: Date.now() };

    var keys = Object.keys(cache);
    if (keys.length > MAX_CACHE_ENTRIES) {
      keys.sort(function (a, b) { return cache[a].timestamp - cache[b].timestamp; });
      keys.slice(0, keys.length - MAX_CACHE_ENTRIES).forEach(function (k) { delete cache[k]; });
    }

    return new Promise(function (resolve) {
      chrome.storage.local.set({ tier2Cache: cache }, resolve);
    });
  });
}

function parseMappingJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) { /* fall through */ }

  var match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (e2) { /* give up below */ }
  }
  return {};
}

function callAnthropic(apiKey, fields, allowedKeys) {
  var body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: JSON.stringify({ fields: fields, allowedKeys: allowedKeys }) }
    ]
  };

  return fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (errText) {
        throw new Error('Anthropic API error ' + res.status + ': ' + (errText || '').slice(0, 200));
      });
    }
    return res.json();
  }).then(function (data) {
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var raw = parseMappingJson(text);

    var allowedIds = {};
    allowedKeys.forEach(function (k) { allowedIds[k.id] = true; });

    var clean = {};
    Object.keys(raw).forEach(function (idx) {
      var v = raw[idx];
      clean[idx] = (v && allowedIds[v]) ? v : null;
    });
    return clean;
  });
}

function handleTier2Match(payload) {
  return getSettings().then(function (settings) {
    var apiKey = settings.anthropicApiKey || '';
    if (!apiKey) return { ok: false, reason: 'no-api-key' };

    var cacheKey = payload.hostname + '|' + payload.formKey;

    return getTier2Cache().then(function (cache) {
      var cached = cache[cacheKey];
      if (cached) return { ok: true, mapping: cached.mapping, fromCache: true };

      return callAnthropic(apiKey, payload.fields, payload.fieldDefs)
        .then(function (mapping) {
          return setTier2CacheEntry(cacheKey, mapping).then(function () {
            return { ok: true, mapping: mapping, fromCache: false };
          });
        })
        .catch(function (err) {
          return { ok: false, reason: 'error', message: String((err && err.message) || err) };
        });
    });
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.type === 'TIER2_MATCH') {
    handleTier2Match(message.payload).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
});
