/**
 * CV import — extracts a PDF's text (pdf.js, bundled locally under
 * vendor/pdfjs/) and turns it into a partial profile object shaped like the
 * one options.js reads/writes (see options.js's render()/collectProfile()).
 *
 * Two extraction paths:
 *  - Tier "api": if an Anthropic API key is supplied, the raw CV text is
 *    sent to Claude with a system prompt asking for JSON in the profile
 *    shape.
 *  - Tier "pattern": no key (or the API call fails) — regex/heading-based
 *    local extraction, covering the same languages Tier 1 field matching
 *    supports (see modules/field-matcher.js's KEYWORD_PACKS): en, it, de, tr.
 *
 * Never touches chrome.storage and never fills the DOM — options.js does
 * that with the returned partial profile, after showing it to the user.
 */

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');

var ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

var LEVELS = ['Basic', 'Intermediate', 'Advanced', 'Fluent', 'Native'];

// ---- PDF text extraction ------------------------------------------------
// pdf.js hands back a flat list of positioned text runs per page, not
// lines — runs are grouped into lines by comparing their baseline (y)
// position so heading/regex-based parsing below has real line boundaries
// to work with.

// A gap this many PDF points wide between two items on the same line is a
// column break (e.g. a company name on the left, its city/country
// right-aligned on the right), not normal word-spacing — pdf.js gives us
// each item's x-coordinate, not the original space characters, so a double
// space is inserted here to carry that signal forward. Without it,
// stripTrailingLocation below has no way to tell a company name from its
// trailing location once everything is joined into one line of text.
var COLUMN_GAP_THRESHOLD = 20;

function groupItemsIntoLines(items) {
  var lines = [];
  var current = null;
  var lastY = null;
  var lastEndX = null;

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var x = item.transform ? item.transform[4] : 0;
    var y = item.transform ? item.transform[5] : 0;
    if (lastY === null || Math.abs(y - lastY) > 2) {
      current = [];
      lines.push(current);
      lastY = y;
      lastEndX = null;
    }
    if (item.str) {
      if (lastEndX !== null && (x - lastEndX) > COLUMN_GAP_THRESHOLD) current.push('  ');
      current.push(item.str);
      lastEndX = x + (item.width || 0);
    }
  }

  return lines
    .map(function (parts) {
      return parts.join(' ')
        .replace(/ {2,}/g, '  ') // collapse any run of 2+ spaces to a canonical double space (still >= 2, so a real column-gap marker survives) rather than to a single space
        .replace(/[^\S ]+/g, ' ') // other whitespace (tabs, etc.) is still just word-spacing
        .trim();
    })
    .filter(Boolean);
}

export async function extractPdfText(arrayBuffer) {
  var pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  var allLines = [];

  for (var i = 1; i <= pdf.numPages; i++) {
    var page = await pdf.getPage(i);
    var content = await page.getTextContent();
    allLines = allLines.concat(groupItemsIntoLines(content.items));
  }

  return allLines.join('\n').trim();
}

// ---- Tier "api": Anthropic extraction -----------------------------------

var PROFILE_JSON_SHAPE = [
  '{',
  '  "personal": { "firstName": "", "lastName": "", "email": "", "phone": "", "phoneCountryCode": "", "addressLine": "", "city": "", "state": "", "postalCode": "", "country": "" },',
  '  "links": { "linkedin": "", "portfolio": "", "github": "" },',
  '  "education": { "school": "", "degree": "", "field": "", "gradYear": "" },',
  '  "workExperience": [ { "company": "", "position": "", "startDate": "", "endDate": "" } ],',
  '  "languages": [ { "language": "", "proficiency": "Basic|Intermediate|Advanced|Fluent|Native" } ],',
  '  "skills": [ "" ],',
  '  "essays": { "aboutMe": "" }',
  '}'
].join('\n');

var SYSTEM_PROMPT = [
  'You extract structured profile data from raw text pulled from a CV/resume',
  'PDF for a browser autofill extension. The text may be in English, Italian,',
  'German or Turkish, and line breaks may be imperfect due to PDF extraction.',
  '',
  'Respond with ONLY a raw JSON object matching exactly this shape. Every',
  'field is optional: omit any key you cannot find in the text, and never',
  'invent a value that is not actually present in it.',
  '',
  PROFILE_JSON_SHAPE,
  '',
  'Normalize workExperience dates to "YYYY-MM" when a month is known, or',
  '"YYYY" when only a year is known; use an empty string for a current/',
  'ongoing end date. "proficiency" must be exactly one of Basic, Intermediate,',
  'Advanced, Fluent, Native (pick the closest). "essays.aboutMe" is the text of',
  'a "Profile", "Summary", "About me" or "Objective" section, if the CV has',
  'one — omit it otherwise. No prose, no markdown code fences, no',
  'explanation — JSON only.'
].join('\n');

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch (e) { /* fall through */ }

  var match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (e2) { /* give up below */ }
  }
  return null;
}

function str(v) {
  return (typeof v === 'string') ? v.trim() : '';
}

// <input type="month"> (options.js's renderWorkList) only accepts "YYYY-MM"
// — a bare "YYYY" is silently coerced to "" by the browser, so a year-only
// date has to be given a month to survive being rendered into the form.
function coerceMonthDate(v) {
  if (/^\d{4}$/.test(v)) return v + '-01';
  return v;
}

function sanitizeApiProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;

  var p = raw.personal || {};
  var links = raw.links || {};
  var edu = raw.education || {};
  var essays = raw.essays || {};

  var workExperience = Array.isArray(raw.workExperience) ? raw.workExperience : [];
  var languages = Array.isArray(raw.languages) ? raw.languages : [];
  var skills = Array.isArray(raw.skills) ? raw.skills : [];

  var phone = str(p.phone);

  return {
    personal: {
      firstName: str(p.firstName),
      lastName: str(p.lastName),
      email: str(p.email),
      phone: phone,
      // Falls back to deriving it from the phone number itself when the
      // model didn't fill this in but the number is in international
      // format (see derivePhoneCountryCode).
      phoneCountryCode: str(p.phoneCountryCode) || derivePhoneCountryCode(phone),
      addressLine: str(p.addressLine),
      city: str(p.city),
      state: str(p.state),
      postalCode: str(p.postalCode),
      country: str(p.country)
    },
    links: {
      linkedin: str(links.linkedin),
      portfolio: str(links.portfolio),
      github: str(links.github)
    },
    education: {
      school: str(edu.school),
      degree: str(edu.degree),
      field: str(edu.field),
      gradYear: str(edu.gradYear)
    },
    workExperience: workExperience
      .map(function (w) {
        return {
          company: str(w && w.company),
          position: str(w && w.position),
          startDate: coerceMonthDate(str(w && w.startDate)),
          endDate: coerceMonthDate(str(w && w.endDate))
        };
      })
      .filter(function (w) { return w.company || w.position; }),
    languages: languages
      .map(function (l) {
        var lang = str(l && l.language);
        var prof = str(l && l.proficiency);
        return { language: lang, proficiency: LEVELS.indexOf(prof) !== -1 ? prof : 'Fluent' };
      })
      .filter(function (l) { return l.language; }),
    skills: skills.map(str).filter(Boolean),
    essays: { aboutMe: str(essays.aboutMe), whyThisRole: '', strengths: '' }
  };
}

var API_TIMEOUT_MS = 45000;

async function extractProfileViaApi(text, apiKey) {
  var body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text.slice(0, 15000) }]
  };

  var controller = new AbortController();
  var timeoutId = setTimeout(function () { controller.abort(); }, API_TIMEOUT_MS);

  var res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    var errText = await res.text().catch(function () { return ''; });
    throw new Error('Anthropic API error ' + res.status + ': ' + (errText || '').slice(0, 200));
  }

  var data = await res.json();
  var textOut = (data.content && data.content[0] && data.content[0].text) || '';
  var sanitized = sanitizeApiProfile(parseJsonLoose(textOut));
  if (!sanitized) throw new Error('Anthropic API returned no usable JSON');
  return sanitized;
}

// ---- Tier "pattern": local regex/heading extraction ----------------------
// Same language set as field-matcher.js's KEYWORD_PACKS (en, it, de, tr).

var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
var PHONE_RE = /(\+?\d[\d .()\-]{7,}\d)/g;
var LINKEDIN_URL_RE = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+\/?/i;
var GITHUB_URL_RE = /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_-]+\/?/i;

function findUrl(text, re) {
  var m = text.match(re);
  return m ? m[0].trim() : '';
}

