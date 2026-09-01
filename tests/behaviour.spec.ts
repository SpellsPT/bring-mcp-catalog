/**
 * Behaviour tests for BringClient.
 *
 * The other suites mock BringClient wholesale, so they assert that a tool
 * forwards its arguments - not that the operation is correct. Everything here
 * drives the real client and mocks only the transport, so an implementation
 * that forwards perfectly but does the wrong thing still fails.
 */
import { BringClient } from '../src/bringClient';

const mockLogin = jest.fn();
const mockGetItems = jest.fn();
const mockGetItemsDetails = jest.fn();
const mockLoadCatalog = jest.fn();

jest.mock('bring-shopping', () => {
  const token = JSON.stringify({ exp: Date.now() / 1000 + 20000 });
  const base64Url = Buffer.from(token).toString('base64');
  return jest.fn().mockImplementation(() => ({
    login: mockLogin,
    getItems: mockGetItems,
    getItemsDetails: mockGetItemsDetails,
    loadCatalog: mockLoadCatalog,
    bearerToken: `a.${base64Url}.a`,
    headers: { Authorization: 'Bearer test', 'X-BRING-USER-UUID': 'user-uuid' },
  }));
});

const LIST = 'list-uuid';

/**
 * Deliberately omits "Leite de coco" so that "leite de coco" ties between
 * Leite and Coco - the ambiguity case.
 */
const CATALOG_ITEMS: [string, string, string, string][] = [
  // itemId, de-DE, pt-BR, en-US
  ['Äpfel', 'Äpfel', 'Maçãs', 'Apples'],
  ['Birnen', 'Birnen', 'Peras', 'Pears'],
  ['Käse', 'Käse', 'Queijo', 'Cheese'],
  ['Milch', 'Milch', 'Leite', 'Milk'],
  ['Kokosnuss', 'Kokosnuss', 'Coco', 'Coconut'],
  ['Zahnbürsten', 'Zahnbürsten', 'Escova de dentes', 'Toothbrush'],
  ['Zahnpasta', 'Zahnpasta', 'Creme dental', 'Toothpaste'],
  // A real-catalog phenomenon: two DIFFERENT entries sharing a display name
  // ("paprika" belongs to both Peperoni and Paprikapulver in the live data).
  ['Peperoni', 'Peperoni', 'Pimentão', 'Paprika'],
  ['Paprikapulver', 'Paprikapulver', 'Páprica', 'Paprika'],
  // Base word + compound: the truncation-vs-plural ambiguity class.
  ['Orange', 'Orange', 'Laranja', 'Orange'],
  ['Orangensaft', 'Orangensaft', 'Suco de laranja', 'Orange juice'],
  ['Süssigkeiten', 'Süssigkeiten', 'Doces', 'Sweets'],
];

function catalogFor(locale: string) {
  const idx = { 'de-DE': 1, 'pt-BR': 2, 'en-US': 3 }[locale] ?? 1;
  return {
    catalog: {
      sections: [
        {
          sectionId: 'Früchte & Gemüse',
          name: 'Frutas',
          items: CATALOG_ITEMS.map((e) => ({ itemId: e[0], name: e[idx] })),
        },
      ],
    },
  };
}

/** Records every request so assertions can check what actually went out. */
type Sent = { method: string; url: string; body: string; contentType: string };
let sent: Sent[] = [];
let detailResponse: unknown = null; // what GET /bringlistitemdetails?... returns

function installFetch() {
  global.fetch = jest.fn(async (url: unknown, init: Record<string, unknown> = {}) => {
    const u = String(url);
    const method = String(init.method ?? 'GET');
    const headers = (init.headers ?? {}) as Record<string, string>;
    sent.push({ method, url: u, body: String(init.body ?? ''), contentType: headers['Content-Type'] ?? '' });

    if (u.includes('bringlistitemdetails?')) {
      // Bring answers 204 with an empty body when the item has no record.
      return detailResponse === null
        ? { ok: true, status: 204, text: async () => '' }
        : { ok: true, status: 200, text: async () => JSON.stringify(detailResponse) };
    }
    if (u.includes('bringlistitemdetails') && method === 'POST') {
      return { ok: true, status: 201, text: async () => JSON.stringify({ uuid: 'new-detail-uuid' }) };
    }
    return { ok: true, status: 204, text: async () => '' };
  }) as unknown as typeof fetch;
}

const bodyOf = (s: Sent) => new URLSearchParams(s.body);
const puts = () => sent.filter((s) => s.method === 'PUT' && s.url.endsWith(`/bringlists/${LIST}`));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MAIL = 'a@b.c';
  // Declared explicitly rather than relying on a default: the indexed locales
  // are user configuration now (BRING_MCP_CATALOG_LOCALES), so a test that
  // exercises Portuguese queries has to say so.
  process.env.BRING_MCP_CATALOG_LOCALES = 'de-DE,pt-BR,en-US';
  process.env.PW = 'pw';
  sent = [];
  detailResponse = null;
  mockLoadCatalog.mockImplementation(async (locale: string) => catalogFor(locale));
  mockGetItems.mockResolvedValue({ purchase: [], recently: [] });
  mockGetItemsDetails.mockResolvedValue([]);
  installFetch();
});

