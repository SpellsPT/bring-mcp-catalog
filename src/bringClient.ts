import Bring from 'bring-shopping';
import {
  BRING_API_BASE,
  bringDelete,
  bringForm,
  bringGet,
  bringJson,
  bringMultipart,
  extractAuthHeaders,
  type BringHeaders,
} from './bringHttp.js';
import {
  assertSupportedLocale,
  buildCatalog,
  catalogLocales,
  describeLocale,
  nearestItems,
  normalize,
  PERMUTATION_SCORE,
  resolveItem,
  resolveSection,
  type SectionMatch,
  type Catalog,
  type Match,
} from './catalog.js';

export type ItemDetail = {
  uuid: string;
  itemId: string;
  listUuid: string;
  userIconItemId: string;
  userSectionId: string;
  assignedTo: string;
  imageUrl: string;
};

export type BatchOperation = 'TO_PURCHASE' | 'TO_RECENTLY' | 'REMOVE';

export type BatchChange = {
  itemId: string;
  /**
   * Same three-way semantics as saveItem: undefined/null CARRIES the existing
   * specification, explicit '' CLEARS it, any other string replaces it. It was
   * `spec?: string`, which could not express "carry" - so the tool layer above
   * coerced with `?? ''` and every batch add silently blanked the spec.
   */
  spec?: string | null;
  uuid?: string;
  operation: BatchOperation;
};

const CATALOG_TTL_MS = 60 * 60 * 1000;

/**
 * Safety margin, in SECONDS, subtracted from the token's `exp` before it is
 * treated as expired. Measured 2026-08-29: Bring issues 7-day tokens, so this
 * re-authenticates ~2.8h early and the session is cached for ~165h. If Bring
 * ever shortened token life below this, every call would re-login instead.
 * The JWT carries `exp` but no `iat`, so lifetime is only measurable against
 * wall-clock.
 */
const TOKEN_EXPIRY_MARGIN_SECONDS = 10000;

/** Bar for "this IS that catalog item" - exact, or the same words reordered. */
const EXACT_MATCH_SCORE = 90;
/** Lower bar for "this is close enough to borrow an icon from". */
const ICON_MATCH_SCORE = 50;

/** The batch endpoint expects these on every change; the app sends zeroes. */
const NULL_LOCATION = { accuracy: '0.0', altitude: '0.0', latitude: '0.0', longitude: '0.0' };

export class BringClient {
  private bring = new Bring({ mail: process.env.MAIL!, password: process.env.PW! });
  private isLoggedIn = false;
  private tokenExpiresAt: Date | undefined;
  /**
   * Keyed, not a single slot. It used to be one `{key, at, catalog}`, so a
   * caller asking for a non-default locale set evicted the default one and the
   * two thrashed: alternating default / non-default calls refetched 3-4 full
   * catalogs EVERY time despite the 1h TTL. `catalogInFlight` below was already
   * a Map; only the cache itself was not.
   */
  private catalogCache = new Map<string, { at: number; catalog: Catalog }>();

  private async _login() {
    try {
      await this.bring.login();
      this.isLoggedIn = true;
      // Defensive: a non-JWT token used to throw a TypeError out of _login
      // AFTER Bring had already authenticated, so every later call re-logged-in
      // and failed the same way. A token with no numeric `exp` produced
      // `new Date(NaN)`, and `Date.now() <= NaN` is false, so ensureLoggedIn
      // re-authenticated on EVERY single call. Neither is fatal to us - we just
      // lose the expiry optimisation - so degrade instead of breaking login.
      const bearerToken = this.bring['bearerToken'] as string | undefined;
      const claims = bearerToken?.split('.')[1];
      this.tokenExpiresAt = undefined;
      if (claims) {
        try {
          const payload = JSON.parse(Buffer.from(claims, 'base64').toString());
          if (typeof payload?.exp === 'number' && Number.isFinite(payload.exp)) {
            this.tokenExpiresAt = new Date((payload.exp - TOKEN_EXPIRY_MARGIN_SECONDS) * 1000);
          }
        } catch {
          // Unparseable claims: fall through with no expiry hint.
        }
      }
    } catch (error) {
      this.isLoggedIn = false; // Ensure isLoggedIn is false if login fails
      throw error;
    }
  }

  private loginInFlight: Promise<void> | undefined;

  private async ensureLoggedIn() {
    if (this.isLoggedIn && this.tokenExpiresAt && Date.now() <= this.tokenExpiresAt.getTime()) {
      return;
    }
    // Serialise concurrent first calls. Without this, two tools in flight at
    // startup both see !isLoggedIn and both POST bringauth, the second clobbering
    // the first session. Everyone awaits the one in-flight login.
    if (!this.loginInFlight) {
      this.loginInFlight = this._login().finally(() => {
        this.loginInFlight = undefined;
      });
    }
    await this.loginInFlight;
  }

  /** Authenticated headers for endpoints `bring-shopping` does not wrap. */
  private async authHeaders(): Promise<BringHeaders> {
    await this.ensureLoggedIn();
    return extractAuthHeaders(this.bring);
  }

  private async userUuid(): Promise<string> {
    await this.ensureLoggedIn();
    return this.bring['uuid'] as string;
  }

