import { importCvFromFile } from './modules/cv-import.js';

(function () {
  'use strict';

  var LEVELS = ['Basic', 'Intermediate', 'Advanced', 'Fluent', 'Native'];

  var workList = [];
  var languagesList = [];

  var el = {
    cvFileInput: document.getElementById('cvFileInput'),
    cvImportStatus: document.getElementById('cvImportStatus'),
    cvImportMsg: document.getElementById('cvImportMsg'),
    cvImportPrivacyHint: document.getElementById('cvImportPrivacyHint'),
    form: document.getElementById('profileForm'),
    firstName: document.getElementById('firstName'),
    lastName: document.getElementById('lastName'),
    email: document.getElementById('email'),
    phone: document.getElementById('phone'),
    phoneCountryCode: document.getElementById('phoneCountryCode'),
    addressLine: document.getElementById('addressLine'),
    city: document.getElementById('city'),
    state: document.getElementById('state'),
    postalCode: document.getElementById('postalCode'),
    country: document.getElementById('country'),
    linkedin: document.getElementById('linkedin'),
    portfolio: document.getElementById('portfolio'),
    github: document.getElementById('github'),
    eduSchool: document.getElementById('eduSchool'),
    eduDegree: document.getElementById('eduDegree'),
    eduField: document.getElementById('eduField'),
    eduGradYear: document.getElementById('eduGradYear'),
    workListEl: document.getElementById('workList'),
    addWorkBtn: document.getElementById('addWorkBtn'),
    languagesListEl: document.getElementById('languagesList'),
    addLanguageBtn: document.getElementById('addLanguageBtn'),
    skills: document.getElementById('skills'),
    qWorkAuthorization: document.getElementById('qWorkAuthorization'),
    qVisaSponsorship: document.getElementById('qVisaSponsorship'),
    qWorkedHereBefore: document.getElementById('qWorkedHereBefore'),
    aboutMe: document.getElementById('aboutMe'),
    whyThisRole: document.getElementById('whyThisRole'),
    strengths: document.getElementById('strengths'),
    apiKey: document.getElementById('apiKey'),
    toggleApiKey: document.getElementById('toggleApiKey'),
    savedMsg: document.getElementById('savedMsg')
  };

  el.toggleApiKey.addEventListener('click', function () {
    var showing = el.apiKey.type === 'text';
    el.apiKey.type = showing ? 'password' : 'text';
    el.toggleApiKey.textContent = showing ? 'Show' : 'Hide';
  });

  // Shown/hidden as the API key field changes so the CV Import section
  // always accurately reflects whether uploading a CV will send its text
  // to the Anthropic API (see runCvImport) — disclosed before upload, not
  // after.
  function updateCvPrivacyHint() {
    el.cvImportPrivacyHint.hidden = !el.apiKey.value.trim();
  }

  el.apiKey.addEventListener('input', updateCvPrivacyHint);

  function esc(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // Accepts "linkedin.com/in/name" or a bare username-style value as well
  // as a full URL, and normalizes to an absolute URL on save so the field
  // both displays cleanly and isn't rejected by a target ATS page's own
  // "must be a valid URL" client-side validation.
  function normalizeUrl(value) {
    var v = (value || '').trim();
    if (!v) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
    return 'https://' + v.replace(/^\/+/, '');
  }

  function blankWork() {
    return { company: '', position: '', startDate: '', endDate: '' };
  }

  function blankLanguage() {
    return { language: '', proficiency: 'Fluent' };
  }

  // ---- Work experience ----------------------------------------------

  function renderWorkList() {
    el.workListEl.innerHTML = workList.map(function (row, i) {
      return (
        '<div class="entry-card" data-index="' + i + '">' +
        '  <div class="entry-grid">' +
        '    <label>Company<input type="text" class="we-company" value="' + esc(row.company) + '"></label>' +
        '    <label>Position<input type="text" class="we-position" value="' + esc(row.position) + '"></label>' +
        '    <label>Start date<input type="month" class="we-start" value="' + esc(row.startDate) + '"></label>' +
        '    <label>End date<input type="month" class="we-end" value="' + esc(row.endDate) + '" placeholder="Leave blank if current"></label>' +
        '  </div>' +
        '  <button type="button" class="remove-btn" data-remove-work="' + i + '">Remove</button>' +
        '</div>'
      );
    }).join('');

    Array.prototype.forEach.call(el.workListEl.querySelectorAll('[data-remove-work]'), function (btn) {
      btn.addEventListener('click', function () {
        captureWorkList();
        workList.splice(Number(btn.getAttribute('data-remove-work')), 1);
        renderWorkList();
      });
    });
  }

  function captureWorkList() {
    var cards = el.workListEl.querySelectorAll('.entry-card');
    workList = Array.prototype.map.call(cards, function (card) {
      return {
        company: card.querySelector('.we-company').value.trim(),
        position: card.querySelector('.we-position').value.trim(),
        startDate: card.querySelector('.we-start').value.trim(),
        endDate: card.querySelector('.we-end').value.trim()
      };
    });
  }

  el.addWorkBtn.addEventListener('click', function () {
    captureWorkList();
    workList.push(blankWork());
    renderWorkList();
  });

  // ---- Languages -------------------------------------------------------

  function renderLanguagesList() {
    el.languagesListEl.innerHTML = languagesList.map(function (row, i) {
      return (
        '<div class="entry-card" data-index="' + i + '">' +
        '  <div class="entry-grid">' +
        '    <label>Language<input type="text" class="lang-name" value="' + esc(row.language) + '"></label>' +
        '    <label>Proficiency' +
        '      <select class="lang-level">' +
        LEVELS.map(function (level) {
          return '<option value="' + level + '"' + (level === row.proficiency ? ' selected' : '') + '>' + level + '</option>';
        }).join('') +
        '      </select>' +
        '    </label>' +
        '  </div>' +
        '  <button type="button" class="remove-btn" data-remove-lang="' + i + '">Remove</button>' +
        '</div>'
      );
    }).join('');

    Array.prototype.forEach.call(el.languagesListEl.querySelectorAll('[data-remove-lang]'), function (btn) {
      btn.addEventListener('click', function () {
        captureLanguagesList();
        languagesList.splice(Number(btn.getAttribute('data-remove-lang')), 1);
        renderLanguagesList();
      });
    });
  }

  function captureLanguagesList() {
    var cards = el.languagesListEl.querySelectorAll('.entry-card');
    languagesList = Array.prototype.map.call(cards, function (card) {
      return {
        language: card.querySelector('.lang-name').value.trim(),
        proficiency: card.querySelector('.lang-level').value
      };
    });
  }

  el.addLanguageBtn.addEventListener('click', function () {
    captureLanguagesList();
    languagesList.push(blankLanguage());
    renderLanguagesList();
  });

  // ---- Load / render ------------------------------------------------

  function render(profile) {
    var p = profile.personal || {};
    el.firstName.value = p.firstName || '';
    el.lastName.value = p.lastName || '';
    el.email.value = p.email || '';
    el.phone.value = p.phone || '';
    el.phoneCountryCode.value = p.phoneCountryCode || '';
    el.addressLine.value = p.addressLine || '';
    el.city.value = p.city || '';
    el.state.value = p.state || '';
    el.postalCode.value = p.postalCode || '';
    el.country.value = p.country || '';

    var links = profile.links || {};
    el.linkedin.value = links.linkedin || '';
    el.portfolio.value = links.portfolio || '';
    el.github.value = links.github || '';

    var edu = profile.education || {};
    el.eduSchool.value = edu.school || '';
    el.eduDegree.value = edu.degree || '';
    el.eduField.value = edu.field || '';
    el.eduGradYear.value = edu.gradYear || '';

    workList = (profile.workExperience && profile.workExperience.length) ? profile.workExperience.slice() : [];
    renderWorkList();

    languagesList = (profile.languages && profile.languages.length) ? profile.languages.slice() : [];
    renderLanguagesList();

    el.skills.value = (profile.skills || []).join(', ');

    var commonQuestions = profile.commonQuestions || {};
    el.qWorkAuthorization.value = commonQuestions.workAuthorization || '';
    el.qVisaSponsorship.value = commonQuestions.visaSponsorship || '';
    el.qWorkedHereBefore.value = commonQuestions.workedHereBefore || '';

    var essays = profile.essays || {};
    el.aboutMe.value = essays.aboutMe || '';
    el.whyThisRole.value = essays.whyThisRole || '';
    el.strengths.value = essays.strengths || '';
  }

  function renderSettings(settings) {
    el.apiKey.value = (settings && settings.anthropicApiKey) || '';
    updateCvPrivacyHint();
  }

  function collectSettings() {
    return { anthropicApiKey: el.apiKey.value.trim() };
  }

  function collectProfile() {
    captureWorkList();
    captureLanguagesList();

    return {
      personal: {
        firstName: el.firstName.value.trim(),
        lastName: el.lastName.value.trim(),
        email: el.email.value.trim(),
        phone: el.phone.value.trim(),
        phoneCountryCode: el.phoneCountryCode.value.trim(),
        addressLine: el.addressLine.value.trim(),
        city: el.city.value.trim(),
        state: el.state.value.trim(),
        postalCode: el.postalCode.value.trim(),
        country: el.country.value.trim()
      },
      links: {
        linkedin: normalizeUrl(el.linkedin.value),
        portfolio: normalizeUrl(el.portfolio.value),
        github: normalizeUrl(el.github.value)
      },
      education: {
        school: el.eduSchool.value.trim(),
        degree: el.eduDegree.value.trim(),
        field: el.eduField.value.trim(),
        gradYear: el.eduGradYear.value.trim()
      },
      workExperience: workList.filter(function (row) {
        return row.company || row.position || row.startDate || row.endDate;
      }),
      languages: languagesList.filter(function (row) {
        return row.language;
      }),
      skills: el.skills.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      commonQuestions: {
        workAuthorization: el.qWorkAuthorization.value,
        visaSponsorship: el.qVisaSponsorship.value,
        workedHereBefore: el.qWorkedHereBefore.value
      },
      essays: {
        aboutMe: el.aboutMe.value.trim(),
        whyThisRole: el.whyThisRole.value.trim(),
        strengths: el.strengths.value.trim()
      }
    };
  }

  // ---- CV import -------------------------------------------------------
  // Fills form fields from a parsed CV but never saves on its own — the
  // user reviews and clicks "Save profile" themselves (see cv-import.js's
  // importCvFromFile for the extraction itself).

  function setCvStatus(text) {
    el.cvImportStatus.textContent = text || '';
  }

  function setCvMessage(text, kind) {
    el.cvImportMsg.textContent = text || '';
    el.cvImportMsg.hidden = !text;
    el.cvImportMsg.classList.toggle('cv-import-msg--error', kind === 'error');
  }

  function cvFailureMessage(result) {
    switch (result.reason) {
      case 'not-pdf':
        return 'That file isn’t a PDF. Fields left unchanged.';
      case 'no-text':
        return 'Couldn’t extract any text from this PDF (it may be a scanned image). Fields left unchanged.';
      case 'no-data':
        return 'Couldn’t find any usable information in this CV. Fields left unchanged.';
      default:
        return 'Couldn’t read this CV. Fields left unchanged.';
    }
  }

  function setIfPresent(inputEl, value) {
    if (!value) return 0;
    inputEl.value = value;
    return 1;
  }

  // Merges CV-derived entries into a list already on the form instead of
  // replacing it outright, so importing a CV never silently discards a
  // returning user's previously saved work experience/languages/skills —
  // it only adds entries the list doesn't already have (by keyFn).
  function mergeEntries(existing, incoming, keyFn) {
    var seen = {};
    existing.forEach(function (item) { seen[keyFn(item)] = true; });
    var merged = existing.slice();
    incoming.forEach(function (item) {
      var key = keyFn(item);
      if (seen[key]) return;
      seen[key] = true;
      merged.push(item);
    });
    return merged;
  }

  // CV import can't cover every layout, so the result reports what it
  // actually found instead of implying it read everything: a count of
  // scalar fields filled, plus which of the five major sections (each
  // either present or not, unlike the scalar fields above) came up empty.
  function fillFormFromPartialProfile(profile) {
    var p = profile.personal || {};
    var filled = 0;
    filled += setIfPresent(el.firstName, p.firstName);
    filled += setIfPresent(el.lastName, p.lastName);
    filled += setIfPresent(el.email, p.email);
    filled += setIfPresent(el.phone, p.phone);
    filled += setIfPresent(el.phoneCountryCode, p.phoneCountryCode);
    filled += setIfPresent(el.addressLine, p.addressLine);
    filled += setIfPresent(el.city, p.city);
    filled += setIfPresent(el.state, p.state);
    filled += setIfPresent(el.postalCode, p.postalCode);
    filled += setIfPresent(el.country, p.country);

    var links = profile.links || {};
    filled += setIfPresent(el.linkedin, links.linkedin);
    filled += setIfPresent(el.portfolio, links.portfolio);
    filled += setIfPresent(el.github, links.github);

    var edu = profile.education || {};
    var hasEducation = !!(edu.school || edu.degree || edu.field || edu.gradYear);
    filled += setIfPresent(el.eduSchool, edu.school);
    filled += setIfPresent(el.eduDegree, edu.degree);
    filled += setIfPresent(el.eduField, edu.field);
    filled += setIfPresent(el.eduGradYear, edu.gradYear);

    var essays = profile.essays || {};
    filled += setIfPresent(el.aboutMe, essays.aboutMe);

    var hasWork = !!(profile.workExperience && profile.workExperience.length);
    if (hasWork) {
      captureWorkList();
      workList = mergeEntries(workList, profile.workExperience, function (w) {
        return (w.company || '').trim().toLowerCase() + '|' + (w.position || '').trim().toLowerCase() + '|' + (w.startDate || '');
      });
      renderWorkList();
    }

    // Unlike work experience, languages and skills are replaced outright
    // rather than merged — a CV's own languages/skills list is a complete,
    // current snapshot, so a stale entry from a previous import (or from
    // hand-editing) should not survive alongside it. mergeEntries([], ...)
    // still dedupes the CV's own list case-insensitively.
    var hasLanguages = !!(profile.languages && profile.languages.length);
    if (hasLanguages) {
      languagesList = mergeEntries([], profile.languages, function (l) {
        return (l.language || '').trim().toLowerCase();
      });
      renderLanguagesList();
    }

    var hasSkills = !!(profile.skills && profile.skills.length);
    if (hasSkills) {
      var dedupedSkills = mergeEntries([], profile.skills, function (s) { return s.trim().toLowerCase(); });
      el.skills.value = dedupedSkills.join(', ');
    }

    var empty = [];
    if (!hasEducation) empty.push('education');
    if (!hasWork) empty.push('work experience');
    if (!hasLanguages) empty.push('languages');
    if (!hasSkills) empty.push('skills');
    if (!essays.aboutMe) empty.push('about me');

    return { filled: filled, empty: empty };
  }

  function joinWithAnd(items) {
    if (items.length < 2) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  function cvImportSummaryMessage(summary) {
    var fieldWord = summary.filled === 1 ? 'field' : 'fields';
    var base = 'Filled ' + summary.filled + ' ' + fieldWord + ' from your CV.';
    if (!summary.empty.length) return base + ' Review before saving.';

    var names = joinWithAnd(summary.empty);
    var wasnt = summary.empty.length === 1 ? 'wasn\'t' : 'weren\'t';
    var them = summary.empty.length === 1 ? 'it' : 'them';
    return base + ' ' + names.charAt(0).toUpperCase() + names.slice(1) +
      ' ' + wasnt + ' recognised, add ' + them + ' below.';
  }

  function runCvImport(file) {
    setCvMessage('');
    setCvStatus('Reading CV…');

    var apiKey = el.apiKey.value.trim();

    importCvFromFile(file, apiKey)
      .then(function (result) {
        setCvStatus('');
        if (!result.ok) {
          setCvMessage(cvFailureMessage(result), 'error');
          return;
        }
        var summary = fillFormFromPartialProfile(result.profile);
        setCvMessage(cvImportSummaryMessage(summary));
      })
      .catch(function () {
        setCvStatus('');
        setCvMessage('Something went wrong reading this CV. Fields left unchanged.', 'error');
      })
      .then(function () {
        el.cvFileInput.value = '';
      });
  }

  el.cvFileInput.addEventListener('change', function () {
    var file = el.cvFileInput.files && el.cvFileInput.files[0];
    if (file) runCvImport(file);
  });

  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var profile = collectProfile();
    var settings = collectSettings();
    chrome.storage.local.set({ profile: profile, settings: settings }, function () {
      el.linkedin.value = profile.links.linkedin;
      el.portfolio.value = profile.links.portfolio;
      el.github.value = profile.links.github;
      el.savedMsg.classList.add('show');
      setTimeout(function () {
        el.savedMsg.classList.remove('show');
      }, 2000);
    });
  });

  chrome.storage.local.get(['profile', 'settings'], function (result) {
    render(result.profile || {});
    renderSettings(result.settings || {});
  });
})();