// A phone written in international format always has its calling code
// (1-3 digits) set off from the rest of the number by a space or other
// separator — "+44 7700 900142", "+351 912 345 678" — so the digit run
// right after "+" is the code; \d{1,3} being greedy naturally stops at
// that separator rather than eating into the local number.
function derivePhoneCountryCode(phone) {
  var m = (phone || '').match(/^\+(\d{1,3})/);
  return m ? '+' + m[1] : '';
}

// "City, Country" or "City, ST" postal codes: UK-style alphanumeric
// ("WC1R 4LL", "SW1A 1AA"), or 4-5 numeric digits (continental European,
// e.g. Italian "20123", or US ZIP/ZIP+4 "94105"/"94105-1234").
var POSTAL_CODE_RE = /^(?:[A-Z]{1,2}\d[A-Z0-9]?\s?\d[A-Z]{2}|\d{4,5}(?:-\d{4})?)$/i;

// Not exhaustive — English names plus native spellings for the 8 supported
// languages' most likely home countries. Good enough to recognize the
// country segment of an address line; anything else just falls through to
// city/state, which is a harmless miss (see parseAddressLine).
var COUNTRY_NAMES = [
  'united kingdom', 'uk', 'u.k.', 'great britain', 'england', 'scotland', 'wales', 'northern ireland',
  'united states', 'usa', 'u.s.a.', 'united states of america',
  'italy', 'italia',
  'germany', 'deutschland',
  'turkey', 'türkiye', 'turkiye',
  'spain', 'españa', 'espana',
  'france',
  'portugal',
  'netherlands', 'the netherlands', 'nederland', 'holland',
  'ireland', 'canada', 'australia',
  'switzerland', 'schweiz', 'suisse', 'svizzera',
  'austria', 'österreich', 'osterreich',
  'belgium', 'belgië', 'belgie', 'belgique',
  'poland', 'polska', 'sweden', 'sverige', 'norway', 'norge',
  'denmark', 'danmark', 'finland', 'suomi', 'greece',
  'brazil', 'brasil', 'mexico', 'méxico',
  'india', 'china', 'japan',
  'united arab emirates', 'uae'
];

function isCountryName(text) {
  return COUNTRY_NAMES.indexOf(normalizeLine(text)) !== -1;
}

// An apartment/unit/suite token sitting in its own comma-separated part
// right after the street — "T318", "Apt 4B", "Suite 200", "Unit 5" — is
// still part of the street address, not the city.
var UNIT_TOKEN_RE = /^(?:[A-Za-z]{1,3}\d{1,5}[A-Za-z]?|(?:apt|apartment|suite|ste|unit|fl|floor|no|nr)\.?\s*\d+[A-Za-z]?)$/i;

// Splits one comma-separated address line into its parts. Street is always
// the first part (plus any unit/apartment token(s) immediately after it —
// see UNIT_TOKEN_RE); postal code and country are found by pattern/name
// wherever they sit among the rest, in either order and regardless of
// position, and removed from consideration once found.
//
// Whatever's left after that is city, then optionally state/province — but
// state is only trusted when a country was also present. Without a
// country, a part after the city has nothing to disambiguate it from a
// district/borough name (e.g. Berlin's "Mitte") rather than an actual
// state, so it's left alone rather than guessed at.
function parseAddressLine(line) {
  var parts = line.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (parts.length < 2) return null;

  var postalCode = '';
  for (var i = 0; i < parts.length; i++) {
    if (POSTAL_CODE_RE.test(parts[i])) {
      postalCode = parts[i];
      parts.splice(i, 1);
      break;
    }
  }

  var country = '';
  for (var j = 0; j < parts.length; j++) {
    if (isCountryName(parts[j])) {
      country = parts[j];
      parts.splice(j, 1);
      break;
    }
  }

  var street = parts.shift() || '';
  while (parts.length && UNIT_TOKEN_RE.test(parts[0])) {
    street += ', ' + parts.shift();
  }

  var city = parts.shift() || '';
  var state = country ? (parts.shift() || '') : '';

  return { addressLine: street, city: city, state: state, postalCode: postalCode, country: country };
}

// Looks for a comma-separated address among the first few lines (the
// contact block) — restricted to the top of the CV rather than the whole
// text so a bullet like "Worked with clients in Paris, France and Berlin,
// Germany" elsewhere can't be mistaken for the candidate's own address.
function extractAddress(lines) {
  var candidateLines = lines.slice(0, 10);
  for (var i = 0; i < candidateLines.length; i++) {
    var parts = candidateLines[i].split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length < 3) continue;
    var hasPostal = parts.some(function (p) { return POSTAL_CODE_RE.test(p); });
    var hasCountry = parts.some(isCountryName);
    if (hasPostal || hasCountry) return parseAddressLine(candidateLines[i]);
  }
  return null;
}

var CV_TITLE_LINES = ['curriculum vitae', 'resume', 'cv', 'lebenslauf', 'özgeçmiş', 'ozgecmis'];

// Label words for lines/headings about languages, certifications and
// interests, covering all 8 supported languages (en, it, de, tr, es, fr,
// pt, nl). Used two ways below: as SECTION_HEADINGS entries (a bare
// "Certifications" line on its own, with no colon) and, for the inline
// case, by extractInlineLabeledContent ("Certifications: AWS SA, Scrum
// Master" sitting inside another section). Without both forms recognized,
// a certifications/interests line — heading or inline — falls through into
// whatever section came before it (often skills or languages), corrupting
// it; neither certifications nor interests has a matching profile field, so
// both are simply dropped once recognized rather than stored anywhere.
var INLINE_LABELS = {
  languages: ['languages', 'lingue', 'sprachen', 'diller', 'idiomas', 'langues', 'idiomas', 'línguas', 'linguas', 'talen'],
  certifications: [
    'certifications', 'certificates',
    'certificazioni', 'zertifikate', 'zertifizierungen',
    'sertifikalar', 'certificaciones', 'certificats', 'certificados', 'certificações', 'certificacoes', 'certificaten'
  ],
  interests: [
    'interests', 'hobbies',
    'interessi', 'interessen', 'hobby',
    'ilgi alanlari', 'ilgi alanları', 'intereses', 'aficiones', 'loisirs', 'interesses'
  ]
};

var SECTION_HEADINGS = {
  aboutMe: [
    'about me', 'profile', 'summary', 'objective', 'professional summary', 'summary of qualifications',
    'chi sono', 'profilo', 'sommario', 'obiettivo', 'profilo professionale',
    'über mich', 'uber mich', 'profil', 'zusammenfassung', 'ziel', 'berufliches profil',
    'hakkımda', 'hakkimda', 'özet', 'ozet', 'hedef',
    'sobre mí', 'sobre mi', 'perfil', 'resumen', 'objetivo',
    'à propos de moi', 'a propos de moi', 'synthèse', 'synthese', 'objectif',
    'sobre mim', 'resumo',
    'over mij', 'profiel', 'samenvatting', 'doel'
  ],
  education: [
    'education', 'academic background',
    'istruzione', 'formazione', 'formazione accademica',
    'ausbildung', 'bildung', 'akademischer werdegang',
    'eğitim', 'egitim',
    'educacion', 'educación', 'formacion academica', 'formación académica',
    'formation', 'formation academique', 'formation académique', 'parcours academique',
    'formação', 'formacao', 'formação académica', 'formacao academica',
    'opleiding', 'onderwijs'
  ],
  experience: [
    'work experience', 'experience', 'professional experience', 'employment history',
    'esperienza lavorativa', 'esperienza professionale', 'esperienza',
    'berufserfahrung', 'arbeitserfahrung',
    'iş deneyimi', 'is deneyimi', 'deneyim',
    'experiencia laboral', 'experiencia profesional', 'experiencia',
    'expérience professionnelle', 'experience professionnelle', 'expérience', 'parcours professionnel',
    'experiência profissional', 'experiencia profissional', 'experiência',
    'werkervaring', 'ervaring'
  ],
  skills: [
    'skills', 'technical skills', 'key skills',
    'competenze', 'abilità', 'abilita',
    'kenntnisse', 'fähigkeiten', 'fahigkeiten',
    'yetenekler', 'beceriler',
    'habilidades', 'competencias', 'aptitudes',
    'compétences', 'competences', 'compétences techniques', 'competences techniques',
    'competências', 'habilidades tecnicas', 'habilidades técnicas',
    'vaardigheden'
  ],
  languages: INLINE_LABELS.languages,
  // Recognized as headings purely so their content is diverted away from
  // whichever section precedes them (see extractProfileByPattern, which
  // never reads sections.certifications/sections.interests, and so
  // splitIntoSections correctly stops accumulating lines for the section
  // above once one of these appears — e.g. a "PROJECTS" heading after
  // "EXPERIENCE" must not let the project entries leak into workExperience).
  certifications: INLINE_LABELS.certifications,
  interests: INLINE_LABELS.interests,
  projects: [
    'projects', 'personal projects', 'academic projects',
    'progetti', 'progetti personali',
    'projekte', 'persönliche projekte', 'personliche projekte',
    'projeler', 'kişisel projeler', 'kisisel projeler',
    'proyectos', 'proyectos personales',
    'projets', 'projets personnels',
    'projetos', 'projectos', 'projetos pessoais',
    'projecten'
  ],
  references: [
    'references',
    'referenze',
    'referenzen',
    'referanslar',
    'referencias',
    'références',
    'referências',
    'referenties'
  ],
  volunteering: [
    'volunteering', 'volunteer experience', 'volunteer work',
    'volontariato', 'esperienza di volontariato',
    'ehrenamtliche tätigkeit', 'ehrenamtliche tatigkeit', 'ehrenamt',
    'gönüllülük', 'gonulluluk', 'gönüllü deneyimi', 'gonullu deneyimi',
    'voluntariado', 'experiencia de voluntariado',
    'bénévolat', 'benevolat', 'expérience bénévole', 'experience benevole',
    'experiência de voluntariado', 'experiencia de voluntariado',
    'vrijwilligerswerk'
  ],
  awards: [
    'awards', 'honors', 'honours', 'awards and honors',
    'premi', 'riconoscimenti',
    'auszeichnungen',
    'ödüller', 'odüller', 'oduller',
    'premios', 'reconocimientos',
    'récompenses', 'recompenses', 'distinctions',
    'prêmios', 'distinções', 'distincoes',
    'prijzen', 'onderscheidingen'
  ],
  publications: [
    'publications',
    'pubblicazioni',
    'veröffentlichungen', 'veroffentlichungen', 'publikationen',
    'yayınlar', 'yayinlar',
    'publicaciones',
    'publicações', 'publicacoes',
    'publicaties'
  ]
};

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