  async loadLists() {
    await this.ensureLoggedIn();
    return this.bring.loadLists();
  }
  async getItems(listUuid: string) {
    await this.ensureLoggedIn();
    const listDetails = await this.bring.getItems(listUuid);

    // Define an interface for the item structure
    interface BringItem {
      name: string;
      specification: string;
      itemId?: string;
      // Add other potential properties if known
    }

    // Helper function to add itemId to items in an array
    const addItemIdToItems = (items: BringItem[]): BringItem[] => {
      if (Array.isArray(items)) {
        return items.map((item) => ({
          ...item,
          itemId: item.name, // Set itemId to be the same as name
        }));
      }
      return items; // Return original if not an array
    };

    // Bring identifies a list item by its name - there is no separate item id in
    // this response - so itemId is surfaced as a copy of name to make that
    // explicit to callers rather than implied.
    //
    // Returned as a new object rather than mutating the library's response in
    // place: callers should not have their input silently rewritten.
    if (listDetails && typeof listDetails === 'object') {
      // The bring.getItems() response type does not include itemId, so cast via
      // unknown to acknowledge the intentional reshaping.
      return {
        ...listDetails,
        purchase: listDetails.purchase
          ? (addItemIdToItems(listDetails.purchase as unknown as BringItem[]) as unknown as typeof listDetails.purchase)
          : listDetails.purchase,
        recently: listDetails.recently
          ? (addItemIdToItems(listDetails.recently as unknown as BringItem[]) as unknown as typeof listDetails.recently)
          : listDetails.recently,
      };
    }

    return listDetails;
  }
  async getItemsDetails(listUuid: string) {
    await this.ensureLoggedIn();
    return this.bring.getItemsDetails(listUuid);
  }
  /**
   * The legacy list-mutation endpoint, sent with correct form encoding.
   *
   * `bring-shopping` builds this body by string concatenation with no escaping
   * (`&purchase=${itemName}&recently=&specification=${specification}&...`), so
   * any `&`, `+` or `%` in a name corrupts the request - silently, because it
   * also never checks the response status:
   *
   *   "Fish & Chips"  -> stored as "Fish"            (truncated at &)
   *   "Salt + Pepper" -> stored as "Salt   Pepper"   (+ decoded as space)
   *   "50% Cream"     -> never arrives at all
   *
   * Going through `bringForm` fixes both problems at once: URLSearchParams
   * escapes the values, and a non-2xx now throws instead of being returned as
   * an ordinary string. Verified round-tripping all of the above plus accents.
   *
   * Returns the raw body (empty on the usual 204) so callers see exactly what
   * the library used to give them.
   */
  private async legacyListMutation(listUuid: string, fields: Record<string, string>): Promise<string> {
    // A CR/LF in an item name survives URLSearchParams (encoded, not rejected),
    // so this path would happily store an item whose name contains a newline -
    // which then can never get an icon, because the multipart detail endpoint
    // rejects newlines. Reject it here too, so the item is never created in
    // that stuck state. Symmetric with bringMultipart, and voice transcription
    // is a realistic source of a stray newline.
    for (const key of ['purchase', 'recently', 'remove'] as const) {
      const value = fields[key];
      if (value && /[\r\n]/.test(value)) {
        throw new Error(`Item name contains a line break, which cannot be stored. Remove it and retry.`);
      }
    }

    const headers = await this.authHeaders();
    const res = await bringForm(headers, 'PUT', `v2/bringlists/${listUuid}`, {
      purchase: '',
      recently: '',
      specification: '',
      remove: '',
      sender: 'null',
      ...fields,
    });
    return res.text;
  }

  /**
   * The save endpoint REPLACES the specification unconditionally on an existing
   * name (verified live: last write wins), so re-adding "Milk" with no spec
   * used to silently blank "2 litres" for everyone on the list.
   *
   * Spec semantics, consistent across every save path:
   *  - undefined / null  -> carry the existing item's spec (the common re-add)
   *  - '' (explicit)     -> CLEAR the spec - `||` used to make this impossible,
   *                         which silently blocked a legitimate edit
   *  - any other string  -> replace
   */
  async saveItem(
    listUuid: string,
    itemName: string,
    specification: string | null | undefined,
    /** An index the caller already fetched, to avoid a second identical read. */
    knownIndex?: Map<string, { specification: string; inRecently: boolean }>,
  ) {
    let spec = specification ?? '';
    if (specification == null) {
      const existing = (knownIndex ?? (await this.listNameIndex(listUuid))).get(itemName);
      if (existing?.specification) spec = existing.specification;
    }
    return this.legacyListMutation(listUuid, { purchase: itemName, specification: spec });
  }

  /**
   * The legacy endpoint answers 204 whether or not the name matched anything,
   * so a typo'd remove used to report success while the item stayed visible to
   * everyone. Both mutations now verify the name first and fail loudly; the
   * one extra read per call is cheap against a silent wrong outcome on a
   * shared list. renameItem uses legacyListMutation directly - it has already
   * verified its names.
   */
  async removeItem(listUuid: string, itemId: string) {
    await this.assertItemOnList(listUuid, itemId);
    return this.legacyListMutation(listUuid, { remove: itemId });
  }
  async moveToRecentList(listUuid: string, itemId: string) {
    await this.assertItemOnList(listUuid, itemId);
    return this.legacyListMutation(listUuid, { recently: itemId });
  }

  /**
   * Saves an image for an item on a shopping list.
   * @param itemUuid The UUID of the item.
   * @param imageData Base64-encoded image data.
   * @returns A promise that resolves when the image has been saved.
   */
  async saveItemImage(itemUuid: string, imageData: string): Promise<unknown> {
    // Not delegated to the library, which was broken twice over: it sent
    // form-urlencoded, which this endpoint rejects with 415 (verified live -
    // like its sibling create endpoint it accepts ONLY multipart), and it never
    // checked resp.ok, so that 415 HTML page went to JSON.parse and surfaced as
    // a bewildering parse error. In other words the vendored saveItemImage
    // cannot ever have worked against the live API. Multipart upload verified
    // live: 200 with the S3 imageUrl.
    const headers = await this.authHeaders();
    const res = await bringMultipart(headers, 'PUT', `v2/bringlistitemdetails/${itemUuid}/image`, { imageData });
    return res.data ?? { status: res.status };
  }

  /**
   * Removes an image from an item on a shopping list.
   * @param itemUuid The UUID of the item.
   * @returns A promise that resolves when the image has been removed.
   */
  async removeItemImage(itemUuid: string): Promise<unknown> {
    // See saveItemImage: the library variant returned the server's HTML error
    // page as a success on any failure. bringDelete throws on non-2xx.
    const headers = await this.authHeaders();
    const res = await bringDelete(headers, `v2/bringlistitemdetails/${itemUuid}/image`);
    return res.data ?? { status: res.status };
  }

  async getAllUsersFromList(listUuid: string) {
    await this.ensureLoggedIn();
    return this.bring.getAllUsersFromList(listUuid);
  }
  async getUserSettings() {
    await this.ensureLoggedIn();
    return this.bring.getUserSettings();
  }
  async loadTranslations(locale?: string) {
    const resolved = locale || 'en-US';
    assertSupportedLocale(resolved);
    await this.ensureLoggedIn();
    return this.bring.loadTranslations(resolved);
  }
  async loadCatalog(locale: string) {
    assertSupportedLocale(locale);
    await this.ensureLoggedIn();
    return this.bring.loadCatalog(locale);
  }
  async getPendingInvitations() {
    await this.ensureLoggedIn();
    return this.bring.getPendingInvitations();
  }

