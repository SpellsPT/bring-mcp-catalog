import {
  assertSupportedLocale,
  buildCatalog,
  normalize,
  resolveItem,
  resolveSection,
  type Catalog,
} from '../src/catalog';

/**
 * A trimmed stand-in for Bring's real catalog. Item ids are the canonical
 * German keys and are identical across locales; only `name` is translated.
 */
function fixture(): Catalog {
  const perLocale = (locale: 0 | 1 | 2) => [
    {
      sectionId: 'Früchte & Gemüse',
      name: ['Obst & Gemüse', 'Frutas & Verduras', 'Fruits & Vegetables'][locale],
      items: [
        { itemId: 'Äpfel', name: ['Äpfel', 'Maçãs', 'Apples'][locale] },
        { itemId: 'Birnen', name: ['Birnen', 'Peras', 'Pears'][locale] },
        { itemId: 'Zwiebeln', name: ['Zwiebeln', 'Cebolas', 'Onions'][locale] },
      ],
    },
    {
      sectionId: 'Zutaten & Gewürze',
      name: ['Zutaten & Gewürze', 'Ingredientes & Temperos', 'Ingredients & Spices'][locale],
      items: [{ itemId: 'Öl', name: ['Öl', 'Óleo', 'Oil'][locale] }],
    },
    {
      sectionId: 'Pflege & Gesundheit',
      name: ['Pflege & Gesundheit', 'Cuidado & Saúde', 'Care & Health'][locale],
      items: [{ itemId: 'Zahnbürsten', name: ['Zahnbürsten', 'Escova de dentes', 'Toothbrush'][locale] }],
    },
  ];

  return buildCatalog([
    { locale: 'de-DE', sections: perLocale(0) },
    { locale: 'pt-BR', sections: perLocale(1) },
    { locale: 'en-US', sections: perLocale(2) },
  ]);
}

describe('normalize', () => {
  it('strips accents, case and punctuation', () => {
    expect(normalize('Maçãs')).toBe('macas');
    expect(normalize('Äpfel')).toBe('apfel');
    expect(normalize('Früchte & Gemüse')).toBe('fruchte gemuse');
    expect(normalize('  WC-Papier ')).toBe('wc papier');
  });

  /**
   * These letters do not decompose under NFD, so the punctuation sweep used to
   * delete them: "Straße" became "stra e" and could never match "Strasse".
   */
  it('folds letters that NFD cannot decompose', () => {
    expect(normalize('Straße')).toBe('strasse');
    expect(normalize('Süßigkeiten')).toBe('sussigkeiten');
    expect(normalize('Łosoś')).toBe('losos');
    expect(normalize('ıspanak')).toBe('ispanak');
    expect(normalize('Smørrebrød')).toBe('smorrebrod');
    // Second-pass additions: eth, and the Maltese/Sami letters.
    expect(normalize('faðir')).toBe('fadir');
    expect(normalize('maħlul')).toBe('mahlul');
    expect(normalize('beŋ')).toBe('beng');
  });

  it('matches the ß and ss spellings of the same word to each other', () => {
    expect(normalize('Süßigkeiten')).toBe(normalize('Süssigkeiten'));
  });
});

describe('buildCatalog', () => {
  it('merges locales onto one canonical entry per itemId', () => {
    const catalog = fixture();
    const apples = catalog.entries.get('Äpfel');
    expect(apples).toBeDefined();
    expect(apples?.sectionId).toBe('Früchte & Gemüse');
    expect(apples?.names).toEqual({ 'de-DE': 'Äpfel', 'pt-BR': 'Maçãs', 'en-US': 'Apples' });
  });

  it('merges section display names the same way', () => {
    const catalog = fixture();
    expect(catalog.sections.get('Früchte & Gemüse')?.names['pt-BR']).toBe('Frutas & Verduras');
  });
});