var ALL_HEADINGS = Object.keys(SECTION_HEADINGS).reduce(function (acc, key) {
  return acc.concat(SECTION_HEADINGS[key]);
}, []);

var SCHOOL_WORDS = [
  'university', 'college', 'institute', 'school',
  'università', 'universita', 'universität', 'universitat', 'hochschule', 'scuola',
  'üniversite', 'universite', 'okul'
];

var DEGREE_WORDS = [
  'bachelor', 'master', 'phd', 'b.sc', 'm.sc', 'degree', 'diploma',
  'laurea', 'diplom', 'abschluss',
  'lisans', 'yüksek lisans', 'yuksek lisans', 'doktora'
];

// Cuts a line at the first round/dot bullet glyph — e.g. "Bachelor of
// Science in Economics • Relevant Coursework: ..." -> "Bachelor of Science
// in Economics". Deliberately excludes a plain "-"/"*", since those
// routinely appear inside a real degree title rather than introducing a
// trailing list.
function cutAtBullet(text) {
  var idx = text.search(/[•●▪◦‣∙·]/);
  return idx === -1 ? text : text.slice(0, idx).trim();
}

var LEVEL_WORDS = {
  Native: [
    'native', 'mother tongue', 'madrelingua', 'muttersprache', 'anadil', 'ana dil',
    'lengua materna', 'materna', 'langue maternelle', 'maternelle', 'língua materna', 'lingua materna',
    'moedertaal'
  ],
  Fluent: [
    'fluent', 'fluente', 'corrente', 'fließend', 'fliessend', 'akıcı', 'akici',
    'fluido', 'fluida', 'courant', 'courante', 'vloeiend'
  ],
  Advanced: [
    'advanced', 'professional working proficiency', 'proficient', 'avanzato', 'fortgeschritten', 'ileri',
    'avanzado', 'avancé', 'avance', 'avançado', 'avancado', 'gevorderd'
  ],
  Intermediate: [
    'intermediate', 'conversational', 'intermedio', 'mittelstufe', 'orta',
    'intermédiaire', 'intermediaire', 'intermediário', 'intermediario', 'gemiddeld'
  ],
  Basic: [
    'basic', 'base', 'elementare', 'grundkenntnisse', 'başlangıç', 'baslangic',
    'básico', 'basico', 'de base', 'débutant', 'debutant', 'basis'
  ]
};

// Words/phrases from LEVEL_WORDS above, sorted longest-first so a phrase
// like "mother tongue" matches whole before a shorter overlapping word
// could. Reused to strip a leading proficiency word off a language NAME
// (see stripProficiencyPrefix) — separately from using the same words to
// detect the proficiency itself (detectProficiencyFromText below).
var ALL_LEVEL_WORDS = Object.keys(LEVEL_WORDS)
  .reduce(function (acc, key) { return acc.concat(LEVEL_WORDS[key]); }, [])
  .sort(function (a, b) { return b.length - a.length; });

// "Fluent in German", "Proficient in French", "Native English" — the
// language name itself only starts after the proficiency word and an
// optional short connector ("in", "en", ...). The CEFR/test-score based
// proficiency (detectProficiencyFromText) already reads the level
// correctly regardless of this — this only cleans up the NAME.
var LANGUAGE_PROFICIENCY_PREFIX_RE = new RegExp(
  '^(?:' + ALL_LEVEL_WORDS.map(escapeRegExp).join('|') + ')\\b(?:\\s+(?:in|en|em|di|a|à)\\b)?[\\s:.-]*',
  'i'
);

function stripProficiencyPrefix(name) {
  return name.replace(LANGUAGE_PROFICIENCY_PREFIX_RE, '').trim();
}

// ---- Proficiency detection from CEFR codes and language test scores ------
// Shared by per-line/per-item language parsing (a dedicated "Languages"
// section, or an inline "Languages: ..." label — see INLINE_LABELS below)
// and by the free-text "test score anywhere in the CV" scan.

var CEFR_LEVEL_MAP = { A1: 'Basic', A2: 'Basic', B1: 'Intermediate', B2: 'Intermediate', C1: 'Advanced', C2: 'Fluent' };
var CEFR_RE = /\b([ABC][12])\b/i;

var CAMBRIDGE_LEVEL_MAP = { FCE: 'Intermediate', CAE: 'Advanced', CPE: 'Fluent' };
var CAMBRIDGE_RE = /\b(FCE|CAE|CPE)\b/i;

var IELTS_RE = /\bielts\b[^0-9]{0,20}?(\d(?:\.\d)?)/i;
var TOEFL_RE = /\btoefl\b(?:\s*ibt)?[^0-9]{0,20}?(\d{2,3})\b/i;

// The tests below are each tied to one specific language, which lets the
// free-text scan (extractTestDerivedLanguages) still attribute a score to a
// language even when the CV never spells the language name out (e.g. a
// "Certifications" line that just says "DELF B2").
var TEST_LANGUAGE_MAP = {
  ielts: 'English', toefl: 'English', fce: 'English', cae: 'English', cpe: 'English',
  goethe: 'German', testdaf: 'German', dsd: 'German',
  dele: 'Spanish',
  delf: 'French'
};
var TEST_NAME_ORDER = ['ielts', 'toefl', 'fce', 'cae', 'cpe', 'goethe', 'testdaf', 'dsd', 'dele', 'delf'];
var TEST_SIGNAL_RE = new RegExp('\\b(' + TEST_NAME_ORDER.join('|') + ')\\b', 'i');

function mapIeltsScore(score) {
  if (isNaN(score)) return null;
  if (score >= 8.0) return 'Fluent';
  if (score >= 6.5) return 'Advanced';
  if (score >= 5.0) return 'Intermediate';
  return null;
}

function mapToeflScore(score) {
  if (isNaN(score)) return null;
  if (score >= 110) return 'Fluent';
  if (score >= 86) return 'Advanced';
  if (score >= 60) return 'Intermediate';
  return null;
}