  // These two go through our own saveItem/removeItem rather than the library's,
  // so they inherit the escaping fix and the status check. Like every multi-item
  // operation here they are not atomic - a throw part-way leaves the earlier
  // items applied, because Bring offers no transaction.
  async saveItemBatch(listUuid: string, items: { itemName: string; specification?: string | null }[]) {
    // One list read for the whole batch, so spec preservation does not cost a
    // read per item. Same spec semantics as saveItem: null/undefined carries,
    // explicit '' clears.
    const index = await this.listNameIndex(listUuid);
    const results = [];
    for (const item of items) {
      const spec = item.specification ?? index.get(item.itemName)?.specification ?? '';
      const result = await this.legacyListMutation(listUuid, { purchase: item.itemName, specification: spec });
      // Keep the index current within the batch: the same name appearing twice
      // used to fall back to the PRE-batch spec on its second occurrence,
      // reverting the first occurrence's explicit value.
      index.set(item.itemName, { specification: spec, inRecently: false });
      results.push(result);
    }
    return results;
  }

  /**
   * Removes the names that are on the list and reports the ones that were not,
   * instead of no-opping the misses and calling everything deleted. Partial by
   * design: the found ones ARE removed even when others are missing.
   */
  async deleteMultipleItemsFromList(
    listUuid: string,
    itemNames: string[],
  ): Promise<{ removed: string[]; notFound: string[] }> {
    const index = await this.listNameIndex(listUuid);
    const removed: string[] = [];
    const notFound: string[] = [];
    // Dedupe: the same name twice would have its second occurrence 204-no-op
    // yet still be reported as removed, overstating the write.
    for (const itemName of [...new Set(itemNames)]) {
      if (!index.has(itemName)) {
        notFound.push(itemName);
        continue;
      }
      await this.legacyListMutation(listUuid, { remove: itemName });
      removed.push(itemName);
    }
    return { removed, notFound };
  }

  // ---------------------------------------------------------------------------
  // Catalog resolution
  // ---------------------------------------------------------------------------

  /** In-flight catalog builds, keyed like the cache, so concurrent callers share one fetch set. */
  private catalogInFlight = new Map<string, Promise<Catalog>>();

  /** Catalogs change rarely; one fetch per locale per hour is plenty. */
  private async getCatalog(locales: string[] = catalogLocales()): Promise<Catalog> {
    // Sorted, so ['de-DE','en-US'] and ['en-US','de-DE'] share one entry rather
    // than building the same catalog twice under two keys.
    const key = [...locales].sort().join(',');
    const cached = this.catalogCache.get(key);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
      return cached.catalog;
    }

