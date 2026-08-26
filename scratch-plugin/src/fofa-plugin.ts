/**
 * src/fofa-plugin.ts
 *
 * DeepSeek Harness (Cordis) plugin for FOFA (fofa.info).
 * Exports:
 *   - name: plugin name
 *   - inject: dependencies (tools)
 *   - apply(ctx): plugin entry, registers a tool 'fofa.search'
 *
 * The tool can be called from other plugins or via the UI if your DSH
 * environment exposes registered tools.
 *
 * Usage (from other plugins):
 *   const res = await ctx.tools.call('fofa.search', { query: 'app=nginx', pages: 2 });
 *
 * NOTE: This file is intended to be used as a scratch/plugin source file
 * referenced directly by cordis.yml during development (no build step).
 */

import type { Context } from '@deepseek-ai/cordis';

export const name = 'dsh-fofa-plugin';
export const inject = ['tools'];

type Tools = any;

function b64(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64');
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export function apply(ctx: Context) {
  const tools: Tools = (ctx as any).tools;
  const logger = (ctx as any).logger ?? console;

  const toolId = 'fofa.search';

  tools?.register?.({
    id: toolId,
    name: 'FOFA Search',
    schema: {
      input: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          pages: { type: 'number' },
          size: { type: 'number' },
          email: { type: 'string' },
          key: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['query'],
      },
    },
    run: async (args: any = {}) => {
      const query: string = args.query;
      const pages: number = Number(args.pages ?? 1);
      const size: number = Number(args.size ?? 100);
      const overrideEmail: string | undefined = args.email;
      const overrideKey: string | undefined = args.key;
      const overrideUrl: string | undefined = args.url;

      const cfgEmail = overrideEmail ?? ctx.config?.fofa?.email ?? process.env.FOFA_EMAIL;
      const cfgKey = overrideKey ?? ctx.config?.fofa?.key ?? process.env.FOFA_KEY;
      const baseUrl = overrideUrl ?? ctx.config?.fofa?.url ?? process.env.FOFA_URL ?? 'https://fofa.info/api/v1/search/all';

      if (!cfgEmail || !cfgKey) {
        const msg = 'FOFA credentials missing: provide email/key in args or ctx.config.fofa or set FOFA_EMAIL/FOFA_KEY';
        logger.error?.(msg);
        throw new Error(msg);
      }

      const items: Array<Record<string, any>> = [];
      let fetchedPages = 0;
      let totalEstimate: number | null = null;

      const maxAttempts = 3;
      const baseBackoffMs = 500;

      for (let page = 1; page <= pages; page++) {
        let attempt = 0;
        let lastErr: any = null;
        while (attempt < maxAttempts) {
          attempt += 1;
          try {
            const qbase64 = b64(query);
            const params = new URLSearchParams({
              email: cfgEmail,
              key: cfgKey,
              qbase64,
              page: String(page),
              size: String(size),
            });
            const url = `${baseUrl}?${params.toString()}`;
            logger.info?.('FOFA request', { url, page, size });
            const res = await fetch(url, { method: 'GET' });
            if (!res.ok) {
              const text = await res.text();
              const errMsg = `FOFA HTTP ${res.status} ${res.statusText}: ${text}`;
              if (res.status === 429 || res.status >= 500) {
                lastErr = new Error(errMsg);
                const backoff = baseBackoffMs * Math.pow(2, attempt - 1);
                logger.warn?.('Transient FOFA error, retrying', { attempt, backoff, err: errMsg });
                await sleep(backoff);
                continue;
              } else {
                throw new Error(errMsg);
              }
            }
            const data = await res.json();
            if (data && typeof data === 'object' && data.error) {
              throw new Error(`FOFA API error: ${JSON.stringify(data)}`);
            }
            const results = data.results ?? data.list ?? [];
            const fields = data.fields ?? data.header ?? [];
            if (totalEstimate == null) {
              totalEstimate = data.size ?? data.total ?? null;
            }
            if (results.length > 0) {
              if (Array.isArray(results[0]) && Array.isArray(fields) && fields.length > 0) {
                for (const row of results as any[]) {
                  const mapped: Record<string, any> = {};
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
                  const mapped = { ...row, _raw_result: row, _meta: { query, page, size } };
                  items.push(mapped);
                }
              } else {
                for (const row of results as any[]) {
                  items.push({ value: row, _raw_result: row, _meta: { query, page, size } });
                }
              }
            }
            fetchedPages += 1;
            break;
          } catch (err) {
            lastErr = err;
            logger.warn?.('FOFA request failed', { attempt, err: String(err) });
            const backoff = baseBackoffMs * Math.pow(2, attempt - 1);
            await sleep(backoff);
          }
        }
        if (lastErr && page === 1 && fetchedPages === 0) {
          logger.error?.('Giving up fetching page', { page, err: String(lastErr) });
          throw lastErr;
        }
        const pageSleep = Number(ctx.config?.fofa?.sleep ?? process.env.FOFA_SLEEP ?? 1000);
        if (page < pages && pageSleep > 0) {
          await sleep(pageSleep);
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
    },
  });

  ctx.effect?.(() => {
    return () => {
      try {
        tools.unregister?.(toolId);
      } catch (e) {
        // ignore
      }
    };
  });

  logger.info?.('[dsh-fofa-plugin] FOFA tool registered:', toolId);
}