// Tries, in order: an explicit level word/phrase (LEVEL_WORDS, including
// "mother tongue" / "professional working proficiency" / "conversational"),
// a Cambridge exam code, an IELTS or TOEFL iBT score, then a bare CEFR code
// (which also covers "Goethe-Zertifikat B2", "DELF B1", etc., since those
// just have a CEFR code sitting next to the test name). Returns null if
// nothing recognized.
function detectProficiencyFromText(text) {
  var norm = text.toLowerCase();

  for (var level in LEVEL_WORDS) {
    if (LEVEL_WORDS[level].some(function (w) { return norm.indexOf(w) !== -1; })) return level;
  }

  var cambridge = text.match(CAMBRIDGE_RE);
  if (cambridge) return CAMBRIDGE_LEVEL_MAP[cambridge[1].toUpperCase()];

  var ielts = text.match(IELTS_RE);
  if (ielts) {
    var ieltsLevel = mapIeltsScore(parseFloat(ielts[1]));
    if (ieltsLevel) return ieltsLevel;
  }

  var toefl = text.match(TOEFL_RE);
  if (toefl) {
    var toeflLevel = mapToeflScore(parseInt(toefl[1], 10));
    if (toeflLevel) return toeflLevel;
  }

  var cefr = text.match(CEFR_RE);
  if (cefr) return CEFR_LEVEL_MAP[cefr[1].toUpperCase()];

  return null;
}

// Only used by the free-text scan below — per-item language parsing already
// knows its language from the item's own leading text.
var LANGUAGE_NAME_PATTERNS = [
  [/\b(english|inglese|englisch|ingilizce|ingles|inglés|anglais|engels)\b/i, 'English'],
  [/\b(german|tedesco|deutsch|almanca|aleman|alemán|allemand|duits)\b/i, 'German'],
  [/\b(italian|italiano|italienisch|italyanca|italien|italiaans)\b/i, 'Italian'],
  [/\b(turkish|turco|türkisch|turkce|türkçe|turc|turks)\b/i, 'Turkish'],
  [/\b(spanish|spagnolo|spanisch|ispanyolca|espanol|español|espagnol|spaans)\b/i, 'Spanish'],
  [/\b(french|francese|französisch|fransizca|fransızca|frances|francés|français|francais|frans)\b/i, 'French'],
  [/\b(dutch|olandese|niederländisch|hollandaca|holandes|holandés|néerlandais|neerlandais|nederlands)\b/i, 'Dutch']
];

function findLanguageNameInText(text) {
  for (var i = 0; i < LANGUAGE_NAME_PATTERNS.length; i++) {
    if (LANGUAGE_NAME_PATTERNS[i][0].test(text)) return LANGUAGE_NAME_PATTERNS[i][1];
  }
  return null;
}

function impliedLanguageFromTestName(text) {
  var lower = text.toLowerCase();
  for (var i = 0; i < TEST_NAME_ORDER.length; i++) {
    if (new RegExp('\\b' + TEST_NAME_ORDER[i] + '\\b').test(lower)) return TEST_LANGUAGE_MAP[TEST_NAME_ORDER[i]];
  }
  return null;
}

// Scans every line of the CV (not just a recognized "Languages" section) for
// a language-test mention, and pairs it with whatever language it names —
// explicitly on the same line if there is one, otherwise the language that
// test is inherently tied to (see TEST_LANGUAGE_MAP). Each line is split
// into comma/semicolon segments first, since a "Certifications: DELF B1,
// Cambridge CAE" line names two different tests (and so two different
// languages) that a whole-line scan would otherwise collapse into one.
function extractTestDerivedLanguages(lines) {
  var results = [];
  var seen = {};

  lines.forEach(function (line) {
    line.split(/[,;]/).forEach(function (segment) {
      if (!TEST_SIGNAL_RE.test(segment)) return;

      var proficiency = detectProficiencyFromText(segment);
      if (!proficiency) return;

      var language = findLanguageNameInText(segment) || impliedLanguageFromTestName(segment);
      if (!language || seen[language]) return;

      seen[language] = true;
      results.push({ language: language, proficiency: proficiency });
    });
  });

  return results;
}

// Combines any number of language lists, in increasing priority: a later
// list's proficiency wins for a language both lists name, and its entries
// are appended for languages the earlier lists didn't have. Test-derived
// scores are concrete evidence, so extractProfileByPattern passes those
// last, letting them override a vaguer adjective from elsewhere in the CV.
function mergeLanguageLists() {
  var byKey = {};
  var order = [];

  for (var i = 0; i < arguments.length; i++) {
    (arguments[i] || []).forEach(function (entry) {
      var key = entry.language.toLowerCase();
      if (!byKey[key]) {
        order.push(key);
        byKey[key] = { language: entry.language, proficiency: entry.proficiency };
      } else {
        byKey[key].proficiency = entry.proficiency;
      }
    });
  }

  return order.map(function (k) { return byKey[k]; }).slice(0, 10);
}

// console.log wrapper for the pattern-based work-experience parser below —
// lets a real CV be checked line-by-line against what the parser saw and
// why it made each call, since CV layouts vary too much to get right by
// inspection alone.
function logCv() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ['[cv-import]'].concat(args));
}

// ---- Month names (en, it, de, tr, es, fr, pt, nl) -------------------------
// Full names + common abbreviations, used to recognize "February 2026"-style
// dates alongside the purely numeric forms. Every entry maps to the same
// month across languages, so overlapping abbreviations (e.g. "mar" for both
// Italian and Spanish March) are harmless.
var MONTH_NAMES = {
  '01': ['january', 'jan', 'gennaio', 'gen', 'januar', 'ocak', 'oca', 'enero', 'ene', 'janvier', 'janv', 'janeiro', 'januari'],
  '02': ['february', 'feb', 'febbraio', 'februar', 'şubat', 'subat', 'şub', 'sub', 'febrero', 'février', 'fevrier', 'févr', 'fevr', 'fevereiro', 'fev', 'februari'],
  '03': ['march', 'mar', 'marzo', 'märz', 'marz', 'mär', 'mart', 'mars', 'março', 'marco', 'maart'],
  '04': ['april', 'apr', 'aprile', 'nisan', 'nis', 'abril', 'avril', 'avr'],
  '05': ['may', 'maggio', 'mag', 'mai', 'mayıs', 'mayis', 'mayo', 'maio', 'mei'],
  '06': ['june', 'jun', 'giugno', 'giu', 'juni', 'haziran', 'haz', 'junio', 'juin', 'junho'],
  '07': ['july', 'jul', 'luglio', 'lug', 'juli', 'temmuz', 'tem', 'julio', 'juillet', 'juil', 'julho'],
  '08': ['august', 'aug', 'agosto', 'ago', 'ağustos', 'agustos', 'ağu', 'agu', 'août', 'aout', 'augustus'],
  '09': ['september', 'sep', 'sept', 'settembre', 'set', 'eylül', 'eylul', 'eyl', 'septiembre', 'septembre', 'setembro'],
  '10': ['october', 'oct', 'ottobre', 'ott', 'oktober', 'okt', 'ekim', 'eki', 'octubre', 'octobre', 'outubro', 'out'],
  '11': ['november', 'nov', 'novembre', 'kasım', 'kasim', 'kas', 'noviembre', 'novembro'],
  '12': ['december', 'dec', 'dicembre', 'dic', 'dezember', 'dez', 'aralık', 'aralik', 'ara', 'diciembre', 'décembre', 'decembre', 'déc']
};

var MONTH_NAME_TO_NUM = {};
var MONTH_WORDS_ALL = [];
Object.keys(MONTH_NAMES).forEach(function (num) {
  MONTH_NAMES[num].forEach(function (w) {
    MONTH_NAME_TO_NUM[w] = num;
    MONTH_WORDS_ALL.push(w);
  });
});
// Longest-first is only a readability nicety here — the \b-anchored,
// case-insensitive alternation below already can't have a short word
// (e.g. "mar") shadow a longer one (e.g. "march") since \b requires a word
// boundary right after the match.
MONTH_WORDS_ALL.sort(function (a, b) { return b.length - a.length; });

var MONTH_NAME_SRC = '(?:' + MONTH_WORDS_ALL.map(escapeRegExp).join('|') + ')';
var MONTH_NAME_SRC_CAP = '(' + MONTH_WORDS_ALL.map(escapeRegExp).join('|') + ')';

function monthNameToNumber(word) {
  return MONTH_NAME_TO_NUM[turkishSafeLower(word || '')] || null;
}

// ---- "Ongoing" words (en, it, de, tr, es, fr, pt, nl) ----------------------
var ONGOING_WORDS = [
  'present', 'current', 'ongoing', 'to date', 'till date',
  'oggi', 'attuale', 'attualmente', 'in corso',
  'heute', 'aktuell', 'laufend',
  'devam', 'günümüz', 'gunumuz', 'halen',
  'actualidad', 'actual', 'presente', 'hoy',
  'aujourd\'hui', 'actuelle', 'en cours',
  'atual', 'atualmente', 'hoje',
  'heden', 'huidig', 'huidige', 'nu'
];
var ONGOING_SRC = '(?:' + ONGOING_WORDS.map(escapeRegExp).join('|') + ')';
var ONGOING_RE = new RegExp('\\b' + ONGOING_SRC + '\\b', 'i');