    // Single-flight, like the login lock: three concurrent cold-cache callers
    // used to issue nine loadCatalog fetches (3 locales x 3 callers).
    const inFlight = this.catalogInFlight.get(key);
    if (inFlight) return inFlight;
    const build = this.buildCatalogUncached(locales, key).finally(() => {
      this.catalogInFlight.delete(key);
    });
    this.catalogInFlight.set(key, build);
    return build;
  }

  private async buildCatalogUncached(locales: string[], key: string): Promise<Catalog> {
    const raw = [];
    for (const locale of locales) {
      assertSupportedLocale(locale);
      const response = await this.loadCatalog(locale);
      raw.push({ locale, sections: response.catalog.sections });
    }

    const catalog = buildCatalog(raw);
    this.catalogCache.set(key, { at: Date.now(), catalog });
    return catalog;
  }

  async findCatalogItem(query: string, limit = 5): Promise<Match[]> {
    const catalog = await this.getCatalog();
    const matches = resolveItem(catalog, query, limit);
    if (matches.length > 0) return matches;
    // Nothing scored. Rather than hand back a bare [] - which tells a caller
    // nothing and invites it to guess another spelling and try again - offer the
    // spelling-nearest entries, flagged `nearest` with score 0 so they can never
    // be mistaken for a match. Search only; no write path sees these.
    return nearestItems(catalog, query, Math.min(limit, 3));
  }

  async findCatalogSection(query: string, limit = 5): Promise<SectionMatch[]> {
    const catalog = await this.getCatalog();
    return resolveSection(catalog, query, limit);
  }

  /**
   * Accepts either an exact canonical id or a phrase in any indexed language.
   * Returns null when nothing clears `minScore` - or when two entries tie for
   * the top score, at ANY tier.
   *
   * The tie check must cover the top tier too: the real catalog contains
   * display-name homographs that BOTH score 100 - "paprika" (Peperoni vs
   * Paprikapulver), "pimenta do reino" (Pfeffer vs Pfefferkörner), "chips",
   * "pasta". Without the check the winner was picked by alphabetical order and,
   * on the canonical path, silently replaced the user's text with a guessed
   * name - worse than a guessed icon. An exact canonical ID is exempt: ids are
   * unique by construction.
   */
  private async toCanonicalItemId(value: string, minScore = 50): Promise<Match | null> {
    const catalog = await this.getCatalog();
    const exact = catalog.entries.get(value);
    if (exact) {
      return { ...exact, score: 100, matchedOn: `itemId:${exact.itemId}` };
    }
    const [best, second] = resolveItem(catalog, value, 2);
    if (!best || best.score < minScore) return null;
    if (second && second.score === best.score) return null; // ambiguous - refuse to guess
    // An inflection-upgraded winner over a competing longer compound is a
    // genuine coin flip: "orangens" truncates Orangensaft yet upgraded Orange
    // past it, and "orangen" (the real plural) produces the identical score
    // pattern - indistinguishable without a lexicon. Refuse both rather than
    // attach the wrong icon half the time; a sole inflection match (laranjas,
    // milchs) still resolves.
    if (best.viaInflection && second && second.score >= 55) return null;
    return best;
  }

  // ---------------------------------------------------------------------------
  // Item details (icons and sections)
  //
  // Undocumented endpoints recovered from the Bring! web app source maps. See
  // bringHttp.ts for the encoding constraints.
  //
  // Known, accepted races (MCP clients MAY issue parallel tool calls):
  //  - get-detail-then-create: harmless duplicates are impossible - verified
  //    live 2026-08-30 that POST /bringlistitemdetails UPSERTS by
  //    (listUuid, itemId): a second create returns 200 with the SAME uuid.
  //    Residual is last-writer-wins on the icon value, which is the inherent
  //    semantics of concurrent writers anyway.
  //  - the saveItem spec-carry read-then-write: two parallel saves of the same
  //    name, one with a spec, can land in either order. Unlocked because Bring
  //    offers no conditional write to close it with; the window is one HTTP
  //    round-trip.
  // ---------------------------------------------------------------------------

  /** The names currently on the list, to-buy and recently, plus their specs. */
  private async listNameIndex(listUuid: string): Promise<Map<string, { specification: string; inRecently: boolean }>> {
    const items = await this.getItems(listUuid);
    const index = new Map<string, { specification: string; inRecently: boolean }>();
    for (const i of (items.recently ?? []) as unknown as { name: string; specification: string }[]) {
      index.set(i.name, { specification: i.specification ?? '', inRecently: true });
    }
    for (const i of (items.purchase ?? []) as unknown as { name: string; specification: string }[]) {
      index.set(i.name, { specification: i.specification ?? '', inRecently: false });
    }
    return index;
  }

  /** Throws with the actual list contents in reach when `itemName` is not on the list. */
  private async assertItemOnList(listUuid: string, itemName: string): Promise<void> {
    const index = await this.listNameIndex(listUuid);
    if (index.has(itemName)) return;
    throw new Error(
      `"${itemName}" is not on this list (checked to-buy and recently), so this would write against a ` +
        `name nobody sees. Check the exact stored name with getItems - names must match exactly.`,
    );
  }

  /** Null when the item has no detail record - the API answers 204, not 404. */
  async getItemDetail(listUuid: string, itemId: string): Promise<ItemDetail | null> {
    const headers = await this.authHeaders();
    const query = new URLSearchParams({ listUuid, itemId }).toString();
    const res = await bringGet(headers, `v2/bringlistitemdetails?${query}`);
    return (res.data as ItemDetail) ?? null;
  }

  async createItemDetail(
    listUuid: string,
    itemId: string,
    fields: { userIconItemId?: string; userSectionId?: string; assignedTo?: string } = {},
  ): Promise<ItemDetail> {
    const headers = await this.authHeaders();
    const res = await bringMultipart(headers, 'POST', 'v2/bringlistitemdetails', {
      listUuid,
      itemId,
      userIconItemId: fields.userIconItemId ?? '',
      userSectionId: fields.userSectionId ?? '',
      assignedTo: fields.assignedTo ?? '',
    });
    // Verified 2026-08-29 this POST answers 201 with the created record. But if
    // Bring ever switched it to a 204 like its sibling endpoints, res.data would
    // be null and a caller reading detail.itemId would throw AFTER the write had
    // already happened - a failure report for a successful change. Re-read once
    // rather than trust the write to have echoed a body.
    const created = res.data as ItemDetail | null;
    if (created && created.uuid) {
      return created;
    }
    const refetched = await this.getItemDetail(listUuid, itemId);
    if (refetched) {
      return refetched;
    }
    throw new Error(`Created an item-detail record for "${itemId}" but could not read it back.`);
  }

  async deleteItemDetail(uuid: string): Promise<void> {
    const headers = await this.authHeaders();
    await bringDelete(headers, `v2/bringlistitemdetails/${uuid}`);
  }

  /**
   * Give a list item an icon.
   *
   * `icon` may be a canonical id (`Äpfel`) or a phrase in any indexed language
   * ("maçãs", "apples"). Creates the detail record when the item has none.
   */
  async setItemIcon(
    listUuid: string,
    itemName: string,
    icon: string,
  ): Promise<{ detail: ItemDetail; resolvedIcon: Match }> {
    const resolved = await this.toCanonicalItemId(icon);
    if (!resolved) {
      throw new Error(
        `No catalog item confidently matches "${icon}". ` +
          `Use findCatalogItem to search, then pass the exact itemId.`,
      );
    }

    // Guard BOTH paths, not just the create. This check used to sit inside the
    // `if (!existing)` branch, so an item that already had a detail record was
    // updated with no list check at all - and on the real list 219 of 224
    // records are for names no longer on it. So setItemIcon(list, "Kibble
    // Gato", ...) quietly rewrote an orphan record, reported success, and
    // changed nothing anyone could see. Same silent-wrong-outcome class that
    // put assertItemOnList on removeItem/moveToRecentList. Found by
    // openai/gpt-5.3-codex.
    await this.assertItemOnList(listUuid, itemName);
    const headers = await this.authHeaders();
    const existing = await this.getItemDetail(listUuid, itemName);

    if (!existing) {
      // Bring happily 201s a record for any name at all, which is how the
      // orphans above accumulated in the first place.
      const detail = await this.createItemDetail(listUuid, itemName, {
        userIconItemId: resolved.itemId,
      });
      return { detail, resolvedIcon: resolved };
    }

    await bringForm(headers, 'PUT', `v2/bringlistitemdetails/${existing.uuid}/usericon`, {
      userIconItemId: resolved.itemId,
    });
    return {
      detail: { ...existing, userIconItemId: resolved.itemId },
      resolvedIcon: resolved,
    };
  }

  /** Move an item into a different aisle/section of the list. */
  async setItemSection(
    listUuid: string,
    itemName: string,
    section: string,
  ): Promise<{ detail: ItemDetail; resolvedSection: { sectionId: string; names: Record<string, string> } }> {
    // The same confidence discipline the item path uses. An exact section id or
    // name is trusted outright; a fuzzy match must clear the auto-attach bar and
    // must not be a tie, so a query that merely begins with a section word (the
    // "reismehl -> Reis" class) no longer files an item into the wrong aisle.
    const catalog = await this.getCatalog();
    const exact = catalog.sections.get(section);
    let resolved: { sectionId: string; names: Record<string, string> } | undefined = exact;
    if (!resolved) {
      const ranked = resolveSection(catalog, section, 2).filter((m) => m.score >= ICON_MATCH_SCORE);
      resolved =
        ranked.length === 1 || (ranked.length > 1 && ranked[0].score > ranked[1].score) ? ranked[0] : undefined;
    }
    if (!resolved) {
      throw new Error(
        `No catalog section confidently matches "${section}". ` +
          `Use findCatalogSection to search, then pass an exact section id. ` +
          `Known sections: ${[...catalog.sections.keys()].join(', ')}`,
      );
    }

    // Guard BOTH paths, not just the create. This check used to sit inside the
    // `if (!existing)` branch, so an item that already had a detail record was
    // updated with no list check at all - and on the real list 219 of 224
    // records are for names no longer on it. So setItemIcon(list, "Kibble
    // Gato", ...) quietly rewrote an orphan record, reported success, and
    // changed nothing anyone could see. Same silent-wrong-outcome class that
    // put assertItemOnList on removeItem/moveToRecentList. Found by
    // openai/gpt-5.3-codex.
    await this.assertItemOnList(listUuid, itemName);
    const headers = await this.authHeaders();
    const existing = await this.getItemDetail(listUuid, itemName);

    if (!existing) {
      const detail = await this.createItemDetail(listUuid, itemName, {
        userSectionId: resolved.sectionId,
      });
      return { detail, resolvedSection: resolved };
    }

    await bringForm(headers, 'PUT', `v2/bringlistitemdetails/${existing.uuid}/usersection`, {
      userSectionId: resolved.sectionId,
    });
    return {
      detail: { ...existing, userSectionId: resolved.sectionId },
      resolvedSection: resolved,
    };
  }

  /** Drop an item's icon/section customisation entirely. */
  async removeItemDetail(listUuid: string, itemName: string): Promise<boolean> {
    // The THIRD sibling of the orphan-write class, missed when setItemIcon and
    // setItemSection were guarded - found by x-ai/grok-4.6 reading that very
    // fix. getItemDetail keys by NAME, and 219 of 224 records on the real list
    // are for names no longer on it, so removeItemCustomisation(list, "Kibble")
    // deleted a leftover record and reported "Customisation removed" while the
    // row the household can actually see was untouched.
    await this.assertItemOnList(listUuid, itemName);
    const existing = await this.getItemDetail(listUuid, itemName);
    if (!existing) return false;
    await this.deleteItemDetail(existing.uuid);
    return true;
  }

  /**
   * Item details rendered in a human language.
   *
   * The raw records store German canonical ids, so a bare dump is unreadable to
   * anyone not shopping in German.
   */
  async describeItemDetails(listUuid: string, locale = describeLocale()) {
    assertSupportedLocale(locale);
    const configured = catalogLocales();
    const locales = configured.includes(locale) ? configured : [...configured, locale];
    const catalog = await this.getCatalog(locales);
    const details = (await this.getItemsDetails(listUuid)) as unknown as ItemDetail[];

    return details.map((detail) => {
      const iconEntry = catalog.entries.get(detail.userIconItemId);
      const sectionEntry = catalog.sections.get(detail.userSectionId);
      return {
        itemId: detail.itemId,
        uuid: detail.uuid,
        icon: detail.userIconItemId || null,
        iconLabel: iconEntry?.names[locale] ?? null,
        section: detail.userSectionId || null,
        sectionLabel: sectionEntry?.names[locale] ?? null,
        hasImage: Boolean(detail.imageUrl),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Newer batch endpoint
  // ---------------------------------------------------------------------------

  /** Raw access to the app's items endpoint, for callers holding real uuids. */
  private async rawBatch(listUuid: string, changes: BatchChange[]): Promise<void> {
    // Keep the newline rule the legacy path enforces: a name with a CR/LF here
    // creates an item that can never get an icon (the multipart detail endpoint
    // rejects it), so refuse it at the source rather than store a stuck item.
    for (const change of changes) {
      if (/[\r\n]/.test(change.itemId)) {
        throw new Error(`Item name "${change.itemId}" contains a line break, which cannot be stored.`);
      }
    }
    const headers = await this.authHeaders();
    await bringJson(headers, 'PUT', `v2/bringlists/${listUuid}/items`, {
      changes: changes.map((change) => ({
        ...NULL_LOCATION,
        itemId: change.itemId,
        spec: change.spec ?? '',
        uuid: change.uuid ?? crypto.randomUUID(),
        operation: change.operation,
      })),
      sender: '',
    });
  }

  /**
   * Apply a set of list changes.
   *
   * Measured behaviour of the newer items endpoint: TO_PURCHASE works, but
   * TO_RECENTLY and REMOVE silently do nothing - they match the item by uuid,
   * and no endpoint exposes the uuid of an item that was created the legacy
   * way. The endpoint returns 200 regardless, so the failure is invisible.
   *
   * Changes are therefore routed to whichever call actually works: the batch
   * endpoint only when the caller supplied a uuid (which preserves item
   * identity), and the name-addressed legacy calls otherwise.
   */
  async batchUpdateList(listUuid: string, changes: BatchChange[]): Promise<{ applied: string[]; notFound: string[] }> {
    // Not atomic: changes are applied one at a time and a throw part-way leaves
    // the earlier ones applied. Bring offers no transaction, and the one real
    // batch endpoint it does have cannot express REMOVE/TO_RECENTLY for these items
    // (see above), so partial application is unavoidable rather than a choice.
    //
    // One list read up front serves two purposes: name-addressed operations on
    // a name that is not there are reported instead of silently no-opping, and
    // adds with no spec keep an existing item's spec instead of blanking it.
    const index = await this.listNameIndex(listUuid);
    const applied: string[] = [];
    const notFound: string[] = [];

    for (const change of changes) {
      if (change.operation === 'TO_PURCHASE') {
        // Same spec-carry on BOTH add paths. The uuid branch used to send
        // spec:'' with no lookup - the one save path that still blanked an
        // existing item's spec, found independently by two reviewers.
        const spec = change.spec ?? index.get(change.itemId)?.specification ?? '';
        if (change.uuid) {
          await this.rawBatch(listUuid, [{ ...change, spec }]);
        } else {
          await this.legacyListMutation(listUuid, { purchase: change.itemId, specification: spec });
        }
        // Keep the index current within the batch, exactly as saveItemBatch does.
        // Without this the existence check below read the PRE-batch snapshot, so a
        // REMOVE/TO_RECENTLY for a name this very loop had just added was reported
        // "not found" AND its write was skipped - a false report on a shared list.
        // Found independently by DeepSeek Flash and the local model.
        index.set(change.itemId, { specification: spec, inRecently: false });
        applied.push(`${change.itemId} (added)`);
      } else if (!index.has(change.itemId)) {
        notFound.push(change.itemId);
      } else if (change.operation === 'TO_RECENTLY') {
        await this.legacyListMutation(listUuid, { recently: change.itemId });
        index.set(change.itemId, {
          specification: index.get(change.itemId)?.specification ?? '',
          inRecently: true,
        });
        applied.push(`${change.itemId} (completed)`);
      } else {
        await this.legacyListMutation(listUuid, { remove: change.itemId });
        // Gone now: a repeated REMOVE in one batch is honestly reported as
        // notFound instead of claiming a second write that 204-no-ops.
        index.delete(change.itemId);
        applied.push(`${change.itemId} (removed)`);
      }
    }
    return { applied, notFound };
  }

  /**
   * Rename an item, carrying everything that can be carried.
   *
   * Detail records are keyed by item name, so a rename orphans them. The API
   * has no update-in-place for a record (PUT on the record 405s), so the record
   * is recreated under the new name and the old one deleted.
   *
   * Three things this has to get right, because each was silently wrong before:
   *
   *  - The item's existing `specification` is carried unless the caller passes
   *    a replacement. It used to be blanked while the tool reported success.
   *  - The source must actually exist. `saveItem` creates unconditionally and
   *    `removeItem` no-ops on a missing name, so renaming something that is not
   *    there used to invent a new item and call it a rename.
   *  - An item stored under a canonical catalog id draws its icon from the
   *    catalog and has no detail record. Renaming it to free text therefore
   *    loses that icon, and there is nothing to "carry over". Reported rather
   *    than hidden, so the caller can offer to pin the icon explicitly.
   *
   * `imageUrl` cannot be carried: the create endpoint takes no image field and
   * the image lives against the old record's uuid. Surfaced for the same reason.
   */
  async renameItem(
    listUuid: string,
    fromName: string,
    toName: string,
    specification?: string,
  ): Promise<{
    movedDetail: boolean;
    stayedInRecently: boolean;
    specificationCarried: string;
    lostAutomaticIcon: boolean;
    lostImage: boolean;
  }> {
    // Renaming to the same name would save then remove the same item, deleting
    // it. Cheap to guard, and an easy mistake for a caller normalising names.
    if (fromName === toName) {
      throw new Error(`renameItem: fromName and toName are both "${fromName}"; nothing to do.`);
    }

    const items = await this.getItems(listUuid);
    // Bring omits an empty array rather than sending []; without the fallback a
    // list with nothing in "recently" crashed with a bare TypeError.
    const purchase = (items.purchase ?? []) as unknown as { name: string; specification: string }[];
    const recently = (items.recently ?? []) as unknown as { name: string; specification: string }[];

    const source = purchase.find((i) => i.name === fromName) ?? recently.find((i) => i.name === fromName);
    if (!source) {
      throw new Error(
        `renameItem: "${fromName}" is not on this list, so there is nothing to rename. ` +
          `Renaming would have created "${toName}" as a new item instead.`,
      );
    }

    // Bring identifies a list item by its name, so if `toName` is already on the
    // list a rename would silently merge into it - overwriting that item's spec
    // and detail record with the source's. That is a surprising, lossy outcome,
    // so refuse it and let the caller decide.
    if (purchase.some((i) => i.name === toName) || recently.some((i) => i.name === toName)) {
      throw new Error(
        `renameItem: "${toName}" is already on this list. Renaming "${fromName}" onto it would merge ` +
          `the two and overwrite "${toName}". If "${toName}" is a leftover from an interrupted rename, ` +
          `remove "${toName}" (NOT "${fromName}", which still carries the icon) and retry.`,
      );
    }

    // saveItem always adds to the to-buy list. Renaming something sitting in
    // "recently" must not push it back onto the active list - on a shared list
    // that is a visible change everyone sees.
    const inRecently = !purchase.some((i) => i.name === fromName);

    const existing = await this.getItemDetail(listUuid, fromName);
    const catalog = await this.getCatalog();
    // Only a loss if the new name has no icon AND no custom icon is carried
    // over. A record whose userIconItemId is EMPTY (section-only records exist
    // - the live list has two) carries no icon, so the automatic one is lost
    // even though a record moved; `!existing` alone reported that case as fine.
    const lostAutomaticIcon =
      catalog.entries.has(fromName) && !catalog.entries.has(toName) && !existing?.userIconItemId;

    const specificationCarried = specification ?? source.specification ?? '';

    // Order matters, because none of this is atomic. The source item and its
    // detail record are the last things touched, so a failure at any point
    // leaves nothing LOST - but honesty about the middle states: once
    // saveItem(toName) has run, both names are on the list, and a blind retry
    // would hit the toName-collision guard above. So a mid-sequence failure is
    // rethrown with the exact list state and the way out, rather than a bare
    // error that leaves the caller to rediscover it. The mutations go through
    // legacyListMutation directly: the names were verified above, and the
    // checked public wrappers would re-read the list on every step.
    await this.legacyListMutation(listUuid, { purchase: toName, specification: specificationCarried });
    try {
      if (inRecently) {
        await this.legacyListMutation(listUuid, { recently: toName });
      }

      if (existing) {
        await this.createItemDetail(listUuid, toName, {
          userIconItemId: existing.userIconItemId,
          userSectionId: existing.userSectionId,
          assignedTo: existing.assignedTo,
        });
        await this.deleteItemDetail(existing.uuid);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `renameItem failed part-way: "${toName}" was already created and "${fromName}" is still on the ` +
          `list, fully intact${existing ? ' with its icon' : ''}. Nothing was lost. To finish the rename, ` +
          `remove "${toName}" and run renameItem again; do NOT remove "${fromName}" first. ` +
          `Underlying error: ${reason}`,
      );
    }

    // The last write gets its own honest error: a raw failure here used to
    // surface with no state description, and the natural retry then hit the
    // collision guard whose advice would have deleted the finished new item.
    try {
      await this.legacyListMutation(listUuid, { remove: fromName });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `renameItem is COMPLETE except for removing the old row: "${toName}" exists with its ` +
          `specification${existing ? ' and icon' : ''}, but "${fromName}" is still on the list too. ` +
          `Just remove "${fromName}" to finish - do NOT remove "${toName}". Underlying error: ${reason}`,
      );
    }

    return {
      movedDetail: Boolean(existing),
      stayedInRecently: inRecently,
      specificationCarried,
      lostAutomaticIcon,
      lostImage: Boolean(existing?.imageUrl),
    };
  }

  /**
   * Attach `match`'s icon to the row stored under `name`, creating or updating
   * the detail record as needed. Never throws: the item is already saved by the
   * time this runs, so an icon failure must not surface as though nothing
   * happened - the caller would retry the whole save.
   */
  private async attachIcon(
    listUuid: string,
    name: string,
    match: Match,
    /**
     * Set when `name` is a row the user ALREADY had (the twin-reuse path). Any
     * icon on it is a deliberate human choice - somebody ran setItemIcon, or
     * picked it in the app - and overwriting that with a computed catalog
     * default is precisely the "tooling writes over human choices" this project
     * is not allowed to do. We may FILL an empty icon, never replace a set one.
     * On a long-lived list the stored icons are mostly better than anything the
     * matcher would compute, which is exactly why they belong to the people
     * using it.
     * Found by z-ai/glm-5.3, and it is a consequence of adding the icon step to
     * the twin branch in an earlier commit - before that this path attached no
     * icon at all, so it could not clobber one either.
     */
    preserveExistingIcon = false,
  ): Promise<{ iconError?: string; keptExistingIcon?: string }> {
    try {
      const existing = await this.getItemDetail(listUuid, name);
      if (!existing) {
        await this.createItemDetail(listUuid, name, { userIconItemId: match.itemId });
      } else if (preserveExistingIcon && existing.userIconItemId) {
        return { keptExistingIcon: existing.userIconItemId };
      } else if (existing.userIconItemId !== match.itemId) {
        // Update, not skip. Skipping the update while still reporting success
        // left an item wearing its OLD icon while the tool claimed it had
        // changed - a false success on a shared list.
        const headers = await this.authHeaders();
        await bringForm(headers, 'PUT', `v2/bringlistitemdetails/${existing.uuid}/usericon`, {
          userIconItemId: match.itemId,
        });
      }
      return {};
    } catch (error) {
      return { iconError: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Save an item the way the app would.
   *
   * Three outcomes, because "close enough to borrow an icon from" and "actually
   * this item" are different bars:
   *
   *  - Confident match (>= EXACT_MATCH_SCORE): store the canonical id, so the
   *    item renders in the list's own language with its icon and aisle.
   *  - Weaker match: store the text verbatim and attach the matched item's icon
   *    to it. Storing the canonical id here would quietly discard detail -
   *    "Escova De Dentes Colgate Maquina" would become plain "Escova de dentes".
   *  - No match: store the text verbatim, no icon.
   */
  async saveItemResolved(
    listUuid: string,
    query: string,
    specification?: string | null,
  ): Promise<{
    storedAs: string;
    resolved: Match | null;
    mode: 'canonical' | 'text-with-icon' | 'text-only';
    /** Set when the item was saved but the icon step failed afterwards. */
    iconError?: string;
    /** Set when the list already held the same product under another name. */
    reusedExistingName?: string;
    /** Set when a reused row already had a deliberate icon, which was kept. */
    keptExistingIcon?: string;
  }> {
    // ONE resolution serves both bars. toCanonicalItemId's tie and inflection
    // refusals do not depend on minScore - only the final `best.score < minScore`
    // test does - so resolving once at the lower bar and applying the higher bar
    // here is exactly equivalent to the two calls this used to make, and halves
    // the catalog scanning on every single save.
    const resolved = await this.toCanonicalItemId(query, ICON_MATCH_SCORE);
    const confident = resolved && resolved.score >= EXACT_MATCH_SCORE ? resolved : null;

    if (confident) {
      // Bring merges by NAME only, so storing the canonical id next to an
      // existing free-text twin ("Apples") puts two apple rows in front of the
      // whole household. If any existing name confidently resolves to the same
      // canonical id, save under THAT name instead and say so - three of the
      // final reviews converged on this duplicate.
      const index = await this.listNameIndex(listUuid);
      if (!index.has(confident.itemId)) {
        // Cheap pre-filter. This loop used to run a FULL catalog resolution for
        // every name on the list on every confident save - O(list x catalog),
        // measured at 1.7s with 19 items and 3.0s with 40 on a single-threaded
        // stdio server, where every other tool call queues behind it. Only a
        // name that already looks like one of THIS item's own forms can reach
        // the canonical bar against it, and comparing normalized strings is a
        // Set lookup instead of a catalog scan. Space-stripped variants are
        // included so a row written "apfel saft" still matches Apfelsaft, the
        // same spaced-compound equivalence the matcher scores at 100.
        //
        // The confirming resolution is KEPT for whatever survives the filter,
        // because one display name can belong to two entries - "Paprika" is
        // Paprikapulver in en-US and Peperoni in de-DE, a real 100/100 tie in
        // the live catalog - and that ambiguity must still be refused, not reused.
        // Signature = normalized tokens SORTED, so a word-order permutation of a
        // display name hits the filter too. Without this, a list already holding
        // "Maçã de suco" got a SECOND row when someone saved "suco de maçã" -
        // the exact duplicate the twin scan exists to prevent. Found by
        // poolside/laguna-s-2.1.
        const sig = (s: string) => s.split(' ').filter(Boolean).sort().join(' ');
        const forms = [confident.itemId, ...Object.values(confident.names)].map(normalize);
        const equivalentForms = new Set([...forms, ...forms.map((f) => f.replace(/ /g, '')), ...forms.map(sig)]);
        for (const existingName of index.keys()) {
          const n = normalize(existingName);
          if (!equivalentForms.has(n) && !equivalentForms.has(n.replace(/ /g, '')) && !equivalentForms.has(sig(n)))
            continue;
          // Confirmed at the PERMUTATION bar, not the canonical one. These two
          // bars answer different questions and were wrongly sharing a value:
          // "may I REPLACE the user's text with this id?" (needs 90 - a
          // reordering is not proof of identity) versus "is this existing row
          // the same product?" (85 is ample, and a wrong answer here merely
          // reuses a row the user can see rather than renaming their text).
          // Demoting permutations to 85 in the previous commit silently broke
          // twin reuse for them; this is the other half of that change. The live
          // catalog has ZERO permutation collisions across 341 multi-word names,
          // measured 2026-09-01 - re-measure if Bring's catalog changes.
          const equivalent = await this.toCanonicalItemId(existingName, PERMUTATION_SCORE);
          if (equivalent?.itemId === confident.itemId) {
            await this.saveItem(listUuid, existingName, specification, index);
            // Reported honestly. `existingName` is by construction NOT the
            // canonical id (if it were, index.has above would have caught it),
            // so it is free text: it does not render per-language and gets no
            // automatic icon. Calling that 'canonical' told the caller the
            // opposite of what happened. The icon is attached explicitly here,
            // so reusing a twin no longer silently costs the item its icon.
            const outcome = await this.attachIcon(listUuid, existingName, confident, true);
            return {
              storedAs: existingName,
              resolved: confident,
              mode: outcome.iconError ? 'text-only' : 'text-with-icon',
              reusedExistingName: existingName,
              ...(outcome.iconError ? { iconError: outcome.iconError } : {}),
              ...(outcome.keptExistingIcon ? { keptExistingIcon: outcome.keptExistingIcon } : {}),
            };
          }
        }
      }
      await this.saveItem(listUuid, confident.itemId, specification, index);
      return { storedAs: confident.itemId, resolved: confident, mode: 'canonical' };
    }

    // toCanonicalItemId refuses ties at any tier ("chá de camomila" scores
    // Camomila and Chá identically; attaching either would be a guess wearing
    // the costume of a decision), so a null here means no match OR ambiguity.
    const loose = resolved;

    await this.saveItem(listUuid, query, specification);

    if (!loose) {
      return { storedAs: query, resolved: null, mode: 'text-only' };
    }

    // Actually attach the icon, in both the create and the update case. It used
    // to skip the update when a record already existed but still report
    // "text-with-icon" with the new id - so an item that already had a
    // different icon kept it while the tool claimed it had been changed. That
    // is a false success on a shared list.
    //
    // And the reverse lie: the item is ALREADY saved by this point, so an icon
    // failure must not surface as a plain error implying nothing happened - a
    // caller would retry the whole thing. The save is reported as done and the
    // icon failure carried alongside; retrying is safe either way, because
    // Bring merges saves by name.
    const outcome = await this.attachIcon(listUuid, query, loose);
    if (outcome.iconError) {
      // `mode` describes what is on the LIST (no icon landed); `resolved` says
      // which icon was attempted, so the caller can report or retry precisely.
      // DeepSeek Pro read the pair as self-contradictory; kept deliberately,
      // because dropping `resolved` here would lose the only clue to WHICH
      // icon failed, and `iconError` already disambiguates the two.
      return { storedAs: query, resolved: loose, mode: 'text-only', iconError: outcome.iconError };
    }
    return { storedAs: query, resolved: loose, mode: 'text-with-icon' };
  }

  // ---------------------------------------------------------------------------
  // List settings
  // ---------------------------------------------------------------------------

  /**
   * Note: clients also fall back to the device locale when no setting is
   * stored, so an unset list is not necessarily displaying in German.
   */
  async setListArticleLanguage(listUuid: string, locale: string): Promise<void> {
    assertSupportedLocale(locale);
    const headers = await this.authHeaders();
    const uuid = await this.userUuid();
    await bringForm(headers, 'POST', `v2/bringusersettings/${uuid}/${listUuid}/listArticleLanguage`, {
      value: locale,
    });
  }

  /** Removing yourself from a list disposes of it when you are the last member. */
  async leaveList(listUuid: string): Promise<void> {
    const headers = await this.authHeaders();
    const uuid = await this.userUuid();
    await bringDelete(headers, `v2/bringlists/${listUuid}/users/${uuid}`);
  }

  // ---------------------------------------------------------------------------
  // Escape hatch
  // ---------------------------------------------------------------------------

  /**
   * Arbitrary authenticated request. Registered as a tool only when
   * BRING_MCP_RAW=1, so it is not exposed on a live assistant by default.
   */
  async apiRaw(
    method: string,
    path: string,
    encoding: 'none' | 'form' | 'json' | 'multipart' = 'none',
    body?: Record<string, string> | unknown,
  ): Promise<unknown> {
    const headers = await this.authHeaders();
    const cleanPath = path.replace(/^\/+/, '');

    // A "no .. segments" string check is not enough: backslashes and %2e
    // encodings slip past it, and the URL parser then collapses them - so
    // "v2\bringlists\..\..\bringauth" and ".../%2e%2e/..." both escaped
    // (verified). Two guards together:
    //
    //  1. Reject traversal in any encoding. A legitimate probe path is always
    //     direct; ".." is never needed, so decode once, fold backslashes to
    //     slashes, and reject a ".." segment. (Double-encoding like %252e does
    //     not traverse at the fetch layer, so one decode pass suffices.)
    //  2. Resolve exactly as fetch will and require the result to stay under
    //     the API base - the backstop that catches anything the first guard's
    //     string handling misses, including climbing out of /rest/ entirely.
    let probe = cleanPath.replace(/\\/g, '/');
    try {
      probe = decodeURIComponent(probe).replace(/\\/g, '/');
    } catch {
      throw new Error(`Path is not valid percent-encoding: ${path}`);
    }
    if (probe.split('/').includes('..')) {
      throw new Error(`Path must not contain ".." segments: ${path}`);
    }
    const resolved = new URL(cleanPath, BRING_API_BASE);
    if (!resolved.href.startsWith(BRING_API_BASE)) {
      throw new Error(`Path must resolve under ${BRING_API_BASE}; "${path}" escapes it.`);
    }

    if (encoding === 'none') {
      // Only GET and DELETE are bodyless. A POST/PUT sent with encoding 'none'
      // would otherwise be quietly downgraded to a GET - which on this API can
      // look like a successful no-op, the worst possible failure mode for a
      // tool whose whole purpose is probing undocumented endpoints.
      const verb = method.toUpperCase();
      if (verb !== 'GET' && verb !== 'DELETE') {
        throw new Error(`encoding "none" supports only GET and DELETE, not ${verb}. Use form, json or multipart.`);
      }
      const res = verb === 'DELETE' ? await bringDelete(headers, cleanPath) : await bringGet(headers, cleanPath);
      return { status: res.status, data: res.data, text: res.text.slice(0, 2000) };
    }
    if (encoding === 'json') {
      const res = await bringJson(headers, method, cleanPath, body);
      return { status: res.status, data: res.data, text: res.text.slice(0, 2000) };
    }
    // URLSearchParams/multipart stringify whatever they are given, so an object
    // became "[object Object]" and an array became "a,b" - a wrong write shaped
    // like a successful one, on the one tool whose entire purpose is probing
    // undocumented endpoints. Reject instead. Found by openai/gpt-5.3-codex.
    const raw = (body ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== 'string') {
        throw new Error(
          `apiRaw field "${k}" must be a string for ${encoding} encoding, got ${Array.isArray(v) ? 'array' : typeof v}. ` +
            `Serialise it yourself so the wire value is explicit.`,
        );
      }
    }
    const fields = raw as Record<string, string>;
    const res =
      encoding === 'multipart'
        ? await bringMultipart(headers, method, cleanPath, fields)
        : await bringForm(headers, method, cleanPath, fields);
    return { status: res.status, data: res.data, text: res.text.slice(0, 2000) };
  }
}
