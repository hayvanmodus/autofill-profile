(function () {
  'use strict';

  var HOST_ID = 'lc-autofill-fab-host';
  var ACCENT = '#4f46e5';
  var TIER_COLORS = { tier1: '#16a34a', tier2: '#7c3aed', unmatched: '#9ca3af' };
  var scanTimer = null;

  function isProfileEmpty(profile) {
    if (!profile) return true;
    var p = profile.personal || {};
    var hasWork = profile.workExperience && profile.workExperience.length > 0;
    var hasEssay = profile.essays && (profile.essays.aboutMe || profile.essays.whyThisRole || profile.essays.strengths);
    return !p.firstName && !p.lastName && !p.email && !hasWork && !hasEssay;
  }

  function hashString(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  function computeFormKey(elements) {
    var parts = elements.map(function (el) {
      return (el.getAttribute('name') || '') + '#' + (el.getAttribute('id') || '') + '#' + el.tagName;
    }).sort();
    return hashString(parts.join('|'));
  }

  // ---- Floating widget (shadow DOM) --------------------------------------

  function ensureHost() {
    var existing = document.getElementById(HOST_ID);
    if (existing) return existing;

    var host = document.createElement('div');
    host.id = HOST_ID;
    host.style.all = 'initial';
    document.documentElement.appendChild(host);

    var shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
      '  .wrap { position: fixed; bottom: 24px; right: 24px; z-index: 2147483647; ' +
      '    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; ' +
      '    display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }' +
      '  .toast { background: #111827; color: #fff; padding: 10px 14px; border-radius: 8px; ' +
      '    font-size: 13px; max-width: 280px; box-shadow: 0 4px 16px rgba(0,0,0,.2); opacity: 0; ' +
      '    transform: translateY(4px); transition: opacity .15s, transform .15s; }' +
      '  .toast.show { opacity: 1; transform: translateY(0); }' +
      '  .btn-row { display: flex; gap: 8px; }' +
      '  .fab { background: ' + ACCENT + '; color: #fff; border: none; border-radius: 999px; ' +
      '    padding: 12px 20px; font-size: 14px; font-weight: 600; cursor: pointer; ' +
      '    box-shadow: 0 4px 14px rgba(79,70,229,.4); display: flex; align-items: center; gap: 8px; ' +
      '    transition: transform .1s, box-shadow .1s; }' +
      '  .fab:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(79,70,229,.5); }' +
      '  .fab:active { transform: translateY(0); }' +
      '  .debug-toggle { background: #fff; color: #374151; border: 1px solid #d1d5db; border-radius: 999px; ' +
      '    width: 44px; height: 44px; font-size: 16px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.12); }' +
      '  .debug-toggle:hover { background: #f9fafb; }' +
      '  .panel { display: none; width: 320px; max-height: 360px; overflow-y: auto; background: #fff; ' +
      '    border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 12px; }' +
      '  .panel.show { display: block; }' +
      '  .panel h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; }' +
      '  .panel .note { font-size: 12px; color: #b45309; background: #fffbeb; border-radius: 6px; padding: 6px 8px; margin-bottom: 8px; }' +
      '  .row { display: flex; align-items: baseline; gap: 6px; padding: 4px 0; font-size: 12px; border-bottom: 1px solid #f3f4f6; }' +
      '  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; margin-top: 3px; }' +
      '  .row .label { color: #374151; flex: 1; word-break: break-word; }' +
      '  .row .field { color: #9ca3af; }' +
      '</style>' +
      '<div class="wrap">' +
      '  <div class="toast" id="toast"></div>' +
      '  <div class="panel" id="panel"></div>' +
      '  <div class="btn-row">' +
      '    <button type="button" class="debug-toggle" id="debugToggle" title="Show match debug info">🐞</button>' +
      '    <button type="button" class="fab" id="fillBtn">⚡ Fill form</button>' +
      '  </div>' +
      '</div>';

    shadow.getElementById('fillBtn').addEventListener('click', runFill);
    shadow.getElementById('debugToggle').addEventListener('click', function () {
      shadow.getElementById('panel').classList.toggle('show');
    });

    return host;
  }

  function removeHost() {
    var existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();
  }

  function showToast(message) {
    var host = document.getElementById(HOST_ID);
    if (!host || !host.shadowRoot) return;
    var toast = host.shadowRoot.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(function () {
      toast.classList.remove('show');
    }, 3000);
  }

  function renderDebugPanel(entries, note) {
    var host = document.getElementById(HOST_ID);
    if (!host || !host.shadowRoot) return;
    var panel = host.shadowRoot.getElementById('panel');

    var groups = { tier1: [], tier2: [], unmatched: [] };
    entries.forEach(function (e) { groups[e.tier].push(e); });

    function renderGroup(title, tier) {
      var rows = groups[tier];
      if (!rows.length) return '';
      var html = '<h4>' + title + ' (' + rows.length + ')</h4>';
      rows.forEach(function (r) {
        html +=
          '<div class="row">' +
          '<span class="dot" style="background:' + TIER_COLORS[tier] + '"></span>' +
          '<span class="label">' + escapeHtml(r.text || '(no label)') + '</span>' +
          '<span class="field">' + escapeHtml(r.fieldId || '') + '</span>' +
          '</div>';
      });
      return html;
    }

    var html = '';
    if (note) html += '<div class="note">' + escapeHtml(note) + '</div>';
    html += renderGroup('Matched — Tier 1', 'tier1');
    html += renderGroup('Matched — Tier 2 (AI)', 'tier2');
    html += renderGroup('Unmatched', 'unmatched');
    panel.innerHTML = html || '<div class="note">No fillable fields found.</div>';
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function highlightElement(el) {
    var original = {
      outline: el.style.outline,
      outlineOffset: el.style.outlineOffset,
      transition: el.style.transition,
      boxShadow: el.style.boxShadow
    };
    el.style.transition = 'outline-color .15s, box-shadow .15s';
    el.style.outline = '2px solid ' + ACCENT;
    el.style.outlineOffset = '1px';
    el.style.boxShadow = '0 0 0 4px rgba(79,70,229,.2)';

    setTimeout(function () {
      el.style.outline = original.outline;
      el.style.outlineOffset = original.outlineOffset;
      el.style.boxShadow = original.boxShadow;
      setTimeout(function () {
        el.style.transition = original.transition;
      }, 200);
    }, 1400);
  }

  // ---- Fill orchestration: Tier 1 (local) then Tier 2 (LLM fallback) ----

  function runFill() {
    chrome.storage.local.get(['profile'], function (result) {
      var profile = result.profile;

      if (isProfileEmpty(profile)) {
        showToast('Set up your profile first — opening settings…');
        if (chrome.runtime && chrome.runtime.openOptionsPage) {
          chrome.runtime.openOptionsPage();
        }
        return;
      }

      var matcher = window.LCFieldMatcher;
      var allEls = matcher.collectFillableElements(document);

      var debugEntries = [];
      var filledCount = 0;
      var matchedEls = new Set();

      allEls.forEach(function (el) {
        var m = matcher.matchElement(el, profile);
        if (!m) return;
        matchedEls.add(el);
        var ok = matcher.applyValue(el, m.value);
        if (ok) {
          filledCount++;
          highlightElement(el);
        }
        debugEntries.push({ text: matcher.getFieldSignals(el).text, tier: 'tier1', fieldId: m.def.id });
      });

      var unmatchedEls = allEls.filter(function (el) { return !matchedEls.has(el); });
      var candidates = unmatchedEls
        .map(function (el) { return { el: el, text: matcher.getFieldSignals(el).text }; })
        .filter(function (c) { return c.text; });

      unmatchedEls
        .filter(function (el) { return !matcher.getFieldSignals(el).text; })
        .forEach(function () {
          debugEntries.push({ text: '', tier: 'unmatched', fieldId: null });
        });

      if (candidates.length === 0) {
        finishFill(filledCount, debugEntries, null);
        return;
      }

      var payload = {
        hostname: location.hostname,
        formKey: computeFormKey(allEls),
        fields: candidates.map(function (c, i) { return { index: i, text: c.text }; }),
        fieldDefs: matcher.FIELD_DEFS.map(function (d) { return { id: d.id, description: d.description }; })
      };

      chrome.runtime.sendMessage({ type: 'TIER2_MATCH', payload: payload }, function (response) {
        var note = null;

        if (response && response.ok) {
          candidates.forEach(function (c, i) {
            var fieldId = response.mapping[String(i)];
            var def = fieldId ? matcher.getFieldDefById(fieldId) : null;
            var value = def ? def.getValue(profile) : null;

            if (def && value) {
              var ok = matcher.applyValue(c.el, value);
              if (ok) {
                filledCount++;
                highlightElement(c.el);
              }
              debugEntries.push({ text: c.text, tier: 'tier2', fieldId: fieldId });
            } else {
              debugEntries.push({ text: c.text, tier: 'unmatched', fieldId: null });
            }
          });
        } else {
          if (response && response.reason === 'error') {
            note = 'Tier 2 (AI) request failed: ' + (response.message || 'unknown error');
          } else if (response && response.reason === 'no-api-key') {
            note = 'Tier 2 (AI) skipped — no Anthropic API key set in options.';
          }
          candidates.forEach(function (c) {
            debugEntries.push({ text: c.text, tier: 'unmatched', fieldId: null });
          });
        }

        finishFill(filledCount, debugEntries, note);
      });
    });
  }

  function finishFill(filledCount, debugEntries, note) {
    renderDebugPanel(debugEntries, note);
    showToast(filledCount > 0
      ? 'Filled ' + filledCount + ' field' + (filledCount === 1 ? '' : 's') + '. Review before submitting.'
      : 'No matching fields found on this page.');
  }

  // ---- Detection ----------------------------------------------------------

  function scanForForm() {
    var found = window.LCFieldMatcher.hasFillableForm(document);
    if (found) {
      ensureHost();
    } else {
      removeHost();
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanForForm, 500);
  }

  scanForForm();
  window.addEventListener('load', scanForForm);

  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var target = mutations[i].target;
      if (target && target.id === HOST_ID) continue;
      scheduleScan();
      return;
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
