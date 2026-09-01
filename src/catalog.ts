/**
 * Catalog resolution: turn a human phrase in any supported language into the
 * canonical Bring! item id.
 *
 * Bring stores an item by its canonical id and each client renders that id in
 * the list's article language. The ids are German (`Äpfel`, `Kartoffeln`) and
 * are identical in every locale's catalog - only the display `name` differs.
 * So storing `Äpfel` shows "Maçãs" to a Portuguese client, "Apples" to an
 * English one, and carries the correct icon and aisle for free.
 *
 * That makes resolution the highest-value operation in this server: an item
 * saved as free text ("Apples / Maçãs") is stuck without an icon forever,
 * whereas the same item saved as `Äpfel` is correct in every language.
 */

export type CatalogEntry = {
  /** Canonical, language-independent id. Also the value `userIconItemId` takes. */
  itemId: string;
  /** Canonical section id. Also the value `userSectionId` takes. */
  sectionId: string;
  /** locale -> display name */
  names: Record<string, string>;
};

export type CatalogSection = {
  sectionId: string;
  names: Record<string, string>;
};

export type Catalog = {
  entries: Map<string, CatalogEntry>;
  sections: Map<string, CatalogSection>;
  locales: string[];
};

export type Match = {
  itemId: string;
  sectionId: string;
  names: Record<string, string>;
  score: number;
  matchedOn: string;
  /** True when the score came from the plural-suffix upgrade (weakest 65 tier). */
  viaInflection?: boolean;
  /**
   * True when this is a spelling-nearest suggestion returned because nothing
   * scored at all. Always accompanied by `score: 0` and NEVER attachable.
   */
  nearest?: boolean;
};

/**
 * Locales indexed when the user has not said otherwise.
 *
 * `de-DE` is structural, not a preference: Bring's canonical item ids ARE the
 * German names (`Äpfel`, `Kartoffeln`), so indexing German is what lets an exact
 * id match work at all. `en-US` is the pragmatic second.
 *
 * Everything else is the user's business - see `catalogLocales()`.
 */
export const DEFAULT_CATALOG_LOCALES = ['de-DE', 'en-US'];

/**
 * The locales this server indexes, from `BRING_MCP_CATALOG_LOCALES` (a
 * comma-separated list) or the default above.
 *
 * Resolution can only ever match a language it has indexed, so a household that
 * shops in Portuguese and English wants `de-DE,pt-BR,en-US` here; one shopping
 * in French wants `de-DE,fr-FR`. Getting this wrong is not an error, it is
 * simply a matcher that never recognises your words.
 *
 * `de-DE` is always included even if omitted, because the canonical ids are
 * German and dropping it would silently weaken every exact match. Unsupported
 * locales throw rather than being skipped, so a typo is loud.
 */
export function catalogLocales(): string[] {
  const raw = process.env.BRING_MCP_CATALOG_LOCALES;
  if (!raw?.trim()) return DEFAULT_CATALOG_LOCALES;
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const locale of wanted) assertSupportedLocale(locale);
  return wanted.includes('de-DE') ? wanted : ['de-DE', ...wanted];
}

/**
 * The language item details are rendered in when the caller does not say.
 *
 * The raw records store German canonical ids, so a bare dump is unreadable to
 * anyone not shopping in German. Defaults to the first configured locale that
 * is not the canonical German one - i.e. "the language this household actually
 * reads" - and falls back to en-US.
 */
export function describeLocale(): string {
  return process.env.BRING_MCP_DESCRIBE_LOCALE?.trim() || catalogLocales().find((l) => l !== 'de-DE') || 'en-US';
}

/**
 * Bring serves one catalog file per locale and 404s (with an HTML page) for
 * anything else. Notably there is no pt-PT - only pt-BR.
 */
export const SUPPORTED_LOCALES = [
  'de-DE',
  'de-CH',
  'en-US',
  'en-GB',
  'fr-FR',
  'it-IT',
  'es-ES',
  'pt-BR',
  'nl-NL',
  'sv-SE',
  'nb-NO',
  'da-DK',
  'fi-FI',
  'pl-PL',
  'hu-HU',
  'tr-TR',
  'ru-RU',
];

export function assertSupportedLocale(locale: string): void {
  if (SUPPORTED_LOCALES.includes(locale)) return;
  const near = SUPPORTED_LOCALES.filter((l) => l.slice(0, 2) === locale.slice(0, 2));
  const hint = near.length ? ` Did you mean ${near.join(' or ')}?` : '';
  throw new Error(
    `Bring! has no catalog for locale "${locale}".${hint} ` + `Supported: ${SUPPORTED_LOCALES.join(', ')}.`,
  );
}

