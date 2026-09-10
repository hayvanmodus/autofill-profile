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

function groupItemsIntoLines(items) {
  var lines = [];
  var current = null;
  var lastY = null;

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var y = item.transform ? item.transform[5] : 0;
    if (lastY === null || Math.abs(y - lastY) > 2) {
      current = [];
      lines.push(current);
      lastY = y;
    }
    if (item.str) current.push(item.str);
  }

  return lines
    .map(function (parts) { return parts.join(' ').replace(/\s+/g, ' ').trim(); })
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
  '  "skills": [ "" ]',
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
  'Advanced, Fluent, Native (pick the closest). No prose, no markdown code',
  'fences, no explanation — JSON only.'
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

function sanitizeApiProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;

  var p = raw.personal || {};
  var links = raw.links || {};
  var edu = raw.education || {};

  var workExperience = Array.isArray(raw.workExperience) ? raw.workExperience : [];
  var languages = Array.isArray(raw.languages) ? raw.languages : [];
  var skills = Array.isArray(raw.skills) ? raw.skills : [];

  return {
    personal: {
      firstName: str(p.firstName),
      lastName: str(p.lastName),
      email: str(p.email),
      phone: str(p.phone),
      phoneCountryCode: str(p.phoneCountryCode),
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
          startDate: str(w && w.startDate),
          endDate: str(w && w.endDate)
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
    skills: skills.map(str).filter(Boolean)
  };
}

async function extractProfileViaApi(text, apiKey) {
  var body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: text.slice(0, 15000) }]
  };

  var res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });

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
var PHONE_RE = /(\+?\d[\d .()\-]{7,}\d)/;

var CV_TITLE_LINES = ['curriculum vitae', 'resume', 'cv', 'lebenslauf', 'özgeçmiş', 'ozgecmis'];

// Label words for lines/headings about languages, certifications and
// interests, covering the same 7 languages throughout (en, it, de, tr, es,
// fr, nl). Used two ways below: as SECTION_HEADINGS entries (a bare
// "Certifications" line on its own, with no colon) and, for the inline
// case, by extractInlineLabeledContent ("Certifications: AWS SA, Scrum
// Master" sitting inside another section). Without both forms recognized,
// a certifications/interests line — heading or inline — falls through into
// whatever section came before it (often skills or languages), corrupting
// it; neither certifications nor interests has a matching profile field, so
// both are simply dropped once recognized rather than stored anywhere.
var INLINE_LABELS = {
  languages: ['languages', 'lingue', 'sprachen', 'diller', 'idiomas', 'langues', 'talen'],
  certifications: [
    'certifications', 'certificates',
    'certificazioni', 'zertifikate', 'zertifizierungen',
    'sertifikalar', 'certificaciones', 'certificats', 'certificaten'
  ],
  interests: [
    'interests', 'hobbies',
    'interessi', 'interessen', 'hobby',
    'ilgi alanlari', 'ilgi alanları', 'intereses', 'aficiones', 'loisirs', 'interesses'
  ]
};

var SECTION_HEADINGS = {
  education: [
    'education', 'academic background',
    'istruzione', 'formazione', 'formazione accademica',
    'ausbildung', 'bildung', 'akademischer werdegang',
    'eğitim', 'egitim'
  ],
  experience: [
    'work experience', 'experience', 'professional experience', 'employment history',
    'esperienza lavorativa', 'esperienza professionale', 'esperienza',
    'berufserfahrung', 'arbeitserfahrung',
    'iş deneyimi', 'is deneyimi', 'deneyim'
  ],
  skills: [
    'skills', 'technical skills', 'key skills',
    'competenze', 'abilità', 'abilita',
    'kenntnisse', 'fähigkeiten', 'fahigkeiten',
    'yetenekler', 'beceriler'
  ],
  languages: INLINE_LABELS.languages,
  // Recognized as headings purely so their content is diverted away from
  // whichever section precedes them (see extractProfileByPattern, which
  // never reads sections.certifications/sections.interests).
  certifications: INLINE_LABELS.certifications,
  interests: INLINE_LABELS.interests
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

var LEVEL_WORDS = {
  Native: ['native', 'mother tongue', 'madrelingua', 'muttersprache', 'anadil', 'ana dil'],
  Fluent: ['fluent', 'fluente', 'corrente', 'fließend', 'fliessend', 'akıcı', 'akici'],
  Advanced: ['advanced', 'professional working proficiency', 'avanzato', 'fortgeschritten', 'ileri'],
  Intermediate: ['intermediate', 'conversational', 'intermedio', 'mittelstufe', 'orta'],
  Basic: ['basic', 'base', 'elementare', 'grundkenntnisse', 'başlangıç', 'baslangic']
};

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

var DATE_RANGE_RE = new RegExp(
  '((?:19|20)\\d{2}(?:[-/.]\\d{1,2})?)\\s*(?:-|–|—|to|a|bis|ile)\\s*' +
  '((?:19|20)\\d{2}(?:[-/.]\\d{1,2})?|present|current|ongoing|oggi|attuale|heute|devam|günümüz|gunumuz)',
  'i'
);

var ONGOING_RE = /present|current|ongoing|oggi|attuale|heute|devam|günümüz|gunumuz/i;

function normalizeLine(line) {
  return line.toLowerCase().replace(/[.:]+$/, '').trim();
}

function isHeadingLine(line, headingWords) {
  var norm = normalizeLine(line);
  if (norm.length > 40) return false;
  for (var i = 0; i < headingWords.length; i++) {
    if (norm === headingWords[i] || norm.indexOf(headingWords[i]) === 0) return true;
  }
  return false;
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
      school = lines[i].trim();
    }
    if (!degree && DEGREE_WORDS.some(function (w) { return norm.indexOf(w) !== -1; })) {
      degree = lines[i].trim();
      var fieldMatch = lines[i].match(/\bin\s+([A-ZÀ-Ý][\w\s&,-]{2,40})/);
      if (fieldMatch) field = fieldMatch[1].trim();
    }
  }

  var gradYear = findYear(lines);

  if (!school && !degree && !field && !gradYear) return null;
  return { school: school, degree: degree, field: field, gradYear: gradYear };
}

