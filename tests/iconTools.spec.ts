import {
  mockFindCatalogItem,
  mockSaveItemResolved,
  mockSetItemIcon,
  mockSetItemSection,
  mockRemoveItemDetail,
  mockDescribeItemDetails,
  mockBatchUpdateList,
  mockRenameItem,
  mockSetListArticleLanguage,
  mockTools,
  loadServer,
  getTool,
} from './helpers';

const LIST = '11111111-2222-4333-8444-555555555555';

let consoleErrorSpy: jest.SpyInstance;

describe('MCP Bring! Server - Catalog and icon tools', () => {
  beforeEach(async () => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.clearAllMocks();
    mockTools.clear();
    delete process.env.BRING_MCP_RAW;
    await loadServer();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('registers the catalog and icon tools', () => {
    for (const name of [
      'findCatalogItem',
      'findCatalogSection',
      'saveItemResolved',
      'setItemIcon',
      'setItemSection',
      'removeItemCustomisation',
      'listItemCustomisations',
      'batchUpdateItems',
      'renameItem',
      'setListArticleLanguage',
    ]) {
      expect(getTool(name)).toBeDefined();
    }
  });

  it('does not expose the raw API escape hatch by default', () => {
    expect(getTool('bringApiRaw')).toBeUndefined();
  });

  describe('findCatalogItem', () => {
    it('passes the query through and defaults the limit', async () => {
      mockFindCatalogItem.mockResolvedValue([]);
      const tool = getTool('findCatalogItem')!;
      await tool.callback({ query: 'maçãs' });
      expect(mockFindCatalogItem).toHaveBeenCalledWith('maçãs', 5);
    });

    it('honours an explicit limit', async () => {
      mockFindCatalogItem.mockResolvedValue([]);
      await getTool('findCatalogItem')!.callback({ query: 'maçãs', limit: 2 });
      expect(mockFindCatalogItem).toHaveBeenCalledWith('maçãs', 2);
    });
  });

  describe('saveItemResolved', () => {
    it('reports a canonical save', async () => {
      mockSaveItemResolved.mockResolvedValue({ storedAs: 'Äpfel', resolved: { itemId: 'Äpfel' }, mode: 'canonical' });
      const result = await getTool('saveItemResolved')!.callback({ listUuid: LIST, query: 'maçãs' });
      expect(mockSaveItemResolved).toHaveBeenCalledWith(LIST, 'maçãs', undefined);
      expect(result.content[0].text).toContain('Äpfel');
    });

    /** The interesting case: text kept verbatim, icon borrowed. */
    it('reports when the text was kept and an icon attached', async () => {
      mockSaveItemResolved.mockResolvedValue({
        storedAs: 'Escova De Dentes Colgate Maquina',
        resolved: { itemId: 'Zahnbürsten' },
        mode: 'text-with-icon',
      });
      const result = await getTool('saveItemResolved')!.callback({
        listUuid: LIST,
        query: 'Escova De Dentes Colgate Maquina',
      });
      expect(result.content[0].text).toContain('kept verbatim');
      expect(result.content[0].text).toContain('Zahnbürsten');
    });

    it('tells the user how to recover when nothing matched', async () => {
      mockSaveItemResolved.mockResolvedValue({ storedAs: 'Cat Kibble', resolved: null, mode: 'text-only' });
      const result = await getTool('saveItemResolved')!.callback({ listUuid: LIST, query: 'Cat Kibble' });
      expect(result.content[0].text).toContain('findCatalogItem');
    });
  });

  describe('setItemIcon', () => {
    it('delegates to the client', async () => {
      mockSetItemIcon.mockResolvedValue({ detail: { itemId: 'Lightbulbs' }, resolvedIcon: { itemId: 'Wodka' } });
      const result = await getTool('setItemIcon')!.callback({ listUuid: LIST, itemName: 'Lightbulbs', icon: 'vodka' });
      expect(mockSetItemIcon).toHaveBeenCalledWith(LIST, 'Lightbulbs', 'vodka');
      expect(result.content[0].text).toContain('Wodka');
    });

    /**
     * A failed write must be flagged, not merely described. Without isError the
     * MCP result is success-shaped and a retry loop re-applies the operation.
     */
    it('marks the result as an error, not just prose saying so', async () => {
      mockSetItemIcon.mockRejectedValue(new Error('No catalog item confidently matches "xyz".'));
      const result = await getTool('setItemIcon')!.callback({ listUuid: LIST, itemName: 'Lightbulbs', icon: 'xyz' });
      expect(result.content[0].text).toContain('Failed to set item icon');
      expect((result as { isError?: boolean }).isError).toBe(true);
    });

    it('does not mark a successful call as an error', async () => {
      mockSetItemIcon.mockResolvedValue({ detail: { itemId: 'Lightbulbs' }, resolvedIcon: { itemId: 'Wodka' } });
      const result = await getTool('setItemIcon')!.callback({ listUuid: LIST, itemName: 'Lightbulbs', icon: 'vodka' });
      expect((result as { isError?: boolean }).isError).toBeUndefined();
    });
  });

  describe('setItemSection', () => {
    it('delegates to the client', async () => {
      mockSetItemSection.mockResolvedValue({
        detail: { itemId: 'Cat Kibble' },
        resolvedSection: { sectionId: 'Tierbedarf' },
      });
      const result = await getTool('setItemSection')!.callback({
        listUuid: LIST,
        itemName: 'Cat Kibble',
        section: 'animais',
      });
      expect(mockSetItemSection).toHaveBeenCalledWith(LIST, 'Cat Kibble', 'animais');
      expect(result.content[0].text).toContain('Tierbedarf');
    });
  });

  describe('removeItemCustomisation', () => {
    it('distinguishes removed from nothing-to-remove', async () => {
      mockRemoveItemDetail.mockResolvedValue(true);
      expect(
        (await getTool('removeItemCustomisation')!.callback({ listUuid: LIST, itemName: 'X' })).content[0].text,
      ).toContain('removed');
      mockRemoveItemDetail.mockResolvedValue(false);
      expect(
        (await getTool('removeItemCustomisation')!.callback({ listUuid: LIST, itemName: 'X' })).content[0].text,
      ).toContain('no customisation');
    });
  });

  describe('listItemCustomisations', () => {
    /** The tool used to hardcode pt-BR here, which was the author's household
     *  language rather than anyone else's. It now passes the caller's choice
     *  straight through and lets the client fall back to the configured
     *  BRING_MCP_DESCRIBE_LOCALE / first non-German indexed locale. */
    it('passes no locale through when the caller gives none', async () => {
      mockDescribeItemDetails.mockResolvedValue([]);
      await getTool('listItemCustomisations')!.callback({ listUuid: LIST });
      expect(mockDescribeItemDetails).toHaveBeenCalledWith(LIST, undefined);
    });

    it('honours an explicit locale', async () => {
      mockDescribeItemDetails.mockResolvedValue([]);
      await getTool('listItemCustomisations')!.callback({ listUuid: LIST, locale: 'en-US' });
      expect(mockDescribeItemDetails).toHaveBeenCalledWith(LIST, 'en-US');
    });
  });

  describe('batchUpdateItems', () => {
    it('maps itemName/specification onto the client shape', async () => {
      mockBatchUpdateList.mockResolvedValue(undefined);
      await getTool('batchUpdateItems')!.callback({
        listUuid: LIST,
        changes: [
          { itemName: 'Milch', operation: 'TO_PURCHASE', specification: '1L' },
          { itemName: 'Äpfel', operation: 'TO_RECENTLY' },
        ],
      });
      expect(mockBatchUpdateList).toHaveBeenCalledWith(LIST, [
        { itemId: 'Milch', spec: '1L', uuid: undefined, operation: 'TO_PURCHASE' },
        // undefined, NOT ''. This assertion used to read `spec: ''` and so
        // cemented the defect it should have caught: the tool coerced "none
        // given" into "clear it", which made the spec-carry in batchUpdateList
        // dead code and blanked an existing item's specification on every re-add.
        { itemId: 'Äpfel', spec: undefined, uuid: undefined, operation: 'TO_RECENTLY' },
      ]);
    });

    /** The client-level carry test lives in behaviour.spec, but it calls
     *  batchUpdateList directly with `spec` absent - which is exactly the path
     *  the tool's `?? ''` bypassed. This asserts the mapping the tool actually
     *  produces, so the two layers can no longer disagree silently. */
    it('passes an explicit empty specification through as a clear', async () => {
      mockBatchUpdateList.mockResolvedValue(undefined);
      await getTool('batchUpdateItems')!.callback({
        listUuid: LIST,
        changes: [{ itemName: 'Milch', operation: 'TO_PURCHASE', specification: '' }],
      });
      expect(mockBatchUpdateList).toHaveBeenCalledWith(LIST, [
        { itemId: 'Milch', spec: '', uuid: undefined, operation: 'TO_PURCHASE' },
      ]);
    });
  });

  describe('renameItem', () => {
    it('reports whether a customisation travelled with the rename', async () => {
      mockRenameItem.mockResolvedValue({ movedDetail: true });
      const withIcon = await getTool('renameItem')!.callback({ listUuid: LIST, fromName: 'a', toName: 'b' });
      expect(withIcon.content[0].text).toContain('carried over');

      mockRenameItem.mockResolvedValue({ movedDetail: false });
      const without = await getTool('renameItem')!.callback({ listUuid: LIST, fromName: 'a', toName: 'b' });
      expect(without.content[0].text).toContain('no custom icon');
    });
  });

  describe('setListArticleLanguage', () => {
    it('delegates to the client', async () => {
      mockSetListArticleLanguage.mockResolvedValue(undefined);
      await getTool('setListArticleLanguage')!.callback({ listUuid: LIST, locale: 'pt-BR' });
      expect(mockSetListArticleLanguage).toHaveBeenCalledWith(LIST, 'pt-BR');
    });
  });
});

describe('MCP Bring! Server - raw escape hatch', () => {
  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.clearAllMocks();
    mockTools.clear();
  });

  afterEach(() => {
    delete process.env.BRING_MCP_RAW;
    consoleErrorSpy.mockRestore();
  });

  it('is registered only when BRING_MCP_RAW=1', async () => {
    process.env.BRING_MCP_RAW = '1';
    await loadServer();
    expect(getTool('bringApiRaw')).toBeDefined();
  });
});