describe('renameItem', () => {
  const onList = (purchase: [string, string][], recently: [string, string][] = []) =>
    mockGetItems.mockResolvedValue({
      purchase: purchase.map(([name, specification]) => ({ name, specification })),
      recently: recently.map(([name, specification]) => ({ name, specification })),
    });

  /** Previously blanked the spec while reporting a clean rename. */
  it('carries the existing specification when the caller supplies none', async () => {
    onList([['Milk', '2 litres']]);
    const bc = new BringClient();

    const result = await bc.renameItem(LIST, 'Milk', 'Milk semi-skimmed');

    expect(result.specificationCarried).toBe('2 litres');
    const added = puts().find((p) => bodyOf(p).get('purchase') === 'Milk semi-skimmed');
    expect(added).toBeDefined();
    expect(bodyOf(added!).get('specification')).toBe('2 litres');
  });

  it('lets an explicit specification override the existing one', async () => {
    onList([['Milk', '2 litres']]);
    const bc = new BringClient();

    const result = await bc.renameItem(LIST, 'Milk', 'Milk', '1 litre').catch((e) => e);
    expect(result).toBeInstanceOf(Error); // same-name guard still applies

    const ok = await bc.renameItem(LIST, 'Milk', 'Milk 1L', '1 litre');
    expect(ok.specificationCarried).toBe('1 litre');
  });

  /** Previously invented a new item and called it a rename. */
  it('refuses to rename an item that is not on the list', async () => {
    onList([['Bread', '']]);
    const bc = new BringClient();

    await expect(bc.renameItem(LIST, 'NonExistent', 'Milk')).rejects.toThrow(/not on this list/);
    // and nothing was written
    expect(puts()).toHaveLength(0);
  });

  it('refuses a no-op rename to the same name', async () => {
    onList([['Milk', '']]);
    const bc = new BringClient();

    await expect(bc.renameItem(LIST, 'Milk', 'Milk')).rejects.toThrow(/both/);
    expect(puts()).toHaveLength(0);
  });

  /**
   * Bring merges items by name, so renaming onto an existing name would
   * overwrite the target rather than duplicate it. Refuse and leave both intact.
   */
  it('refuses to rename onto a name already on the list', async () => {
    onList([
      ['Milk', ''],
      ['Bread', 'wholemeal'],
    ]);
    const bc = new BringClient();

    await expect(bc.renameItem(LIST, 'Milk', 'Bread')).rejects.toThrow(/already on this list/);
    expect(puts()).toHaveLength(0);
  });

  /** A shared list: an item in "recently" must not reappear as to-buy. */
  it('keeps an item that was in recently out of the to-buy list', async () => {
    onList([], [['Milk', '']]);
    const bc = new BringClient();

    const result = await bc.renameItem(LIST, 'Milk', 'Leite');

    expect(result.stayedInRecently).toBe(true);
    expect(puts().some((p) => bodyOf(p).get('recently') === 'Leite')).toBe(true);
  });

  it('does not move a to-buy item into recently', async () => {
    onList([['Milk', '']]);
    const bc = new BringClient();

    const result = await bc.renameItem(LIST, 'Milk', 'Leite');

    expect(result.stayedInRecently).toBe(false);
    expect(puts().some((p) => bodyOf(p).get('recently') === 'Leite')).toBe(false);
  });

  /** Renaming off a canonical id loses the icon the catalog was providing. */
  it('reports the loss when renaming a catalog item to free text', async () => {
    onList([['Äpfel', '']]);
    const bc = new BringClient();

    const result = await bc.renameItem(LIST, 'Äpfel', 'Maçãs Pink Lady');

    expect(result.lostAutomaticIcon).toBe(true);
  });

  it('does not report a loss when renaming between two catalog items', async () => {
    onList([['Äpfel', '']]);
    const bc = new BringClient();

    const result = await bc.renameItem(LIST, 'Äpfel', 'Birnen');

    expect(result.lostAutomaticIcon).toBe(false);
  });

  it('moves a custom icon to the new name and deletes the old record', async () => {
    onList([['Kibble', '']]);
    detailResponse = {
      uuid: 'old-detail',
      itemId: 'Kibble',
      listUuid: LIST,
      userIconItemId: 'Käse',
      userSectionId: 'Früchte & Gemüse',
      assignedTo: '',
      imageUrl: '',
    };
    const bc = new BringClient();

    const result = await bc.renameItem(LIST, 'Kibble', 'Kibble XL');

    expect(result.movedDetail).toBe(true);
    const created = sent.find((s) => s.method === 'POST' && s.url.includes('bringlistitemdetails'));
    expect(created?.body).toContain('Käse');
    expect(created?.body).toContain('Kibble XL');
    expect(sent.some((s) => s.method === 'DELETE' && s.url.includes('old-detail'))).toBe(true);
  });

  /**
   * The source item and its record must be the LAST things touched, so that a
   * failure while re-creating the icon leaves the original intact and the whole
   * thing retryable. An implementation that removed first would pass every
   * other test here, so the order is pinned explicitly.
   */
  it('removes the source only after the new item and its icon exist', async () => {
    onList([['Kibble', '']]);
    detailResponse = {
      uuid: 'old-detail',
      itemId: 'Kibble',
      listUuid: LIST,
      userIconItemId: 'Käse',
      userSectionId: '',
      assignedTo: '',
      imageUrl: '',
    };
    const bc = new BringClient();

    await bc.renameItem(LIST, 'Kibble', 'Kibble XL');

    const idx = (pred: (s: Sent) => boolean) => sent.findIndex(pred);
    const savedNew = idx((s) => s.method === 'PUT' && bodyOf(s).get('purchase') === 'Kibble XL');
    const createdIcon = idx((s) => s.method === 'POST' && s.url.includes('bringlistitemdetails'));
    const removedOld = idx((s) => s.method === 'PUT' && bodyOf(s).get('remove') === 'Kibble');

    expect(savedNew).toBeGreaterThanOrEqual(0);
    expect(createdIcon).toBeGreaterThan(savedNew);
    expect(removedOld).toBeGreaterThan(createdIcon); // source removed dead last
  });

  /**
   * A pinned custom icon on a catalog item IS carried, so renaming must not
   * warn that an automatic icon was lost - that contradicts "icon carried over"
   * in the same message.
   */
  it('does not warn about a lost icon when a custom record carries it', async () => {
    onList([['Äpfel', '']]);
    detailResponse = {
      uuid: 'detail',
      itemId: 'Äpfel',
      listUuid: LIST,
      userIconItemId: 'Birnen',
      userSectionId: '',
      assignedTo: '',
      imageUrl: '',
    };
    const bc = new BringClient();

    const result = await bc.renameItem(LIST, 'Äpfel', 'Maçãs artesanais');

    expect(result.movedDetail).toBe(true);
    expect(result.lostAutomaticIcon).toBe(false);
  });

  /**
   * The failure path neither review round had covered: a throw after
   * saveItem(toName) leaves BOTH names on the list. The error must say so and
   * point at the safe way out (remove toName, retry) - the old bare error left
   * the caller to hit the collision guard blind, and the guard's old advice
   * ("remove one") could have destroyed the source's icon.
   */
  it('explains the exact list state when the icon carry fails mid-rename', async () => {
    onList([['Kibble', '2 bags']]);
    detailResponse = {
      uuid: 'old-detail',
      itemId: 'Kibble',
      listUuid: LIST,
      userIconItemId: 'Käse',
      userSectionId: '',
      assignedTo: '',
      imageUrl: '',
    };
    const original = global.fetch;
    global.fetch = (async (url: unknown, init?: Record<string, unknown>) => {
      if (String(url).includes('bringlistitemdetails') && (init?.method ?? 'GET') === 'POST') {
        return { ok: false, status: 500, text: async () => 'Internal Server Error' };
      }
      return (original as unknown as (u: unknown, i?: unknown) => Promise<unknown>)(url, init);
    }) as unknown as typeof fetch;

    const bc = new BringClient();
    const failure = await bc.renameItem(LIST, 'Kibble', 'Kibble XL').catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('"Kibble XL" was already created');
    expect(message).toContain('"Kibble" is still on the list');
    expect(message).toContain('do NOT remove "Kibble"');
    // the source item must not have been removed
    expect(puts().some((p) => bodyOf(p).get('remove') === 'Kibble')).toBe(false);
    // and its detail record must not have been deleted
    expect(sent.some((s) => s.method === 'DELETE' && s.url.includes('old-detail'))).toBe(false);
  });

  /** The last write used to fail raw, and the natural retry would have hit the
   *  collision guard whose advice deletes the finished new item. */
  it('explains the finish step when only the final remove fails', async () => {
    onList([['Kibble', '2 bags']]);
    detailResponse = null;
    const original = global.fetch;
    global.fetch = (async (url: unknown, init?: Record<string, unknown>) => {
      const body = String(init?.body ?? '');
      if (body.includes('remove=Kibble')) {
        return { ok: false, status: 500, text: async () => 'Internal Server Error' };
      }
      return (original as unknown as (u: unknown, i?: unknown) => Promise<unknown>)(url, init);
    }) as unknown as typeof fetch;

    const bc = new BringClient();
    const failure = await bc.renameItem(LIST, 'Kibble', 'Kibble XL').catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('COMPLETE except for removing the old row');
    expect((failure as Error).message).toContain('do NOT remove "Kibble XL"');
  });

  /** A section-only record (empty userIconItemId) carries no icon, so renaming
   *  a catalog item to free text still loses the automatic icon. */
  it('warns about the lost automatic icon even when a section-only record moves', async () => {
    onList([['Äpfel', '']]);
    detailResponse = {
      uuid: 'sec-only',
      itemId: 'Äpfel',
      listUuid: LIST,
      userIconItemId: '',
      userSectionId: 'Früchte & Gemüse',
      assignedTo: '',
      imageUrl: '',
    };
    const bc = new BringClient();

    const result = await bc.renameItem(LIST, 'Äpfel', 'Maçãs Especiais');

    expect(result.movedDetail).toBe(true); // the section record did move
    expect(result.lostAutomaticIcon).toBe(true); // but the icon is genuinely gone
  });

  it('reports that a photo could not be carried across', async () => {
    onList([['Kibble', '']]);
    detailResponse = {
      uuid: 'old-detail',
      itemId: 'Kibble',
      listUuid: LIST,
      userIconItemId: '',
      userSectionId: '',
      assignedTo: '',
      imageUrl: 'https://img.example/x.jpg',
    };
    const bc = new BringClient();

    expect((await bc.renameItem(LIST, 'Kibble', 'Kibble XL')).lostImage).toBe(true);
  });
});

