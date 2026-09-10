(function () {
  'use strict';

  var LEVELS = ['Basic', 'Intermediate', 'Advanced', 'Fluent', 'Native'];

  var workList = [];
  var languagesList = [];

  var el = {
    form: document.getElementById('profileForm'),
    firstName: document.getElementById('firstName'),
    lastName: document.getElementById('lastName'),
    email: document.getElementById('email'),
    phone: document.getElementById('phone'),
    city: document.getElementById('city'),
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
    el.city.value = p.city || '';
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
        city: el.city.value.trim(),
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
