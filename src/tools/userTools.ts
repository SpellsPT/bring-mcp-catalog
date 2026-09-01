import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BringClient } from '../bringClient.js';
import { registerTool } from '../index.js';
import { listUuidParam } from '../schemaShared.js';

export function registerUserTools(server: McpServer, bc: BringClient) {
  const getAllUsersFromListParams = z.object({
    ...listUuidParam,
  });
  registerTool({
    server,
    bc,
    name: 'getAllUsersFromList',
    description: 'Get all users associated with a specific shopping list.',
    schemaShape: getAllUsersFromListParams.shape,
    actionFn: async (args: z.infer<typeof getAllUsersFromListParams>, bc: BringClient) =>
      bc.getAllUsersFromList(args.listUuid),
    failureMessage: 'Failed to get all users from list',
  });

  registerTool({
    server,
    bc,
    name: 'getUserSettings',
    description: 'Get the settings for the current authenticated user.',
    schemaShape: undefined,
    actionFn: async (_args: undefined, bc: BringClient) => bc.getUserSettings(),
    failureMessage: 'Failed to get user settings',
  });

  registerTool({
    server,
    bc,
    name: 'getPendingInvitations',
    description: 'Get any pending invitations for the authenticated user to join shopping lists.',
    schemaShape: undefined,
    actionFn: async (_args: undefined, bc: BringClient) => bc.getPendingInvitations(),
    failureMessage: 'Failed to get pending invitations',
  });

  /**
   * `defaultListUUID` only appears in usersettings for accounts that have
   * explicitly set a default list (verified 2026-08-29: an account that never
   * has carries just `autoPush` and `onboardClient`). Relying on it alone made
   * this throw on every call for such accounts - and since the description
   * steers the assistant here whenever no list was named, that is the most
   * common path, not an edge case.
   *
   * So: prefer the setting, then fall back to the account's lists. A single
   * list is unambiguous and is returned; several with no default set is
   * genuinely ambiguous, so that still errors, but names the candidates
   * instead of just failing.
   */
  registerTool({
    server,
    bc,
    name: 'getDefaultList',
    description:
      'Get the UUID of the default shopping list for the authenticated user. Use this if the user does not ask for a special list.',
    schemaShape: undefined,
    actionFn: async (_args: undefined, bc: BringClient) => {
      const settings = await bc.getUserSettings();
      const lists = (await bc.loadLists())?.lists ?? [];

      // @ts-expect-error The bring-shopping type GetUserSettingsResponse may be outdated
      // and not include usersettings array structure, which is expected based on API observation.
      if (settings && settings.usersettings && Array.isArray(settings.usersettings)) {
        // @ts-expect-error The bring-shopping type GetUserSettingsResponse may be outdated.
        const defaultListSetting = settings.usersettings.find(
          (setting: { key: string; value: string }) => setting.key === 'defaultListUUID',
        );
        // A stored default that points at a list the account no longer has (left
        // or deleted) would send every subsequent tool call at a dead uuid, so
        // it is only honoured when it still exists; otherwise fall through.
        if (defaultListSetting && lists.some((l: { listUuid: string }) => l.listUuid === defaultListSetting.value)) {
          return defaultListSetting.value;
        }
      }

      if (lists.length === 1) {
        return lists[0].listUuid;
      }
      if (lists.length === 0) {
        throw new Error('No default list is set and the account has no lists.');
      }
      throw new Error(
        `No default list is set and the account has ${lists.length} lists. ` +
          `Ask which one, then pass its listUuid: ` +
          lists.map((l: { name: string; listUuid: string }) => `"${l.name}" (${l.listUuid})`).join(', '),
      );
    },
    failureMessage: 'Failed to get default list UUID',
    transformResult: (result: string) => ({
      content: [{ type: 'text', text: result }],
    }),
  });
}