describe('saveItemResolved', () => {
  it('stores the canonical id on a confident match', async () => {
    const bc = new BringClient();

    const result = await bc.saveItemResolved(LIST, 'maçãs');

    expect(result.mode).toBe('canonical');
    expect(result.storedAs).toBe('Äpfel');
    expect(bodyOf(puts()[0]).get('purchase')).toBe('Äpfel');
  });

  /** The product name must survive; only the icon is borrowed. */
  it('keeps the text verbatim and attaches an icon on a weaker match', async () => {
    const bc = new BringClient();

    const result = await bc.saveItemResolved(LIST, 'Escova de dentes Colgate');

    expect(result.mode).toBe('text-with-icon');
    expect(result.storedAs).toBe('Escova de dentes Colgate');
    expect(result.resolved?.itemId).toBe('Zahnbürsten');
    const created = sent.find((s) => s.method === 'POST' && s.url.includes('bringlistitemdetails'));
    expect(created?.body).toContain('Zahnbürsten');
  });

  it('stores text with no icon when nothing matches', async () => {
    const bc = new BringClient();

    const result = await bc.saveItemResolved(LIST, 'zzzqqq');

    expect(result.mode).toBe('text-only');
    expect(sent.some((s) => s.method === 'POST' && s.url.includes('bringlistitemdetails'))).toBe(false);
  });

  /** Two equally-good readings must not be resolved by alphabetical luck. */
  it('attaches no icon when two catalog items tie', async () => {
    const bc = new BringClient();

    const result = await bc.saveItemResolved(LIST, 'leite de coco');

    expect(result.mode).toBe('text-only');
    expect(result.storedAs).toBe('leite de coco');
  });

  /**
   * The tie refusal must hold at the CANONICAL tier too. The real catalog has
   * display-name homographs that both score 100 ("paprika": Peperoni vs
   * Paprikapulver); without the guard the user's text was silently replaced by
   * whichever id sorts first - a guessed NAME, worse than a guessed icon.
   */
  /**
   * "orangens" truncates Orangensaft yet the plural-suffix rule upgraded
   * Orange past it; "orangen" (the real plural) is mechanically identical, so
   * BOTH are refused when the compound competes - the stated trade-off. A sole
   * inflection match with no competing compound still attaches.
   */
  it('refuses an inflection-upgraded winner when a longer compound competes', async () => {
    const bc = new BringClient();

    const truncation = await bc.saveItemResolved(LIST, 'orangens');
    expect(truncation.mode).toBe('text-only');
    expect(truncation.storedAs).toBe('orangens');

    const plural = await bc.saveItemResolved(LIST, 'orangen'); // sacrificed knowingly
    expect(plural.mode).toBe('text-only');
  });

  it('still attaches a sole inflection match with no competing compound', async () => {
    const bc = new BringClient();

    const result = await bc.saveItemResolved(LIST, 'laranjas'); // Laranja+s, nothing else matches
    expect(result.mode).toBe('text-with-icon');
    expect(result.resolved?.itemId).toBe('Orange');
  });

  /**
   * Bring merges by NAME only, so a canonical save next to a free-text twin
   * ("Apples" already on the list, user says "maçãs") used to put two apple
   * rows in front of the household. The equivalent existing name is reused.
   */
  it('reuses an existing free-text twin instead of adding a canonical duplicate', async () => {
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Apples', specification: '6' }], recently: [] });
    const bc = new BringClient();

    const result = await bc.saveItemResolved(LIST, 'maçãs');

    // NOT 'canonical'. The row on the list is the free-text name "Apples",
    // which does not render per-language and has no automatic icon - reporting
    // it as canonical told the caller the opposite of what happened, and the
    // icon was never attached at all. Both fixed: honest mode, icon attached.
    expect(result.mode).toBe('text-with-icon');
    expect(result.storedAs).toBe('Apples');
    expect(result.reusedExistingName).toBe('Apples');
    // the write went to the EXISTING name, and carried its spec
    const put = puts().find((p) => bodyOf(p).get('purchase') === 'Apples');
    expect(put).toBeDefined();
    expect(bodyOf(put!).get('specification')).toBe('6');
    expect(puts().some((p) => bodyOf(p).get('purchase') === 'Äpfel')).toBe(false);
    // ...and the icon was actually attached to the reused free-text row. This
    // path used to return before reaching the icon step, so the household kept
    // an icon-less "Apples" row while the tool reported canonical success.
    const iconPost = sent.find((s) => s.method === 'POST' && s.url.includes('bringlistitemdetails'));
    expect(iconPost).toBeDefined();
    expect(String(iconPost!.body)).toContain('Äpfel');
  });

  /** The twin scan used to run a full catalog resolution for EVERY name on the
   *  list. It is pre-filtered now; this pins that the pre-filter still finds a
   *  twin hiding behind a long list of unrelated names. */
  it('still finds a twin when the list is full of unrelated names', async () => {
    mockGetItems.mockResolvedValue({
      purchase: [
        { name: 'Batteries', specification: '' },
        { name: 'Lightbulbs', specification: '' },
        { name: 'Apples', specification: '6' },
        { name: 'Napkins', specification: '' },
      ],
      recently: [],
    });
    const bc = new BringClient();
    const result = await bc.saveItemResolved(LIST, 'maçãs');
    expect(result.reusedExistingName).toBe('Apples');
    expect(puts().some((p) => bodyOf(p).get('purchase') === 'Äpfel')).toBe(false);
  });

  /** laguna-s: all the twin tests used the SAME shape - the literal unmodified
   *  display name "Apples" - so an implementation that only did exact-string
   *  equality passed them all. Demoting permutations to 85 in an earlier commit
   *  silently broke twin reuse for reordered names, and nothing caught it. */
  it('reuses a twin whose existing name is a word-order permutation', async () => {
    mockGetItems.mockResolvedValue({
      purchase: [{ name: 'Laranja de suco', specification: '2L' }],
      recently: [],
    });
    const bc = new BringClient();

    const result = await bc.saveItemResolved(LIST, 'suco de laranja');

    expect(result.reusedExistingName).toBe('Laranja de suco');
    expect(result.storedAs).toBe('Laranja de suco');
    // and no duplicate canonical row went out
    expect(puts().some((p) => bodyOf(p).get('purchase') === 'Orangensaft')).toBe(false);
    const put = puts().find((p) => bodyOf(p).get('purchase') === 'Laranja de suco');
    expect(put).toBeDefined();
    expect(bodyOf(put!).get('specification')).toBe('2L'); // existing spec carried
  });

  /** glm-5.3: adding the icon step to the twin branch made it CLOBBER a
   *  deliberately pinned icon on a row the user already had. Icons are human
   *  territory - fill an empty one, never replace a set one. */
  it('keeps a pinned icon when reusing an existing twin', async () => {
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Apples', specification: '6' }], recently: [] });
    detailResponse = {
      uuid: 'pinned-uuid',
      itemId: 'Apples',
      listUuid: LIST,
      userIconItemId: 'Süssigkeiten', // somebody deliberately chose this
      userSectionId: '',
      assignedTo: '',
      imageUrl: '',
    };
    const bc = new BringClient();

    const result = await bc.saveItemResolved(LIST, 'maçãs');

    expect(result.reusedExistingName).toBe('Apples');
    expect(result.keptExistingIcon).toBe('Süssigkeiten');
    // no icon write of any kind went out
    expect(sent.some((s) => s.url.includes('/usericon'))).toBe(false);
    expect(sent.some((s) => s.method === 'POST' && s.url.includes('bringlistitemdetails'))).toBe(false);
  });

  it('saves canonically as before when no twin exists', async () => {
    const bc = new BringClient();
    const result = await bc.saveItemResolved(LIST, 'maçãs');
    expect(result.storedAs).toBe('Äpfel');
    expect(result.reusedExistingName).toBeUndefined();
  });

  it('keeps the text verbatim when a homograph ties at score 100', async () => {
    const bc = new BringClient();

    const result = await bc.saveItemResolved(LIST, 'paprika');

    expect(result.mode).toBe('text-only');
    expect(result.storedAs).toBe('paprika'); // NOT Peperoni, NOT Paprikapulver
    expect(bodyOf(puts()[0]).get('purchase')).toBe('paprika');
  });

  /**
   * The item is already saved when the icon step runs, so an icon failure must
   * be reported as a partial success - not an error implying nothing happened.
   */
  it('reports the save and carries the icon failure when the detail write dies', async () => {
    const original = global.fetch;
    global.fetch = (async (url: unknown, init?: Record<string, unknown>) => {
      if (String(url).includes('bringlistitemdetails') && (init?.method ?? 'GET') === 'POST') {
        return { ok: false, status: 500, text: async () => 'Internal Server Error' };
      }
      return (original as unknown as (u: unknown, i?: unknown) => Promise<unknown>)(url, init);
    }) as unknown as typeof fetch;

    const bc = new BringClient();
    const result = await bc.saveItemResolved(LIST, 'Escova de dentes Colgate');

    expect(result.mode).toBe('text-only');
    expect(result.iconError).toMatch(/500/);
    // and the save itself went out before the failure
    expect(puts().some((p) => bodyOf(p).get('purchase') === 'Escova de dentes Colgate')).toBe(true);
  });

  /**
   * text-with-icon must actually attach the icon, in both create and update.
   * It used to skip the update when a record already existed while still
   * reporting the new icon - a false success.
   */
  it('updates the icon on an item that already has a different one', async () => {
    detailResponse = {
      uuid: 'existing-uuid',
      itemId: 'Escova de dentes Colgate',
      listUuid: LIST,
      userIconItemId: 'Äpfel', // a wrong pre-existing icon
      userSectionId: '',
      assignedTo: '',
      imageUrl: '',
    };
    const bc = new BringClient();

    const result = await bc.saveItemResolved(LIST, 'Escova de dentes Colgate');

    expect(result.mode).toBe('text-with-icon');
    const put = sent.find((s) => s.url.includes('/usericon'));
    expect(put).toBeDefined(); // the icon was actually written, not just reported
    expect(new URLSearchParams(put!.body).get('userIconItemId')).toBe('Zahnbürsten');
  });
});