function isOngoingToken(text) {
  return ONGOING_RE.test(text || '');
}

// ---- Date tokens and ranges -------------------------------------------
// A single date mention, in decreasing specificity: "Month YYYY" / "YYYY
// Month" (either order), numeric "YYYY-MM" / "MM-YYYY" (dash, slash or dot),
// then a bare year. Two of these either side of a separator (dash/en
// dash/em dash, or "to"/"a"/"à"/"au"/"bis"/"ile"/"hasta"/"até"/"tot"/"t/m")
// is a work-experience date range, wherever it sits in the line — on its
// own, after a title/company, or parenthesized.
var DATE_TOKEN_SRC = '(?:' +
  MONTH_NAME_SRC + '\\.?\\s+(?:19|20)\\d{2}' + '|' +
  '(?:19|20)\\d{2}\\s+' + MONTH_NAME_SRC + '\\.?' + '|' +
  '(?:19|20)\\d{2}[-/.]\\d{1,2}' + '|' +
  '\\d{1,2}[-/.](?:19|20)\\d{2}' + '|' +
  '(?:19|20)\\d{2}' +
  ')';

// Plain \b treats only [A-Za-z0-9_] as "word" characters, so it silently
// fails to anchor next to a letter like "à" or "é" (e.g. /\bà\b/.test("2019
// à 2021") is false) — which would otherwise make the French/Portuguese
// separator words below never match. wordBoundary() uses a Unicode-aware
// lookaround instead (requires DATE_RANGE_RE's "u" flag).
function wordBoundary(src) {
  return '(?<![\\p{L}\\p{N}])' + src + '(?![\\p{L}\\p{N}])';
}

var DATE_SEP_SRC = '(?:-|–|—|' + [
  'to', 'a', 'à', 'au', 'bis', 'ile', 'hasta', 'at[eé]', 'tot', 't\\/m'
].map(wordBoundary).join('|') + ')';

var DATE_RANGE_RE = new RegExp(
  '(' + DATE_TOKEN_SRC + ')\\s*' + DATE_SEP_SRC + '\\s*(' + DATE_TOKEN_SRC + '|' + ONGOING_SRC + ')',
  'iu'
);

// Matches a trailing date or date range at the end of a string — e.g. the
// "  July 2025" or "  2018 - 2022" that a degree/field-of-study line often
// has tacked onto it via the same column-gap layout as work experience
// (see groupItemsIntoLines). The range half is optional, so this strips
// either a lone trailing date or a full trailing range.
var TRAILING_DATE_RE = new RegExp(
  '\\s*(?:' + DATE_TOKEN_SRC + '\\s*' + DATE_SEP_SRC + '\\s*)?(?:' + DATE_TOKEN_SRC + '|' + ONGOING_SRC + ')\\s*$',
  'iu'
);

function stripTrailingDate(text) {
  return (text || '').replace(TRAILING_DATE_RE, '').trim();
}

var MONTH_YEAR_RE = new RegExp('^' + MONTH_NAME_SRC_CAP + '\\.?\\s+((?:19|20)\\d{2})$', 'i');
var YEAR_MONTH_RE = new RegExp('^((?:19|20)\\d{2})\\s+' + MONTH_NAME_SRC_CAP + '\\.?$', 'i');

// Normalizes one date token (one side of a DATE_RANGE_RE match) to
// "YYYY-MM", or a bare "YYYY" (later coerced to "YYYY-01" — see
// coerceMonthDate) when only a year is known. Returns null if the token
// isn't a recognized date shape (shouldn't happen for text DATE_RANGE_RE
// already matched, but kept defensive since it's also reachable directly).
function parseDateToken(raw) {
  var t = (raw || '').trim();
  if (!t) return null;

  var mn = t.match(MONTH_YEAR_RE);
  if (mn) {
    var num = monthNameToNumber(mn[1]);
    if (num) return mn[2] + '-' + num;
  }

  var nm = t.match(YEAR_MONTH_RE);
  if (nm) {
    var num2 = monthNameToNumber(nm[2]);
    if (num2) return nm[1] + '-' + num2;
  }

  var ym = t.match(/^((?:19|20)\d{2})[-/.](\d{1,2})$/);
  if (ym) return ym[1] + '-' + (ym[2].length === 1 ? '0' + ym[2] : ym[2]);

  var my = t.match(/^(\d{1,2})[-/.]((?:19|20)\d{2})$/);
  if (my) return my[2] + '-' + (my[1].length === 1 ? '0' + my[1] : my[1]);

  var y = t.match(/^(?:19|20)\d{2}$/);
  if (y) return coerceMonthDate(t);

  return null;
}

// PHONE_RE's char class (digits, spaces, dots, parens, dashes) also matches
// date ranges like "2015 - 2020" or "01.2015 - 12.2020" — a real phone
// number has more digits than a year range, and a date-range-shaped
// candidate is never one, so both checks guard against picking up a date
// that happens to appear before the actual phone number in the CV text.
function looksLikePhone(candidate) {
  var digitCount = (candidate.match(/\d/g) || []).length;
  if (digitCount < 9) return false;
  if (DATE_RANGE_RE.test(candidate)) return false;
  return true;
}

function findPhone(text) {
  var matches = text.match(PHONE_RE);
  if (!matches) return '';
  for (var i = 0; i < matches.length; i++) {
    if (looksLikePhone(matches[i])) return matches[i].trim();
  }
  return '';
}

// Plain toLowerCase() maps Turkish 'İ' (dotted capital I) to 'i' + a
// combining dot above (per Unicode SpecialCasing), not plain 'i' — breaking
// substring/heading comparisons against the plain-ASCII words below. Strip
// it to a plain 'i' first so heading/label matching works for Turkish CVs.
function turkishSafeLower(s) {
  return String(s).replace(/İ/g, 'i').toLowerCase();
}

function normalizeLine(line) {
  return turkishSafeLower(line).replace(/[.:]+$/, '').trim();
}

function isHeadingLine(line, headingWords) {
  var norm = normalizeLine(line);
  if (norm.length > 40) return false;
  for (var i = 0; i < headingWords.length; i++) {
    var w = headingWords[i];
    if (norm === w) return true;
    // Prefix match ("Experience:" heading followed by more text on the
    // same line) — but only at a real word boundary, so a prose sentence
    // like "Experienced software engineer..." can't match "experience".
    if (norm.indexOf(w) === 0 && !/[a-z]/.test(norm.charAt(w.length))) return true;
  }
  return false;
}

// General "is this line a section heading at all" check, used by
// extractWorkExperience to stop at the end of the experience section even
// for a heading not in any SECTION_HEADINGS list (or a language/spelling
// not covered there) — matches against every known heading word across all
// categories, or falls back to "the line is short and entirely uppercase",
// which is how a heading usually reads regardless of language. Only called
// on a line that has already passed looksLikeHeaderLine (starts with a
// capital, no trailing period), so a bullet's wrapped continuation — which
// almost always fails that check first — never reaches this at all.
function isAnySectionHeading(line) {
  var norm = normalizeLine(line);
  if (!norm || norm.length > 40) return false;

  for (var key in SECTION_HEADINGS) {
    if (isHeadingLine(line, SECTION_HEADINGS[key])) return true;
  }

  var letters = line.replace(/[^\p{L}]/gu, '');
  return letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

// Splits the CV into named sections by scanning for heading lines; text
// before the first recognized heading is dropped (it's the contact-info
// block already covered by name/email/phone extraction above).
function splitIntoSections(lines) {
  var sections = {};
  var current = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var matchedKey = null;

    for (var key in SECTION_HEADINGS) {
      if (isHeadingLine(line, SECTION_HEADINGS[key])) {
        matchedKey = key;
        break;
      }
    }

    if (matchedKey) {
      current = matchedKey;
      if (!sections[current]) sections[current] = [];
      continue;
    }

    if (current) sections[current].push(line);
  }

  return sections;
}

function findYear(lines) {
  var years = [];
  lines.forEach(function (line) {
    var matches = line.match(/\b(19|20)\d{2}\b/g);
    if (matches) years = years.concat(matches);
  });
  if (!years.length) return '';
  return years.sort().pop();
}