describe('resolveItem', () => {
  it('matches a display name in any indexed language back to the canonical id', () => {
    const catalog = fixture();
    for (const query of ['maçãs', 'Maçãs', 'apples', 'Äpfel', 'apfel']) {
      expect(resolveItem(catalog, query, 1)[0]?.itemId).toBe('Äpfel');
    }
  });

  it('scores an exact match at 100', () => {
    const catalog = fixture();
    expect(resolveItem(catalog, 'peras', 1)[0]).toMatchObject({ itemId: 'Birnen', score: 100 });
  });

  it('matches a catalog phrase embedded in a longer product name', () => {
    const catalog = fixture();
    const [best] = resolveItem(catalog, 'Escova De Dentes Colgate Maquina', 1);
    expect(best?.itemId).toBe('Zahnbürsten');
  });

  /**
   * Regression: a substring-based matcher resolved this to `Öl`, because "ol"
   * occurs inside "Colgate". A wrong icon is worse than none - nobody goes
   * looking for an icon they did not ask for.
   */
  it('never matches on a fragment inside a word', () => {
    const catalog = fixture();
    const ids = resolveItem(catalog, 'Escova De Dentes Colgate Maquina', 5).map((m) => m.itemId);
    expect(ids).not.toContain('Öl');
    expect(resolveItem(catalog, 'colgate', 5)).toEqual([]);
  });

  it('returns nothing rather than a guess for unknown input', () => {
    const catalog = fixture();
    expect(resolveItem(catalog, 'zzzqqq', 5)).toEqual([]);
  });

  it('still matches a short id when the query is exactly that id', () => {
    const catalog = fixture();
    expect(resolveItem(catalog, 'Öl', 1)[0]?.itemId).toBe('Öl');
  });

  /**
   * The partial rules used different minimum lengths (4 and 5), so a 4-letter
   * prefix matched nothing while the same prefix at 5 letters scored 55.
   */
  it('applies one minimum length to every partial rule', () => {
    const catalog = fixture();
    const four = resolveItem(catalog, 'zahn', 3).map((m) => m.itemId);
    const five = resolveItem(catalog, 'zahnb', 3).map((m) => m.itemId);
    expect(four).toContain('Zahnbürsten');
    expect(five).toContain('Zahnbürsten');
  });

  it('still refuses fragments below the minimum length', () => {
    const catalog = fixture();
    expect(resolveItem(catalog, 'zah', 3)).toEqual([]);
  });

  /**
   * A single-token query that merely begins with a short catalog word, sharing
   * no whole token, is coincidental (the "reismehl -> Reis" class). It must
   * score below the auto-attach bar. "kase" (Käse) is a string-prefix of the
   * one-token query "kaseblock" but not a whole-token match.
   */
  it('scores a coincidental leading-word prefix below the auto-attach bar', () => {
    const catalog = fixture();
    // "birnenkompott" is one token beginning with the catalog word "Birnen"
    // but sharing no whole token with it - the reismehl->Reis class.
    const [best] = resolveItem(catalog, 'birnenkompott', 1);
    expect(best.itemId).toBe('Birnen');
    expect(best.score).toBeLessThan(50); // surfaced as a hint, never auto-attached
  });

  it('keeps a genuine typed prefix (catalog word starts with the query) above the bar', () => {
    const catalog = fixture();
    const [best] = resolveItem(catalog, 'zahnb', 1);
    expect(best.itemId).toBe('Zahnbürsten');
    expect(best.score).toBeGreaterThanOrEqual(50);
  });

  /**
   * A plural/inflection ("Orangen" over "Orange") must resolve to the base item,
   * not to a different compound that merely begins with the query
   * ("Orangensaft"). Before the coverage rule the juice (rule-3 prefix, 55) beat
   * the fruit (rule-4 weak, 40) and the wrong icon was auto-attached.
   */
  it('resolves an inflection to its base word, beating a compound that shares the prefix', () => {
    const catalog = buildCatalog([
      {
        locale: 'de-DE',
        sections: [
          {
            sectionId: 'S',
            name: 'S',
            items: [
              { itemId: 'Orange', name: 'Orange' },
              { itemId: 'Orangensaft', name: 'Orangensaft' },
            ],
          },
        ],
      },
    ]);
    const ranked = resolveItem(catalog, 'orangen', 2);
    expect(ranked[0].itemId).toBe('Orange');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[0].score).toBeGreaterThanOrEqual(50); // auto-attaches the FRUIT
  });

  it('still treats a small leading-word overlap as coincidental (reismehl)', () => {
    const catalog = buildCatalog([
      {
        locale: 'de-DE',
        sections: [{ sectionId: 'S', name: 'S', items: [{ itemId: 'Reis', name: 'Reis' }] }],
      },
    ]);
    const [best] = resolveItem(catalog, 'reismehl', 1);
    expect(best.itemId).toBe('Reis');
    expect(best.score).toBeLessThan(50); // never auto-attached
  });

  /**
   * The inflection upgrade is gated on genuine plural suffixes, because a pure
   * length ratio cannot tell "orangen = orange+n" from "kohle = Kohl + a
   * different word". Verified false positives from two independent reviews:
   * kohle (charcoal) got the cabbage icon; "kohlr" (truncated Kohlrabi)
   * upgraded Kohl past the real compound.
   */
  it.each([
    ['kohle', 'Kohl'], // different word, +e
    ['reise', 'Reis'], // different word, +e
    ['kohlr', 'Kohl'], // truncated compound, +r
    ['kasek', 'Käse'], // truncated compound, +k
  ])('keeps the non-plural extension %j below the auto-attach bar', (query, base) => {
    const catalog = buildCatalog([
      {
        locale: 'de-DE',
        sections: [
          {
            sectionId: 'S',
            name: 'S',
            items: [
              { itemId: 'Kohl', name: 'Kohl' },
              { itemId: 'Kohlrabi', name: 'Kohlrabi' },
              { itemId: 'Reis', name: 'Reis' },
              { itemId: 'Käse', name: 'Käse' },
              { itemId: 'Käsekuchen', name: 'Käsekuchen' },
            ],
          },
        ],
      },
    ]);
    const matches = resolveItem(catalog, query, 3);
    const baseMatch = matches.find((m) => m.itemId === base);
    expect(baseMatch?.score ?? 0).toBeLessThan(50);
  });

  it('still upgrades genuine plural suffixes above the compound prefix', () => {
    const catalog = buildCatalog([
      {
        locale: 'de-DE',
        sections: [
          {
            sectionId: 'S',
            name: 'S',
            items: [
              { itemId: 'Orange', name: 'Orange' },
              { itemId: 'Orangensaft', name: 'Orangensaft' },
            ],
          },
        ],
      },
    ]);
    const [best] = resolveItem(catalog, 'orangen', 2);
    expect(best.itemId).toBe('Orange'); // the fruit still beats the juice
    expect(best.score).toBeGreaterThanOrEqual(50);
  });

  /**
   * DeepSeek's sharpest test-gap catch: the anagram rule (same words, different
   * order, score 90) is the branch that REPLACES the user's text with a
   * canonical id, and it had zero coverage.
   */
  it('scores a word-order permutation BELOW the canonical tier', () => {
    const catalog = buildCatalog([
      {
        locale: 'pt-BR',
        sections: [{ sectionId: 'S', name: 'S', items: [{ itemId: 'Apfelsaft', name: 'Suco de maçã' }] }],
      },
    ]);
    const [best] = resolveItem(catalog, 'maçã de suco', 1);
    expect(best.itemId).toBe('Apfelsaft');
    // 85: still offered and still able to carry an icon (>= ICON_MATCH_SCORE 50),
    // but deliberately under EXACT_MATCH_SCORE (90) so it can never REPLACE the
    // user's text. See the rice-pudding/rice-milk case below for why.
    expect(best.score).toBe(85);
    expect(best.score).toBeLessThan(90);
  });

  /** A permutation is not proof of identity: in romance languages the word
   *  order carries the meaning. "arroz de leite" is how people colloquially
   *  say rice pudding; "Leite de arroz" is rice MILK - a different product.
   *  At the old score of 90 this silently stored the wrong item's canonical
   *  id in place of what the user typed. */
  it('never lets a reordering reach the canonical-replace bar', () => {
    const catalog = buildCatalog([
      {
        locale: 'pt-BR',
        sections: [{ sectionId: 'S', name: 'S', items: [{ itemId: 'Reismilch', name: 'Leite de arroz' }] }],
      },
    ]);
    const [best] = resolveItem(catalog, 'arroz de leite', 1);
    expect(best.itemId).toBe('Reismilch');
    expect(best.score).toBeLessThan(90);
  });

  /** A compound written with a space IS that compound. Before this, "apfel
   *  strudel" matched the base word Äpfel at 70 (whole-token run) and the real
   *  product scored 0 and never appeared at all - wrong icon AND a total miss. */
  /** `[^a-z0-9]` deleted every non-Latin script outright, so a ru-RU catalog -
   *  and ru-RU IS in SUPPORTED_LOCALES - normalized every entry to the empty
   *  string and matched NOTHING, completely silently. */
  it('matches a non-Latin catalog name instead of erasing it', () => {
    const catalog = buildCatalog([
      {
        locale: 'ru-RU',
        sections: [{ sectionId: 'S', name: 'S', items: [{ itemId: 'Äpfel', name: 'Яблоки' }] }],
      },
    ]);
    const [best] = resolveItem(catalog, 'яблоки', 1);
    expect(best).toBeDefined();
    expect(best.itemId).toBe('Äpfel');
    expect(best.score).toBe(100);
  });

  /** The whole-token rule fired on ONE incidental token of a long phrase, so
   *  "eistee ohne zucker" (iced tea WITHOUT sugar) took the SUGAR icon and
   *  "nudelsuppe mit reis" took RICE over noodle soup. Replaying a real list of
   *  stored icon choices, this shape accounted for ~40% of the wrong ones. */
  it('refuses a whole-token match that covers too little of the query', () => {
    const catalog = fixture();
    // "cebolas" is 1 of 5 typed words - not enough to carry the icon for the
    // whole phrase. Without the floor this scored 70 and auto-attached.
    expect(resolveItem(catalog, 'sopa de peixe com cebolas', 1)).toEqual([]);
  });

  /** ...but a two-word modifier phrase is exactly the case the rule exists for,
   *  and sits precisely at the 0.5 floor. */
  it('still matches a two-word modifier phrase to its base word', () => {
    const catalog = fixture();
    const [best] = resolveItem(catalog, 'cebolas roxas', 1);
    expect(best?.itemId).toBe('Zwiebeln');
    expect(best?.score).toBe(70); // 1 of 2 tokens = exactly the 0.5 floor
  });

  it('matches a spaced compound to the single-token catalog entry', () => {
    const catalog = buildCatalog([
      {
        locale: 'de-DE',
        sections: [
          {
            sectionId: 'S',
            name: 'S',
            items: [
              { itemId: 'Apfelstrudel', name: 'Apfelstrudel' },
              { itemId: 'Äpfel', name: 'Äpfel' },
            ],
          },
        ],
      },
    ]);
    const [best] = resolveItem(catalog, 'apfel strudel', 1);
    expect(best.itemId).toBe('Apfelstrudel');
    expect(best.score).toBe(100);
  });
});

describe('resolveSection', () => {
  it('resolves a localized section name to its canonical id', () => {
    const catalog = fixture();
    expect(resolveSection(catalog, 'frutas verduras', 1)[0]?.sectionId).toBe('Früchte & Gemüse');
  });
});

describe('assertSupportedLocale', () => {
  it('accepts locales Bring actually serves', () => {
    expect(() => assertSupportedLocale('pt-BR')).not.toThrow();
    expect(() => assertSupportedLocale('de-DE')).not.toThrow();
  });

  /**
   * pt-PT 404s with an HTML page, which the underlying library then tries to
   * JSON.parse - producing an unhelpful parse error rather than a clear one.
   */
  it('rejects pt-PT and suggests pt-BR', () => {
    expect(() => assertSupportedLocale('pt-PT')).toThrow(/pt-BR/);
  });
});
