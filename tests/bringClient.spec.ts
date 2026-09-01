import { BringClient } from '../src/bringClient';

const mockLogin = jest.fn();
const mockGetItems = jest.fn();
const mockSaveItem = jest.fn();
const mockRemoveItem = jest.fn();
const mockLoadTranslations = jest.fn();
const mockLoadCatalog = jest.fn();
const mockSaveItemImage = jest.fn();
const mockRemoveItemImage = jest.fn();

jest.mock('bring-shopping', () => {
  const token = JSON.stringify({
    exp: Date.now() / 1000 + 20000,
  });
  const base64Url = Buffer.from(token).toString('base64');
  return jest.fn().mockImplementation(() => ({
    login: mockLogin,
    getItems: mockGetItems,
    saveItem: mockSaveItem,
    removeItem: mockRemoveItem,
    loadTranslations: mockLoadTranslations,
    loadCatalog: mockLoadCatalog,
    saveItemImage: mockSaveItemImage,
    removeItemImage: mockRemoveItemImage,
    bearerToken: `a.${base64Url}.a`,
    // Read back by bringHttp.extractAuthHeaders so the authenticated session can
    // be reused for endpoints the library does not wrap.
    headers: { Authorization: 'Bearer test', 'X-BRING-USER-UUID': 'user-uuid' },
  }));
});

/** Captures what the client actually put on the wire. */
let fetchMock: jest.Mock;

function lastBody(): string {
  const calls = fetchMock.mock.calls;
  return String(calls[calls.length - 1][1].body ?? '');
}