describe('setItemSection', () => {
  it('applies an exact section id', async () => {
    detailResponse = null;
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Milk', specification: '' }], recently: [] });
    const bc = new BringClient();
    const result = await bc.setItemSection(LIST, 'Milk', 'Früchte & Gemüse');
    expect(result.resolvedSection.sectionId).toBe('Früchte & Gemüse');
  });

  /** Creating a record for a name not on the list is an orphan write. */
  it('refuses to create a record for a name that is not on the list', async () => {
    detailResponse = null;
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Milk', specification: '' }], recently: [] });
    const bc = new BringClient();
    await expect(bc.setItemSection(LIST, 'Milkk', 'Früchte & Gemüse')).rejects.toThrow(/not on this list/);
    expect(sent.some((s) => s.method === 'POST')).toBe(false);
  });

  /**
   * The same discipline as the item path: a query that merely begins with a
   * section word must not silently file the item into that aisle. Before this
   * fix, resolveSection returned the top match at any score and it was applied.
   */
  it('refuses a coincidental low-confidence section match', async () => {
    const bc = new BringClient();
    // "frutasextra" begins with the section name "Frutas" (score 40) but is not
    // a confident match; the floor must refuse it rather than file the item.
    await expect(bc.setItemSection(LIST, 'Milk', 'frutasextra')).rejects.toThrow(/No catalog section/);
  });
});

