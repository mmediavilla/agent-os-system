import { Page, PageMeta } from "../api";

/**
 * Wrap fixture rows in the `{ data, meta }` envelope the catalog endpoints
 * return, so a mocked list call is shaped like the real one.
 *
 * The default meta describes a single full page. Tests that care about paging
 * override the parts they are asserting on; everything else stays consistent
 * with `data` without each suite having to spell out six fields.
 *
 * Lives outside `__tests__` on purpose — Jest treats every file under that
 * directory as a suite, and a helper module there would fail as one with no
 * tests in it.
 */
export function page<T>(data: T[], meta: Partial<PageMeta> = {}): Page<T> {
  return {
    data,
    meta: {
      page: 1,
      per_page: null,
      total: data.length,
      last_page: 1,
      from: data.length ? 1 : null,
      to: data.length ? data.length : null,
      ...meta,
    },
  };
}