/**
 * Letters that NFD cannot decompose into "base + combining mark", so the
 * `[^a-z0-9]` sweep below would delete them outright rather than fold them.
 *
 * That silently turned real words into non-matches: "Straße" became "stra e",
 * so it could never match "Strasse", and "Łosoś" became "osos". Bring's own
 * catalog happens to use Swiss spelling ("Süssigkeiten", "Weisswein"), but a
 * user typing the German or Polish form is exactly the fuzzy path's job.
 */
const LETTER_FOLDINGS: [RegExp, string][] = [
  [/ß/g, 'ss'],
  [/ł/g, 'l'],
  [/ı/g, 'i'],
  [/ø/g, 'o'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/đ/g, 'd'],
  [/ð/g, 'd'],
  [/þ/g, 'th'],
  [/ħ/g, 'h'],
  [/ŋ/g, 'ng'],
  [/ĸ/g, 'k'],
  [/ŧ/g, 't'],
];

/**
 * European Portuguese -> Brazilian Portuguese term aliases.
 *
 * Bring publishes a `pt-BR` catalog and NO `pt-PT`, so a shopper in Portugal
 * types words the catalog has never heard of. This is not a preference, it is a
 * gap in the source data: `sumo` (juice) simply does not appear anywhere in
 * Bring's index, while `suco` resolves fine.
 *
 * Every entry below was MEASURED against the live catalog, not guessed. Each one
 * either fails outright as pt-PT and succeeds as pt-BR, or - in the case of
 * `gelado` - resolves to the WRONG product: it matched `Eistee` (iced TEA) at 65
 * before, and `sorvete` gives `Glacé` at 100. Terms that already work in pt-PT
 * (ananás, queijo, manteiga, iogurte, papel higiénico) are deliberately absent,
 * and so is anything where the pt-PT form scored HIGHER (bolacha -> Kräcker 65
 * beats biscoito -> Kekse 55).
 *
 * Applied as an ADDITIONAL query form, never a replacement: the original wording
 * is still scored, and the better of the two wins. So adding an alias can only
 * improve a result, never take one away.
 */
const PT_PT_ALIASES: Record<string, string> = {
  sumo: 'suco',
  gelado: 'sorvete',
  fiambre: 'presunto',
  brocolos: 'brocolis',
  courgette: 'abobrinha',
  beringela: 'berinjela',
};

/**
 * Rewrite known pt-PT words in an already-normalized query. Returns the input
 * unchanged when nothing matches, so callers can cheaply skip the second pass.
 */
export function applyLocaleAliases(normalizedQuery: string): string {
  const words = normalizedQuery.split(' ');
  let changed = false;
  const out = words.map((w) => {
    const alias = PT_PT_ALIASES[w];
    if (alias) changed = true;
    return alias ?? w;
  });
  return changed ? out.join(' ') : normalizedQuery;
}

/** Lowercase, fold accents and punctuation, collapse whitespace. */
export function normalize(value: string): string {
  let folded = value.toLowerCase();
  for (const [pattern, replacement] of LETTER_FOLDINGS) {
    folded = folded.replace(pattern, replacement);
  }
  return (
    folded
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      // Unicode-aware: `[^a-z0-9]` deleted every non-Latin script outright, so a
      // ru-RU catalog (a SUPPORTED_LOCALE that assertSupportedLocale accepts)
      // normalized every entry to the empty string and matched NOTHING, silently.
      // Latin behaviour is unchanged - NFD above has already folded accents.
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
  );
}

/**
 * Shortest string allowed to drive a partial match. Below this, fragments like
 * "ol" collide with half the catalog.
 */
const MIN_PARTIAL_LENGTH = 4;

/**
 * Score for the weakest match type - "what you typed merely begins with a
 * catalog word". Kept below the caller's ICON_MATCH_SCORE (50) so it can be
 * shown as a hint but is never enough, on its own, to attach an icon.
 */
const WEAK_PREFIX_SCORE = 40;

/**
 * Same tokens, different order. Deliberately BELOW the caller's
 * EXACT_MATCH_SCORE (90) and above its ICON_MATCH_SCORE (50): a reordering may
 * carry an icon, but it must never replace the user's text with another
 * product's canonical id. See the comment at the permutation tier below.
 */
export const PERMUTATION_SCORE = 85;