describe('setItemIcon', () => {
  it('creates a detail record when the item has none', async () => {
    detailResponse = null;
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Lightbulbs', specification: '' }], recently: [] });
    const bc = new BringClient();

    await bc.setItemIcon(LIST, 'Lightbulbs', 'queijo');

    const created = sent.find((s) => s.method === 'POST' && s.url.includes('bringlistitemdetails'));
    expect(created).toBeDefined();
    expect(created?.contentType).toContain('multipart/form-data');
    expect(created?.contentType).toContain('charset=UTF-8');
  });

  /** Bring 201s a record for ANY name, so a typo produced an orphan + success. */
  it('refuses to create a record for a name that is not on the list', async () => {
    detailResponse = null;
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Lightbulbs', specification: '' }], recently: [] });
    const bc = new BringClient();

    await expect(bc.setItemIcon(LIST, 'Lightbulbsy', 'queijo')).rejects.toThrow(/not on this list/);
    expect(sent.some((s) => s.method === 'POST')).toBe(false);
  });

  /**
   * setItemIcon resolves through the same tie-refusing path as its siblings.
   * "zahn" prefix-matches Zahnbürsten AND Zahnpasta at the same score; picking
   * one by alphabet put a toothbrush icon on floss.
   */
  it('refuses an ambiguous icon query instead of picking alphabetically', async () => {
    detailResponse = null;
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Floss picks', specification: '' }], recently: [] });
    const bc = new BringClient();

    await expect(bc.setItemIcon(LIST, 'Floss picks', 'zahn')).rejects.toThrow(/No catalog item/);
    expect(sent.some((s) => s.method === 'POST')).toBe(false);
  });

  it('updates via the usericon sub-resource when a record exists', async () => {
    // Lightbulbs must be ON the list: the update path is guarded by assertItemOnList
    // now, because 219 of 224 real detail records are for names no longer on the
    // list and updating one of those is a silent no-op reported as success.
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Lightbulbs', specification: '' }], recently: [] });
    detailResponse = {
      uuid: 'existing-uuid',
      itemId: 'Lightbulbs',
      listUuid: LIST,
      userIconItemId: 'Äpfel',
      userSectionId: '',
      assignedTo: '',
      imageUrl: '',
    };
    const bc = new BringClient();

    await bc.setItemIcon(LIST, 'Lightbulbs', 'queijo');

    const put = sent.find((s) => s.url.includes('/usericon'));
    expect(put?.method).toBe('PUT');
    expect(put?.contentType).toContain('x-www-form-urlencoded');
    expect(new URLSearchParams(put!.body).get('userIconItemId')).toBe('Käse');
    expect(sent.some((s) => s.method === 'POST' && s.url.includes('bringlistitemdetails'))).toBe(false);
  });

  /** 219 of the 224 real detail records are for names no longer on the list.
   *  Updating one of those changed nothing anyone could see while reporting
   *  success - the same silent-wrong-outcome that put assertItemOnList on
   *  removeItem. The guard used to cover only the CREATE path. */
  it('refuses to update an orphan record for a name not on the list', async () => {
    mockGetItems.mockResolvedValue({ purchase: [], recently: [] });
    detailResponse = {
      uuid: 'orphan-uuid',
      itemId: 'Cat Kibble',
      listUuid: LIST,
      userIconItemId: 'Erdnüsse',
      userSectionId: '',
      assignedTo: '',
      imageUrl: '',
    };
    const bc = new BringClient();
    await expect(bc.setItemIcon(LIST, 'Cat Kibble', 'queijo')).rejects.toThrow(/not on this list/);
    expect(sent.some((s) => s.url.includes('/usericon'))).toBe(false);
  });

  /** Third sibling of the same orphan class: getItemDetail keys by name, so a
   *  leftover record for a name not on the list was deleted and reported as a
   *  success while the visible row was untouched. */
  it('refuses to delete a customisation for a name not on the list', async () => {
    mockGetItems.mockResolvedValue({ purchase: [], recently: [] });
    detailResponse = {
      uuid: 'orphan-uuid',
      itemId: 'Kibble',
      listUuid: LIST,
      userIconItemId: 'Erdnüsse',
      userSectionId: '',
      assignedTo: '',
      imageUrl: '',
    };
    const bc = new BringClient();
    await expect(bc.removeItemDetail(LIST, 'Kibble')).rejects.toThrow(/not on this list/);
    expect(sent.some((s) => s.method === 'DELETE')).toBe(false);
  });

  it('refuses rather than guessing when nothing matches', async () => {
    const bc = new BringClient();
    await expect(bc.setItemIcon(LIST, 'Lightbulbs', 'zzzqqq')).rejects.toThrow(/No catalog item/);
  });
});

