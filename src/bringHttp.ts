/**
 * Raw access to Bring! endpoints that `bring-shopping` does not wrap.
 *
 * The item-detail endpoints are undocumented and were recovered from the Bring!
 * web app's published source maps (`src/app/core/bring-api-resources.ts`). They
 * are picky in two ways that are easy to get wrong:
 *
 *  - The *collection* endpoint (`POST /bringlistitemdetails`) accepts ONLY
 *    `multipart/form-data`. JSON, form-urlencoded and text/plain all 415.
 *  - The *sub-resources* (`/usericon`, `/usersection`, `/image`) accept ONLY
 *    `application/x-www-form-urlencoded`, and reject multipart.
 *
 * Both decode the request body as ISO-8859-1 unless the Content-Type carries an
 * explicit `charset=UTF-8`. Without it, catalog ids such as `Äpfel` are stored
 * as `Ãpfel`. Every icon id and section id in Bring's catalog is German, so this
 * is not an edge case - it is the common path.
 */

export const BRING_API_BASE = 'https://api.getbring.com/rest/';

export type BringHeaders = Record<string, string>;

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=UTF-8';

export type BringResponse = {
  status: number;
  ok: boolean;
  /** Parsed JSON when the response carried a body, otherwise null (e.g. 204). */
  data: unknown;
  /** Raw body text, useful for diagnosing HTML error pages from the gateway. */
  text: string;
};

/** Tomcat answers unknown routes with an HTML error page rather than JSON. */
function describe(text: string): string {
  const status = text.match(/HTTP Status \d+ [-–] [^<]+/);
  if (status) return status[0];
  return text.slice(0, 300);
}

async function request(
  headers: BringHeaders,
  method: string,
  path: string,
  contentType: string | undefined,
  body: string | Buffer | undefined,
): Promise<BringResponse> {
  const requestHeaders: BringHeaders = { ...headers, Accept: 'application/json' };
  if (contentType) {
    requestHeaders['Content-Type'] = contentType;
  }

  const res = await fetch(`${BRING_API_BASE}${path}`, {
    method,
    headers: requestHeaders,
    body: body as BodyInit | undefined,
  });
  const text = await res.text();

  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    throw new Error(`Bring! API ${method} /${path} failed (${res.status}): ${describe(text)}`);
  }

  return { status: res.status, ok: res.ok, data, text };
}

export function bringGet(headers: BringHeaders, path: string): Promise<BringResponse> {
  return request(headers, 'GET', path, undefined, undefined);
}

export function bringDelete(headers: BringHeaders, path: string): Promise<BringResponse> {
  return request(headers, 'DELETE', path, undefined, undefined);
}

/** For the item-detail sub-resources and the legacy list endpoints. */
export function bringForm(
  headers: BringHeaders,
  method: string,
  path: string,
  fields: Record<string, string>,
): Promise<BringResponse> {
  return request(headers, method, path, FORM_CONTENT_TYPE, new URLSearchParams(fields).toString());
}

/** For the newer batch endpoints, which are genuinely JSON. */
export function bringJson(headers: BringHeaders, method: string, path: string, body: unknown): Promise<BringResponse> {
  return request(headers, method, path, 'application/json', JSON.stringify(body));
}

/**
 * The only encoding `POST /bringlistitemdetails` accepts.
 *
 * Built by hand rather than with `FormData` so that the boundary is known and
 * `charset=UTF-8` can be appended to the Content-Type - `FormData` lets the
 * runtime own the header, which loses the charset and mojibakes every accent.
 */
export function bringMultipart(
  headers: BringHeaders,
  method: string,
  path: string,
  fields: Record<string, string>,
): Promise<BringResponse> {
  const boundary = `----bringmcp${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  let body = '';
  for (const [name, value] of Object.entries(fields)) {
    // A CR or LF in a value ends its part early and everything after it is
    // parsed as further multipart headers and fields. Verified: an item name
    // containing CRLF + a crafted Content-Disposition puts a second
    // userIconItemId into the request.
    //
    // Rejected rather than stripped: these values are item names the user
    // chose, and quietly rewriting one is precisely the silent-wrong-write this
    // server is built to avoid. A newline is plausible here - voice
    // transcription produces them - so the caller gets a message it can act on.
    // Both the name and the value are interpolated into the part header, so a
    // CR/LF in EITHER ends the part early and smuggles further fields. Field
    // names are fixed constants for the built-in tools, but apiRaw forwards a
    // caller-supplied object straight here, so a crafted key would inject
    // otherwise. Check both.
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new Error(
        `Multipart field "${name}" contains a line break in its name or value, which would corrupt ` +
          `the request. Remove the line break and retry.`,
      );
    }
    // A double quote in the NAME closes the quoted string early, letting a
    // crafted key append further Content-Disposition parameters. Checked after
    // the CR/LF guard above so a payload carrying both still reports the line
    // break, which is the more actionable message. Field names are fixed
    // constants for the 26 built-in tools, so this is reachable only through
    // apiRaw (opt-in BRING_MCP_RAW=1), which forwards a caller-supplied object
    // straight here - the same reason the CR/LF check already covers names.
    if (name.includes('"')) {
      throw new Error(
        `Multipart field name "${name}" contains a double quote, which would corrupt the request header. ` +
          `Remove it and retry.`,
      );
    }
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${name}"\r\n\r\n`;
    body += `${value}\r\n`;
  }
  body += `--${boundary}--\r\n`;

  return request(
    headers,
    method,
    path,
    `multipart/form-data; boundary=${boundary}; charset=UTF-8`,
    Buffer.from(body, 'utf8'),
  );
}

/**
 * `bring-shopping` keeps its authenticated headers private. Reading them back is
 * the only way to reuse the session for endpoints it does not implement; the
 * alternative would be a second login and a second token to keep fresh.
 *
 * Validated rather than trusted, so a future release of the package fails here
 * with an actionable message instead of producing confusing 401s at the callsite.
 */
export function extractAuthHeaders(bring: unknown): BringHeaders {
  const headers = (bring as Record<string, unknown>)?.['headers'];
  if (!headers || typeof headers !== 'object') {
    throw new Error(
      'Could not read authenticated headers from bring-shopping. ' +
        'The package layout changed; bringHttp.extractAuthHeaders needs updating.',
    );
  }
  const typed = headers as BringHeaders;
  if (!typed['Authorization'] || !typed['X-BRING-USER-UUID']) {
    throw new Error(
      'bring-shopping headers are missing Authorization/X-BRING-USER-UUID. ' +
        'Login probably did not complete before this call.',
    );
  }
  return { ...typed };
}
