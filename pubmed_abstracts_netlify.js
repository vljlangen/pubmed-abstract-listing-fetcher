#!/usr/bin/env node

// Simple Node.js script to:
// 1) Read a references text file (one reference per line)
// 2) For each reference, try to find a PubMed record via E-utilities
// 3) If found, fetch the "Abstract (text)" representation
// 4) Emit a continuous HTML file with each original line + abstract (or "Not found in PubMed.")
//
// Usage (from project directory):
//   node pubmed_abstracts.js references.txt pubmed_abstracts.html
//   # or rely on defaults:
//   node pubmed_abstracts.js

const fs = require("fs").promises;
const path = require("path");
const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");

// Configuration: update these if you want to supply real contact info / API key
const NCBI_TOOL_NAME = "pubmed-abstract-collector";
const NCBI_CONTACT_EMAIL_DEFAULT = "your-email@example.com"; // Used when NCBI_CONTACT_EMAIL env is unset (fine for deploys).

function ncbiContactEmail() {
  return process.env.NCBI_CONTACT_EMAIL || NCBI_CONTACT_EMAIL_DEFAULT;
}

function ncbiApiKey() {
  return process.env.NCBI_API_KEY || "";
}

function minRequestIntervalMs() {
  if (ncbiApiKey()) return 120;
  // NCBI: max 3 requests/sec without an API key — stay just under that for serverless runs.
  return 334;
}

const MAX_RETRIES = 5;
/** Confidence gate on combined ranking score (title Jaccard + journal + first author when available) */
const JACCARD_GATE = 0.35;
/** Title-only Jaccard high enough to accept without journal/author match (generic-title guard) */
const TITLE_JACCARD_STRONG = 0.65;

let lastRequestAt = 0;

function parseArgs() {
  const [, , inFile, outFile] = process.argv;
  const inputPath = inFile || "references.txt";
  const outputPath = outFile || "pubmed_abstracts.html";
  return { inputPath, outputPath };
}

function parseReferenceLines(rawText) {
  return rawText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const RETRYABLE_FETCH_CODES = new Set([
  "ENOTFOUND",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EPIPE"
]);

function isRetryableFetchError(err) {
  if (!err) return false;
  const code = err.code;
  const causeCode = err.cause && err.cause.code;
  return RETRYABLE_FETCH_CODES.has(code) || RETRYABLE_FETCH_CODES.has(causeCode);
}

function formatFetchError(err) {
  if (err.cause) {
    const c = err.cause;
    return `${err.message}: ${c.message || c.code || String(c)}`;
  }
  return err.message || String(err);
}

async function throttledFetch(url) {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  const waitMs = Math.max(0, minRequestIntervalMs() - elapsed);
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  const res = await fetch(url);
  lastRequestAt = Date.now();
  return res;
}

async function fetchWithRetry(url, operationName) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await throttledFetch(url);
    } catch (err) {
      if (isRetryableFetchError(err) && attempt < MAX_RETRIES) {
        const backoffMs = 1200 * Math.pow(2, attempt);
        console.warn(
          `  ${operationName}: network error (${formatFetchError(err)}), retry ${attempt + 1}/${MAX_RETRIES} in ${backoffMs} ms...`
        );
        await sleep(backoffMs);
        continue;
      }
      throw new Error(`${operationName}: ${formatFetchError(err)}`);
    }
    if (res.ok) return res;

    // Handle PubMed throttling gracefully
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1200 * Math.pow(2, attempt);
      console.warn(`  ${operationName}: HTTP 429, retrying in ${backoffMs} ms...`);
      await sleep(backoffMs);
      continue;
    }

    throw new Error(`${operationName} error: HTTP ${res.status}`);
  }

  throw new Error(`${operationName} error: exceeded retry limit`);
}