/**
 * The whole-token rule below fires when a catalog word appears as a contiguous
 * run inside a LONGER query. That is right for a modifier phrase ("bananen bio"
 * is still bananas) and wrong for a phrase whose meaning lives in the other
 * words. The matched name must therefore account for at least half of what the
 * user typed.
 *
 * Half is a measured cut rather than a guess: it was chosen by replaying a real
 * list of ~220 stored icon choices and picking the threshold that blocked every
 * absurd match while losing nothing legitimate.
 *
 * The shape it blocks is a phrase whose meaning lives in words the match does
 * not cover: "eistee ohne zucker" (iced tea WITHOUT sugar) taking the SUGAR icon
 * off one token, or "nudelsuppe mit reis" taking RICE over noodle soup. The
 * negation case is the clearest - the matched token is the one thing the item is
 * defined by NOT containing.
 *
 * It keeps two-word modifier phrases, which sit exactly at 0.5 ("bananen bio" is
 * still bananas), and keeps a long qualified name like
 * "Escova de dentes Colgate Maquina" -> Zahnbürsten, which covers 3 of 5.
 * Raising it to 0.6 blocks more but also kills the modifier phrases and correct
 * matches like "kaffee kapseln" -> Kaffee.
 */
const WHOLE_TOKEN_COVERAGE_FLOOR = 0.5;

/**
 * Endings that turn a catalog word into its own plural/inflection rather than
 * a different word: orangen = orange+n, laranjas = laranja+s, äpfeln = äpfel+n.
 * "e" is deliberately absent (Kohle is not a Kohl; Reise is not a Reis), as is
 * everything longer that could start a compound.
 */
const INFLECTION_SUFFIXES = new Set(['n', 'en', 's', 'ns']);

const tokens = (value: string): string[] => (value ? value.split(' ') : []);

/**
 * Genitive particles, dropped when comparing a query to a candidate as one
 * word. Deliberately excludes "com" and "sem" - those change the meaning, and
 * dropping "sem" would let "sumo sem açúcar" match sugar.
 */
const PARTICLES = new Set(['de', 'da', 'do', 'dos', 'das', 'of']);

/** Normalized text with spaces and genitive particles removed. */
function compact(value: string): string {
  return value
    .split(' ')
    .filter((w) => w && !PARTICLES.has(w))
    .join('');
}

/** True when `needle`'s tokens appear as a contiguous run inside `haystack`'s. */
function containsRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (needle.every((tok, j) => haystack[i + j] === tok)) return true;
  }
  return false;
}

/**
 * Deliberately conservative.
 *
 * An earlier substring-based version matched "Escova De Dentes Colgate Maquina"
 * to `Öl` (oil) because "ol" occurs inside "Colgate". Partial matches are
 * therefore whole-token only and subject to a minimum length, and anything that
 * does not clear the bar returns no match rather than a plausible wrong one -
 * a wrong icon is worse than no icon, because nobody goes looking for it.
 */
