/**
 * Field matching + filling engine for AutoFill Profile — Tier 1 (local).
 *
 * Exposed as `window.LCFieldMatcher`. Kept dependency-free and separate from
 * content.js so matching rules can grow independently of detection/UI logic.
 *
 * Tier 1 matches fields locally using a multilingual keyword map + fuzzy
 * partial matching — no network access. Fields it can't confidently match
 * are left for content.js to hand off to the Tier 2 LLM fallback
 * (see background.js), which is a separate concern from this module.
 *
 * Expected profile shape (produced by options.js):
 * {
 *   personal: { firstName, lastName, email, phone, city, country },
 *   links: { linkedin, portfolio, github },
 *   education: { school, degree, field, gradYear },
 *   workExperience: [ { company, position, startDate, endDate }, ... ],
 *   languages: [ { language, proficiency }, ... ],
 *   skills: [ 'JavaScript', 'Figma', ... ],
 *   essays: { aboutMe, whyThisRole, strengths }
 * }
 */
(function () {
  'use strict';

  // Below this score a match is considered too weak to trust. Raised after
  // a real-world false positive (an Italian "Link dell'annuncio" URL field
  // fuzzy-matched to phone via "dell" ~ "cell") — see FUZZY_* constants
  // below, which are the actual fix; this threshold is a second layer.
  var MIN_SCORE_THRESHOLD = 2.4;

  // How much each signal on a field contributes when a keyword is found in it.
  var SOURCE_WEIGHTS = {
    label: 3,
    aria: 3,
    name: 2,
    id: 2,
    placeholder: 2,
    autocomplete: 2
  };

  // Exact whole-word/phrase matches are trusted; fuzzy (edit-distance)
  // matches are deliberately weaker so a near-miss on a short, generic
  // token can never outscore a real exact match. Skipping a field is
  // always preferable to filling it with the wrong value.
  var EXACT_MATCH_BONUS = 1.3;
  var FUZZY_MATCH_DAMPENING = 0.5;
  var FUZZY_MIN_TOKEN_LENGTH = 5; // below this, only exact token equality counts
  var FUZZY_SIMILARITY_CUTOFF = 0.82;

  // A field's type/inputmode is a hard constraint checked before any
  // keyword scoring happens — see getElementKindConstraint().
  var URL_KIND_IDS = ['linkedin', 'portfolio', 'github'];
  var TYPE_MATCH_SCORE = 99; // sentinel "score" for debug display when type alone decided the match

  var INPUT_TYPES_ALLOWED = [
    'text', 'email', 'tel', 'url', 'number', 'search', 'date', 'month'
  ];

  var LANGUAGE_PROFICIENCY_LEVELS = ['Basic', 'Intermediate', 'Advanced', 'Fluent', 'Native'];

  // ---- Multilingual keyword map -----------------------------------------
  // Language -> field id -> phrases in that language. To add a new
  // language, add ONE new top-level key here (e.g. `fr: { firstName: [...],
  // ... }`) — every field id below is optional, partial packs are fine.
  // All keywords across all languages are pooled per field id, so a page
  // in any covered language can be matched without knowing the page's
  // language ahead of time.
  var KEYWORD_PACKS = {
    en: {
      firstName: ['first name', 'firstname', 'fname', 'given name'],
      lastName: ['last name', 'lastname', 'lname', 'surname', 'family name'],
      fullName: ['full name', 'your name', 'name'],
      email: ['email', 'e mail', 'email address'],
      phone: ['phone', 'telephone', 'mobile', 'cell', 'phone number'],
      city: ['city', 'town'],
      country: ['country', 'nation', 'country region'],
      linkedin: ['linkedin', 'linked in'],
      portfolio: ['portfolio', 'personal website', 'personal site', 'website'],
      github: ['github', 'git hub'],
      educationSchool: ['school', 'university', 'college', 'institution', 'alma mater'],
      educationDegree: ['degree', 'qualification'],
      educationField: ['field of study', 'major', 'discipline', 'area of study'],
      educationGradYear: ['graduation year', 'grad year', 'year of graduation', 'graduation date'],
      workCompany: ['company name', 'employer', 'company', 'organization'],
      workPosition: ['job title', 'position title', 'position', 'role', 'title'],
      workStartDate: ['start date', 'employment start', 'from date', 'date started'],
      workEndDate: ['end date', 'employment end', 'to date', 'date ended'],
      languages: ['languages', 'language spoken', 'spoken languages'],
      skills: ['skills', 'skill set', 'technical skills', 'expertise', 'technologies', 'competencies'],
      aboutMe: ['about yourself', 'about me', 'tell us about yourself', 'bio', 'summary', 'introduce yourself'],
      whyThisRole: ['why this role', 'why do you want this job', 'why are you interested', 'why this position', 'motivation letter', 'why us'],
      strengths: ['greatest strengths', 'key strengths', 'your strengths', 'strengths']
    },
    it: {
      firstName: ['nome', 'nome di battesimo', 'primo nome'],
      lastName: ['cognome'],
      fullName: ['nome completo', 'nome e cognome'],
      email: ['email', 'indirizzo email', 'posta elettronica'],
      phone: ['telefono', 'cellulare', 'numero di telefono'],
      city: ['città', 'citta'],
      country: ['paese', 'nazione'],
      linkedin: ['linkedin'],
      portfolio: ['portfolio', 'sito web', 'sito personale'],
      github: ['github'],
      educationSchool: ['scuola', 'università', 'universita', 'istituto'],
      educationDegree: ['laurea', 'titolo di studio', 'diploma'],
      educationField: ['campo di studio', 'indirizzo di studio', 'materia di studio'],
      educationGradYear: ['anno di laurea', 'anno di diploma'],
      workCompany: ['azienda', 'datore di lavoro', 'società', 'societa'],
      workPosition: ['posizione', 'ruolo', 'qualifica professionale', 'titolo professionale'],
      workStartDate: ['data di inizio', 'inizio impiego'],
      workEndDate: ['data di fine', 'fine impiego'],
      languages: ['lingue', 'lingue parlate'],
      skills: ['competenze', 'abilità', 'abilita'],
      aboutMe: ['chi sono', 'parlaci di te', 'biografia', 'presentati'],
      whyThisRole: ['perché questo ruolo', 'perche questo ruolo', 'perché vuoi questo lavoro', 'lettera di motivazione'],
      strengths: ['punti di forza', 'i tuoi punti di forza']
    },
    de: {
      firstName: ['vorname'],
      lastName: ['nachname', 'familienname'],
      fullName: ['vollständiger name', 'vollstandiger name', 'ihr name'],
      email: ['email adresse', 'e mail adresse'],
      phone: ['telefon', 'telefonnummer', 'handynummer', 'mobilnummer'],
      city: ['stadt', 'wohnort'],
      country: ['land'],
      linkedin: ['linkedin'],
      portfolio: ['portfolio', 'webseite', 'persönliche webseite', 'personliche webseite'],
      github: ['github'],
      educationSchool: ['schule', 'universität', 'universitat', 'hochschule'],
      educationDegree: ['abschluss', 'akademischer grad'],
      educationField: ['studienfach', 'fachrichtung'],
      educationGradYear: ['abschlussjahr'],
      workCompany: ['firma', 'arbeitgeber', 'unternehmen'],
      workPosition: ['stellenbezeichnung', 'jobtitel', 'stelle', 'rolle'],
      workStartDate: ['startdatum', 'beginn der beschäftigung', 'beginn der beschaftigung'],
      workEndDate: ['enddatum', 'ende der beschäftigung', 'ende der beschaftigung'],
      languages: ['sprachen', 'sprachkenntnisse'],
      skills: ['fähigkeiten', 'fahigkeiten', 'kenntnisse'],
      aboutMe: ['über mich', 'uber mich', 'über dich', 'uber dich', 'kurzbeschreibung'],
      whyThisRole: ['warum diese rolle', 'warum diese position', 'motivationsschreiben'],
      strengths: ['ihre stärken', 'ihre starken', 'stärken', 'starken']
    },
    tr: {
      firstName: ['ad', 'isim', 'adınız', 'adiniz'],
      lastName: ['soyad', 'soyadı', 'soyadi', 'soyadınız', 'soyadiniz'],
      fullName: ['ad soyad', 'tam ad', 'adınız soyadınız', 'adiniz soyadiniz'],
      email: ['eposta', 'e posta', 'email adresi', 'e posta adresi'],
      phone: ['telefon numarası', 'telefon numarasi', 'cep telefonu'],
      city: ['şehir', 'sehir'],
      country: ['ülke', 'ulke'],
      linkedin: ['linkedin'],
      portfolio: ['portfolyo', 'kişisel web sitesi', 'kisisel web sitesi', 'web sitesi'],
      github: ['github'],
      educationSchool: ['okul', 'üniversite', 'universite'],
      educationDegree: ['derece', 'diploma'],
      educationField: ['bölüm', 'bolum', 'çalışma alanı', 'calisma alani'],
      educationGradYear: ['mezuniyet yılı', 'mezuniyet yili'],
      workCompany: ['şirket', 'sirket', 'işveren', 'isveren', 'firma adı', 'firma adi'],
      workPosition: ['pozisyon', 'unvan', 'görev', 'gorev'],
      workStartDate: ['başlangıç tarihi', 'baslangic tarihi', 'işe başlama tarihi', 'ise baslama tarihi'],
      workEndDate: ['bitiş tarihi', 'bitis tarihi', 'işten çıkış tarihi', 'isten cikis tarihi'],
      languages: ['diller', 'bildiğiniz diller', 'bildiginiz diller'],
      skills: ['yetenekler', 'beceriler'],
      aboutMe: ['hakkımda', 'hakkimda', 'kendinden bahset', 'kendinizden bahsedin'],
      whyThisRole: ['neden bu pozisyon', 'neden bu rol', 'motivasyon mektubu'],
      strengths: ['güçlü yönler', 'guclu yonler', 'güçlü yönleriniz', 'guclu yonleriniz']
    }
  };

  // ---- Non-linguistic field metadata ------------------------------------
  // id -> { getValue(profile), longtext?, selectable? }
  var FIELD_META = {
    firstName: { getValue: function (p) { return p.personal && p.personal.firstName; } },
    lastName: { getValue: function (p) { return p.personal && p.personal.lastName; } },
    fullName: {
      getValue: function (p) {
        var first = (p.personal && p.personal.firstName) || '';
        var last = (p.personal && p.personal.lastName) || '';
        return (first + ' ' + last).trim();
      }
    },
    email: { getValue: function (p) { return p.personal && p.personal.email; } },
    phone: { getValue: function (p) { return p.personal && p.personal.phone; } },
    city: { getValue: function (p) { return p.personal && p.personal.city; } },
    country: { selectable: true, getValue: function (p) { return p.personal && p.personal.country; } },
    linkedin: { getValue: function (p) { return p.links && p.links.linkedin; } },
    portfolio: { getValue: function (p) { return p.links && p.links.portfolio; } },
    github: { getValue: function (p) { return p.links && p.links.github; } },
    educationSchool: { getValue: function (p) { return p.education && p.education.school; } },
    educationDegree: { getValue: function (p) { return p.education && p.education.degree; } },
    educationField: { getValue: function (p) { return p.education && p.education.field; } },
    educationGradYear: { getValue: function (p) { return p.education && p.education.gradYear; } },
    // NOTE: only the most recent (first) work entry is used for now.
    // Matching repeated experience sections on a page is a good next step.
    workCompany: {
      getValue: function (p) { return p.workExperience && p.workExperience[0] && p.workExperience[0].company; }
    },
    workPosition: {
      getValue: function (p) { return p.workExperience && p.workExperience[0] && p.workExperience[0].position; }
    },
    workStartDate: {
      getValue: function (p) { return p.workExperience && p.workExperience[0] && p.workExperience[0].startDate; }
    },
    workEndDate: {
      getValue: function (p) { return p.workExperience && p.workExperience[0] && p.workExperience[0].endDate; }
    },
    languages: {
      getValue: function (p) {
        if (!p.languages || !p.languages.length) return '';
        return p.languages.map(function (l) {
          return l.proficiency ? (l.language + ' (' + l.proficiency + ')') : l.language;
        }).join(', ');
      }
    },
    skills: { getValue: function (p) { return (p.skills || []).join(', '); } },
    aboutMe: { longtext: true, getValue: function (p) { return p.essays && p.essays.aboutMe; } },
    whyThisRole: { longtext: true, getValue: function (p) { return p.essays && p.essays.whyThisRole; } },
    strengths: { longtext: true, getValue: function (p) { return p.essays && p.essays.strengths; } }
  };

  // ---- Text normalization -----------------------------------------------

  function stripSpecialLetters(s) {
    // Letters that aren't expressible as base + combining accent in
    // Unicode NFD, so NFD-stripping below won't catch them.
    return s
      .replace(/ß/g, 'ss')
      .replace(/ı/g, 'i').replace(/İ/g, 'I')
      .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
      .replace(/ş/g, 's').replace(/Ş/g, 'S');
  }

  function normalize(str) {
    if (!str) return '';
    var s = String(str)
      .replace(/([a-zA-Z])([A-Z])/g, '$1 $2'); // camelCase -> two words
    s = stripSpecialLetters(s);
    s = s.toLowerCase();
    s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); // à/é/ü/ö/ç/etc -> plain letter
    s = s
      .replace(/[_\-]+/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return s;
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function tokenize(text) {
    return text ? text.split(' ').filter(Boolean) : [];
  }

  // ---- Fuzzy matching -----------------------------------------------------

  function levenshtein(a, b) {
    if (a === b) return 0;
    var al = a.length, bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    var prev = new Array(bl + 1);
    var curr = new Array(bl + 1);
    for (var j = 0; j <= bl; j++) prev[j] = j;
    for (var i = 1; i <= al; i++) {
      curr[0] = i;
      for (var j2 = 1; j2 <= bl; j2++) {
        var cost = a[i - 1] === b[j2 - 1] ? 0 : 1;
        curr[j2] = Math.min(prev[j2] + 1, curr[j2 - 1] + 1, prev[j2 - 1] + cost);
      }
      var tmp = prev; prev = curr; curr = tmp;
    }
    return prev[bl];
  }

  function tokenSimilarity(a, b) {
    if (a === b) return 1;
    // Skip fuzzy matching on short tokens entirely — a 1-edit-distance
    // near-miss on a 4-letter word is frequently a different word in a
    // different language (e.g. Italian "dell'" ~ English "cell"), not a
    // translation. Only whole-word exact matches count below this length.
    if (a.length < FUZZY_MIN_TOKEN_LENGTH || b.length < FUZZY_MIN_TOKEN_LENGTH) return 0;
    var dist = levenshtein(a, b);
    var maxLen = Math.max(a.length, b.length);
    return 1 - dist / maxLen;
  }

  // Returns { score: 0..1, exact: bool } for how well a normalized keyword
  // phrase matches normalized field text, or null for no match at all.
  // Exact whole-word/phrase matches are flagged so the caller can weight
  // them far more heavily than a fuzzy (edit-distance) match — see
  // EXACT_MATCH_BONUS / FUZZY_MATCH_DAMPENING.
  function phraseMatchScore(kw, textNorm) {
    if (!textNorm) return null;
    if (kw.re.test(textNorm)) return { score: 1, exact: true };

    var textTokens = tokenize(textNorm);
    if (!textTokens.length) return null;

    var total = 0;
    for (var i = 0; i < kw.tokens.length; i++) {
      var pt = kw.tokens[i];
      var best = 0;
      for (var j = 0; j < textTokens.length; j++) {
        var sim = pt === textTokens[j] ? 1 : tokenSimilarity(pt, textTokens[j]);
        if (sim > best) best = sim;
        if (best === 1) break;
      }
      total += best;
    }
    var avg = total / kw.tokens.length;
    return avg >= FUZZY_SIMILARITY_CUTOFF ? { score: avg, exact: false } : null;
  }

  function specificity(tokenCount) {
    return 1 + Math.min(tokenCount - 1, 3) * 0.15;
  }

  // ---- Build FIELD_DEFS by pooling every language pack -------------------

  function buildFieldDefs() {
    var ids = Object.keys(FIELD_META);
    var defs = [];

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var weightByNorm = {};

      for (var lang in KEYWORD_PACKS) {
        var phrases = KEYWORD_PACKS[lang][id] || [];
        for (var p = 0; p < phrases.length; p++) {
          var norm = normalize(phrases[p]);
          if (!norm) continue;
          var w = specificity(tokenize(norm).length);
          if (!weightByNorm[norm] || weightByNorm[norm] < w) weightByNorm[norm] = w;
        }
      }

      var normKeywords = Object.keys(weightByNorm).map(function (norm) {
        return {
          norm: norm,
          tokens: tokenize(norm),
          re: new RegExp('\\b' + escapeRegExp(norm) + '\\b'),
          weight: weightByNorm[norm]
        };
      });

      var meta = FIELD_META[id];
      defs.push({
        id: id,
        normKeywords: normKeywords,
        description: (KEYWORD_PACKS.en[id] || []).join(' / ') || id,
        longtext: !!meta.longtext,
        selectable: !!meta.selectable,
        getValue: meta.getValue
      });
    }

    return defs;
  }

  var FIELD_DEFS = buildFieldDefs();

  function getFieldDefById(id) {
    for (var i = 0; i < FIELD_DEFS.length; i++) {
      if (FIELD_DEFS[i].id === id) return FIELD_DEFS[i];
    }
    return null;
  }

  // ---- DOM inspection ---------------------------------------------------

  function getLabelText(el) {
    var text = '';

    if (el.id) {
      try {
        var selector = 'label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]';
        var byFor = document.querySelector(selector);
        if (byFor) text = byFor.textContent;
      } catch (e) { /* invalid selector, ignore */ }
    }

    var ariaLabelledBy = el.getAttribute('aria-labelledby');
    if (!text && ariaLabelledBy) {
      var parts = ariaLabelledBy.split(/\s+/).map(function (id) {
        var node = document.getElementById(id);
        return node ? node.textContent : '';
      });
      text = parts.join(' ').trim();
    }

    if (!text) {
      var wrapping = el.closest('label');
      if (wrapping) text = wrapping.textContent;
    }

    if (!text) {
      // Shallow fallback: look for a <label> near the field within a
      // reasonable ancestor container (common form-row markup).
      var container = el.closest('div, li, tr, fieldset, p');
      if (container) {
        var candidate = container.querySelector('label');
        if (candidate) text = candidate.textContent;
      }
    }

    return (text || '').trim();
  }

  function getRawSignals(el) {
    return {
      label: getLabelText(el),
      placeholder: el.getAttribute('placeholder') || '',
      name: el.getAttribute('name') || '',
      id: el.getAttribute('id') || '',
      aria: el.getAttribute('aria-label') || '',
      autocomplete: el.getAttribute('autocomplete') || ''
    };
  }

  function bestSignalText(raw) {
    if (raw.label) return raw.label;
    if (raw.aria) return raw.aria;
    if (raw.placeholder) return raw.placeholder;
    if (raw.name) return raw.name;
    if (raw.id) return raw.id;
    return '';
  }

  // Human/LLM-readable signal for a field, plus the raw attribute values
  // (used by content.js both for the debug panel and the Tier 2 prompt).
  function getFieldSignals(el) {
    var raw = getRawSignals(el);
    return { raw: raw, text: bestSignalText(raw) };
  }

  function buildContext(el) {
    var raw = getRawSignals(el);
    return {
      label: normalize(raw.label),
      placeholder: normalize(raw.placeholder),
      name: normalize(raw.name),
      id: normalize(raw.id),
      aria: normalize(raw.aria),
      autocomplete: normalize(raw.autocomplete)
    };
  }

  function isVisible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  }

  function isFillable(el) {
    var tag = el.tagName;
    if (tag === 'SELECT') return !el.disabled;
    if (tag === 'TEXTAREA') return !el.disabled && !el.readOnly;
    if (tag === 'INPUT') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      return INPUT_TYPES_ALLOWED.indexOf(type) !== -1 && !el.disabled && !el.readOnly;
    }
    return false;
  }

  function collectFillableElements(root) {
    root = root || document;
    var nodes = root.querySelectorAll('input, textarea, select');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (isFillable(el) && isVisible(el)) out.push(el);
    }
    return out;
  }

  // ---- Scoring -----------------------------------------------------------

  function scoreDef(ctx, def) {
    var score = 0;
    for (var source in SOURCE_WEIGHTS) {
      var text = ctx[source];
      if (!text) continue;

      var bestContribution = 0;
      for (var k = 0; k < def.normKeywords.length; k++) {
        var kw = def.normKeywords[k];
        var m = phraseMatchScore(kw, text);
        if (!m) continue;
        var multiplier = m.exact ? EXACT_MATCH_BONUS : FUZZY_MATCH_DAMPENING;
        var contribution = m.score * kw.weight * multiplier;
        if (contribution > bestContribution) bestContribution = contribution;
      }

      if (bestContribution > 0) score += SOURCE_WEIGHTS[source] * bestContribution;
    }
    return score;
  }

  // A field's declared type/inputmode is a hard signal, checked BEFORE any
  // keyword scoring: type="email"/"tel" can only ever resolve to that exact
  // profile field (or stay unmatched — never guessed at from label text),
  // and type="url" can never resolve to phone or email. This is what
  // ultimately stops a URL field from being mis-filled with a phone number
  // even if some label text on the page happened to score well for phone.
  function getElementKindConstraint(el) {
    var type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    var inputmode = (el.getAttribute && el.getAttribute('inputmode') || '').toLowerCase();
    if (type === 'email' || inputmode === 'email') return 'email';
    if (type === 'tel' || inputmode === 'tel') return 'tel';
    if (type === 'url' || inputmode === 'url') return 'url';
    return null;
  }

  function matchElement(el, profile) {
    if (!isFillable(el) || !isVisible(el)) return null;

    var kind = getElementKindConstraint(el);

    // type="email" / type="tel" are exclusive: fill from the matching
    // profile field or leave unmatched — never fall through to scoring
    // against other fields (which is exactly how "dell'annuncio" ended up
    // guessed as a phone number).
    if (kind === 'email' || kind === 'tel') {
      var forcedDef = getFieldDefById(kind === 'email' ? 'email' : 'phone');
      var forcedValue = forcedDef.getValue(profile);
      if (!forcedValue) return null;
      return { el: el, def: forcedDef, value: forcedValue, score: TYPE_MATCH_SCORE };
    }

    // type="url" can only resolve to one of the link-shaped profile
    // fields — phone/email (and everything else) are excluded outright.
    var candidateDefs = FIELD_DEFS;
    if (kind === 'url') {
      candidateDefs = FIELD_DEFS.filter(function (d) { return URL_KIND_IDS.indexOf(d.id) !== -1; });
    }

    var ctx = buildContext(el);
    var best = null;
    var bestScore = 0;

    for (var i = 0; i < candidateDefs.length; i++) {
      var def = candidateDefs[i];
      var score = scoreDef(ctx, def);
      if (score > bestScore) {
        bestScore = score;
        best = def;
      }
    }

    if (!best || bestScore < MIN_SCORE_THRESHOLD) return null;

    var value = best.getValue(profile);
    if (value === null || value === undefined || value === '') return null;

    return { el: el, def: best, value: value, score: bestScore };
  }

  function matchForm(root, profile) {
    var elements = collectFillableElements(root);
    var matches = [];
    for (var i = 0; i < elements.length; i++) {
      var m = matchElement(elements[i], profile);
      if (m) matches.push(m);
    }
    return matches;
  }

  function hasFillableForm(root) {
    return collectFillableElements(root || document).length >= 3;
  }

  // NOTE: unlabeled date fields (no label/aria/placeholder/name/id at all)
  // are common and deliberately left unmatched — ctx has no signal text
  // for scoreDef to work with, so every def scores 0 and matchElement
  // returns null. Do not add positional/order-based guessing here (e.g.
  // "the first date field on the page must be the start date") — a wrong
  // guess is worse than leaving it blank for the user to fill in.

  // ---- Applying values ---------------------------------------------------

  function applyTextValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function applySelectValue(el, value) {
    var target = normalize(String(value));
    if (!target) return false;
    var match = null;

    for (var i = 0; i < el.options.length; i++) {
      var opt = el.options[i];
      if (normalize(opt.textContent) === target || normalize(opt.value) === target) {
        match = opt;
        break;
      }
    }

    if (!match) {
      for (var j = 0; j < el.options.length; j++) {
        var candidate = el.options[j];
        var optText = normalize(candidate.textContent);
        if (optText && (optText.indexOf(target) !== -1 || target.indexOf(optText) !== -1)) {
          match = candidate;
          break;
        }
      }
    }

    if (!match) return false;
    el.value = match.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function applyValue(el, value) {
    if (el.tagName === 'SELECT') return applySelectValue(el, value);
    return applyTextValue(el, value);
  }

  window.LCFieldMatcher = {
    FIELD_DEFS: FIELD_DEFS,
    LANGUAGE_PROFICIENCY_LEVELS: LANGUAGE_PROFICIENCY_LEVELS,
    SUPPORTED_LANGUAGES: Object.keys(KEYWORD_PACKS),
    normalize: normalize,
    collectFillableElements: collectFillableElements,
    getFieldSignals: getFieldSignals,
    getFieldDefById: getFieldDefById,
    matchElement: matchElement,
    matchForm: matchForm,
    hasFillableForm: hasFillableForm,
    applyValue: applyValue
  };
})();
