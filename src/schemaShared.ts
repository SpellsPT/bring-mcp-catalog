import { z } from 'zod';

export const listUuidParam = {
  listUuid: z.string().uuid({ message: 'Invalid list UUID' }),
};

export const itemIdParam = {
  itemId: z.string().min(1, { message: 'Item ID cannot be empty' }),
};

export const itemNameParam = {
  itemName: z.string().min(1, { message: 'Item name cannot be empty' }),
};

export const itemSpecificationParam = {
  specification: z.string().nullable().optional(),
};

const MAX_IMAGE_DATA_LENGTH = 6_990_508;
const BASE64_IMAGE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export const itemImageDataParam = {
  imageData: z
    .string()
    .min(1, { message: 'Image data cannot be empty' })
    .max(MAX_IMAGE_DATA_LENGTH, { message: 'Image data exceeds the 5 MiB limit' })
    .regex(BASE64_IMAGE_PATTERN, { message: 'Image data must be valid base64' })
    .refine((value) => value.length % 4 === 0, { message: 'Image data must be valid base64' }),
};

export const batchItemSchema = z.object({
  itemName: z.string().min(1, { message: 'Item name cannot be empty in batch' }),
  specification: z.string().nullable().optional(),
});

export const saveItemBatchParams = {
  ...listUuidParam,
  items: z.array(batchItemSchema).min(1, { message: 'Items array cannot be empty' }),
};

export const itemNamesArrayParam = {
  itemNames: z
    .array(z.string().min(1, { message: 'Item name in array cannot be empty' }))
    .min(1, { message: 'Item names array cannot be empty' }),
};

/**
 * Catalog ids are free-form German strings ("Äpfel", "WC-Papier"), so these
 * stay unconstrained beyond non-empty - no casing or charset assumptions.
 */
export const catalogQueryParam = {
  query: z.string().min(1, { message: 'Query cannot be empty' }),
};

export const iconParam = {
  icon: z.string().min(1, { message: 'Icon cannot be empty' }),
};

export const sectionParam = {
  section: z.string().min(1, { message: 'Section cannot be empty' }),
};

export const localeParam = {
  locale: z.string().min(2).optional(),
};

export const searchLimitParam = {
  limit: z.number().int().min(1).max(25).optional(),
};

export const batchChangeSchema = z.object({
  itemName: z.string().min(1, { message: 'Item name cannot be empty in batch' }),
  specification: z.string().nullable().optional(),
  uuid: z.string().uuid({ message: 'Invalid item UUID' }).optional(),
  operation: z.enum(['TO_PURCHASE', 'TO_RECENTLY', 'REMOVE']),
});

export const batchUpdateParams = {
  ...listUuidParam,
  changes: z.array(batchChangeSchema).min(1, { message: 'Changes array cannot be empty' }),
};

export const renameItemParams = {
  ...listUuidParam,
  fromName: z.string().min(1, { message: 'Current item name cannot be empty' }),
  toName: z.string().min(1, { message: 'New item name cannot be empty' }),
  specification: z.string().nullable().optional(),
};

export const apiRawParams = {
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
  path: z.string().min(1, { message: 'Path cannot be empty' }),
  encoding: z.enum(['none', 'form', 'json', 'multipart']).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
};
