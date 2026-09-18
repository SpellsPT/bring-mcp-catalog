import { z } from 'zod';

export const shoppingListSchema = z.object({
  listUuid: z.string().describe('Unique identifier of the shopping list.'),
  name: z.string().describe('Display name of the shopping list.'),
  theme: z.string().optional().describe('Bring! theme assigned to the shopping list.'),
});

export const loadListsOutputSchema = z.object({
  lists: z.array(shoppingListSchema),
});

export const shoppingItemSchema = z.object({
  name: z.string(),
  specification: z.string().nullable(),
  itemId: z.string().describe('Identifier accepted by item mutation tools.'),
});

export const getItemsOutputSchema = z.object({
  uuid: z.string(),
  status: z.string(),
  purchase: z.array(shoppingItemSchema),
  recently: z.array(shoppingItemSchema),
});

export const itemDetailsSchema = z.object({
  uuid: z.string(),
  itemId: z.string(),
  listUuid: z.string(),
  userIconItemId: z.string(),
  userSectionId: z.string(),
  assignedTo: z.string(),
  imageUrl: z.string(),
});

export const getItemsDetailsOutputSchema = z.array(itemDetailsSchema);

export const saveItemOutputSchema = z.object({
  success: z.literal(true),
  listUuid: z.string(),
  itemName: z.string(),
  specification: z.string().nullable(),
});

export const saveItemBatchOutputSchema = z.object({
  success: z.literal(true),
  listUuid: z.string(),
  count: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      itemName: z.string(),
      specification: z.string().nullable(),
    }),
  ),
});

export const itemMutationOutputSchema = z.object({
  success: z.literal(true),
  listUuid: z.string(),
  itemId: z.string(),
});

export const imageMutationOutputSchema = z.object({
  success: z.literal(true),
  itemId: z.string(),
  imageUrl: z.string().optional(),
});

export const deleteMultipleItemsOutputSchema = z.object({
  success: z.literal(true),
  listUuid: z.string(),
  count: z.number().int().nonnegative().describe('How many items were actually removed.'),
  itemNames: z.array(z.string()).describe('The names that were removed.'),
  notFound: z.array(z.string()).describe('Names that did not match anything on the list; nothing was done for them.'),
});

// Only the identity fields are always present. Bring omits the rest for some
// members - `photoPath` is simply absent for anyone without a profile photo -
// and a strict schema then failed the WHOLE call, hiding every member.
export const listUserSchema = z.object({
  publicUuid: z.string(),
  name: z.string(),
  email: z.string().optional(),
  photoPath: z.string().optional(),
  pushEnabled: z.boolean().optional(),
  plusTryOut: z.boolean().optional(),
  country: z.string().optional(),
  language: z.string().optional(),
});

export const getAllUsersOutputSchema = z.object({
  users: z.array(listUserSchema),
});

export const settingSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export const getUserSettingsOutputSchema = z.object({
  settings: z.array(settingSchema),
  listSettings: z.array(
    z.object({
      listUuid: z.string(),
      settings: z.array(settingSchema),
    }),
  ),
});

export const getPendingInvitationsOutputSchema = z.object({
  invitations: z.array(z.unknown()),
});

export const getDefaultListOutputSchema = z.object({
  listUuid: z.string().nullable(),
  source: z.enum(['configured', 'only-list', 'not-configured']),
  message: z.string().optional(),
});

export const translationsOutputSchema = z.record(z.string(), z.string());

export const catalogItemSchema = z.object({
  itemId: z.string(),
  name: z.string(),
});

export const catalogSectionSchema = z.object({
  sectionId: z.string(),
  name: z.string(),
  items: z.array(catalogItemSchema),
});

export const catalogOutputSchema = z.object({
  language: z.string(),
  catalog: z.object({
    sections: z.array(catalogSectionSchema),
  }),
});

// ---------------------------------------------------------------------------
// Catalog resolution, icon and section tools
// ---------------------------------------------------------------------------

export const catalogMatchSchema = z.object({
  itemId: z.string().describe('Canonical Bring! item id (looks German, e.g. "Äpfel"); store this to get the icon.'),
  sectionId: z.string(),
  names: z.record(z.string(), z.string()).describe('Display name per indexed locale.'),
  score: z.number(),
  matchedOn: z.string(),
  viaInflection: z.boolean().optional(),
  nearest: z
    .boolean()
    .optional()
    .describe('Spelling-nearest suggestion returned because nothing matched. Never attachable.'),
});

export const findCatalogItemOutputSchema = z.object({
  matches: z.array(catalogMatchSchema),
});

export const sectionMatchSchema = z.object({
  sectionId: z.string(),
  names: z.record(z.string(), z.string()),
  score: z.number(),
});

export const findCatalogSectionOutputSchema = z.object({
  matches: z.array(sectionMatchSchema),
});

export const saveItemResolvedOutputSchema = z.object({
  storedAs: z.string(),
  resolved: catalogMatchSchema.nullable(),
  mode: z.enum(['canonical', 'text-with-icon', 'text-only']),
  iconError: z.string().optional(),
  reusedExistingName: z.string().optional(),
  keptExistingIcon: z.string().optional(),
});

/** The detail record as Bring! returns it - only the fields callers rely on are pinned. */
const itemDetailRecordSchema = z.looseObject({
  uuid: z.string().optional(),
  itemId: z.string(),
  userIconItemId: z.string().nullable().optional(),
  userSectionId: z.string().nullable().optional(),
});

export const setItemIconOutputSchema = z.object({
  detail: itemDetailRecordSchema,
  resolvedIcon: catalogMatchSchema,
});

export const setItemSectionOutputSchema = z.object({
  detail: itemDetailRecordSchema,
  resolvedSection: z.object({
    sectionId: z.string(),
    names: z.record(z.string(), z.string()),
  }),
});

export const removeItemCustomisationOutputSchema = z.object({
  removed: z.boolean(),
});

export const itemCustomisationSchema = z.object({
  itemId: z.string(),
  uuid: z.string(),
  icon: z.string().nullable(),
  iconLabel: z.string().nullable(),
  section: z.string().nullable(),
  sectionLabel: z.string().nullable(),
  hasImage: z.boolean(),
});

export const listItemCustomisationsOutputSchema = z.object({
  customisations: z.array(itemCustomisationSchema),
});

export const batchUpdateOutputSchema = z.object({
  applied: z.array(z.string()),
  notFound: z.array(z.string()),
});

export const renameItemOutputSchema = z.object({
  movedDetail: z.boolean(),
  stayedInRecently: z.boolean(),
  specificationCarried: z.string(),
  lostAutomaticIcon: z.boolean(),
  lostImage: z.boolean(),
});

export const setListArticleLanguageOutputSchema = z.object({
  success: z.literal(true),
  listUuid: z.string(),
  locale: z.string(),
});

export const apiRawOutputSchema = z.object({
  response: z.unknown(),
});