function scoreCandidate(query: string, candidate: string): { score: number; viaInflection?: boolean } | null {
  if (!query || !candidate) return null;
  if (query === candidate) return { score: 100 };

  // A compound written with a space IS that compound: "apfel strudel" is
  // Apfelstrudel. Without this the query matched the base word Äpfel at 70 via
  // the whole-token run rule while the REAL product scored 0 and never appeared
  // in results at all - a confidently wrong icon plus a total miss of the item
  // the user asked for. German catalog ids store compounds as a single token
  // ("Weisswein", "Erdnussbutter"), so every spaced compound hit this.
  //
  // Genitive particles are ignored on BOTH sides for the same reason: people
  // drop them. "sumo maçã" is how a real list entry is written, and it could
  // never reach "Suco de maçã" while that "de" had to be present. Only the
  // semantically empty connectors are stripped - de/da/do/dos/das/of. NOT
  // "com"/"sem", because those carry meaning and dropping "sem" would turn
  // "sumo sem açúcar" (sugar-FREE juice) into a match for sugar.
  if (compact(query) && compact(query) === compact(candidate)) return { score: 100 };

  const q = tokens(query);
  const c = tokens(candidate);

  // Reaching here means the strings are NOT identical (that returned 100), so
  // this tier is always a genuine reordering - and word order carries meaning:
  // "arroz de leite" (colloquial rice pudding) is a permutation of "Leite de
  // arroz", which is rice MILK. At 90 that cleared EXACT_MATCH_SCORE and
  // REPLACED the user's text with the other product's canonical id. A wrong
  // name is worse than a wrong icon, so this now scores below the replace bar
  // while staying well above the icon bar. Found by DeepSeek Pro.
  if (q.length === c.length && [...q].sort().join(' ') === [...c].sort().join(' ')) {
    return { score: PERMUTATION_SCORE };
  }
  // Whole-token containment: reliable in both directions.
  if (
    candidate.length >= MIN_PARTIAL_LENGTH &&
    containsRun(q, c) &&
    c.length / q.length >= WHOLE_TOKEN_COVERAGE_FLOOR
  ) {
    return { score: 70 };
  }
  if (query.length >= MIN_PARTIAL_LENGTH && containsRun(c, q)) return { score: 65 };

  // The two string-prefix rules are NOT equally trustworthy, so they no longer
  // share a threshold or a score:
  //
  //  - "the catalog word starts with what you typed" ("zahn" -> Zahnbürsten) is
  //    a real prefix of a real word. Score 55, above the auto-attach bar.
  //  - "what you typed starts with a catalog word" ("reismehl" -> Reis) is
  //    usually coincidental - compounds routinely begin with a shorter,
  //    unrelated word. This used to score 50, exactly the auto-attach bar, so
  //    lowering the length to 4 started silently attaching Reis/Wild/Kohl/Wein
  //    icons to reismehl/wildreis/kohlrabi/weinessig. It now scores below the
  //    bar: still surfaced by findCatalogItem as a weak hint, never applied by
  //    itself. (Legitimate long prefixes like "Bananen bio" already match via
  //    whole-token containment above, so nothing useful is lost.)
  if (query.length >= MIN_PARTIAL_LENGTH && candidate.startsWith(query)) return { score: 55 };
  if (candidate.length >= MIN_PARTIAL_LENGTH && query.startsWith(candidate)) {
    // "your query starts with a catalog word" is only trustworthy when the
    // remainder is a plural/inflection suffix - then the query IS that word
    // ("orangen" = orange+n, "laranjas" = laranja+s) and must outrank a
    // different compound that merely begins with the query ("orangensaft" at
    // 55), or the fruit loses to the juice.
    //
    // A pure length ratio cannot make this call: "kohle" (charcoal) is
    // Kohl+81%, but it is a DIFFERENT word from Kohl (cabbage), and "kohlr"
    // truncates Kohlrabi yet upgraded Kohl past the real compound. Both real
    // false positives, both cold-review finds. The suffix list is deliberately
    // tiny - only endings that are inflections and essentially never form a
    // new word ("-e" is excluded exactly because Kohle/Reise exist).
    //
    // Even a genuine suffix is not proof: "apfels"/"orangens" are TRUNCATIONS
    // of Apfelsaft/Orangensaft that happen to land on 's', and were upgraded
    // past the real compound. Marked viaInflection so the resolver's caller can
    // refuse when a longer compound also matches - mechanically, "orangen"
    // (real plural) and "orangens" (truncation) are indistinguishable without a
    // lexicon, so both are refused when a compound competes; that trade-off is
    // deliberate ("a wrong icon is worse than no icon").
    const remainder = query.slice(candidate.length);
    if (INFLECTION_SUFFIXES.has(remainder)) return { score: 65, viaInflection: true };
    return { score: WEAK_PREFIX_SCORE };
  }

  return null;
}

export function buildCatalog(
  raw: { locale: string; sections: { sectionId: string; name: string; items: { itemId: string; name: string }[] }[] }[],
): Catalog {
  const entries = new Map<string, CatalogEntry>();
  const sections = new Map<string, CatalogSection>();

  for (const { locale, sections: rawSections } of raw) {
    for (const section of rawSections) {
      let sec = sections.get(section.sectionId);
      if (!sec) {
        sec = { sectionId: section.sectionId, names: {} };
        sections.set(section.sectionId, sec);
      }
      sec.names[locale] = section.name;

      for (const item of section.items) {
        let entry = entries.get(item.itemId);
        if (!entry) {
          entry = { itemId: item.itemId, sectionId: section.sectionId, names: {} };
          entries.set(item.itemId, entry);
        }
        entry.names[locale] = item.name;
      }
    }
  }

  const locales = raw.map((r) => r.locale);
  return { entries, sections, locales };
}

