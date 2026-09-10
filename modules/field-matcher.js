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

  // Generic "website"-style phrases are ambiguous — a real-world Italian
  // "Sito web dell'agenzia immobiliare" (a company's website, not the
  // user's) fuzzy/exact-matched portfolio via bare "sito web". Rather than
  // drop these phrases outright (which also stops a plain "Website" field
  // from matching a real portfolio field — a regression caught in testing),
  // they're kept as "weak" keywords: they still score normally, UNLESS the
  // same field's text also contains a company/employer word, in which case
  // they're skipped for that field. Specific phrases like "portfolio" or
  // "personal website" are unambiguous and stay as regular (strong)
  // keywords in KEYWORD_PACKS below — this list is only for the generic
  // "website" family.
  var WEAK_KEYWORD_PHRASES = {
    portfolio: ['website', 'sito web', 'webseite', 'web sitesi']
  };

  var COMPANY_CONTEXT_WORDS = [
    'company', 'employer', 'agency', 'business', 'organization', 'organisation',
    'azienda', 'impresa', 'agenzia', 'datore di lavoro', 'societa',
    'unternehmen', 'firma', 'arbeitgeber',
    'sirket', 'isveren', 'firma adi'
  ].map(normalize);

  function hasCompanyContext(textNorm) {
    for (var i = 0; i < COMPANY_CONTEXT_WORDS.length; i++) {
      if (textNorm.indexOf(COMPANY_CONTEXT_WORDS[i]) !== -1) return true;
    }
    return false;
  }

  // "Country/Territory Phone Code" (Workday) wants a dialing code like
  // "+39", not a country name — but it contains the literal word "country",
  // so it exact-matches the `country` def's own keyword. Used both to seed
  // the phoneCountryCode field below and, unmodified, to hard-block
  // `country` matching in NEGATIVE_KEYWORD_PHRASES.
  var PHONE_CODE_PHRASES = {
    en: ['phone code', 'dialing code', 'calling code', 'country code', 'country phone code', 'international dialing code'],
    it: ['prefisso telefonico', 'prefisso internazionale', 'prefisso paese'],
    de: ['landesvorwahl', 'telefonvorwahl', 'laendercode'],
    tr: ['telefon kodu', 'ulke kodu', 'cevirme kodu']
  };

  // Qualifiers for a name that aren't the name itself — there's no profile
  // field for any of these (see FIELD_META), so a field asking for one is
  // deliberately left unmatched rather than filled with the legal name.
  var NAME_QUALIFIER_NEGATIVE_PHRASES = [
    'middle name', 'secondo nome', 'zweiter vorname', 'mittelname', 'gobek adi',
    'preferred name', 'nome preferito', 'bevorzugter name', 'spitzname', 'tercih edilen ad', 'takma ad'
  ];

  // A field whose text contains one of these phrases is NEVER matched to
  // that id, regardless of how well other keywords score — stronger than
  // WEAK_KEYWORD_PHRASES above (which only guards specific ambiguous
  // keywords), this blocks the def outright. Real-world false positives:
  // "Legal Middle Name" and "I have a preferred name" exact-matching
  // fullName/firstName/lastName via the bare "name" keyword, and
  // "Country/Territory Phone Code" exact-matching `country` (see
  // PHONE_CODE_PHRASES above).
  var NEGATIVE_KEYWORD_PHRASES = {
    firstName: NAME_QUALIFIER_NEGATIVE_PHRASES,
    lastName: NAME_QUALIFIER_NEGATIVE_PHRASES,
    fullName: NAME_QUALIFIER_NEGATIVE_PHRASES,
    country: [].concat(PHONE_CODE_PHRASES.en, PHONE_CODE_PHRASES.it, PHONE_CODE_PHRASES.de, PHONE_CODE_PHRASES.tr)
  };

  function hasNegativeContext(ctx, negativeKeywords) {
    for (var source in SOURCE_WEIGHTS) {
      var text = ctx[source];
      if (!text) continue;
      for (var i = 0; i < negativeKeywords.length; i++) {
        if (negativeKeywords[i].test(text)) return true;
      }
    }
    return false;
  }

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
      addressLine: ['address', 'street address', 'address line 1', 'mailing address'],
      state: ['state', 'province', 'state province', 'region'],
      postalCode: ['postal code', 'zip code', 'zip', 'post code'],
      phoneCountryCode: PHONE_CODE_PHRASES.en,
      linkedin: ['linkedin', 'linked in'],
      portfolio: ['portfolio', 'personal website', 'personal site'],
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
      addressLine: ['indirizzo', 'via', 'indirizzo di residenza'],
      state: ['provincia', 'regione'],
      postalCode: ['codice postale'],
      phoneCountryCode: PHONE_CODE_PHRASES.it,
      linkedin: ['linkedin'],
      portfolio: ['portfolio', 'sito web personale', 'sito personale'],
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
      addressLine: ['adresse', 'straße', 'strasse', 'anschrift'],
      state: ['bundesland', 'kanton'],
      postalCode: ['postleitzahl'],
      phoneCountryCode: PHONE_CODE_PHRASES.de,
      linkedin: ['linkedin'],
      portfolio: ['portfolio', 'persönliche webseite', 'personliche webseite'],
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
      addressLine: ['adres', 'açık adres', 'acik adres'],
      state: ['eyalet', 'vilayet'],
      postalCode: ['posta kodu'],
      phoneCountryCode: PHONE_CODE_PHRASES.tr,
      linkedin: ['linkedin'],
      portfolio: ['portfolyo', 'kişisel web sitesi', 'kisisel web sitesi'],
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

  // Options page accepts URLs without a scheme (e.g. "linkedin.com/in/ada")
  // and normalizes on save — see options.js's own copy of this logic. This
  // is a second, defensive pass at fill time: a value saved before that
  // normalization existed, or edited directly in storage, still gets a
  // scheme here. Real-world payoff: some ATS URL fields client-side-reject
  // a value with no scheme, which silently "loses" the fill.
  function normalizeUrlValue(value) {
    if (!value) return value;
    var v = String(value).trim();
    if (!v) return v;
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v; // already has a scheme (http:, https:, mailto:, ...)
    return 'https://' + v.replace(/^\/+/, '');
  }

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
    addressLine: { getValue: function (p) { return p.personal && p.personal.addressLine; } },
    state: { getValue: function (p) { return p.personal && p.personal.state; } },
    postalCode: { getValue: function (p) { return p.personal && p.personal.postalCode; } },
    // A dialing code like "+39" is a distinct concept from the country name
    // itself — see NEGATIVE_KEYWORD_PHRASES.country above, which is what
    // stops a Workday "Country/Territory Phone Code" field from being
    // filled with the country name instead of this.
    phoneCountryCode: { getValue: function (p) { return p.personal && p.personal.phoneCountryCode; } },
    linkedin: { getValue: function (p) { return normalizeUrlValue(p.links && p.links.linkedin); } },
    portfolio: { getValue: function (p) { return normalizeUrlValue(p.links && p.links.portfolio); } },
    github: { getValue: function (p) { return normalizeUrlValue(p.links && p.links.github); } },
    educationSchool: { getValue: function (p) { return p.education && p.education.school; } },
    educationDegree: { getValue: function (p) { return p.education && p.education.degree; } },
    educationField: { getValue: function (p) { return p.education && p.education.field; } },
    educationGradYear: { getValue: function (p) { return p.education && p.education.gradYear; } },
    // When a page has several repeating experience sections, each def below
    // is resolved once per occurrence (see `repeatableGroup` / resolveValue):
    // the 1st workCompany field on the page gets workExperience[0], the 2nd
    // gets workExperience[1], etc. Assumes sections repeat top-to-bottom in
    // the same order the fields are declared per section, which holds for
    // the generic repeating-fieldset markup these ATSes use.
    workCompany: {
      repeatableGroup: 'workExperience',
      getValue: function (p, idx) { var e = p.workExperience && p.workExperience[idx || 0]; return e && e.company; }
    },
    workPosition: {
      repeatableGroup: 'workExperience',
      getValue: function (p, idx) { var e = p.workExperience && p.workExperience[idx || 0]; return e && e.position; }
    },
    workStartDate: {
      repeatableGroup: 'workExperience',
      getValue: function (p, idx) { var e = p.workExperience && p.workExperience[idx || 0]; return e && e.startDate; }
    },
    workEndDate: {
      repeatableGroup: 'workExperience',
      getValue: function (p, idx) { var e = p.workExperience && p.workExperience[idx || 0]; return e && e.endDate; }
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

  // ---- Build defs by pooling every language pack -------------------------
  // Shared by FIELD_DEFS (text/select inputs) and QUESTION_DEFS (radio /
  // checkbox groups) — both are "an id -> per-language keyword phrases"
  // pack matched against some normalized text, differing only in metadata.

  function buildDefsFromPacks(packs, metaMap) {
    var ids = Object.keys(metaMap);
    var defs = [];

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var weightByNorm = {};
      var weakNorms = {};

      for (var lang in packs) {
        var phrases = packs[lang][id] || [];
        for (var p = 0; p < phrases.length; p++) {
          var norm = normalize(phrases[p]);
          if (!norm) continue;
          var w = specificity(tokenize(norm).length);
          if (!weightByNorm[norm] || weightByNorm[norm] < w) weightByNorm[norm] = w;
        }
      }

      var weakPhrases = WEAK_KEYWORD_PHRASES[id] || [];
      for (var wp = 0; wp < weakPhrases.length; wp++) {
        var weakNorm = normalize(weakPhrases[wp]);
        // A strong (unambiguous) phrase always wins if it happens to
        // normalize to the same text as a weak one — never downgrade it.
        if (!weakNorm || weightByNorm.hasOwnProperty(weakNorm)) continue;
        weightByNorm[weakNorm] = specificity(tokenize(weakNorm).length);
        weakNorms[weakNorm] = true;
      }

      var normKeywords = Object.keys(weightByNorm).map(function (norm) {
        return {
          norm: norm,
          tokens: tokenize(norm),
          re: new RegExp('\\b' + escapeRegExp(norm) + '\\b'),
          weight: weightByNorm[norm],
          weak: !!weakNorms[norm]
        };
      });

      var negativeKeywords = (NEGATIVE_KEYWORD_PHRASES[id] || []).map(function (phrase) {
        return new RegExp('\\b' + escapeRegExp(normalize(phrase)) + '\\b');
      });

      var meta = metaMap[id];
      defs.push({
        id: id,
        normKeywords: normKeywords,
        negativeKeywords: negativeKeywords,
        description: (packs.en[id] || []).join(' / ') || id,
        longtext: !!meta.longtext,
        selectable: !!meta.selectable,
        repeatableGroup: meta.repeatableGroup || null,
        getValue: meta.getValue
      });
    }

    return defs;
  }

  var FIELD_DEFS = buildDefsFromPacks(KEYWORD_PACKS, FIELD_META);

  function getFieldDefById(id) {
    for (var i = 0; i < FIELD_DEFS.length; i++) {
      if (FIELD_DEFS[i].id === id) return FIELD_DEFS[i];
    }
    return null;
  }

  // ---- Standard yes/no application questions (radio / checkbox groups) --
  // Same pooling approach as KEYWORD_PACKS/FIELD_META above, but matched
  // against a *group's* label (fieldset legend, aria-labelledby, etc.)
  // instead of a single field's signals — see getGroupLabelText().
  var QUESTION_KEYWORD_PACKS = {
    en: {
      workAuthorization: ['authorized to work', 'legally authorized to work', 'eligible to work', 'work authorization', 'authorised to work'],
      visaSponsorship: ['require sponsorship', 'require visa sponsorship', 'need sponsorship', 'visa sponsorship', 'sponsorship to work', 'sponsorship for employment'],
      workedHereBefore: ['worked here before', 'previously worked for this company', 'previously employed', 'former employee', 'worked for us before', 'previously worked for us']
    },
    it: {
      workAuthorization: ['autorizzato a lavorare', 'permesso di lavoro', 'autorizzazione al lavoro'],
      visaSponsorship: ['sponsorizzazione del visto', 'necessiti di uno sponsor per il visto', 'permesso di soggiorno per lavoro'],
      workedHereBefore: ['hai già lavorato qui', 'hai gia lavorato qui', 'lavorato in precedenza per questa azienda', 'ex dipendente']
    },
    de: {
      workAuthorization: ['arbeitserlaubnis', 'arbeitsberechtigung', 'berechtigt zu arbeiten'],
      visaSponsorship: ['visum sponsoring', 'arbeitsvisum sponsoring', 'benötigen sie ein arbeitsvisum', 'benotigen sie ein arbeitsvisum'],
      workedHereBefore: ['bereits hier gearbeitet', 'waren sie bereits bei uns beschäftigt', 'waren sie bereits bei uns beschaftigt', 'ehemaliger mitarbeiter']
    },
    tr: {
      workAuthorization: ['çalışma izni', 'calisma izni', 'çalışmaya yetkili misiniz', 'calismaya yetkili misiniz'],
      visaSponsorship: ['vize sponsorluğu', 'vize sponsorlugu', 'çalışma vizesi sponsorluğu', 'calisma vizesi sponsorlugu'],
      workedHereBefore: ['daha önce burada çalıştınız mı', 'daha once burada calistiniz mi', 'bu şirkette daha önce çalıştınız mı', 'bu sirkette daha once calistiniz mi', 'eski çalışan', 'eski calisan']
    }
  };

  var QUESTION_META = {
    workAuthorization: { getValue: function (p) { return p.commonQuestions && p.commonQuestions.workAuthorization; } },
    visaSponsorship: { getValue: function (p) { return p.commonQuestions && p.commonQuestions.visaSponsorship; } },
    workedHereBefore: { getValue: function (p) { return p.commonQuestions && p.commonQuestions.workedHereBefore; } }
  };

  var QUESTION_DEFS = buildDefsFromPacks(QUESTION_KEYWORD_PACKS, QUESTION_META);

  function getQuestionDefById(id) {
    for (var i = 0; i < QUESTION_DEFS.length; i++) {
      if (QUESTION_DEFS[i].id === id) return QUESTION_DEFS[i];
    }
    return null;
  }

  // Pooled yes/no option words across all supported languages, used to pick
  // the right radio/checkbox once a group's question has been identified.
  var YES_WORDS = ['yes', 'si', 'sì', 'ja', 'evet'].map(normalize);
  var NO_WORDS = ['no', 'nein', 'hayır', 'hayir'].map(normalize);

  // Real-world ATS wording for a single standalone checkbox is often
  // negated ("I do NOT require visa sponsorship", "I am not authorized to
  // work in the US") — the QUESTION_KEYWORD_PACKS phrases still substring-
  // match these (e.g. "require sponsorship" appears inside "do not require
  // sponsorship"), so without this the checkbox gets checked/unchecked
  // backwards from the user's actual answer. See matchQuestionGroup's
  // isSingleCheckbox branch.
  //
  // Checked against the RAW (unnormalized) label, not normalize()'s output:
  // normalize's camelCase-splitting regex treats consecutive capitals as
  // camelCase boundaries too, so all-caps "NOT" becomes "N OT" — silently
  // breaking a token-based check on the normalized text.
  var NEGATION_RE = /\b(not|non|nicht|kein|keine|değil|degil)\b/i;

  function hasNegation(rawText) {
    return NEGATION_RE.test(String(rawText || ''));
  }

  // Shared by matchQuestionGroup (radio/checkbox groups) and
  // matchElementAsQuestion (a single select/text field) — both score
  // `ctx` against QUESTION_DEFS the same way and need the same yes/no
  // answer validation; they differ only in how they apply the result.
  function pickBestQuestionAnswer(ctx, profile) {
    var best = null;
    var bestScore = 0;

    for (var i = 0; i < QUESTION_DEFS.length; i++) {
      var def = QUESTION_DEFS[i];
      var score = scoreDef(ctx, def);
      if (score > bestScore) {
        bestScore = score;
        best = def;
      }
    }

    if (!best || bestScore < MIN_SCORE_THRESHOLD) return null;

    var answer = best.getValue(profile);
    if (answer !== 'yes' && answer !== 'no') return null;

    return { def: best, answer: answer, score: bestScore };
  }

  // ---- Shadow DOM traversal ----------------------------------------------
  // ATS platforms (Workday, Greenhouse, Lever, ...) commonly render form
  // fields inside open shadow roots. Every collection/lookup below needs to
  // see into those trees, and label lookups need to search *within the
  // right tree* (a label in one shadow root can't reach an input in
  // another via plain document.querySelector).

  function getOwnerRoot(el) {
    return (el.getRootNode && el.getRootNode()) || document;
  }

  // Depth-first walk of `root` plus every open shadow root reachable from
  // it. Returns an array of root nodes (Document/ShadowRoot), each usable
  // directly with querySelectorAll/getElementById.
  function collectRoots(root, acc) {
    acc.push(root);
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      if (node.shadowRoot) collectRoots(node.shadowRoot, acc);
    }
    return acc;
  }

  function collectAllRoots(root) {
    return collectRoots(root || document, []);
  }

  function deepQueryAll(root, selector) {
    var roots = collectAllRoots(root);
    var out = [];
    for (var i = 0; i < roots.length; i++) {
      var found = roots[i].querySelectorAll(selector);
      for (var j = 0; j < found.length; j++) out.push(found[j]);
    }
    return out;
  }

  // ---- DOM inspection ---------------------------------------------------

  function getLabelText(el) {
    var text = '';
    var ownerRoot = getOwnerRoot(el);

    if (el.id) {
      try {
        var selector = 'label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]';
        var byFor = ownerRoot.querySelector(selector);
        if (byFor) text = byFor.textContent;
      } catch (e) { /* invalid selector, ignore */ }
    }

    var ariaLabelledBy = el.getAttribute('aria-labelledby');
    if (!text && ariaLabelledBy) {
      var parts = ariaLabelledBy.split(/\s+/).map(function (id) {
        var node = ownerRoot.getElementById ? ownerRoot.getElementById(id) : document.getElementById(id);
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

  function buildContext(el, raw) {
    raw = raw || getRawSignals(el);
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
    var nodes = deepQueryAll(root, 'input, textarea, select');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (isFillable(el) && isVisible(el)) out.push(el);
    }
    return out;
  }

  // ---- Radio / checkbox groups (standard yes/no questions) ---------------

  // The question text for a whole radio/checkbox group — a fieldset legend,
  // an aria-labelledby/aria-label on a role="group"/"radiogroup" wrapper —
  // as opposed to getLabelText(), which resolves one specific option.
  function getGroupLabelText(el) {
    var ownerRoot = getOwnerRoot(el);

    var fieldset = el.closest('fieldset');
    if (fieldset) {
      var legend = fieldset.querySelector('legend');
      if (legend && legend.textContent.trim()) return legend.textContent.trim();
    }

    var groupContainer = el.closest('[role="radiogroup"], [role="group"]');
    if (groupContainer) {
      var ariaLabel = groupContainer.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

      var labelledBy = groupContainer.getAttribute('aria-labelledby');
      if (labelledBy) {
        var parts = labelledBy.split(/\s+/).map(function (id) {
          var node = ownerRoot.getElementById ? ownerRoot.getElementById(id) : document.getElementById(id);
          return node ? node.textContent : '';
        });
        var text = parts.join(' ').trim();
        if (text) return text;
      }
    }

    return '';
  }

  // The label of one specific radio/checkbox option (e.g. "Yes"), as
  // opposed to getGroupLabelText() above, which resolves the question.
  function getOptionLabelText(el) {
    var text = getLabelText(el);
    if (!text) text = el.getAttribute('aria-label') || '';
    if (!text) text = el.getAttribute('value') || '';
    return text;
  }

  // Groups radio/checkbox inputs by shared `name` within the same owning
  // form (or owner root, for fields with no <form> ancestor — common in
  // shadow-DOM ATS widgets). A lone checkbox with a unique name is its own
  // one-element "group".
  function collectRadioGroups(root) {
    var nodes = deepQueryAll(root, 'input[type="radio"], input[type="checkbox"]');
    var groups = [];

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.disabled || !isVisible(el)) continue;

      var name = el.getAttribute('name') || '';
      var scope = el.form || getOwnerRoot(el);
      var group = null;

      if (name) {
        for (var g = 0; g < groups.length; g++) {
          if (groups[g].scope === scope && groups[g].name === name) {
            group = groups[g];
            break;
          }
        }
      }

      if (!group) {
        group = { scope: scope, name: name, elements: [] };
        groups.push(group);
      }
      group.elements.push(el);
    }

    return groups;
  }

  function matchQuestionGroup(group, profile) {
    // A lone checkbox (no radio siblings) is often its own full question —
    // e.g. a single "I require visa sponsorship to work in this country"
    // checkbox with no fieldset — rather than a yes/no pair with a legend.
    var isSingleCheckbox = group.elements.length === 1 &&
      (group.elements[0].getAttribute('type') || '').toLowerCase() === 'checkbox';

    var labelText = getGroupLabelText(group.elements[0]);
    if (!labelText && isSingleCheckbox) {
      labelText = getOptionLabelText(group.elements[0]);
    }
    if (!labelText) return null;

    var ctx = { label: normalize(labelText) };
    var picked = pickBestQuestionAnswer(ctx, profile);
    if (!picked) return null;

    if (isSingleCheckbox) {
      // The checkbox's own label IS the statement being agreed to. If it's
      // phrased in the negative ("I do NOT require sponsorship"), checking
      // it means the opposite of the profile's stored yes/no answer.
      var negated = hasNegation(labelText);
      var checked = negated ? picked.answer === 'no' : picked.answer === 'yes';
      return {
        def: picked.def, target: group.elements[0], elements: group.elements,
        labelText: labelText, checkedState: checked
      };
    }

    var words = picked.answer === 'yes' ? YES_WORDS : NO_WORDS;
    var target = null;
    for (var j = 0; j < group.elements.length; j++) {
      var optionTokens = tokenize(normalize(getOptionLabelText(group.elements[j])));
      if (optionTokens.some(function (t) { return words.indexOf(t) !== -1; })) {
        target = group.elements[j];
        break;
      }
    }
    if (!target) return null;

    return { def: picked.def, target: target, elements: group.elements, labelText: labelText, checkedState: true };
  }

  function applyRadioGroupValue(match) {
    var el = match.target;
    if (el.tagName !== 'INPUT') return false;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked').set;
    setter.call(el, match.checkedState);
    el.dispatchEvent(new Event('click', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // ---- Scoring -----------------------------------------------------------

  function scoreDef(ctx, def) {
    if (def.negativeKeywords && def.negativeKeywords.length && hasNegativeContext(ctx, def.negativeKeywords)) {
      return 0;
    }

    var score = 0;
    for (var source in SOURCE_WEIGHTS) {
      var text = ctx[source];
      if (!text) continue;

      var bestContribution = 0;
      for (var k = 0; k < def.normKeywords.length; k++) {
        var kw = def.normKeywords[k];
        if (kw.weak && hasCompanyContext(text)) continue;
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

  // Real-world false positive: "I am legally authorized to work in the
  // country I am applying in" matched `country` purely because the word
  // "country" appears in the sentence. A full sentence/question is never
  // actually a short single-value field like a name or place — it's almost
  // always a yes/no application question — so these ids are excluded from
  // normal scoring once a field's label looks sentence-shaped, and the
  // field is instead tried against QUESTION_DEFS (see
  // matchElementAsQuestion below).
  var SENTENCE_UNSAFE_IDS = ['firstName', 'lastName', 'fullName', 'city', 'country'];

  // Name fields require an actual text input. Real-world false positive on
  // Workday: "I have a preferred name" exact-matched fullName's own "name"
  // keyword. It turned out to carry neither type="checkbox" nor any
  // checkbox-ish ARIA role — Workday's component library apparently
  // doesn't expose one here — so detecting it by attribute alone wasn't
  // enough. A field name is never phrased as a sentence, though: real
  // field labels are noun phrases ("Middle Name", "Preferred Name"), while
  // this is a first-person statement. STATEMENT_LEAD_RE below catches that
  // shape regardless of what markup renders it.
  var NAME_FIELD_IDS = ['firstName', 'lastName', 'fullName'];

  var STATEMENT_LEAD_RE = /^(i\s+(have|am|agree|certify|confirm|understand|acknowledge|hereby|require|need|would|wish)|do\s+you|are\s+you|is\s+this|will\s+you|have\s+you|can\s+you|did\s+you|would\s+you)\b/i;

  function isCheckboxLike(el, raw) {
    var type = (el.getAttribute && el.getAttribute('type') || '').toLowerCase();
    var role = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio' || role === 'switch') {
      return true;
    }
    var text = raw ? String(raw.label || raw.aria || '').trim() : '';
    return STATEMENT_LEAD_RE.test(text);
  }

  var QUESTION_MARK_RE = /[?？]\s*$/;
  var QUESTION_LEAD_RE = /^(are|do|does|did|is|was|were|will|would|can|could|have|has|had)\s+(you|i)\b/i;
  var SENTENCE_MIN_WORDS = 7; // "longer than about six words"

  function looksLikeQuestionText(rawText) {
    if (!rawText) return false;
    var trimmed = String(rawText).trim();
    if (!trimmed) return false;
    if (QUESTION_MARK_RE.test(trimmed)) return true;
    if (QUESTION_LEAD_RE.test(trimmed)) return true;
    var wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    return wordCount >= SENTENCE_MIN_WORDS;
  }

  // On a <select>, find the option whose own text is actually a localized
  // yes/no word (e.g. "Sì" / "Ja" / "Evet"), rather than assuming the
  // English word "Yes"/"No" is present — a select on a non-English page
  // legitimately never has that.
  function findLocalizedSelectOption(el, answer) {
    var words = answer === 'yes' ? YES_WORDS : NO_WORDS;
    for (var i = 0; i < el.options.length; i++) {
      var opt = el.options[i];
      var tokens = tokenize(normalize(opt.textContent));
      if (tokens.some(function (t) { return words.indexOf(t) !== -1; })) return opt.textContent;
    }
    return null;
  }

  // Tries a single element (a <select>, or occasionally a text input) as a
  // standard yes/no question, the same way matchQuestionGroup() tries a
  // radio/checkbox group — some ATSes render these as a Yes/No dropdown
  // instead of radio buttons.
  function matchElementAsQuestion(el, ctx, profile) {
    var picked = pickBestQuestionAnswer(ctx, profile);
    if (!picked) return null;

    var value = picked.answer.charAt(0).toUpperCase() + picked.answer.slice(1);
    if (el.tagName === 'SELECT') {
      var localized = findLocalizedSelectOption(el, picked.answer);
      if (localized) value = localized;
    }

    return { el: el, def: picked.def, value: value, score: picked.score };
  }

  // Occurrence counters live on a per-fill-run object the caller creates
  // once (see content.js) and threads through every resolveValue call, so
  // the Nth workCompany field *resolved* on the page gets
  // workExperience[N-1] — see FIELD_META's repeatableGroup fields. Callers
  // MUST resolve values for repeatable defs in DOM order across the whole
  // page (Tier 1 and Tier 2 combined) — resolving them in whatever order
  // matches happen to be found/confirmed in (e.g. Tier 1 first, then
  // Tier 2 filling in gaps afterwards) would hand a later DOM section's
  // fields to an earlier occurrence index than an earlier section that
  // took longer to resolve. See content.js's runFill for the single
  // DOM-ordered resolution pass this requires.
  function nextOccurrenceIndex(runCtx, id) {
    runCtx.counters = runCtx.counters || {};
    var idx = runCtx.counters[id] || 0;
    runCtx.counters[id] = idx + 1;
    return idx;
  }

  function resolveValue(def, profile, runCtx) {
    if (!def) return null;
    if (def.repeatableGroup) return def.getValue(profile, nextOccurrenceIndex(runCtx || {}, def.id));
    return def.getValue(profile);
  }

  // Picks the best matching def for `el`, or null. Deliberately does NOT
  // resolve/apply a value: for a repeatableGroup def (see resolveValue
  // above), the right occurrence index can only be known once every
  // element on the page — Tier 1 and Tier 2 combined — has been matched
  // and walked in DOM order, which is the caller's job (content.js).
  // matchElementAsQuestion is the one exception: QUESTION_DEFS are never
  // repeatable, so it resolves its own (possibly localized-select) value
  // immediately and returns it via `.value`.
  function matchElement(el, profile) {
    if (!isFillable(el) || !isVisible(el)) return null;

    var kind = getElementKindConstraint(el);

    // type="email" / type="tel" are exclusive: fill from the matching
    // profile field or leave unmatched — never fall through to scoring
    // against other fields (which is exactly how "dell'annuncio" ended up
    // guessed as a phone number).
    if (kind === 'email' || kind === 'tel') {
      return { el: el, def: getFieldDefById(kind === 'email' ? 'email' : 'phone'), score: TYPE_MATCH_SCORE };
    }

    // type="url" can only resolve to one of the link-shaped profile
    // fields — phone/email (and everything else) are excluded outright.
    var candidateDefs = FIELD_DEFS;
    if (kind === 'url') {
      candidateDefs = FIELD_DEFS.filter(function (d) { return URL_KIND_IDS.indexOf(d.id) !== -1; });
    }

    var raw = getRawSignals(el);

    if (isCheckboxLike(el, raw)) {
      candidateDefs = candidateDefs.filter(function (d) { return NAME_FIELD_IDS.indexOf(d.id) === -1; });
    }

    var isQuestionLike = !kind && looksLikeQuestionText(raw.label || raw.aria || '');
    if (isQuestionLike) {
      candidateDefs = candidateDefs.filter(function (d) { return SENTENCE_UNSAFE_IDS.indexOf(d.id) === -1; });
    }

    var ctx = buildContext(el, raw);
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

    if (!best || bestScore < MIN_SCORE_THRESHOLD) {
      return isQuestionLike ? matchElementAsQuestion(el, ctx, profile) : null;
    }

    return { el: el, def: best, score: bestScore };
  }

  // Resolves a matchElement() pick to its final value: `.value` is used as-
  // is when already resolved (matchElementAsQuestion's result), otherwise
  // resolveValue() is called against the *shared* runCtx passed in — see
  // nextOccurrenceIndex's docs on why every def on a page must be resolved
  // through one shared runCtx, walked in DOM order.
  function finalizePick(picked, profile, runCtx) {
    if (!picked) return null;
    var value = picked.value !== undefined ? picked.value : resolveValue(picked.def, profile, runCtx);
    if (value === null || value === undefined || value === '') return null;
    return { el: picked.el, def: picked.def, value: value, score: picked.score };
  }

  function matchForm(root, profile) {
    var elements = collectFillableElements(root);
    var runCtx = {};
    var matches = [];
    for (var i = 0; i < elements.length; i++) {
      var m = finalizePick(matchElement(elements[i], profile), profile, runCtx);
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
    QUESTION_DEFS: QUESTION_DEFS,
    LANGUAGE_PROFICIENCY_LEVELS: LANGUAGE_PROFICIENCY_LEVELS,
    SUPPORTED_LANGUAGES: Object.keys(KEYWORD_PACKS),
    normalize: normalize,
    collectAllRoots: collectAllRoots,
    collectFillableElements: collectFillableElements,
    collectRadioGroups: collectRadioGroups,
    getFieldSignals: getFieldSignals,
    getGroupLabelText: getGroupLabelText,
    getFieldDefById: getFieldDefById,
    getQuestionDefById: getQuestionDefById,
    matchElement: matchElement,
    matchForm: matchForm,
    matchQuestionGroup: matchQuestionGroup,
    finalizePick: finalizePick,
    resolveValue: resolveValue,
    hasFillableForm: hasFillableForm,
    applyValue: applyValue,
    applyRadioGroupValue: applyRadioGroupValue
  };
})();
