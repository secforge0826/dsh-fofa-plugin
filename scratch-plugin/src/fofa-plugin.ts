/**
 * scratch-plugin/src/fofa-plugin.ts
 *
 * DeepSeek Harness (Cordis) plugin for FOFA (fofa.info).
 * - Uses undici.fetch for Node compatibility
 * - Exports default plugin object (name/inject/apply) per Cordis conventions
 * - Exposes `searchFOFA` helper so other JS/AI agents can import and call directly
 * - Registers a tool `fofa.search` with rich JSON Schema for AI tool-calling
 *
 * Security:
 *   - Credentials may come from: args > ctx.config.fofa > environment (FOFA_EMAIL/FOFA_KEY)
 *
 * Usage (as plugin):
 *   // cordis overlay should reference this file
 *   tools.call('fofa.search', { query: 'app=nginx', pages: 2, size: 100 })
 *
 * Usage (direct import by AI/agent code):
 *   import { searchFOFA } from './scratch-plugin/src/fofa-plugin';
 *   const res = await searchFOFA({ query: 'app=nginx', pages: 1 }, { email: 'x', key: 'y' });
 */

import type { Context } from '@deepseek-ai/cordis';
import { fetch } from 'undici';

export const name = 'dsh-fofa-plugin';
export const inject = ['tools'];

export interface FOFAQueryOptions {
  query: string;
  pages?: number;
  size?: number;
  email?: string;
  key?: string;
  url?: string;
  sleepMs?: number; // ms between page requests
  concurrency?: number; // currently unused, reserved for future
}

export interface FOFAResultItem {
  // dynamic mapping of FOFA fields -> values
  [key: string]: any;
  _raw_result?: any;
  _fofa_fields?: string[];
  _meta?: { query: string; page: number; size: number };
}

export interface FOFAResult {
  items: FOFAResultItem[];
  meta: {
    requestedPages: number;
    fetchedPages: number;
    perPage: number;
    totalEstimate: number | null;
  };
}

