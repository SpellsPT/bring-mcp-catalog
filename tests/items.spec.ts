import {
  getTool,
  loadServer,
  mockDeleteMultipleItemsFromList,
  mockGetItems,
  mockGetItemsDetails,
  mockMoveToRecentList,
  mockRemoveItem,
  mockSaveItem,
  mockSaveItemBatch,
  mockTools,
} from './helpers';

describe('item tools', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(async () => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.clearAllMocks();
    mockTools.clear();
    await loadServer();
  });

  afterEach(() => consoleErrorSpy.mockRestore());

  it('registers read and mutation tools with complete metadata', () => {
    for (const name of ['getItems', 'getItemsDetails']) {
      expect(getTool(name)).toMatchObject({
        title: expect.any(String),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      });
    }

    for (const name of ['saveItem', 'saveItemBatch', 'removeItem', 'moveToRecentList', 'deleteMultipleItemsFromList']) {
      expect(getTool(name)).toMatchObject({
        title: expect.any(String),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      });
      expect(getTool(name)?.inputSchema).toEqual(expect.objectContaining({ '~standard': expect.any(Object) }));
      expect(getTool(name)?.outputSchema).toEqual(expect.objectContaining({ '~standard': expect.any(Object) }));
    }

    expect(getTool('saveItem')?.schema).toEqual({
      listUuid: expect.anything(),
      itemName: expect.anything(),
      specification: expect.anything(),
    });
  });

  it('returns list items as natural structured content', async () => {
    const items = {
      uuid: 'list-1',
      status: 'SHARED',
      purchase: [{ name: 'Milk', specification: '1 L', itemId: 'Milk' }],
      recently: [{ name: 'Bread', specification: '', itemId: 'Bread' }],
    };
    mockGetItems.mockResolvedValue(items);

    const result = await getTool('getItems')!.callback({ listUuid: 'list-1' });

    expect(mockGetItems).toHaveBeenCalledWith('list-1');
    expect(result.structuredContent).toEqual(items);
    expect(result.content[0]?.text).toBe(JSON.stringify(items, null, 2));
  });

  it('returns item details as a root array for MCP 2026 projection', async () => {
    const details = [
      {
        uuid: 'detail-1',
        itemId: 'Milk',
        listUuid: 'list-1',
        userIconItemId: '',
        userSectionId: '',
        assignedTo: '',
        imageUrl: '',
      },
    ];
    mockGetItemsDetails.mockResolvedValue(details);

    const result = await getTool('getItemsDetails')!.callback({ listUuid: 'list-1' });

    expect(mockGetItemsDetails).toHaveBeenCalledWith('list-1');
    expect(result.structuredContent).toEqual(details);
  });

  it('normalizes a successful saveItem mutation', async () => {
    mockSaveItem.mockResolvedValue('');

    const result = await getTool('saveItem')!.callback({
      listUuid: 'list-1',
      itemName: 'Milk',
      specification: '2 L',
    });

    expect(mockSaveItem).toHaveBeenCalledWith('list-1', 'Milk', '2 L');
    expect(result.structuredContent).toEqual({
      success: true,
      listUuid: 'list-1',
      itemName: 'Milk',
      specification: '2 L',
    });
  });

  it('normalizes successful batch mutations', async () => {
    const items = [{ itemName: 'Eggs', specification: '12' }, { itemName: 'Apples' }];
    mockSaveItemBatch.mockResolvedValue(['', '']);
    mockDeleteMultipleItemsFromList.mockResolvedValue({ removed: ['Eggs', 'Apples'], notFound: [] });

    const saveResult = await getTool('saveItemBatch')!.callback({ listUuid: 'list-1', items });
    const deleteResult = await getTool('deleteMultipleItemsFromList')!.callback({
      listUuid: 'list-1',
      itemNames: ['Eggs', 'Apples'],
    });

    expect(mockSaveItemBatch).toHaveBeenCalledWith('list-1', items);
    expect(saveResult.structuredContent).toEqual({
      success: true,
      listUuid: 'list-1',
      count: 2,
      items: [
        { itemName: 'Eggs', specification: '12' },
        { itemName: 'Apples', specification: null },
      ],
    });
    expect(mockDeleteMultipleItemsFromList).toHaveBeenCalledWith('list-1', ['Eggs', 'Apples']);
    expect(deleteResult.structuredContent).toEqual({
      success: true,
      listUuid: 'list-1',
      count: 2,
      itemNames: ['Eggs', 'Apples'],
      notFound: [],
    });
  });

  it.each([
    ['removeItem', mockRemoveItem],
    ['moveToRecentList', mockMoveToRecentList],
  ])('normalizes the %s mutation', async (toolName, apiMock) => {
    apiMock.mockResolvedValue('');

    const result = await getTool(toolName)!.callback({ listUuid: 'list-1', itemId: 'Milk' });

    expect(apiMock).toHaveBeenCalledWith('list-1', 'Milk');
    expect(result.structuredContent).toEqual({ success: true, listUuid: 'list-1', itemId: 'Milk' });
  });

  it('marks API failures as MCP errors', async () => {
    mockRemoveItem.mockRejectedValue(new Error('Mutation failed'));

    const result = await getTool('removeItem')!.callback({ listUuid: 'list-1', itemId: 'Milk' });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Failed to remove item: Mutation failed' }],
      isError: true,
    });
  });

  it('reports names that were not on the list instead of claiming they were deleted', async () => {
    mockDeleteMultipleItemsFromList.mockResolvedValue({ removed: ['ItemA'], notFound: ['ItemB'] });

    const result = await getTool('deleteMultipleItemsFromList')!.callback({
      listUuid: 'list-1',
      itemNames: ['ItemA', 'ItemB'],
    });

    expect(result.structuredContent).toEqual({
      success: true,
      listUuid: 'list-1',
      count: 1,
      itemNames: ['ItemA'],
      notFound: ['ItemB'],
    });
    expect(result.content[0].text).toContain('Removed: ItemA.');
    expect(result.content[0].text).toContain('NOT FOUND');
    expect(result.content[0].text).toContain('ItemB');
  });
});