function parseDateFragment(fragment) {
  if (ONGOING_RE.test(fragment)) return '';
  var m = fragment.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (m) return m[1] + '-' + (m[2].length === 1 ? '0' + m[2] : m[2]);
  var y = fragment.match(/^\d{4}$/);
  if (y) return y[0];
  return '';
}

function extractWorkExperience(lines) {
  if (!lines || !lines.length) return [];

  var entries = [];
  for (var i = 0; i < lines.length && entries.length < 5; i++) {
    var line = lines[i];
    var m = line.match(DATE_RANGE_RE);
    if (!m) continue;

    var before = line.slice(0, m.index).trim();
    before = before.replace(/[-–—|,]+$/, '').trim();

    var company = '';
    var position = '';
    var sep = before.split(/\s+(?:at|@|presso|bei|de)\s+|\s*[-–—|]\s*/i);
    if (sep.length >= 2) {
      position = sep[0].trim();
      company = sep.slice(1).join(' ').trim();
    } else {
      company = before;
    }

    entries.push({
      company: company,
      position: position,
      startDate: parseDateFragment(m[1]),
      endDate: parseDateFragment(m[2])
    });
  }

  return entries;
}

// Shared by extractLanguages (one language per line, in a dedicated
// "Languages" section) and parseInlineLanguagesContent (one language per
// comma-separated item, in an inline "Languages: ..." line).
function parseLanguageEntry(itemText) {
  var name = itemText.split(/[-–—(:]/)[0].trim();
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

function parseInlineLanguagesContent(content) {
  return content
    .split(/[,;]/)
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
  var lowerLine = line.toLowerCase();
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

function extractSkills(lines) {
  if (!lines || !lines.length) return [];

  var joined = lines.join(', ');
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
  var phoneMatch = text.match(PHONE_RE);
  var name = extractName(lines);

  var inline = extractInlineLabeledContent(lines);
  var sections = splitIntoSections(inline.remainingLines);
  var education = extractEducation(sections.education);
  var workExperience = extractWorkExperience(sections.experience);
  var skills = extractSkills(sections.skills);

  var testDerivedLanguages = extractTestDerivedLanguages(lines);
  var languages = mergeLanguageLists(extractLanguages(sections.languages), inline.languages, testDerivedLanguages);

  return {
    personal: {
      firstName: (name && name.firstName) || '',
      lastName: (name && name.lastName) || '',
      email: emailMatch ? emailMatch[0] : '',
      phone: phoneMatch ? phoneMatch[0].trim() : '',
      phoneCountryCode: '',
      addressLine: '',
      city: '',
      state: '',
      postalCode: '',
      country: ''
    },
    links: { linkedin: '', portfolio: '', github: '' },
    education: education || { school: '', degree: '', field: '', gradYear: '' },
    workExperience: workExperience,
    languages: languages,
    skills: skills
  };
}

// ---- Orchestration --------------------------------------------------------

function profileHasData(profile) {
  if (!profile) return false;
  var p = profile.personal || {};
  if (p.firstName || p.lastName || p.email || p.phone) return true;
  var links = profile.links || {};
  if (links.linkedin || links.portfolio || links.github) return true;
  var edu = profile.education || {};
  if (edu.school || edu.degree || edu.field || edu.gradYear) return true;
  if (profile.workExperience && profile.workExperience.length) return true;
  if (profile.languages && profile.languages.length) return true;
  if (profile.skills && profile.skills.length) return true;
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