// Helper that performs FOFA search and returns normalized results.
export async function searchFOFA(
  opts: FOFAQueryOptions,
  // optional credentials/config override: { email, key, url }
  overrideConfig?: { email?: string; key?: string; url?: string },
): Promise<FOFAResult> {
  const query = opts.query;
  const pages = Math.max(1, Math.floor(opts.pages ?? 1));
  const size = Math.max(1, Math.min(1000, Math.floor(opts.size ?? 100)));
  const sleepMs = opts.sleepMs ?? 1000;

  const cfgEmail = overrideConfig?.email ?? opts.email ?? process.env.FOFA_EMAIL;
  const cfgKey = overrideConfig?.key ?? opts.key ?? process.env.FOFA_KEY;
  const baseUrl = overrideConfig?.url ?? opts.url ?? process.env.FOFA_URL ?? 'https://fofa.info/api/v1/search/all';

  if (!cfgEmail || !cfgKey) {
    throw new Error('FOFA credentials missing: provide email/key in args, overrideConfig, or set FOFA_EMAIL/FOFA_KEY');
  }

  // base64 encode helper
  const qbase64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

  const items: FOFAResultItem[] = [];
  let fetchedPages = 0;
  let totalEstimate: number | null = null;

  // Retry/backoff parameters
  const maxAttempts = 3;
  const baseBackoffMs = 500;

  for (let page = 1; page <= pages; page++) {
    let attempt = 0;
    let lastError: any = null;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const params = new URLSearchParams({
          email: cfgEmail,
          key: cfgKey,
          qbase64: qbase64(query),
          page: String(page),
          size: String(size),
        });
        const url = `${baseUrl}?${params.toString()}`;
        const resp = await fetch(url, { method: 'GET' });
        if (!resp.ok) {
          const text = await resp.text();
          const errMsg = `FOFA HTTP ${resp.status} ${resp.statusText}: ${text}`;
          // retry on 429 or 5xx
          if (resp.status === 429 || resp.status >= 500) {
            lastError = new Error(errMsg);
            const backoff = baseBackoffMs * Math.pow(2, attempt - 1);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          throw new Error(errMsg);
        }
        const data = await resp.json();
        if (data && typeof data === 'object' && data.error) {
          throw new Error(`FOFA API error: ${JSON.stringify(data)}`);
        }

        const results = data.results ?? data.list ?? [];
        const fields = data.fields ?? data.header ?? [];
        if (totalEstimate === null) {
          totalEstimate = (data.size ?? data.total) ?? null;
        }

        if (Array.isArray(results) && results.length > 0) {
          if (Array.isArray(results[0]) && Array.isArray(fields) && fields.length > 0) {
            for (const row of results as any[]) {
              const mapped: FOFAResultItem = {};
              for (let i = 0; i < Math.min(fields.length, (row as any[]).length); i++) {
                mapped[fields[i]] = row[i];
              }
              mapped._fofa_fields = fields;
              mapped._raw_result = row;
              mapped._meta = { query, page, size };
              items.push(mapped);
            }
          } else if (typeof results[0] === 'object') {
            for (const row of results as any[]) {
              const mapped: FOFAResultItem = { ...row, _raw_result: row, _meta: { query, page, size } };
              items.push(mapped);
            }
          } else {
            for (const row of results as any[]) {
              items.push({ value: row, _raw_result: row, _meta: { query, page, size } });
            }
          }
        }

        fetchedPages += 1;
        break; // success for this page
      } catch (err) {
        lastError = err;
        // simple logging to stdout/stderr; callers may wrap
        // but keep library agnostic (no ctx.logger here)
        // retry after backoff
        const backoff = baseBackoffMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    if (lastError && page === 1 && fetchedPages === 0) {
      // give up early if first page fails after retries
      throw lastError;
    }

    if (page < pages && sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  return {
    items,
    meta: {
      requestedPages: pages,
      fetchedPages,
      perPage: size,
      totalEstimate,
    },
  };
}

// Default export in Cordis object form. This is the form accepted by
// deepseek-harness docs: a module exporting name / inject / apply.
export default {
  name,
  inject,
  apply(ctx: Context) {
    const tools = (ctx as any).tools;
    const logger = (ctx as any).logger ?? console;

    const toolId = 'fofa.search';

    // Tool input/output schema aims to be AI-friendly so language agents
    // can call it using tool-calling with structured arguments.
    tools?.register?.({
      id: toolId,
      name: 'FOFA Search',
      description: 'Search FOFA (fofa.info) for network assets using FOFA DSL. Returns normalized items and metadata.',
      schema: {
        input: {
          type: 'object',
          properties: {
            query: { type: 'string', description: "FOFA query (e.g. 'app=nginx')" },
            pages: { type: 'integer', minimum: 1, description: 'Number of pages to fetch (default 1)' },
            size: { type: 'integer', minimum: 1, description: 'Page size (default 100)' },
            email: { type: 'string', description: 'FOFA email (overrides environment/config)' },
            key: { type: 'string', description: 'FOFA API key (overrides environment/config)' },
            url: { type: 'string', description: 'FOFA API URL (optional)' },
            sleepMs: { type: 'integer', description: 'Delay between page requests in ms (default 1000)' },
          },
          required: ['query'],
        },
        output: {
          type: 'object',
          properties: {
            items: { type: 'array' },
            meta: { type: 'object' },
          },
        },
      },
      run: async (args: any = {}) => {
        const opts: FOFAQueryOptions = {
          query: String(args.query),
          pages: args.pages ?? 1,
          size: args.size ?? 100,
          email: args.email,
          key: args.key,
          url: args.url,
          sleepMs: args.sleepMs ?? 1000,
        };

        // allow ctx.config.fofa to supply defaults
        const override = {
          email: (ctx as any).config?.fofa?.email,
          key: (ctx as any).config?.fofa?.key,
          url: (ctx as any).config?.fofa?.url,
        };

        try {
          const res = await searchFOFA(opts, override);
          return res;
        } catch (e: any) {
          logger.error?.('[dsh-fofa-plugin] FOFA search failed:', e?.message ?? String(e));
          throw e;
        }
      },
    });

    ctx.effect?.(() => {
      return () => {
        try {
          tools?.unregister?.('fofa.search');
        } catch (e) {
          // ignore
        }
      };
    });

    logger.info?.('[dsh-fofa-plugin] Registered tool: fofa.search');
  },
};