function extractEducation(lines) {
  if (!lines || !lines.length) return null;

  var school = '';
  var degree = '';
  var field = '';

  for (var i = 0; i < lines.length; i++) {
    var norm = normalizeLine(lines[i]);
    if (!school && SCHOOL_WORDS.some(function (w) { return norm.indexOf(w) !== -1; })) {
      // Same column-gap artifact as work experience — a school line often
      // has its city/country packed onto the end (see stripTrailingLocation
      // and groupItemsIntoLines' column-gap handling above).
      school = stripTrailingLocation(lines[i].trim());
    }
    if (!degree && DEGREE_WORDS.some(function (w) { return norm.indexOf(w) !== -1; })) {
      // A "Relevant Coursework: ..." list is often tacked onto the same
      // line as the degree, after a bullet glyph — cut there first so it
      // never ends up in degree/field. A plain "-" isn't cut on here since
      // it's routinely part of the degree title itself (e.g. "Bachelor of
      // Science - Computer Science"), unlike a round bullet character.
      var degreeLine = cutAtBullet(lines[i].trim());
      // Trailing graduation date on the degree/field line — it's still
      // read separately below via findYear (which tolerates its absence),
      // so dropping it here just keeps it out of the degree/field text.
      degree = stripTrailingDate(degreeLine);
      var fieldMatch = degree.match(/\bin\s+([A-ZÀ-Ý][\w\s&,-]{2,40})/);
      if (fieldMatch) field = stripTrailingDate(fieldMatch[1].trim());
    }
  }

  // Absent (empty) rather than required — a degree/school found with no
  // graduation year anywhere in the section still produces a real entry.
  var gradYear = findYear(lines);

  if (!school && !degree && !field && !gradYear) return null;
  return { school: school, degree: degree, field: field, gradYear: gradYear };
}

