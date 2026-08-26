/**
 * scratch-plugin/src/fofa-plugin.ts
 *
 * DeepSeek Harness (Cordis) plugin for FOFA (fofa.info).
 * - Compatible with Node and DSH agent environments
 * - Uses global fetch if available, otherwise undici.fetch
 * - Exports searchFOFA, searchFOFASummary, buildFofaQuery helpers
 * - Exports default Cordis plugin object (name/inject/apply) with tool registration
 *
 * FOFA query helper (buildFofaQuery) accepts either a FOFA DSL string
 * or an object of filters, e.g. { app: 'nginx', domain: 'example.com' }
 * which gets translated to: 'app="nginx" && domain="example.com"'
 *
 * Security:
 *   - Credentials may come from: args > ctx.config.fofa > environment (FOFA_EMAIL/FOFA_KEY)
 */

import type { Context } from '@deepseek-ai/cordis';
import { fetch as undiciFetch } from 'undici';

export const name = 'dsh-fofa-plugin';
export const inject = ['tools'];

// Use global fetch if present, otherwise undici
const _fetch: typeof fetch = (globalThis as any).fetch ?? undiciFetch as any;

export interface FOFAQueryOptions {
  query: string;
  pages?: number;
  size?: number;
  email?: string;
  key?: string;
  url?: string;
  sleepMs?: number; // ms between page requests
  concurrency?: number; // reserved for future
}

export interface FOFAResultItem {
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

/**
 * buildFofaQuery - 将结构化描述或字符串转换为 FOFA DSL 字符串
 *
 * 支持输入：
 *  - 字符串（直接返回）
 *  - 对象：
 *      { _and: [ ... ] } / { _or: [ ... ] } / { _not: expr }
 *      { field: value }  // value 可为 string | number | boolean | array | { op, value } | { after, before } | { func, expr | args }
 *
 * 示例：
 *  buildFofaQuery({ app: 'nginx', domain: ['a.com','b.com'] })
 *   => 'app="nginx" && (domain="a.com" || domain="b.com")'
 *
 *  buildFofaQuery({ _or: [ { ip: '1.1.1.1' }, { domain: 'example.com' } ] })
 *   => '(ip="1.1.1.1" || domain="example.com")'
 */
export function buildFofaQuery(input: string | any): string {
  if (typeof input === 'string') return input.trim();

  function quoteVal(v: any): string {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    // Escape double quotes inside value
    return `"${String(v).replace(/"/g, '\\"')}"`;
  }

  function opToSymbol(op: string): string {
    switch (op) {
      case 'eq': case '=': return '=';
      case 'exact': case '==': return '==';
      case 'neq': case '!=': return '!=';
      case 'like': case '*=': return '*=';
      default: return op; // allow direct symbols if provided
    }
  }

  function buildFieldExpr(field: string, val: any): string {
    // If val is primitive
    if (val === null || val === undefined) {
      return `${field}=""`;
    }
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      if (typeof val === 'boolean') return `${field}=${val ? 'true' : 'false'}`;
      if (typeof val === 'number') return `${field}=${val}`;
      return `${field}=${quoteVal(val)}`;
    }

    // Array => OR of values
    if (Array.isArray(val)) {
      const parts = val.map(v => buildFieldExpr(field, v));
      return `(${parts.join(' || ')})`;
    }

    // Object: might be {op, value} or {after,before} or function descriptor
    if (typeof val === 'object') {
      // function form: { func: 'ip_filter', expr: 'banner="SSH-..."' } or { func: 'ip_filter', args: ['banner="..."', 'icon_hash="..."'] }
      if (val.func) {
        const fn = String(val.func);
        if (typeof val.expr === 'string') {
          return `${fn}(${val.expr})`;
        }
        if (Array.isArray(val.args)) {
          // produce fn(arg) && fn(arg2) ...
          return val.args.map((a: any) => `${fn}(${typeof a === 'string' ? a : buildFofaQuery(a)})`).join(' && ');
        }
        // fallback: pass object fields as exprs joined with ' && '
        const argExprs: string[] = [];
        for (const [k, v] of Object.entries(val)) {
          if (k === 'func') continue;
          if (k === 'expr' || k === 'args') continue;
          argExprs.push(buildFieldExpr(String(k), v));
        }
        return `${fn}(${argExprs.join(' && ')})`;
      }

      // range / time style: { after: '2023-01-01', before: '2023-12-01' }
      if ('after' in val || 'before' in val) {
        const parts: string[] = [];
        if ('after' in val) parts.push(`${field}.after=${quoteVal(val.after)}`);
        if ('before' in val) parts.push(`${field}.before=${quoteVal(val.before)}`);
        return parts.join(' && ');
      }

      // operator form: { op: '==', value: 'x' } or { op: 'like', value: 'v*' }
      if ('op' in val && 'value' in val) {
        const sym = opToSymbol(String(val.op));
        const v = val.value;
        if (typeof v === 'boolean' || typeof v === 'number') {
          return `${field}${sym}${v}`;
        }
        return `${field}${sym}${quoteVal(v)}`;
      }

      // Nested object where keys are subfields (support cert.not_after.after via nested)
      const nestedParts: string[] = [];
      for (const [subk, subv] of Object.entries(val)) {
        const dotted = `${field}.${subk}`;
        nestedParts.push(buildFieldExpr(dotted, subv));
      }
      return nestedParts.join(' && ');
    }

    // fallback
    return `${field}=${quoteVal(String(val))}`;
  }

