import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BringClient } from '../bringClient.js';
import { registerTool } from '../index.js';
import {
  listUuidParam,
  itemNameParam,
  itemSpecificationParam,
  catalogQueryParam,
  iconParam,
  sectionParam,
  localeParam,
  searchLimitParam,
  batchUpdateParams,
  renameItemParams,
  apiRawParams,
} from '../schemaShared.js';

/**
 * Tools built on Bring's catalog and item-detail endpoints.
 *
 * Background that makes these tools make sense: Bring stores an item by a
 * canonical, language-independent id (which happens to look German - `Äpfel`,
 * `Kartoffeln`) and every client renders that id in the list's own article
 * language. An item stored as `Äpfel` shows up as "Maçãs" on a Portuguese
 * phone, with the right icon and aisle. An item stored as free text
 * ("Apples / Maçãs") shows up verbatim, with no icon, forever.
 */
export function registerIconTools(server: McpServer, bc: BringClient) {
  const findCatalogItemParams = z.object({ ...catalogQueryParam, ...searchLimitParam });
  registerTool({
    server,
    bc,
    name: 'findCatalogItem',
    description:
      "Search Bring's item catalog in any supported language and return canonical item ids, ranked by " +
      'score. Use this to discover the correct itemId before calling saveItemResolved or setItemIcon. ' +
      'Scores below 50 are weak hints and are never applied automatically; only a confident, untied ' +
      'match is ever auto-attached by the other tools.',
    schemaShape: findCatalogItemParams.shape,
    actionFn: async (args: z.infer<typeof findCatalogItemParams>, bc: BringClient) =>
      bc.findCatalogItem(args.query, args.limit ?? 5),
    failureMessage: 'Failed to search the catalog',
  });

  const findCatalogSectionParams = z.object({ ...catalogQueryParam, ...searchLimitParam });
  registerTool({
    server,
    bc,
    name: 'findCatalogSection',
    description: "Search Bring's list sections (aisles) in any supported language and return canonical section ids.",
    schemaShape: findCatalogSectionParams.shape,
    actionFn: async (args: z.infer<typeof findCatalogSectionParams>, bc: BringClient) =>
      bc.findCatalogSection(args.query, args.limit ?? 5),
    failureMessage: 'Failed to search catalog sections',
  });

  const saveItemResolvedParams = z.object({
    ...listUuidParam,
    ...catalogQueryParam,
    ...itemSpecificationParam,
  });
  registerTool({
    server,
    bc,
    name: 'saveItemResolved',
    description:
      'Add an item to a list, storing it as a catalog item when one matches so it displays in the ' +
      "list's own language with the correct icon and aisle. Prefer this over saveItem: " +
      'saveItemResolved("maçãs") stores `Äpfel`, which a Portuguese client shows as "Maçãs" with an ' +
      'apple icon. Falls back to storing the text verbatim when no catalog item matches.',
    schemaShape: saveItemResolvedParams.shape,
    actionFn: async (args: z.infer<typeof saveItemResolvedParams>, bc: BringClient) =>
      bc.saveItemResolved(args.listUuid, args.query, args.specification),
    transformResult: (result: {
      storedAs: string;
      resolved: { itemId: string } | null;
      mode: 'canonical' | 'text-with-icon' | 'text-only';
      iconError?: string;
      reusedExistingName?: string;
    }) => {
      const text = result.iconError
        ? `Saved as "${result.storedAs}" - the item IS on the list - but attaching the ` +
          `"${result.resolved?.itemId}" icon failed: ${result.iconError} ` +
          `Retry with setItemIcon; do not re-save the item.`
        : result.reusedExistingName
          ? `The list already has "${result.reusedExistingName}", which is the same product ` +
            `(${result.resolved?.itemId}) - updated that entry instead of adding a duplicate row.`
          : result.mode === 'canonical'
            ? `Saved as catalog item "${result.storedAs}" - renders in the list's language with its icon.`
            : result.mode === 'text-with-icon'
              ? `Saved as "${result.storedAs}" (kept verbatim) and given the icon of "${result.resolved?.itemId}".`
              : `Saved as "${result.storedAs}". No catalog match (or an ambiguous one), so it has no icon. ` +
                `Use findCatalogItem to search, then setItemIcon to give it one.`;
      return { content: [{ type: 'text' as const, text }] };
    },
    failureMessage: 'Failed to save item',
  });

  const setItemIconParams = z.object({ ...listUuidParam, ...itemNameParam, ...iconParam });
  registerTool({
    server,
    bc,
    name: 'setItemIcon',
    description:
      'Give an existing list item an icon. Use for custom items that are not in the catalog ' +
      '(e.g. "Escova De Dentes Colgate Maquina"). The icon may be a canonical itemId or a phrase in ' +
      'any supported language; it is resolved against the catalog. Creates the item detail record if ' +
      'the item does not have one yet.',
    schemaShape: setItemIconParams.shape,
    actionFn: async (args: z.infer<typeof setItemIconParams>, bc: BringClient) =>
      bc.setItemIcon(args.listUuid, args.itemName, args.icon),
    transformResult: (result: { detail: { itemId: string }; resolvedIcon: { itemId: string } }) => ({
      content: [
        {
          type: 'text' as const,
          text: `"${result.detail.itemId}" now uses the icon of catalog item "${result.resolvedIcon.itemId}".`,
        },
      ],
    }),
    failureMessage: 'Failed to set item icon',
  });

  const setItemSectionParams = z.object({ ...listUuidParam, ...itemNameParam, ...sectionParam });
  registerTool({
    server,
    bc,
    name: 'setItemSection',
    description:
      'Move a list item into a different section (aisle). Section may be a canonical sectionId or a ' +
      'phrase in any supported language. Creates the item detail record if needed.',
    schemaShape: setItemSectionParams.shape,
    actionFn: async (args: z.infer<typeof setItemSectionParams>, bc: BringClient) =>
      bc.setItemSection(args.listUuid, args.itemName, args.section),
    transformResult: (result: { detail: { itemId: string }; resolvedSection: { sectionId: string } }) => ({
      content: [
        {
          type: 'text' as const,
          text: `"${result.detail.itemId}" moved to section "${result.resolvedSection.sectionId}".`,
        },
      ],
    }),
    failureMessage: 'Failed to set item section',
  });

  const removeItemIconParams = z.object({ ...listUuidParam, ...itemNameParam });
  registerTool({
    server,
    bc,
    name: 'removeItemCustomisation',
    description:
      "Delete an item's detail record, removing its custom icon and section. The item itself stays " + 'on the list.',
    schemaShape: removeItemIconParams.shape,
    actionFn: async (args: z.infer<typeof removeItemIconParams>, bc: BringClient) =>
      bc.removeItemDetail(args.listUuid, args.itemName),
    transformResult: (removed: boolean) => ({
      content: [
        {
          type: 'text' as const,
          text: removed ? 'Customisation removed.' : 'That item had no customisation to remove.',
        },
      ],
    }),
    failureMessage: 'Failed to remove item customisation',
  });

  const listItemIconsParams = z.object({ ...listUuidParam, ...localeParam });
  registerTool({
    server,
    bc,
    name: 'listItemCustomisations',
    description:
      'List every item on a list that has a custom icon or section, with the icon and section names ' +
      'translated into a readable language (default pt-BR). Raw getItemsDetails returns German ' +
      'canonical ids, which are hard to read.',
    schemaShape: listItemIconsParams.shape,
    actionFn: async (args: z.infer<typeof listItemIconsParams>, bc: BringClient) =>
      bc.describeItemDetails(args.listUuid, args.locale),
    failureMessage: 'Failed to list item customisations',
  });

  const batchUpdateSchema = z.object(batchUpdateParams);
  registerTool({
    server,
    bc,
    name: 'batchUpdateItems',
    description:
      'Apply several list changes in one call. Each change has an operation: TO_PURCHASE (add / move ' +
      'to buy), TO_RECENTLY (mark bought), REMOVE. Items are addressed by NAME and the name must match ' +
      'what is stored on the list exactly - call getItems first if unsure, because a name that does not ' +
      'match is a no-op. An optional uuid may be given on TO_PURCHASE to create an item with a known ' +
      'identity; it is ignored for TO_RECENTLY and REMOVE, which Bring only accepts by name. ' +
      'Applied one at a time and not atomic: a failure part-way leaves earlier changes applied.',
    schemaShape: batchUpdateSchema.shape,
    actionFn: async (args: z.infer<typeof batchUpdateSchema>, bc: BringClient) =>
      bc.batchUpdateList(
        args.listUuid,
        args.changes.map((c) => ({
          itemId: c.itemName,
          // NOT `?? ''`: that collapsed "none given" into "clear it", which made
          // the spec-carry in batchUpdateList dead code and blanked an existing
          // item's specification on every re-add. Found by DeepSeek Pro and the
          // local model independently; the tool test below used to assert the bug.
          spec: c.specification,
          uuid: c.uuid,
          operation: c.operation,
        })),
      ),
    transformResult: (result: { applied: string[]; notFound: string[] }) => ({
      content: [
        {
          type: 'text' as const,
          text:
            (result.applied.length ? `Applied: ${result.applied.join(', ')}.` : 'Nothing was applied.') +
            (result.notFound.length
              ? ` NOT FOUND, skipped (check exact names with getItems): ${result.notFound.join(', ')}.`
              : ''),
        },
      ],
    }),
    failureMessage: 'Failed to apply batch update',
  });

  const renameSchema = z.object(renameItemParams);
  registerTool({
    server,
    bc,
    name: 'renameItem',
    description:
      'Rename an item on a list, carrying its custom icon and section across. Detail records are keyed ' +
      'by item name, so renaming with saveItem/removeItem would silently lose the icon.',
    schemaShape: renameSchema.shape,
    actionFn: async (args: z.infer<typeof renameSchema>, bc: BringClient) =>
      bc.renameItem(args.listUuid, args.fromName, args.toName, args.specification ?? undefined),
    transformResult: (result: {
      movedDetail: boolean;
      stayedInRecently: boolean;
      specificationCarried: string;
      lostAutomaticIcon: boolean;
      lostImage: boolean;
    }) => {
      const parts = [
        result.movedDetail
          ? 'Item renamed; its custom icon and section were carried over.'
          : 'Item renamed. It had no custom icon or section.',
      ];
      if (result.specificationCarried) parts.push(`Specification "${result.specificationCarried}" kept.`);
      if (result.stayedInRecently) parts.push('It was in "recently" and was left there.');
      // Say what was lost. Silence here previously read as "nothing was lost".
      if (result.lostAutomaticIcon) {
        parts.push(
          'WARNING: the old name was a catalog item, so it had an automatic icon that the new name does not. ' +
            'Use setItemIcon to pin one.',
        );
      }
      if (result.lostImage) parts.push('WARNING: the item had a photo, which could not be carried over.');
      return { content: [{ type: 'text' as const, text: parts.join(' ') }] };
    },
    failureMessage: 'Failed to rename item',
  });

  const setLanguageParams = z.object({
    ...listUuidParam,
    locale: z.string().min(2, { message: 'Locale cannot be empty' }),
  });
  registerTool({
    server,
    bc,
    name: 'setListArticleLanguage',
    description:
      'Set the article language for a list, which decides how catalog items are displayed and which ' +
      'names auto-match. Note Bring has pt-BR but no pt-PT. Clients fall back to the device locale ' +
      'when no value is stored, so an unset list is not necessarily German.',
    schemaShape: setLanguageParams.shape,
    actionFn: async (args: z.infer<typeof setLanguageParams>, bc: BringClient) =>
      bc.setListArticleLanguage(args.listUuid, args.locale),
    transformResult: () => ({
      content: [{ type: 'text' as const, text: 'List article language updated.' }],
    }),
    failureMessage: 'Failed to set list article language',
  });

  // Unrestricted API access is useful while exploring undocumented endpoints but
  // has no place on a live assistant, so it is opt-in per process.
  if (process.env.BRING_MCP_RAW === '1') {
    const apiRawSchema = z.object(apiRawParams);
    registerTool({
      server,
      bc,
      name: 'bringApiRaw',
      description:
        'Escape hatch: send an arbitrary authenticated request to the Bring! API. Path is relative to ' +
        'https://api.getbring.com/rest/ (e.g. "v2/bringlistitemdetails/<uuid>"). Note the item-detail ' +
        'collection accepts only multipart, its sub-resources only form. Enabled by BRING_MCP_RAW=1.',
      schemaShape: apiRawSchema.shape,
      actionFn: async (args: z.infer<typeof apiRawSchema>, bc: BringClient) =>
        bc.apiRaw(args.method, args.path, args.encoding ?? 'none', args.body),
      failureMessage: 'Raw API call failed',
    });
  }
}