describe('getItemDetail', () => {
  /** The API answers 204, not 404, when a record is absent. */
  it('returns null for a 204', async () => {
    detailResponse = null;
    const bc = new BringClient();
    expect(await bc.getItemDetail(LIST, 'Anything')).toBeNull();
  });
});

describe('batchUpdateList routing', () => {
  const milkOnList = () =>
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Milk', specification: '' }], recently: [] });

  it('sends TO_PURCHASE without a uuid via the legacy add', async () => {
    const bc = new BringClient();
    const result = await bc.batchUpdateList(LIST, [{ itemId: 'Milk', operation: 'TO_PURCHASE' }]);
    expect(bodyOf(puts()[0]).get('purchase')).toBe('Milk');
    expect(result.applied).toEqual(['Milk (added)']);
  });

  /** TO_RECENTLY and REMOVE by uuid are accepted with 200 and do nothing. */
  it('sends TO_RECENTLY by name, not through the uuid batch endpoint', async () => {
    milkOnList();
    const bc = new BringClient();
    await bc.batchUpdateList(LIST, [{ itemId: 'Milk', uuid: 'some-uuid', operation: 'TO_RECENTLY' }]);
    expect(sent.some((s) => s.url.endsWith('/items'))).toBe(false);
    expect(bodyOf(puts()[0]).get('recently')).toBe('Milk');
  });

  it('sends REMOVE by name, not through the uuid batch endpoint', async () => {
    milkOnList();
    const bc = new BringClient();
    await bc.batchUpdateList(LIST, [{ itemId: 'Milk', uuid: 'some-uuid', operation: 'REMOVE' }]);
    expect(sent.some((s) => s.url.endsWith('/items'))).toBe(false);
    expect(bodyOf(puts()[0]).get('remove')).toBe('Milk');
  });

  /** The legacy endpoint no-ops a miss with 204; the report is the only truth. */
  it('reports a REMOVE for a name that is not there instead of claiming success', async () => {
    milkOnList();
    const bc = new BringClient();
    const result = await bc.batchUpdateList(LIST, [
      { itemId: 'Milk', operation: 'REMOVE' },
      { itemId: 'Milkk', operation: 'REMOVE' },
    ]);
    expect(result.applied).toEqual(['Milk (removed)']);
    expect(result.notFound).toEqual(['Milkk']);
    expect(puts()).toHaveLength(1); // only the found name produced a write
  });

  /** The index used to be read once and never updated, so a REMOVE/TO_RECENTLY
   *  for a name THIS batch had just added read the pre-batch snapshot, reported
   *  "not found", and skipped the write entirely. Found independently by
   *  DeepSeek Flash and the local model. */
  it('sees an item added earlier in the same batch', async () => {
    mockGetItems.mockResolvedValue({ purchase: [], recently: [] });
    const bc = new BringClient();
    const result = await bc.batchUpdateList(LIST, [
      { itemId: 'Milk', operation: 'TO_PURCHASE' },
      { itemId: 'Milk', operation: 'REMOVE' },
    ]);
    expect(result.applied).toEqual(['Milk (added)', 'Milk (removed)']);
    expect(result.notFound).toEqual([]);
    expect(puts()).toHaveLength(2); // the remove was actually sent, not skipped
  });

  it('marks an item bought when it was added earlier in the same batch', async () => {
    mockGetItems.mockResolvedValue({ purchase: [], recently: [] });
    const bc = new BringClient();
    const result = await bc.batchUpdateList(LIST, [
      { itemId: 'Milk', operation: 'TO_PURCHASE' },
      { itemId: 'Milk', operation: 'TO_RECENTLY' },
    ]);
    expect(result.applied).toEqual(['Milk (added)', 'Milk (completed)']);
    expect(result.notFound).toEqual([]);
  });

  /** The mirror case: once a name is removed it really is gone, so a repeated
   *  REMOVE is reported honestly instead of claiming a second write that the
   *  server would 204-no-op. */
  it('reports a repeated REMOVE in one batch as not found', async () => {
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Milk', specification: '' }], recently: [] });
    const bc = new BringClient();
    const result = await bc.batchUpdateList(LIST, [
      { itemId: 'Milk', operation: 'REMOVE' },
      { itemId: 'Milk', operation: 'REMOVE' },
    ]);
    expect(result.applied).toEqual(['Milk (removed)']);
    expect(result.notFound).toEqual(['Milk']);
    expect(puts()).toHaveLength(1);
  });

  /** Adds with no spec must not blank an existing item's spec. */
  it('carries the existing spec on a TO_PURCHASE re-add with none given', async () => {
    mockGetItems.mockResolvedValue({ purchase: [], recently: [{ name: 'Milk', specification: '2 litres' }] });
    const bc = new BringClient();
    await bc.batchUpdateList(LIST, [{ itemId: 'Milk', operation: 'TO_PURCHASE' }]);
    expect(bodyOf(puts()[0]).get('specification')).toBe('2 litres');
  });

  /** The uuid branch used to skip the lookup and send spec:'' - two reviewers
   *  independently flagged it. Both add paths carry now. */
  it('carries the existing spec on the uuid batch path too', async () => {
    mockGetItems.mockResolvedValue({ purchase: [], recently: [{ name: 'Milk', specification: '2 litres' }] });
    const bc = new BringClient();
    await bc.batchUpdateList(LIST, [{ itemId: 'Milk', uuid: 'known-uuid', operation: 'TO_PURCHASE' }]);
    const batch = sent.find((s) => s.url.endsWith('/items'));
    expect(batch?.body).toContain('"spec":"2 litres"');
  });

  it('uses the uuid batch endpoint only for TO_PURCHASE with a uuid', async () => {
    const bc = new BringClient();
    await bc.batchUpdateList(LIST, [{ itemId: 'Milk', uuid: 'known-uuid', operation: 'TO_PURCHASE' }]);
    const batch = sent.find((s) => s.url.endsWith('/items'));
    expect(batch?.contentType).toContain('application/json');
    expect(batch?.body).toContain('known-uuid');
  });
});

