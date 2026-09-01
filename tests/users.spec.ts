import {
  mockGetAllUsersFromList,
  mockGetUserSettings,
  mockGetPendingInvitations,
  mockLoadLists,
  mockMcpServerInstance,
  mockTools,
  loadServer,
  getTool,
} from './helpers';

let consoleErrorSpy: jest.SpyInstance;

describe('MCP Bring! Server - User Tools', () => {
  beforeEach(async () => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.clearAllMocks();
    mockTools.clear();
    await loadServer();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  // Test for getAllUsersFromList
  describe('bring.getAllUsersFromList tool', () => {
    const toolSchema = { listUuid: expect.any(Object) }; // Zod string

    it('should be registered correctly', () => {
      expect(mockMcpServerInstance.tool).toHaveBeenCalledWith(
        'getAllUsersFromList',
        'Get all users associated with a specific shopping list.',
        toolSchema,
        expect.any(Function),
      );
      const tool = getTool('getAllUsersFromList');
      expect(tool).toBeDefined();
      expect(tool?.description).toBe('Get all users associated with a specific shopping list.');
      expect(tool?.schema).toMatchObject({ listUuid: {} });
    });

    it('should return users on success', async () => {
      const fakeListUuid = 'list-users';
      const fakeUsers = [
        { id: 'user1', name: 'Alice' },
        { id: 'user2', name: 'Bob' },
      ];
      mockGetAllUsersFromList.mockResolvedValue(fakeUsers);
      const tool = getTool('getAllUsersFromList');
      if (!tool) throw new Error('Tool getAllUsersFromList not found');
      const result = await tool.callback({ listUuid: fakeListUuid });
      expect(mockGetAllUsersFromList).toHaveBeenCalledWith(fakeListUuid);
      expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fakeUsers, null, 2) }] });
    });

    it('should return error on failure', async () => {
      const fakeListUuid = 'list-users-fail';
      const error = new Error('Failed to get users');
      mockGetAllUsersFromList.mockRejectedValue(error);
      const tool = getTool('getAllUsersFromList');
      if (!tool) throw new Error('Tool getAllUsersFromList not found');
      const result = await tool.callback({ listUuid: fakeListUuid });
      expect(result).toEqual({
        content: [{ type: 'text', text: `Failed to get all users from list: ${error.message}` }],
        isError: true,
      });
    });
  });

  // Test for getUserSettings
  describe('bring.getUserSettings tool', () => {
    it('should be registered correctly', () => {
      expect(mockMcpServerInstance.tool).toHaveBeenCalledWith(
        'getUserSettings',
        'Get the settings for the current authenticated user.',
        {},
        expect.any(Function),
      );
      const tool = getTool('getUserSettings');
      expect(tool).toBeDefined();
      expect(tool?.description).toBe('Get the settings for the current authenticated user.');
      expect(tool?.schema).toEqual({});
    });

    it('should return settings on success', async () => {
      const fakeSettings = { theme: 'dark', notifications: true };
      mockGetUserSettings.mockResolvedValue(fakeSettings);
      const tool = getTool('getUserSettings');
      if (!tool) throw new Error('Tool getUserSettings not found');
      const result = await tool.callback({});
      expect(mockGetUserSettings).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fakeSettings, null, 2) }] });
    });

    it('should return error on failure', async () => {
      const error = new Error('Failed to get settings');
      mockGetUserSettings.mockRejectedValue(error);
      const tool = getTool('getUserSettings');
      if (!tool) throw new Error('Tool getUserSettings not found');
      const result = await tool.callback({});
      expect(result).toEqual({
        content: [{ type: 'text', text: `Failed to get user settings: ${error.message}` }],
        isError: true,
      });
    });
  });

  // Test for getPendingInvitations
  describe('bring.getPendingInvitations tool', () => {
    it('should be registered correctly', () => {
      expect(mockMcpServerInstance.tool).toHaveBeenCalledWith(
        'getPendingInvitations',
        'Get any pending invitations for the authenticated user to join shopping lists.',
        {},
        expect.any(Function),
      );
      const tool = getTool('getPendingInvitations');
      expect(tool).toBeDefined();
      expect(tool?.description).toBe('Get any pending invitations for the authenticated user to join shopping lists.');
      expect(tool?.schema).toEqual({});
    });

    it('should return invitations on success', async () => {
      const fakeInvitations = [{ listId: 'list-invite', fromUser: 'UserA' }];
      mockGetPendingInvitations.mockResolvedValue(fakeInvitations);
      const tool = getTool('getPendingInvitations');
      if (!tool) throw new Error('Tool getPendingInvitations not found');
      const result = await tool.callback({});
      expect(mockGetPendingInvitations).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fakeInvitations, null, 2) }] });
    });

    it('should return error on failure', async () => {
      const error = new Error('Failed to get invitations');
      mockGetPendingInvitations.mockRejectedValue(error);
      const tool = getTool('getPendingInvitations');
      if (!tool) throw new Error('Tool getPendingInvitations not found');
      const result = await tool.callback({});
      expect(result).toEqual({
        content: [{ type: 'text', text: `Failed to get pending invitations: ${error.message}` }],
        isError: true,
      });
    });
  });

  // Test for getDefaultList
  describe('bring.getDefaultList tool', () => {
    it('should be registered correctly', () => {
      expect(mockMcpServerInstance.tool).toHaveBeenCalledWith(
        'getDefaultList',
        'Get the UUID of the default shopping list for the authenticated user. Use this if the user does not ask for a special list.',
        {}, // No schema for this tool
        expect.any(Function),
      );
      const tool = getTool('getDefaultList');
      expect(tool).toBeDefined();
      expect(tool?.description).toBe(
        'Get the UUID of the default shopping list for the authenticated user. Use this if the user does not ask for a special list.',
      );
      expect(tool?.schema).toEqual({});
    });

    it('should return default list UUID on success', async () => {
      const fakeSettings = {
        usersettings: [
          { key: 'someOtherSetting', value: 'someValue' },
          { key: 'defaultListUUID', value: 'default-list-uuid-123' },
          { key: 'anotherSetting', value: 'anotherValue' },
        ],
      };
      // getDefaultList also validates the stored uuid against the account's
      // actual lists (a stale default would aim every later call at a dead
      // uuid), so the list must exist for the setting to be honoured.
      mockGetUserSettings.mockResolvedValue(fakeSettings);
      mockLoadLists.mockResolvedValue({
        lists: [{ listUuid: 'default-list-uuid-123', name: 'Home', theme: 't' }],
      });
      const tool = getTool('getDefaultList');
      if (!tool) throw new Error('Tool getDefaultList not found');

      const result = await tool.callback({});
      expect(mockGetUserSettings).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        content: [{ type: 'text', text: 'default-list-uuid-123' }],
      });
    });

    it('ignores a stored default that points at a list the account no longer has', async () => {
      mockGetUserSettings.mockResolvedValue({
        usersettings: [{ key: 'defaultListUUID', value: 'dead-uuid' }],
      });
      mockLoadLists.mockResolvedValue({ lists: [{ listUuid: 'live-uuid', name: 'Home', theme: 't' }] });
      const tool = getTool('getDefaultList');
      if (!tool) throw new Error('Tool getDefaultList not found');

      const result = await tool.callback({});
      expect(result).toEqual({ content: [{ type: 'text', text: 'live-uuid' }] });
    });

    /**
     * Real accounts often carry no `defaultListUUID` at all - one verified on
     * 2026-08-29 had only `autoPush` and `onboardClient` - and this tool's own
     * description steers the assistant here whenever no list was named. Falling
     * back to the account's lists turns the most common path from a guaranteed
     * error into an answer.
     */
    it('falls back to the only list when no defaultListUUID is set', async () => {
      mockGetUserSettings.mockResolvedValue({
        usersettings: [
          { key: 'autoPush', value: 'ON' },
          { key: 'onboardClient', value: 'webApp' },
        ],
      });
      mockLoadLists.mockResolvedValue({ lists: [{ listUuid: 'only-list-uuid', name: 'Home', theme: 't' }] });
      const tool = getTool('getDefaultList');
      if (!tool) throw new Error('Tool getDefaultList not found');

      const result = await tool.callback({});
      expect(mockGetUserSettings).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ content: [{ type: 'text', text: 'only-list-uuid' }] });
    });

    it('should return error if getUserSettings fails', async () => {
      const error = new Error('Failed to get user settings from API');
      mockGetUserSettings.mockRejectedValue(error);
      const tool = getTool('getDefaultList');
      if (!tool) throw new Error('Tool getDefaultList not found');

      const result = await tool.callback({});
      expect(mockGetUserSettings).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        content: [{ type: 'text', text: `Failed to get default list UUID: ${error.message}` }],
        isError: true,
      });
    });

    it('falls back to the lists when the usersettings structure is unexpected', async () => {
      mockGetUserSettings.mockResolvedValue({ someOtherProperty: 'value' }); // no usersettings array
      mockLoadLists.mockResolvedValue({ lists: [{ listUuid: 'only-list-uuid', name: 'Home', theme: 't' }] });
      const tool = getTool('getDefaultList');
      if (!tool) throw new Error('Tool getDefaultList not found');

      const result = await tool.callback({});
      expect(result).toEqual({ content: [{ type: 'text', text: 'only-list-uuid' }] });
    });

    /** Several lists and no default set is genuinely ambiguous - name them. */
    it('errors with the candidates when several lists exist and no default is set', async () => {
      mockGetUserSettings.mockResolvedValue({ usersettings: [] });
      mockLoadLists.mockResolvedValue({
        lists: [
          { listUuid: 'a-uuid', name: 'Home', theme: 't' },
          { listUuid: 'b-uuid', name: 'Beach House', theme: 't' },
        ],
      });
      const tool = getTool('getDefaultList');
      if (!tool) throw new Error('Tool getDefaultList not found');

      const result = await tool.callback({});
      expect(result.content[0].text).toContain('2 lists');
      expect(result.content[0].text).toContain('"Home" (a-uuid)');
      expect(result.content[0].text).toContain('"Beach House" (b-uuid)');
    });

    it('errors clearly when the account has no lists at all', async () => {
      mockGetUserSettings.mockResolvedValue({ usersettings: [] });
      mockLoadLists.mockResolvedValue({ lists: [] });
      const tool = getTool('getDefaultList');
      if (!tool) throw new Error('Tool getDefaultList not found');

      const result = await tool.callback({});
      expect(result.content[0].text).toContain('no lists');
    });
  });
});