function cleanReferenceForSearch(referenceLine) {
  return referenceLine
    .replace(/^\d+\.\s*/, "")
    .replace(/�/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForMatch(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s) {
  const n = normalizeForMatch(s);
  if (!n) return new Set();
  return new Set(n.split(" ").filter(Boolean));
}

function jaccard(a, b) {
  const as = tokenSet(a);
  const bs = tokenSet(b);
  if (as.size === 0 && bs.size === 0) return 1;
  if (as.size === 0 || bs.size === 0) return 0;
  let inter = 0;
  for (const t of as) if (bs.has(t)) inter++;
  const union = as.size + bs.size - inter;
  return union === 0 ? 0 : inter / union;
}

function extractCitationFields(referenceLine) {
  // Strip leading numbering like "1." or "10."
  const line = referenceLine.replace(/^\d+\.\s*/, "").trim();

  // Year
  const yearMatch = line.match(/(19|20)\d{2}/);
  const year = yearMatch ? yearMatch[0] : "";

  // Title: usually after ":" and before the journal segment that precedes the year.
  // We do not try to fully parse the journal; we instead:
  //   - take the substring after ":" up to the year (or end)
  //   - drop the last dot-delimited segment (likely journal abbreviation)
  const colonIdx = line.indexOf(":");
  let afterColon = colonIdx >= 0 ? line.slice(colonIdx + 1) : line;

  let beforeYear = afterColon;
  if (yearMatch && typeof yearMatch.index === "number") {
    const yearPosInLine = yearMatch.index;
    // Convert yearPosInLine (in `line`) to position in `afterColon`
    const offset = colonIdx >= 0 ? colonIdx + 1 : 0;
    const yearPosInAfterColon = Math.max(0, yearPosInLine - offset);
    beforeYear = afterColon.slice(0, yearPosInAfterColon);
  }

  // Split on "." to separate [title sentences ...] + [journal]
  const parts = beforeYear
    .split(".")
    .map(p => p.trim())
    .filter(Boolean);

  let title = beforeYear.trim();
  let journal = "";
  if (parts.length >= 2) {
    // Last segment before year is usually journal (e.g. "Lancet", "Hypertension")
    journal = parts[parts.length - 1].trim();
    // Title is everything before that segment
    title = parts.slice(0, -1).join(". ").trim();
  } else if (parts.length === 1) {
    title = parts[0].trim();
  }

  const firstAuthorSurname = extractFirstAuthorSurnameFromLine(line);

  return { line, year, title, journal, firstAuthorSurname };
}

/** First author's family name from text before ":" (e.g. "Cooper DS, Biondi B" -> "Cooper"). */
function extractFirstAuthorSurnameFromLine(line) {
  const colonIdx = line.indexOf(":");
  if (colonIdx < 0) return "";
  const beforeColon = line.slice(0, colonIdx).trim();
  const firstChunk = beforeColon.split(",")[0].trim();
  const words = firstChunk.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  return words[0].replace(/[^a-zA-Z\-]/g, "");
}

function buildSearchTerm(referenceLine) {
  const { title, year, journal, firstAuthorSurname } = extractCitationFields(referenceLine);

  // Prefer title field query; keep year filter if present.
  // Using [Title] makes PubMed search much less noisy.
  let term = title ? `${title}[Title]` : referenceLine;
  if (year) {
    term += ` AND ${year}[dp]`;
  }
  // Disambiguate generic titles (e.g. multiple "Subclinical thyroid disease" papers)
  const author = (firstAuthorSurname || "").trim();
  if (author.length >= 2 && author.toLowerCase() !== "who") {
    term += ` AND ${author}[Author]`;
  }
  const jour = (journal || "").replace(/\./g, " ").trim();
  if (jour.length >= 3) {
    term += ` AND ${jour}[Journal]`;
  }
  return term;
}

/** Same as buildSearchTerm but omits journal (PubMed [Journal] often mismatches abbreviations). */
function buildSearchTermNoJournal(referenceLine) {
  const { title, year, firstAuthorSurname } = extractCitationFields(referenceLine);
  let term = title ? `${title}[Title]` : referenceLine;
  if (year) {
    term += ` AND ${year}[dp]`;
  }
  const author = (firstAuthorSurname || "").trim();
  if (author.length >= 2 && author.toLowerCase() !== "who") {
    term += ` AND ${author}[Author]`;
  }
  return term;
}

const TITLE_QUERY_STOPWORDS = new Set(
  `the a an and or but in on at to for of as by is are was were been be have has had do does did will with from that this these those not no we our their there then than into onto upon via its can may could would should must shall his her them they who whom which what when where why how all each every both few some any such only own same other more most also just even per among within without against between through during before after above below under over`.split(
    /\s+/
  )
);

/**
 * Few distinctive title tokens as separate [Title] AND clauses — survives long titles
 * where a single full-string [Title] query returns 0 hits in E-utilities.
 */
function extractKeywordTitleTerms(title, maxTerms = 6) {
  if (!title) return [];
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map(w => w.trim())
    .filter(Boolean);

  const out = [];
  for (const w of words) {
    if (TITLE_QUERY_STOPWORDS.has(w)) continue;
    if (w.length >= 4) {
      out.push(w);
    } else if (w.length >= 3) {
      out.push(w);
    }
    if (out.length >= maxTerms) break;
  }
  return out.slice(0, maxTerms);
}

function buildSearchTermKeywordTitles(referenceLine) {
  const { title, year, firstAuthorSurname } = extractCitationFields(referenceLine);
  const terms = extractKeywordTitleTerms(title, 5);
  if (terms.length < 2) return null;
  const titlePart = terms.map(t => `${t}[Title]`).join(" AND ");
  let q = titlePart;
  if (year) {
    q += ` AND ${year}[dp]`;
  }
  const author = (firstAuthorSurname || "").trim();
  if (author.length >= 2 && author.toLowerCase() !== "who") {
    q += ` AND ${author}[Author]`;
  }
  return q;
}

/**
 * Try strict parsed query, then without journal, then keyword [Title] clauses (author+year kept).
 */
async function searchParsedWithFallbacks(referenceLine) {
  const full = buildSearchTerm(referenceLine);
  let ids = await searchPubMedByTerm(full);
  if (ids.length) {
    return { ids, label: "parsed-full" };
  }

  const noJournal = buildSearchTermNoJournal(referenceLine);
  ids = await searchPubMedByTerm(noJournal);
  if (ids.length) {
    console.log("  Parsed PubMed: strict query returned 0 hits; retry without [Journal] → hits.");
    return { ids, label: "parsed-no-journal" };
  }

  const kw = buildSearchTermKeywordTitles(referenceLine);
  if (kw) {
    ids = await searchPubMedByTerm(kw);
    if (ids.length) {
      console.log(
        "  Parsed PubMed: full-title and no-journal queries returned 0 hits; retry with keyword [Title] terms → hits."
      );
      return { ids, label: "parsed-keywords" };
    }
  }

  return { ids: [], label: "parsed-none" };
}

function buildRawSearchTerm(referenceLine) {
  return cleanReferenceForSearch(referenceLine);
}

function makeEutilsUrl(base, params) {
  const url = new URL(base);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

async function searchPubMedByTerm(term) {
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
  const params = {
    db: "pubmed",
    retmode: "json",
    term,
    retmax: "20",
    tool: NCBI_TOOL_NAME,
    email: ncbiContactEmail()
  };
  if (ncbiApiKey()) {
    params.api_key = ncbiApiKey();
  }
  const url = makeEutilsUrl(base, params);

  const res = await fetchWithRetry(url, "PubMed esearch");
  const data = await res.json();
  const idList = (data.esearchresult && data.esearchresult.idlist) || [];
  return idList;
}

function getPubmedSource(rec) {
  if (!rec) return "";
  return rec.source || rec.fulljournalname || rec.booktitle || "";
}

function getPubmedFirstAuthorName(rec) {
  if (!rec) return "";
  if (rec.sortfirstauthor) return String(rec.sortfirstauthor);
  const authors = rec.authors;
  if (!authors) return "";
  if (typeof authors === "string") {
    return authors.split("|")[0].trim() || authors;
  }
  if (!Array.isArray(authors) || !authors.length) return "";
  const a = authors[0];
  if (!a) return "";
  if (typeof a === "string") return a;
  return a.name || "";
}

function journalMatches(citationJournal, pubmedSource) {
  if (!citationJournal || !pubmedSource) return false;
  const c = normalizeForMatch(citationJournal).replace(/\s+/g, "");
  const p = normalizeForMatch(pubmedSource);
  if (c.length < 3) return false;
  return p.replace(/\s+/g, "").includes(c) || p.includes(normalizeForMatch(citationJournal));
}

function firstAuthorSurnameMatches(citationSurname, pubmedAuthorField) {
  if (!citationSurname || !pubmedAuthorField) return false;
  const c = normalizeForMatch(citationSurname);
  if (c.length < 2) return false;
  const first = pubmedAuthorField.split(",")[0].trim();
  const p = normalizeForMatch(first);
  return p.startsWith(c + " ") || p === c || p.split(/\s+/)[0] === c;
}

/**
 * Title Jaccard plus strong boosts when parsed journal / first author match PubMed summary.
 * Caps at 1 so generic titles still need journal or author agreement to beat wrong hits.
 */
function combinedRankingScore(citationTitle, citationJournal, citationFirstAuthor, rec) {
  const pubmedTitle = rec && rec.title ? rec.title : "";
  let score = jaccard(citationTitle, pubmedTitle);
  const source = getPubmedSource(rec);
  const authStr = getPubmedFirstAuthorName(rec);

  if (citationJournal && journalMatches(citationJournal, source)) {
    score = Math.min(1, score + 0.42);
  }
  if (citationFirstAuthor && firstAuthorSurnameMatches(citationFirstAuthor, authStr)) {
    score = Math.min(1, score + 0.42);
  }
  return score;
}

/** Require journal or first-author alignment vs PubMed metadata, or a very strong title-only match. */
function passesCorroborationRule(best) {
  if (!best) return false;
  if (best.titleJaccard == null) return true;
  return (
    best.journalAligned ||
    best.authorAligned ||
    best.titleJaccard >= TITLE_JACCARD_STRONG
  );
}

function isAcceptableConfidentMatch(best) {
  return best && best.score >= JACCARD_GATE && passesCorroborationRule(best);
}

async function fetchSummaries(pmids) {
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
  const params = {
    db: "pubmed",
    retmode: "json",
    id: pmids.join(","),
    tool: NCBI_TOOL_NAME,
    email: ncbiContactEmail()
  };
  if (ncbiApiKey()) {
    params.api_key = ncbiApiKey();
  }

  const url = makeEutilsUrl(base, params);
  const res = await fetchWithRetry(url, "PubMed esummary");
  return await res.json();
}

/**
 * Among candidate PMIDs, pick the one whose PubMed title best matches the citation title.
 * @returns {{ pmid: string, score: number, titleJaccard: number | null, journalAligned: boolean, authorAligned: boolean } | null}
 */
async function scoreBestMatch(referenceLine, candidatePmids) {
  if (!candidatePmids || !candidatePmids.length) return null;

  const {
    title: citationTitle,
    journal: citationJournal,
    firstAuthorSurname: citationFirstAuthor
  } = extractCitationFields(referenceLine);
  if (!citationTitle) {
    return {
      pmid: candidatePmids[0],
      score: 1,
      titleJaccard: null,
      journalAligned: false,
      authorAligned: false
    };
  }

  const summaries = await fetchSummaries(candidatePmids);
  const result = summaries && summaries.result ? summaries.result : null;
  if (!result) {
    return {
      pmid: candidatePmids[0],
      score: 0,
      titleJaccard: null,
      journalAligned: false,
      authorAligned: false
    };
  }

  let best = { pmid: null, score: -1 };
  for (const pmid of candidatePmids) {
    const rec = result[pmid];
    const score = combinedRankingScore(
      citationTitle,
      citationJournal,
      citationFirstAuthor,
      rec
    );
    if (score > best.score) best = { pmid, score };
  }

  if (best.pmid == null) return null;

  const chosen = result[best.pmid];
  const pubmedTitle = chosen && chosen.title ? chosen.title : "";
  const titleJaccard = jaccard(citationTitle, pubmedTitle);
  const source = getPubmedSource(chosen);
  const authStr = getPubmedFirstAuthorName(chosen);
  const journalAligned = !!(citationJournal && journalMatches(citationJournal, source));
  const authorAligned = !!(citationFirstAuthor && firstAuthorSurnameMatches(citationFirstAuthor, authStr));

  return {
    pmid: best.pmid,
    score: best.score,
    titleJaccard,
    journalAligned,
    authorAligned
  };
}

/**
 * 1) Raw full-line search, then parsed title+year if no confident match.
 * 2) Confident match = ranking ≥ gate AND (journal match OR first-author match OR very strong title Jaccard).
 * 3) Best-effort below gate only if corroboration passes; otherwise no PMID.
 */
async function resolvePmid(referenceLine) {
  const rawTerm = buildRawSearchTerm(referenceLine);
  const rawCandidates = await searchPubMedByTerm(rawTerm);
  const bestRaw = await scoreBestMatch(referenceLine, rawCandidates);

  if (isAcceptableConfidentMatch(bestRaw)) {
    console.log(
      `  Match: raw-line search · ranking ${bestRaw.score.toFixed(3)}` +
        (bestRaw.titleJaccard != null ? ` · title Jaccard ${bestRaw.titleJaccard.toFixed(3)}` : "") +
        ` · journal ${bestRaw.journalAligned ? "yes" : "no"} · 1st author ${bestRaw.authorAligned ? "yes" : "no"}`
    );
    return {
      pmid: bestRaw.pmid,
      jaccardWarning: null,
      strategy: "raw-line",
      rankingScore: bestRaw.score,
      titleJaccard: bestRaw.titleJaccard,
      journalAligned: bestRaw.journalAligned,
      authorAligned: bestRaw.authorAligned
    };
  }

  if (bestRaw && bestRaw.score >= JACCARD_GATE && !passesCorroborationRule(bestRaw)) {
    console.log(
      `  Raw-line ranking ≥ ${JACCARD_GATE} but fails corroboration (need journal match, first-author match, or title Jaccard ≥ ${TITLE_JACCARD_STRONG}); trying parsed-title search...`
    );
  } else if (rawCandidates.length && bestRaw && bestRaw.score < JACCARD_GATE) {
    console.log(
      `  Raw-line search below ranking gate (${bestRaw.score.toFixed(3)} < ${JACCARD_GATE}); trying parsed-title search...`
    );
  }

  const { ids: parsedCandidates, label: parsedQueryLabel } = await searchParsedWithFallbacks(
    referenceLine
  );
  const bestParsed = await scoreBestMatch(referenceLine, parsedCandidates);

  if (isAcceptableConfidentMatch(bestParsed)) {
    console.log(
      `  Match: ${parsedQueryLabel} · ranking ${bestParsed.score.toFixed(3)}` +
        (bestParsed.titleJaccard != null ? ` · title Jaccard ${bestParsed.titleJaccard.toFixed(3)}` : "") +
        ` · journal ${bestParsed.journalAligned ? "yes" : "no"} · 1st author ${bestParsed.authorAligned ? "yes" : "no"}`
    );
    return {
      pmid: bestParsed.pmid,
      jaccardWarning: null,
      strategy: parsedQueryLabel,
      rankingScore: bestParsed.score,
      titleJaccard: bestParsed.titleJaccard,
      journalAligned: bestParsed.journalAligned,
      authorAligned: bestParsed.authorAligned
    };
  }

  if (bestParsed && bestParsed.score >= JACCARD_GATE && !passesCorroborationRule(bestParsed)) {
    console.log(
      `  Parsed-title ranking ≥ ${JACCARD_GATE} but fails corroboration (need journal, first author, or title Jaccard ≥ ${TITLE_JACCARD_STRONG}).`
    );
  }

  let overall = null;
  if (bestRaw && bestParsed) {
    overall = bestRaw.score >= bestParsed.score ? bestRaw : bestParsed;
  } else {
    overall = bestRaw || bestParsed;
  }

  if (overall && overall.pmid != null && passesCorroborationRule(overall) && overall.score < JACCARD_GATE) {
    const tj =
      overall.titleJaccard != null
        ? ` Title Jaccard (citation vs PubMed title): ${overall.titleJaccard.toFixed(3)}.`
        : "";
    const msg = `Weak automatic match.${tj} Ranking score ${overall.score.toFixed(3)} (below confident gate ${JACCARD_GATE}, but journal/author/title corroboration passed). PMID ${overall.pmid}—please verify in PubMed.`;
    console.warn(`  ${msg}`);
    return {
      pmid: overall.pmid,
      jaccardWarning: msg,
      strategy: "best-effort-below-gate",
      rankingScore: overall.score,
      titleJaccard: overall.titleJaccard,
      journalAligned: overall.journalAligned,
      authorAligned: overall.authorAligned
    };
  }

  if (overall && overall.pmid != null && !passesCorroborationRule(overall)) {
    console.log(
      "  No PubMed match: best hit failed corroboration (no journal match, no first-author match, and title Jaccard below strong threshold)."
    );
  }

  return {
    pmid: null,
    jaccardWarning: null,
    strategy: "none",
    rankingScore: null,
    titleJaccard: null,
    journalAligned: false,
    authorAligned: false
  };
}

async function fetchAbstractText(pmid) {
  const base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
  const params = {
    db: "pubmed",
    id: pmid,
    rettype: "abstract",
    retmode: "text",
    tool: NCBI_TOOL_NAME,
    email: ncbiContactEmail()
  };
  if (ncbiApiKey()) {
    params.api_key = ncbiApiKey();
  }

  const url = makeEutilsUrl(base, params);
  const res = await fetchWithRetry(url, "PubMed efetch");
  const text = await res.text();
  return text.trim();
}

function formatMatchMetricsHtml(block) {
  if (block.status !== "found") return "";
  const parts = [];
  if (block.titleJaccard != null && Number.isFinite(block.titleJaccard)) {
    parts.push(`Title Jaccard (parsed citation title vs PubMed title): ${block.titleJaccard.toFixed(3)}`);
  }
  if (block.rankingScore != null && Number.isFinite(block.rankingScore)) {
    parts.push(
      `Ranking score (Jaccard + journal / first-author boosts, max 1): ${block.rankingScore.toFixed(3)}`
    );
  }
  parts.push(
    `Journal aligned (citation journal vs PubMed source): ${block.journalAligned ? "yes" : "no"}`
  );
  parts.push(
    `First author aligned (citation vs PubMed first author): ${block.authorAligned ? "yes" : "no"}`
  );
  parts.push(
    `Confident match: ranking ≥ ${JACCARD_GATE} and (journal yes OR first author yes OR title Jaccard ≥ ${TITLE_JACCARD_STRONG})`
  );
  if (!parts.length) return "";
  const inner = parts.map(t => `<p>${escapeHtml(t)}</p>`).join("\n");
  return `<div class="match-metrics">\n${inner}\n</div>`;
}

function renderBlocksToInnerHtml(blocks) {
  return blocks
    .map(block => {
      const escapedOriginal = escapeHtml(block.original);
      const escapedAbstract = escapeHtml(block.abstract || "");
      let abstractPart = "";
      if (block.status === "found") {
        const metrics = formatMatchMetricsHtml(block);
        const warn =
          block.jaccardWarning
            ? `<div class="jaccard-warning">${escapeHtml(block.jaccardWarning)}</div>`
            : "";
        abstractPart =
          metrics +
          warn +
          `<div class="reference-abstract">${escapedAbstract.replace(/\n/g, "<br>")}</div>`;
      } else if (block.status === "not-found") {
        abstractPart = `<div class="reference-abstract not-found">Not found in PubMed.</div>`;
      } else if (block.status === "error") {
        abstractPart = `<div class="reference-abstract not-found">Error while querying PubMed.</div>`;
      }
      return [
        `<div class="reference-block">`,
        `<p class="reference-original">${escapedOriginal}</p>`,
        abstractPart,
        `</div>`
      ].join("\n");
    })
    .join("\n\n");
}

function wrapFullHtml(bodyInnerHtml) {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="UTF-8">',
    "  <title>PubMed Abstract Listing</title>",
    "  <style>",
    "    body { font-family: Arial, sans-serif; margin: 2rem; max-width: 900px; }",
    "    .reference-block { margin-bottom: 1.5rem; line-height: 1.4; }",
    "    .reference-original { font-weight: 600; }",
    "    .reference-abstract { margin-top: 0.75rem; white-space: pre-wrap; }",
    "    .not-found { font-style: italic; color: #a00; }",
    "    .jaccard-warning { margin-top: 0.35rem; margin-bottom: 0.35rem; padding: 0.5rem 0.65rem; background: #fff8e6; border: 1px solid #e6c200; border-radius: 4px; font-size: 0.92rem; color: #553800; }",
    "    .match-metrics { margin-top: 0.25rem; margin-bottom: 1rem; font-size: 0.88rem; color: #333; line-height: 1.45; }",
    "    .match-metrics p { margin: 0 0 0.45rem 0; }",
    "    .match-metrics p:last-child { margin-bottom: 0; }",
    "  </style>",
    "</head>",
    "<body>",
    "<h2>Continuous Abstract Listing</h2>",
    bodyInnerHtml,
    "</body>",
    "</html>"
  ].join("\n");
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function buildAbstractsHtmlFromLines(lines, options = {}) {
  const { logProgress = false } = options;
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const refLine = lines[i];
    if (logProgress) {
      console.log(`Processing ${i + 1} / ${lines.length} ...`);
    }
    try {
      const {
        pmid,
        jaccardWarning,
        strategy,
        rankingScore,
        titleJaccard,
        journalAligned,
        authorAligned
      } = await resolvePmid(refLine);
      if (logProgress) {
        const metricsLog =
          titleJaccard != null && Number.isFinite(titleJaccard)
            ? ` title Jaccard ${titleJaccard.toFixed(3)}`
            : "";
        console.log(
          `  Resolution strategy: ${strategy}` +
            (rankingScore != null ? ` · ranking ${rankingScore.toFixed(3)}` : "") +
            metricsLog +
            ` · journal ${journalAligned ? "yes" : "no"} · 1st author ${authorAligned ? "yes" : "no"}`
        );
      }
      if (!pmid) {
        if (logProgress) console.log("  No PubMed match found.");
        blocks.push({
          original: refLine,
          status: "not-found",
          abstract: ""
        });
      } else {
        if (logProgress) console.log(`  Using PMID: ${pmid}`);
        const absText = await fetchAbstractText(pmid);
        if (absText) {
          blocks.push({
            original: refLine,
            status: "found",
            abstract: absText,
            jaccardWarning: jaccardWarning || undefined,
            rankingScore,
            titleJaccard: titleJaccard != null ? titleJaccard : undefined,
            journalAligned,
            authorAligned
          });
        } else {
          if (logProgress) console.log("  No abstract text returned.");
          blocks.push({
            original: refLine,
            status: "not-found",
            abstract: ""
          });
        }
      }
    } catch (err) {
      if (logProgress) {
        console.error(
          "  Error while querying PubMed:",
          err.message,
          err.cause ? `(${err.cause.message || err.cause})` : ""
        );
      }
      blocks.push({
        original: refLine,
        status: "error",
        abstract: ""
      });
    }
  }

  const innerHtml = renderBlocksToInnerHtml(blocks);
  const fullHtml = wrapFullHtml(innerHtml);
  return { fullHtml, innerHtml, lineCount: lines.length };
}

/** Build listing HTML from raw pasted text (one reference per non-empty line). */
async function buildAbstractsHtml(rawText, options = {}) {
  const lines = parseReferenceLines(rawText);
  if (!lines.length) {
    const innerHtml = `<p class="not-found">No non-empty reference lines in input.</p>`;
    return {
      fullHtml: wrapFullHtml(innerHtml),
      innerHtml,
      lineCount: 0
    };
  }
  return buildAbstractsHtmlFromLines(lines, options);
}

async function main() {
  const { inputPath, outputPath } = parseArgs();
  const absInputPath = path.resolve(process.cwd(), inputPath);
  const absOutputPath = path.resolve(process.cwd(), outputPath);

  console.log(`Reading references from: ${absInputPath}`);
  const raw = await fs.readFile(absInputPath, "utf8");
  const lines = parseReferenceLines(raw);
  if (!lines.length) {
    console.error("No non-empty reference lines found in input file.");
    process.exit(1);
  }
  console.log(`Found ${lines.length} reference line(s).`);

  const { fullHtml } = await buildAbstractsHtmlFromLines(lines, { logProgress: true });
  await fs.writeFile(absOutputPath, fullHtml, "utf8");
  console.log(`Wrote output HTML to: ${absOutputPath}`);
}

// Node 18+ has global fetch; if not available, fail with a clear message.
if (typeof fetch !== "function") {
  console.error("Global fetch is not available. Please run this script with Node.js v18+ or install a fetch polyfill.");
  if (require.main === module) {
    process.exit(1);
  }
} else if (require.main === module) {
  main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = {
  buildAbstractsHtml,
  buildAbstractsHtmlFromLines,
  parseReferenceLines,
  wrapFullHtml
};