describe('describeItemDetails', () => {
  it('translates canonical ids into the requested language', async () => {
    mockGetItemsDetails.mockResolvedValue([
      {
        uuid: 'u1',
        itemId: 'Kibble',
        listUuid: LIST,
        userIconItemId: 'Käse',
        userSectionId: 'Früchte & Gemüse',
        assignedTo: '',
        imageUrl: '',
      },
    ]);
    const bc = new BringClient();

    const [row] = await bc.describeItemDetails(LIST, 'pt-BR');

    expect(row.icon).toBe('Käse');
    expect(row.iconLabel).toBe('Queijo');
    expect(row.sectionLabel).toBe('Frutas');
  });

  it('leaves labels null for an icon that is not in the catalog', async () => {
    mockGetItemsDetails.mockResolvedValue([
      {
        uuid: 'u1',
        itemId: 'X',
        listUuid: LIST,
        userIconItemId: 'NoSuchIcon',
        userSectionId: '',
        assignedTo: '',
        imageUrl: '',
      },
    ]);
    const bc = new BringClient();

    const [row] = await bc.describeItemDetails(LIST, 'pt-BR');
    expect(row.iconLabel).toBeNull();
  });
});

describe('apiRaw guards', () => {
  /** Literal, backslash, and %2e encodings all resolve to the same escape. */
  it.each([
    'v2/bringlists/../../bringauth',
    'v2\\bringlists\\..\\..\\bringauth',
    'v2/bringlists/%2e%2e/%2e%2e/bringauth',
    'v2/../../../etc',
  ])('rejects traversal via %j', async (path) => {
    const bc = new BringClient();
    await expect(bc.apiRaw('GET', path)).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });

  it('allows a legitimate direct path', async () => {
    const bc = new BringClient();
    await bc.apiRaw('GET', 'v2/bringlists/some-uuid/items');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://api.getbring.com/rest/v2/bringlists/some-uuid/items');
  });

  it('rejects a body-bearing verb sent with encoding none', async () => {
    const bc = new BringClient();
    await expect(bc.apiRaw('POST', 'v2/bringlistitemdetails', 'none')).rejects.toThrow(/only GET and DELETE/);
    expect(sent).toHaveLength(0);
  });
});