// A "Profile"/"Summary"/"About me"/"Objective" section is free-flowing
// prose wrapped across several lines by the PDF, not a list — join them
// back into one paragraph instead of keeping the line breaks. Stops at the
// first line that looks like the start of another section, same defense
// extractWorkExperience uses — splitIntoSections already bounds this via
// SECTION_HEADINGS, but a heading it doesn't recognize would otherwise let
// the whole rest of the CV (e.g. work experience bullets) bleed in here.
function extractAboutMe(lines) {
  if (!lines || !lines.length) return '';
  var kept = [];
  for (var i = 0; i < lines.length; i++) {
    if (isAnySectionHeading(lines[i])) break;
    kept.push(lines[i]);
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim().replace(/^[-–—•*●▪◦‣∙·]\s*/, '');
}

// A description/bullet line under a job — starts with a bullet glyph (or a
// bare "-", the most common PDF-extraction fallback for "•"). These never
// start a new entry and are never scanned for dates, so a sentence like
// "- Grew revenue 20% from 2019 to 2021" can't be mistaken for a new job's
// header/date line.
function isBulletLine(line) {
  return /^[-–—•*●▪◦‣∙·]\s/.test(line);
}

// Heuristic signal for "this header line is a job title, not a company
// name" — used only to decide which of two ambiguous header lines is the
// position vs. the company (see classifyHeaderPair/splitCombinedHeaderLine).
// Not exhaustive by design: a false negative just falls through to the
// default ordering below, which still gets the common cases right.
var JOB_TITLE_WORDS = [
  'intern', 'manager', 'engineer', 'developer', 'designer', 'analyst', 'specialist',
  'coordinator', 'assistant', 'director', 'officer', 'consultant', 'executive',
  'lead', 'representative', 'associate', 'supervisor',
  'stagista', 'tirocinante', 'ingegnere', 'sviluppatore', 'analista', 'specialista',
  'coordinatore', 'assistente', 'direttore', 'responsabile', 'consulente',
  'praktikant', 'praktikantin', 'ingenieur', 'entwickler', 'spezialist', 'koordinator',
  'direktor', 'leiter', 'berater',
  'stajyer', 'uzman', 'mühendis', 'muhendis', 'geliştirici', 'gelistirici',
  'koordinatör', 'asistan', 'müdür', 'mudur', 'danışman', 'danisman', 'temsilci',
  'becario', 'gerente', 'ingeniero', 'desarrollador', 'especialista', 'coordinador',
  'director', 'consultor',
  'stagiaire', 'ingénieur', 'développeur', 'developpeur', 'analyste', 'spécialiste',
  'specialiste', 'coordinateur', 'consultant', 'responsable',
  'estagiário', 'estagiario', 'engenheiro', 'desenvolvedor', 'coordenador', 'diretor',
  'stagiair', 'ontwikkelaar', 'analist', 'coördinator', 'adviseur'
];
var JOB_TITLE_HINT_RE = new RegExp('\\b(?:' + JOB_TITLE_WORDS.map(escapeRegExp).join('|') + ')\\b', 'i');

// Heuristic signal for "this header line is a company name" — common legal
// entity suffixes. Same role as JOB_TITLE_HINT_RE above: a tie-breaker, not
// a classifier on its own.
var COMPANY_SUFFIX_WORDS_SRC = 'inc|llc|ltd|gmbh|corp|plc|sarl|s\\.?r\\.?l\\.?|s\\.?p\\.?a\\.?|s\\.?a\\.?|s\\.?l\\.?|b\\.?v\\.?|n\\.?v\\.?|kg|ag|oy|aps|kft|lda|ltda|a\\.?ş\\.?|şti';
var COMPANY_SUFFIX_RE = new RegExp('\\b(?:' + COMPANY_SUFFIX_WORDS_SRC + ')\\b\\.?', 'i');
// Same suffix list, anchored to the end of the string — used to allow a
// trailing period on a company candidate ONLY when it's a real abbreviation
// ("Inc.", "Corp.", "A.Ş."), not the tail of an unrelated sentence.
var COMPANY_SUFFIX_TAIL_RE = new RegExp('\\b(?:' + COMPANY_SUFFIX_WORDS_SRC + ')\\.?$', 'i');

// Whether a line plausibly starts a new header (company/position), as
// opposed to being the tail of a bullet's sentence that wrapped onto its
// own physical line with no bullet glyph of its own — PDF text extraction
// produces one array entry per visual line, so a long bullet reads as
// several unprefixed lines in a row. A real company/position starts with a
// capitalized word and doesn't end mid-sentence with a period; a wrapped
// continuation usually does neither. A trailing period is still allowed
// when it's a recognized company-suffix abbreviation ("Inc.", "Corp.",
// "A.Ş."), since those are common and legitimate. Used both to decide when
// a run of bullet lines has ended (see extractWorkExperience) and, as a
// last check, to reject a company value built from a false-positive header
// line (see buildWorkEntry).
function looksLikeHeaderLine(text) {
  var t = (text || '').trim();
  if (!t || !/^\p{Lu}/u.test(t)) return false;
  if (!/\.$/.test(t)) return true;
  return COMPANY_SUFFIX_TAIL_RE.test(t);
}

// Stricter than looksLikeHeaderLine, with no trailing-period exception —
// used only to validate a position value, since job titles don't
// legitimately end with an abbreviated legal-entity suffix the way company
// names do.
function looksLikeValidPosition(text) {
  var t = (text || '').trim();
  if (!t) return false;
  if (/\.$/.test(t)) return false;
  return /^\p{Lu}/u.test(t);
}

// "City, Country" or "City, ST" — one or two comma-separated parts, each 1-4
// capitalized words. Deliberately narrower than "starts with a capital
// letter": a company line can just as easily have a second capitalized word
// after a wide gap (e.g. a second column that isn't a location at all), so
// only text that's actually comma-shaped like a place name counts.
var LOCATION_RE = new RegExp(
  '^\\p{Lu}[\\p{L}.\'-]*(?:\\s+\\p{Lu}[\\p{L}.\'-]*){0,3}\\s*,\\s*\\p{Lu}[\\p{L}.\'-]*(?:\\s+\\p{Lu}[\\p{L}.\'-]*){0,3}$',
  'u'
);

function looksLikeLocation(text) {
  return LOCATION_RE.test(text.trim());
}

// Strips a trailing "City, Country" from a company line that has its
// location packed onto the same line, separated by a wide gap (a common PDF
// text-extraction artifact from column-aligned CV layouts, preserved as a
// double space by groupItemsIntoLines above) — e.g. "Acme Corp  Istanbul,
// Turkey" -> "Acme Corp". Splits on the LAST such gap, since the location is
// the part that sits at the end of the line; left alone if what follows the
// gap doesn't actually look like a place name.
function stripTrailingLocation(line) {
  var parts = line.split(/ {2,}/);
  if (parts.length < 2) return line;

  var right = parts[parts.length - 1].trim();
  var left = parts.slice(0, -1).join(' ').trim();
  return (left && looksLikeLocation(right)) ? left : line;
}

// Decides which of two header lines (already known to be company vs.
// position, in some order — no date/bullet on either) is which, using
// JOB_TITLE_HINT_RE/COMPANY_SUFFIX_RE as tie-breakers. Falls back to the
// conventional "company, then position" order when neither line has a
// signal either way.
function classifyHeaderPair(line1, line2) {
  var l1Title = JOB_TITLE_HINT_RE.test(line1);
  var l2Title = JOB_TITLE_HINT_RE.test(line2);
  if (l2Title && !l1Title) return { company: line1, position: line2, reason: 'title word on 2nd line' };
  if (l1Title && !l2Title) return { company: line2, position: line1, reason: 'title word on 1st line' };

  var l1Company = COMPANY_SUFFIX_RE.test(line1);
  var l2Company = COMPANY_SUFFIX_RE.test(line2);
  if (l1Company && !l2Company) return { company: line1, position: line2, reason: 'company-suffix on 1st line' };
  if (l2Company && !l1Company) return { company: line2, position: line1, reason: 'company-suffix on 2nd line' };

  return { company: line1, position: line2, reason: 'no signal, default company-then-position order' };
}

// Splits one line that holds both company and position, separated by a
// dash/comma/pipe or a connector word ("at", "presso", "bei", ...), and
// figures out which side is which the same way classifyHeaderPair does.
// Falls back to the conventional "position, then company" order (matching
// this module's original single-line behavior) when neither side has a
// signal either way.
function splitCombinedHeaderLine(line) {
  var parts = line
    .split(/\s+(?:at|@|presso|bei|chez|em|bij)\s+|\s*[-–—|,]\s*/i)
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
  if (parts.length < 2) return null;

  var a = parts[0];
  var b = parts.slice(1).join(', ');
  var aTitle = JOB_TITLE_HINT_RE.test(a);
  var bTitle = JOB_TITLE_HINT_RE.test(b);
  if (aTitle && !bTitle) return { position: a, company: b, reason: 'title word before separator' };
  if (bTitle && !aTitle) return { position: b, company: a, reason: 'title word after separator' };

  var aCompany = COMPANY_SUFFIX_RE.test(a);
  var bCompany = COMPANY_SUFFIX_RE.test(b);
  if (aCompany && !bCompany) return { company: a, position: b, reason: 'company-suffix before separator' };
  if (bCompany && !aCompany) return { company: b, position: a, reason: 'company-suffix after separator' };

  return { position: a, company: b, reason: 'no signal, default position-then-company order' };
}

// Turns the header lines collected for one job (1, 2, or occasionally more
// — see extractWorkExperience) plus its date range (possibly none) into a
// {company, position, startDate, endDate} entry.
function buildWorkEntry(headerLines, dateInfo) {
  var lines = headerLines.filter(Boolean);
  var company = '';
  var position = '';
  var reason = 'no header text';

  if (lines.length === 1) {
    var split = splitCombinedHeaderLine(lines[0]);
    if (split) {
      company = split.company;
      position = split.position;
      reason = 'single combined line (' + split.reason + ')';
    } else {
      company = lines[0];
      reason = 'single line with no separator, treated as company';
    }
  } else if (lines.length >= 2) {
    var pair = classifyHeaderPair(lines[0], lines[lines.length - 1]);
    company = pair.company;
    position = pair.position;
    if (lines.length > 2) {
      var middle = lines.slice(1, lines.length - 1).join(', ');
      company = company + (company ? ', ' : '') + middle;
      reason = lines.length + ' header lines, extra line(s) folded into company (' + pair.reason + ')';
    } else {
      reason = 'two header lines (' + pair.reason + ')';
    }
  }

  var strippedCompany = stripTrailingLocation(company);
  if (strippedCompany !== company) reason += ', stripped trailing location from company';
  company = strippedCompany.trim();
  position = position.trim();

  // Last line of defense against a wrapped bullet continuation that slipped
  // through as header text (see looksLikeHeaderLine/looksLikeValidPosition)
  // — a real company/position is never a lowercase-starting or
  // period-ending sentence fragment. Blanked rather than dropped outright
  // so the OTHER field (if valid) is still kept.
  if (company && !looksLikeHeaderLine(company)) {
    reason += ', rejected company "' + company + '" (looks like a bullet fragment)';
    company = '';
  }
  if (position && !looksLikeValidPosition(position)) {
    reason += ', rejected position "' + position + '" (looks like a bullet fragment)';
    position = '';
  }

  var entry = {
    company: company,
    position: position,
    startDate: (dateInfo && dateInfo.startDate) || '',
    endDate: (dateInfo && dateInfo.endDate) || ''
  };
  logCv('  entry ->', entry, '(' + reason + ')');
  return entry;
}

// Groups the experience section's lines into entries. Layouts vary a lot —
// company/position on one line or two (in either order), dates inline or on
// their own line, a wide-gap location tacked onto the company line — so
// this walks the lines as a small state machine instead of expecting one
// fixed shape:
//  - a bullet line never starts an entry and is never scanned for a date;
//    it just closes off whatever header lines were pending (an entry can
//    have no date at all, e.g. if the CV never states one), and puts the
//    parser into "inside a bullet" mode.
//  - while inside a bullet, an unprefixed line is normally a wrapped
//    continuation of that bullet's sentence (PDF text extraction produces
//    one array entry per visual line, so a long bullet reads as several
//    unprefixed lines in a row) — it's ignored, same as the bullet itself,
//    unless it looks like a real header (see looksLikeHeaderLine), in which
//    case it's the next job's company/position and bullet mode ends.
//  - outside a bullet, a non-bullet line either contains a date range
//    (closing the entry: text before the date on that line still counts as
//    header text) or is plain header text accumulated for the entry
//    currently being built.
function extractWorkExperience(lines) {
  if (!lines || !lines.length) return [];

  logCv('extractWorkExperience: experience section has', lines.length, 'line(s)');
  lines.forEach(function (line, i) { logCv('  line', i, ':', JSON.stringify(line)); });

  var entries = [];
  var pending = [];
  var inBullet = false;

  function flush(dateInfo) {
    if (!pending.length && !dateInfo) return;
    var entry = buildWorkEntry(pending, dateInfo);
    pending = [];
    if (!entry.company && !entry.position) {
      logCv('  dropped: no company/position text found for this entry');
      return;
    }
    entries.push(entry);
  }

  for (var i = 0; i < lines.length && entries.length < 5; i++) {
    var line = lines[i];

    if (isBulletLine(line)) {
      logCv('line', i, 'is a bullet/description line, skipping and closing any pending entry');
      inBullet = true;
      if (pending.length) flush(null);
      continue;
    }

    var m = line.match(DATE_RANGE_RE);
    if (m) {
      inBullet = false;
      var before = line.slice(0, m.index).trim().replace(/[-–—|,(]+$/, '').trim();
      if (before) pending.push(before);

      var startDate = parseDateToken(m[1]) || '';
      var endDate = isOngoingToken(m[2]) ? '' : (parseDateToken(m[2]) || '');
      logCv('line', i, 'matched date range', JSON.stringify(m[0]), '-> start:', JSON.stringify(startDate), 'end:', JSON.stringify(endDate));

      flush({ startDate: startDate, endDate: endDate });
      continue;
    }

    if (inBullet) {
      if (looksLikeHeaderLine(line)) {
        if (isAnySectionHeading(line)) {
          logCv('line', i, 'looks like the start of a new section, stopping experience extraction:', JSON.stringify(line));
          if (pending.length) flush(null);
          break;
        }
        logCv('line', i, 'ends the bullet run (looks like a new header), treated as header text');
        inBullet = false;
        pending.push(line);
      } else {
        logCv('line', i, 'is a wrapped continuation of the previous bullet, skipping:', JSON.stringify(line));
      }
      continue;
    }

    if (isAnySectionHeading(line)) {
      logCv('line', i, 'looks like the start of a new section, stopping experience extraction:', JSON.stringify(line));
      if (pending.length) flush(null);
      break;
    }

    logCv('line', i, 'treated as header text (company/position/location)');
    pending.push(line);
  }

  if (pending.length) flush(null);

  logCv('extractWorkExperience: extracted', entries.length, 'entrie(s)');
  return entries;
}

// Shared by extractLanguages (one language per line, in a dedicated
// "Languages" section) and parseInlineLanguagesContent (one language per
// comma-separated item, in an inline "Languages: ..." line).
function parseLanguageEntry(itemText) {
  var name = stripProficiencyPrefix(itemText.split(/[-–—(:]/)[0].trim());
  if (!name || name.length > 30) return null;
  return { language: name, proficiency: detectProficiencyFromText(itemText) || 'Fluent' };
}

function extractLanguages(lines) {
  if (!lines || !lines.length) return [];

  var out = [];
  lines.forEach(function (line) {
    var norm = normalizeLine(line);
    if (!norm || ALL_HEADINGS.indexOf(norm) !== -1) return;

    var entry = parseLanguageEntry(line);
    if (entry) out.push(entry);
  });

  return out.slice(0, 10);
}

// "German (DSD II - C1) and English" — "and" (plus its equivalents in the
// eight supported languages) separates items here just as much as a comma
// does; without this, everything after it is lost inside the first item.
var LANGUAGE_LIST_SEP_RE = /[,;]|\s+(?:and|und|ve|y|et|en|e)\s+/i;

function parseInlineLanguagesContent(content) {
  return content
    .split(LANGUAGE_LIST_SEP_RE)
    .map(function (item) { return item.trim(); })
    .filter(Boolean)
    .map(parseLanguageEntry)
    .filter(Boolean)
    .slice(0, 10);
}

// ---- Inline "Languages: ...", "Certifications: ...", "Interests: ..." ----
// Many CVs list these as one line inside another section (often "Skills &
// Interests") rather than under their own heading — e.g.
// "Languages: Turkish (Native), Italian (Fluent), English (...)" sitting
// inside a Skills block. Left alone, that whole line gets swept into
// skills. This runs as a pass over every line, before section splitting,
// so it catches the label regardless of which section it's sitting in.
// (Word lists are INLINE_LABELS, defined above alongside SECTION_HEADINGS.)

// Returns the text after "<label>:" / "<label> -" if `line` starts with one
// of `labelWords`, or null if it doesn't (including a bare heading line like
// "Languages:" with nothing after it — that's left for the normal
// section-heading path to handle).
function matchInlineLabelContent(line, labelWords) {
  var lowerLine = turkishSafeLower(line);
  for (var i = 0; i < labelWords.length; i++) {
    var re = new RegExp('^' + escapeRegExp(labelWords[i]) + '\\s*[:\\-–]\\s*');
    var m = lowerLine.match(re);
    if (m) {
      var content = line.slice(m[0].length).trim();
      if (content) return content;
    }
  }
  return null;
}

function extractInlineLabeledContent(lines) {
  var languages = [];
  var remainingLines = [];

  lines.forEach(function (line) {
    var langContent = matchInlineLabelContent(line, INLINE_LABELS.languages);
    if (langContent !== null) {
      languages = languages.concat(parseInlineLanguagesContent(langContent));
      return;
    }

    // Certifications/interests have no matching profile field — dropping
    // the whole line here is what keeps them out of skills (and everything
    // else); nothing further needs to be done with their content.
    if (matchInlineLabelContent(line, INLINE_LABELS.certifications) !== null) return;
    if (matchInlineLabelContent(line, INLINE_LABELS.interests) !== null) return;

    remainingLines.push(line);
  });

  return { languages: languages, remainingLines: remainingLines };
}

// Strips a leading "Label:" from a line — e.g. "Technical Skills:  Excel,
// SAP" -> "Excel, SAP" — so a sub-label inside the skills section body
// (as opposed to its own SECTION_HEADINGS heading) doesn't end up glued to
// the first real skill. Only matches a label made of letters/spaces, so a
// skill that happens to contain a colon (unlikely, but e.g. "C++: modern")
// is left alone.
var LEADING_LABEL_RE = /^\p{Lu}[\p{L}\s]{1,30}:\s*/u;

function stripLeadingLabel(line) {
  return line.replace(LEADING_LABEL_RE, '');
}

function extractSkills(lines) {
  if (!lines || !lines.length) return [];

  // A "Skills" section sometimes holds more than the skills list itself
  // (e.g. a stray sub-heading or unrelated line) — if one line actually
  // starts with a "Skills:"/"Technical Skills:" label, that's the real
  // list and the rest of the section is noise. Otherwise fall back to
  // every line, for the common case of a plain comma list with no label.
  var labeledLine = lines.find(function (line) {
    var m = line.match(LEADING_LABEL_RE);
    return m && /skill/i.test(m[0]);
  });

  var joined = (labeledLine ? [stripLeadingLabel(labeledLine)] : lines.map(stripLeadingLabel)).join(', ');
  return joined
    .split(/[,;•·|]/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s && s.length <= 40 && ALL_HEADINGS.indexOf(normalizeLine(s)) === -1; })
    .slice(0, 30);
}

function extractName(lines) {
  for (var i = 0; i < Math.min(lines.length, 3); i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var norm = normalizeLine(line);
    if (CV_TITLE_LINES.indexOf(norm) !== -1) continue;
    if (EMAIL_RE.test(line)) continue;
    if (line.length > 60) continue;
    if (/\d/.test(line)) continue;

    var words = line.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 4) continue;

    return {
      firstName: words[0],
      lastName: words.slice(1).join(' ')
    };
  }
  return null;
}

function extractProfileByPattern(text) {
  var lines = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

  var emailMatch = text.match(EMAIL_RE);
  var phone = findPhone(text);
  var phoneCountryCode = derivePhoneCountryCode(phone);
  var linkedin = findUrl(text, LINKEDIN_URL_RE);
  var github = findUrl(text, GITHUB_URL_RE);
  var name = extractName(lines);
  var address = extractAddress(lines) || {};

  var inline = extractInlineLabeledContent(lines);
  var sections = splitIntoSections(inline.remainingLines);
  var education = extractEducation(sections.education);
  var workExperience = extractWorkExperience(sections.experience);
  var skills = extractSkills(sections.skills);
  var aboutMe = extractAboutMe(sections.aboutMe);

  var testDerivedLanguages = extractTestDerivedLanguages(lines);
  var languages = mergeLanguageLists(extractLanguages(sections.languages), inline.languages, testDerivedLanguages);

  return {
    personal: {
      firstName: (name && name.firstName) || '',
      lastName: (name && name.lastName) || '',
      email: emailMatch ? emailMatch[0] : '',
      phone: phone,
      phoneCountryCode: phoneCountryCode,
      addressLine: address.addressLine || '',
      city: address.city || '',
      state: address.state || '',
      postalCode: address.postalCode || '',
      country: address.country || ''
    },
    links: { linkedin: linkedin, portfolio: '', github: github },
    education: education || { school: '', degree: '', field: '', gradYear: '' },
    workExperience: workExperience,
    languages: languages,
    skills: skills,
    essays: { aboutMe: aboutMe, whyThisRole: '', strengths: '' }
  };
}

// ---- Orchestration --------------------------------------------------------

function profileHasData(profile) {
  if (!profile) return false;
  var p = profile.personal || {};
  if (p.firstName || p.lastName || p.email || p.phone || p.addressLine || p.city || p.country) return true;
  var links = profile.links || {};
  if (links.linkedin || links.portfolio || links.github) return true;
  var edu = profile.education || {};
  if (edu.school || edu.degree || edu.field || edu.gradYear) return true;
  if (profile.workExperience && profile.workExperience.length) return true;
  if (profile.languages && profile.languages.length) return true;
  if (profile.skills && profile.skills.length) return true;
  var essays = profile.essays || {};
  if (essays.aboutMe) return true;
  return false;
}

export async function importCvFromFile(file, apiKey) {
  if (!file) return { ok: false, reason: 'no-file' };

  var looksLikePdf = (file.type === 'application/pdf') || /\.pdf$/i.test(file.name || '');
  if (!looksLikePdf) return { ok: false, reason: 'not-pdf' };

  var buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (e) {
    return { ok: false, reason: 'file-error', message: String((e && e.message) || e) };
  }

  var text;
  try {
    text = await extractPdfText(buffer);
  } catch (e) {
    return { ok: false, reason: 'not-pdf', message: String((e && e.message) || e) };
  }

  if (!text || !text.trim()) {
    return { ok: false, reason: 'no-text' };
  }

  var profile = null;
  var source = 'pattern';

  if (apiKey) {
    try {
      profile = await extractProfileViaApi(text, apiKey);
      source = 'api';
    } catch (e) {
      profile = null; // fall back to pattern-based extraction below
    }
  }

  if (!profile) {
    profile = extractProfileByPattern(text);
    source = 'pattern';
  }

  if (!profileHasData(profile)) {
    return { ok: false, reason: 'no-data' };
  }

  return { ok: true, profile: profile, source: source };
}