  function buildFromObj(obj: any): string {
    if (obj === null || obj === undefined) return '';

    // boolean operators keys: _and, _or, _not
    if (typeof obj === 'object' && !Array.isArray(obj)) {
      if ('_and' in obj) {
        const arr = Array.isArray(obj._and) ? obj._and : [obj._and];
        const parts = arr.map((e: any) => typeof e === 'string' ? e : buildFromObj(e)).filter(Boolean);
        return parts.length > 1 ? `(${parts.join(' && ')})` : parts[0] ?? '';
      }
      if ('_or' in obj) {
        const arr = Array.isArray(obj._or) ? obj._or : [obj._or];
        const parts = arr.map((e: any) => typeof e === 'string' ? e : buildFromObj(e)).filter(Boolean);
        return parts.length > 1 ? `(${parts.join(' || ')})` : parts[0] ?? '';
      }
      if ('_not' in obj) {
        const e = obj._not;
        const inner = typeof e === 'string' ? e : buildFromObj(e);
        return `!(${inner})`;
      }

      const parts: string[] = [];
      for (const [k, v] of Object.entries(obj)) {
        if (!k) continue;
        parts.push(buildFieldExpr(k, v));
      }
      if (parts.length === 0) return '';
      if (parts.length === 1) return parts[0];
      return `(${parts.join(' && ')})`;
    }

    if (Array.isArray(obj)) {
      const parts = obj.map(e => (typeof e === 'string' ? e : buildFromObj(e))).filter(Boolean);
      return parts.length > 1 ? `(${parts.join(' || ')})` : parts[0] ?? '';
    }

    return String(obj);
  }

  return buildFromObj(input).trim();
}

// Helper: short textual summary for LLM / AI consumption
export function summarizeResults(items: FOFAResultItem[], topN = 5): string {
  const take = items.slice(0, topN);
  const lines = take.map((it, idx) => {
    // Try common fields
    const host = it.host || it.ip || it.domain || it.value || '';
    const port = it.port ? `:${it.port}` : '';
    const app = it.app || it.service || '';
    const title = it.title ? ` title="${it.title}"` : '';
    return `${idx + 1}. ${host}${port}${app ? ` (${app})` : ''}${title}`.trim();
  });
  return `Top ${Math.min(topN, items.length)} assets:\n` + lines.join('\n');
}

// core search function
export async function searchFOFA(
  opts: FOFAQueryOptions,
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

  const qbase64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

  const items: FOFAResultItem[] = [];
  let fetchedPages = 0;
  let totalEstimate: number | null = null;

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
        const resp = await _fetch(url, { method: 'GET' } as any);
        if (!resp.ok) {
          const text = await resp.text();
          const errMsg = `FOFA HTTP ${resp.status} ${resp.statusText}: ${text}`;
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
        break;
      } catch (err) {
        lastError = err;
        const backoff = baseBackoffMs * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }

    if (lastError && page === 1 && fetchedPages === 0) {
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

// Convenience: return both structured results and a short textual summary.
export async function searchFOFASummary(opts: FOFAQueryOptions, overrideConfig?: { email?: string; key?: string; url?: string }) {
  const res = await searchFOFA(opts, overrideConfig);
  const summary = summarizeResults(res.items, 5);
  return { ...res, summary };
}

// Cordis plugin export
export default {
  name,
  inject,
  apply(ctx: Context) {
    const tools = (ctx as any).tools;
    const logger = (ctx as any).logger ?? console;

    const toolId = 'fofa.search';

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
            summary: { type: 'string' },
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

        const override = {
          email: (ctx as any).config?.fofa?.email,
          key: (ctx as any).config?.fofa?.key,
          url: (ctx as any).config?.fofa?.url,
        };

        try {
          const res = await searchFOFASummary(opts, override);
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