describe('BringClient functionality', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MAIL = 'test@example.com';
    process.env.PW = 'pw';
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  test('getItems adds itemId to purchase and recently items', async () => {
    const response = {
      purchase: [{ name: 'Milk', specification: '1L' }],
      recently: [{ name: 'Bread', specification: 'Whole' }],
    };
    mockGetItems.mockResolvedValue(response);
    const bc = new BringClient();

    const result = await bc.getItems('list1');

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockGetItems).toHaveBeenCalledWith('list1');
    expect(result.purchase[0]).toEqual({ name: 'Milk', specification: '1L', itemId: 'Milk' });
    expect(result.recently[0]).toEqual({ name: 'Bread', specification: 'Whole', itemId: 'Bread' });
  });

  test('saveItem forwards empty specification string when undefined', async () => {
    const bc = new BringClient();

    await bc.saveItem('listA', 'Eggs', undefined);

    expect(mockLogin).toHaveBeenCalledTimes(1);
    // Not delegated to the library any more: its unescaped body loses characters.
    expect(mockSaveItem).not.toHaveBeenCalled();
    const params = new URLSearchParams(lastBody());
    expect(params.get('purchase')).toBe('Eggs');
    expect(params.get('specification')).toBe('');
  });

  /**
   * Regression: `bring-shopping` concatenates the form body unescaped, so
   * "Fish & Chips" was stored as "Fish", "Salt + Pepper" as "Salt   Pepper",
   * and "50% Cream" never arrived - with no error, because it also ignores the
   * response status. Verified against the live API on 2026-08-29.
   */
  test.each([
    ['Fish & Chips', 'qty 2'],
    ['Salt + Pepper', '100%'],
    ['50% Cream', 'a&b'],
    ['Água & Gás', 'ção'],
  ])('saveItem escapes %j so it survives the round trip', async (itemName, specification) => {
    const bc = new BringClient();

    await bc.saveItem('listA', itemName, specification);

    const params = new URLSearchParams(lastBody());
    expect(params.get('purchase')).toBe(itemName);
    expect(params.get('specification')).toBe(specification);
    expect(params.get('remove')).toBe('');
  });

  test('removeItem and moveToRecentList escape the item name too', async () => {
    // Both now verify the name is on the list before writing.
    mockGetItems.mockResolvedValue({
      purchase: [{ name: 'Fish & Chips', specification: '' }],
      recently: [{ name: 'Salt + Pepper', specification: '' }],
    });
    const bc = new BringClient();

    await bc.removeItem('listA', 'Fish & Chips');
    expect(new URLSearchParams(lastBody()).get('remove')).toBe('Fish & Chips');

    await bc.moveToRecentList('listA', 'Salt + Pepper');
    expect(new URLSearchParams(lastBody()).get('recently')).toBe('Salt + Pepper');
  });

  /** The legacy endpoint 204s on a miss, so the check is the only honest signal. */
  test('removeItem refuses a name that is not on the list', async () => {
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Milk', specification: '' }], recently: [] });
    const bc = new BringClient();

    await expect(bc.removeItem('listA', 'Milkk')).rejects.toThrow(/not on this list/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** Re-saving with no spec must keep the existing one (the endpoint replaces it). */
  test('saveItem with no spec carries the existing spec of an existing item', async () => {
    mockGetItems.mockResolvedValue({ purchase: [], recently: [{ name: 'Milk', specification: '2 litres' }] });
    const bc = new BringClient();

    await bc.saveItem('listA', 'Milk', undefined);
    expect(new URLSearchParams(lastBody()).get('specification')).toBe('2 litres');

    // An explicit spec still replaces.
    await bc.saveItem('listA', 'Milk', '1 litre');
    expect(new URLSearchParams(lastBody()).get('specification')).toBe('1 litre');
  });

  /** `||` used to make clearing impossible: '' fell into the carry branch. */
  test('an explicit empty string CLEARS the spec instead of carrying it', async () => {
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Milk', specification: '2 litres' }], recently: [] });
    const bc = new BringClient();

    await bc.saveItem('listA', 'Milk', '');
    expect(new URLSearchParams(lastBody()).get('specification')).toBe('');
  });

  /** Second occurrence of a name in one batch must see the FIRST occurrence's
   *  spec, not the stale pre-batch value. */
  test('saveItemBatch keeps its name index current within the batch', async () => {
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Milk', specification: 'old' }], recently: [] });
    const bc = new BringClient();

    await bc.saveItemBatch('listB', [{ itemName: 'Milk', specification: '1L' }, { itemName: 'Milk' }]);

    const second = new URLSearchParams(String(fetchMock.mock.calls[1][1].body));
    expect(second.get('specification')).toBe('1L'); // not 'old'
  });

  test('deleteMultipleItemsFromList dedupes repeated input names', async () => {
    mockGetItems.mockResolvedValue({ purchase: [{ name: 'Milk', specification: '' }], recently: [] });
    const bc = new BringClient();

    const result = await bc.deleteMultipleItemsFromList('listC', ['Milk', 'Milk']);

    expect(fetchMock).toHaveBeenCalledTimes(1); // one write, not two
    expect(result).toEqual({ removed: ['Milk'], notFound: [] });
  });

  /** The library returned an error body as an ordinary string; we throw. */
  test('a non-2xx response raises instead of being returned as data', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'Bad Request' });
    const bc = new BringClient();

    await expect(bc.saveItem('listA', 'Eggs', '')).rejects.toThrow(/400/);
  });

  test('saveItemBatch saves each item individually', async () => {
    const bc = new BringClient();

    const result = await bc.saveItemBatch('listB', [{ itemName: 'A & B', specification: '1' }, { itemName: 'B' }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1].body)).get('purchase')).toBe('A & B');
    expect(new URLSearchParams(String(fetchMock.mock.calls[1][1].body)).get('purchase')).toBe('B');
    expect(result).toEqual(['', '']);
  });

  test('deleteMultipleItemsFromList removes the found names and reports the missing ones', async () => {
    mockGetItems.mockResolvedValue({
      purchase: [
        { name: 'x & y', specification: '' },
        { name: 'z', specification: '' },
      ],
      recently: [],
    });
    const bc = new BringClient();

    const result = await bc.deleteMultipleItemsFromList('listC', ['x & y', 'z', 'ghost']);

    expect(fetchMock).toHaveBeenCalledTimes(2); // one PUT per FOUND name only
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1].body)).get('remove')).toBe('x & y');
    expect(new URLSearchParams(String(fetchMock.mock.calls[1][1].body)).get('remove')).toBe('z');
    expect(result).toEqual({ removed: ['x & y', 'z'], notFound: ['ghost'] });
  });

  test('getItems does not mutate the library response', async () => {
    const response = {
      purchase: [{ name: 'Milk', specification: '1L' }],
      recently: [{ name: 'Bread', specification: 'Whole' }],
    };
    mockGetItems.mockResolvedValue(response);
    const bc = new BringClient();

    const result = await bc.getItems('list1');

    expect(result.purchase[0]).toHaveProperty('itemId', 'Milk');
    expect(response.purchase[0]).not.toHaveProperty('itemId');
  });

  test('loadTranslations defaults to en-US when no locale is provided', async () => {
    mockLoadTranslations.mockResolvedValue('ok');
    const bc = new BringClient();

    await bc.loadTranslations();

    expect(mockLoadTranslations).toHaveBeenCalledWith('en-US');
  });

  test('loadCatalog passes locale through', async () => {
    mockLoadCatalog.mockResolvedValue('catalog');
    const bc = new BringClient();

    await bc.loadCatalog('de-DE');

    expect(mockLoadCatalog).toHaveBeenCalledWith('de-DE');
  });

  /**
   * The image calls no longer delegate to the library: its versions never
   * checked resp.ok (a 404 HTML page came back as success) and JSON.parsed
   * unconditionally (a 204 threw after a successful upload).
   */
  test('saveItemImage uploads as multipart (the only encoding the endpoint accepts)', async () => {
    const bc = new BringClient();

    const result = await bc.saveItemImage('item-uuid', 'aW1hZ2U=');

    expect(mockSaveItemImage).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(String(url)).toContain('bringlistitemdetails/item-uuid/image');
    expect(init.method).toBe('PUT');
    // form-urlencoded gets a 415 from this endpoint (verified live); multipart works
    expect(init.headers['Content-Type']).toContain('multipart/form-data');
    expect(init.headers['Content-Type']).toContain('charset=UTF-8');
    expect(String(init.body)).toContain('aW1hZ2U=');
    expect(result).toEqual({ status: 204 }); // empty body is a success, not a parse error
  });

  test('saveItemImage raises on a non-2xx instead of returning the error page', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => '<html>HTTP Status 404</html>' });
    const bc = new BringClient();

    await expect(bc.saveItemImage('bad-uuid', 'aW1hZ2U=')).rejects.toThrow(/404/);
  });

  test('removeItemImage deletes over the checked path and raises on failure', async () => {
    const bc = new BringClient();

    await bc.removeItemImage('item-uuid');
    expect(mockRemoveItemImage).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(String(url)).toContain('bringlistitemdetails/item-uuid/image');
    expect(init.method).toBe('DELETE');

    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => '<html>HTTP Status 404</html>' });
    await expect(bc.removeItemImage('stale-uuid')).rejects.toThrow(/404/);
  });
});