/** Ranked matches, best first. Empty when nothing clears the confidence bar. */
export function resolveItem(catalog: Catalog, query: string, limit = 5): Match[] {
  const normalizedQuery = normalize(query);
  // A pt-PT query is scored BOTH as typed and with its pt-BR aliases applied,
  // and the better score wins - so an alias can only ever help. The second form
  // is skipped entirely when no alias fired, which is the overwhelming majority.
  const aliased = applyLocaleAliases(normalizedQuery);
  const queryForms = aliased === normalizedQuery ? [normalizedQuery] : [normalizedQuery, aliased];
  const results: Match[] = [];

  for (const entry of catalog.entries.values()) {
    let best: { score: number; matchedOn: string; viaInflection?: boolean } | null = null;

    const candidates: [string, string][] = [['itemId', entry.itemId]];
    for (const [locale, name] of Object.entries(entry.names)) {
      candidates.push([locale, name]);
    }

    for (const [label, text] of candidates) {
      const normalizedText = normalize(text);
      for (const form of queryForms) {
        const scored = scoreCandidate(form, normalizedText);
        if (scored && (!best || scored.score > best.score)) {
          best = { score: scored.score, matchedOn: `${label}:${text}`, viaInflection: scored.viaInflection };
        }
      }
    }

    if (best) {
      results.push({
        itemId: entry.itemId,
        sectionId: entry.sectionId,
        names: entry.names,
        score: best.score,
        matchedOn: best.matchedOn,
        viaInflection: best.viaInflection,
      });
    }
  }

  results.sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId));
  return results.slice(0, limit);
}

/**
 * Nearest catalog entries by raw spelling, for when scoring finds NOTHING.
 *
 * An empty result gives an agent no signal at all, so it guesses another
 * spelling, gets nothing again, and loops. Observed on this box: a garbled
 * voice transcription produced 20 findCatalogItem calls in one session, five of
 * them returning `[]`, with the model burning ~16s of reasoning between bursts
 * while the server answered every call in 20ms. The searching was never slow;
 * the agent was flying blind.
 *
 * These are ranked by trigram overlap, carry `score: 0` and `nearest: true`,
 * and exist ONLY to let a caller say "closest things are X, Y, Z - none of them
 * confident" and then ask a human. They are deliberately NOT wired into
 * `resolveItem`, so `toCanonicalItemId` and every write path cannot see them:
 * a score of 0 could never clear a confidence bar anyway, but keeping them out
 * of the shared path means that is structurally true rather than merely true
 * today.
 */
export function nearestItems(catalog: Catalog, query: string, limit = 3): Match[] {
  const q = trigrams(normalize(query));
  if (q.size === 0) return [];
  const scored: { entry: CatalogEntry; sim: number; matchedOn: string }[] = [];
  for (const entry of catalog.entries.values()) {
    let best = 0;
    let bestOn = entry.itemId;
    for (const [label, text] of [['itemId', entry.itemId] as const, ...Object.entries(entry.names)]) {
      const sim = jaccard(q, trigrams(normalize(text)));
      if (sim > best) {
        best = sim;
        bestOn = `${label}:${text}`;
      }
    }
    // Below this the "nearest" entries are noise and would mislead rather than help.
    if (best >= 0.2) scored.push({ entry, sim: best, matchedOn: bestOn });
  }
  scored.sort((a, b) => b.sim - a.sim || a.entry.itemId.localeCompare(b.entry.itemId));
  return scored.slice(0, limit).map(({ entry, matchedOn }) => ({
    itemId: entry.itemId,
    sectionId: entry.sectionId,
    names: entry.names,
    score: 0,
    matchedOn,
    nearest: true,
  }));
}

function trigrams(value: string): Set<string> {
  const padded = ` ${value.replace(/ /g, '')} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return shared / (a.size + b.size - shared);
}

export type SectionMatch = CatalogSection & { score: number };

/**
 * Ranked section matches, best first, each carrying its score - so a caller
 * can apply the same confidence floor and tie check the item path uses. It
 * previously returned bare sections with the scores discarded, which is how
 * setItemSection came to apply a coincidental score-40 match blindly.
 */
export function resolveSection(catalog: Catalog, query: string, limit = 5): SectionMatch[] {
  const normalizedQuery = normalize(query);
  const scored: SectionMatch[] = [];

  for (const section of catalog.sections.values()) {
    let best = 0;
    for (const text of [section.sectionId, ...Object.values(section.names)]) {
      const result = scoreCandidate(normalizedQuery, normalize(text));
      if (result && result.score > best) best = result.score;
    }
    if (best) scored.push({ ...section, score: best });
  }

  scored.sort((a, b) => b.score - a.score || a.sectionId.localeCompare(b.sectionId));
  return scored.slice(0, limit);
}
