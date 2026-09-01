import {
  mockLoadLists, // Specific mock for this tool
  mockMcpServerInstance,
  mockTools,
  loadServer,
  getTool,
} from './helpers';

let consoleErrorSpy: jest.SpyInstance;

describe('MCP Bring! Server - List Tools', () => {
  beforeEach(async () => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.clearAllMocks();
    mockTools.clear();
    await loadServer();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('bring.loadLists tool', () => {
    it('should be registered with correct name, description, and schema', () => {
      expect(mockMcpServerInstance.tool).toHaveBeenCalledWith(
        'loadLists',
        'Load all shopping lists from Bring!',
        {}, // Schema for no-param tool
        expect.any(Function), // Callback
      );
      const tool = getTool('loadLists');
      expect(tool).toBeDefined();
      expect(tool?.description).toBe('Load all shopping lists from Bring!');
      expect(tool?.schema).toEqual({});
    });

    it('should call BringClient.loadLists and return lists on success', async () => {
      const fakeLists = [
        { listUuid: 'uuid1', name: 'Groceries' },
        { listUuid: 'uuid2', name: 'Work' },
      ];
      mockLoadLists.mockResolvedValue(fakeLists);

      const tool = getTool('loadLists');
      if (!tool) throw new Error('Tool loadLists not found');
      const result = await tool.callback({});

      expect(mockLoadLists).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(fakeLists, null, 2) }],
      });
    });

    it('should return an error message on failed loadLists', async () => {
      const errorMessage = 'Network error';
      mockLoadLists.mockRejectedValue(new Error(errorMessage));

      const tool = getTool('loadLists');
      if (!tool) throw new Error('Tool loadLists not found');
      const result = await tool.callback({});

      expect(mockLoadLists).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        content: [{ type: 'text', text: `Failed to load lists: ${errorMessage}` }],
        isError: true,
      });
    });
  });
});