describe('read amplification', () => {
  /** saveItemResolved fetched listNameIndex, then called saveItem which fetched
   *  the SAME index again - two getItems round-trips per canonical save with an
   *  omitted spec, which is the common MCP call shape. The index is threaded
   *  through now. */
  it('reads the list once, not twice, on a canonical save', async () => {
    mockGetItems.mockResolvedValue({ purchase: [], recently: [] });
    const bc = new BringClient();
    await bc.saveItemResolved(LIST, 'maçãs');
    expect(mockGetItems).toHaveBeenCalledTimes(1);
  });

  it('reads the list once when reusing an existing twin too', async () => {
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Apples', specification: '6' }], recently: [] });
    const bc = new BringClient();
    await bc.saveItemResolved(LIST, 'maçãs');
    expect(mockGetItems).toHaveBeenCalledTimes(1);
  });
});

describe('catalog cache', () => {
  /** One slot meant a non-default locale evicted the default set, so the two
   *  thrashed and every alternating call refetched 3-4 full catalogs despite
   *  the 1h TTL. Keyed now. */
  it('does not evict the default catalog when another locale set is used', async () => {
    mockGetItemsDetails.mockResolvedValue([]);
    const bc = new BringClient();

    await bc.findCatalogItem('maçãs');
    const afterFirst = mockLoadCatalog.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await bc.describeItemDetails(LIST, 'fr-FR'); // different key -> its own entry
    const afterOther = mockLoadCatalog.mock.calls.length;
    expect(afterOther).toBeGreaterThan(afterFirst);

    await bc.findCatalogItem('maçãs'); // must still be cached
    expect(mockLoadCatalog.mock.calls.length).toBe(afterOther);
  });
});

describe('multipart safety', () => {
  /** A CRLF ends the part early and smuggles further fields into the request. */
  it('refuses a value containing a line break rather than corrupting the request', async () => {
    const bc = new BringClient();
    await expect(bc.createItemDetail(LIST, 'Milk\r\nContent-Disposition: x', {})).rejects.toThrow(/line break/);
  });

  it('refuses a plain newline too', async () => {
    const bc = new BringClient();
    await expect(bc.createItemDetail(LIST, 'Milk\n2L', {})).rejects.toThrow(/line break/);
  });

  /** The legacy form path must reject newlines too, or it creates an item that
   *  can never get an icon (the multipart detail endpoint would reject it). */
  it('refuses a newline in an item name on the legacy save path', async () => {
    const bc = new BringClient();
    await expect(bc.saveItem(LIST, 'Milk\n2L', '')).rejects.toThrow(/line break/);
    expect(sent).toHaveLength(0);
  });

  it('still allows a newline inside a specification', async () => {
    const bc = new BringClient();
    await bc.saveItem(LIST, 'Milk', 'line1\nline2');
    expect(sent).toHaveLength(1);
  });

  /** The JSON batch path must reject newlines in a name too (N6). */
  it('refuses a newline in an item name on the batch path', async () => {
    const bc = new BringClient();
    await expect(
      bc.batchUpdateList(LIST, [{ itemId: 'Milk\n2L', uuid: 'u', operation: 'TO_PURCHASE' }]),
    ).rejects.toThrow(/line break/);
  });

  /** A crafted multipart FIELD NAME must be rejected, not just a value (N2). */
  it('rejects a line break in a multipart field name via the raw escape hatch', async () => {
    const bc = new BringClient();
    await expect(
      bc.apiRaw('POST', 'v2/bringlistitemdetails', 'multipart', {
        listUuid: LIST,
        ['itemId\r\nContent-Disposition: form-data; name="x"']: 'injected',
      }),
    ).rejects.toThrow(/line break/);
  });

  /** URLSearchParams and the multipart builder stringify anything, so an object
   *  became "[object Object]" and an array "a,b" - a wrong write shaped like a
   *  successful one, on the tool whose whole job is probing endpoints. */
  it('rejects a non-string field value rather than stringifying it', async () => {
    const bc = new BringClient();
    await expect(
      bc.apiRaw('PUT', `v2/bringlists/${LIST}`, 'form', { purchase: { x: 1 } as unknown as string }),
    ).rejects.toThrow(/must be a string/);
    await expect(
      bc.apiRaw('PUT', `v2/bringlists/${LIST}`, 'form', { specification: ['a', 'b'] as unknown as string }),
    ).rejects.toThrow(/must be a string/);
    expect(sent).toHaveLength(0);
  });

  /** A double quote closes the Content-Disposition name early and lets a
   *  crafted key append further parameters. Same escape hatch, different char. */
  it('rejects a double quote in a multipart field name', async () => {
    const bc = new BringClient();
    await expect(
      bc.apiRaw('POST', 'v2/bringlistitemdetails', 'multipart', {
        listUuid: LIST,
        ['itemId"; name="x']: 'injected',
      }),
    ).rejects.toThrow(/double quote/);
  });
});
