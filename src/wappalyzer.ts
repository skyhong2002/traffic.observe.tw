import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as cheerio from 'cheerio';

// A small matcher for the Wappalyzer technology-rule format (the src/technologies/*.json files of the community fork
// enthec/webappanalyzer), moved from blog (app/src/tech/wappalyzer/). Written from the public rule schema, no code from
// wappalyzer-core, so this file stays MIT. The rule data is GPL-3.0 and never committed: tools/fetch-wappalyzer-rules.ts
// downloads exactly the files data/wappalyzer-pin.json names into TRAFFIC_WAPPALYZER_RULES_DIR (default
// ~/.local/share/traffic-observe/wappalyzer/<commit>/), and the loader refuses a file whose hash differs.
//
// Evaluated: url, html, scriptSrc, scripts, meta, headers, dom (exists / attributes). Not evaluated, because they need a
// browser, cookies or extra requests: js, css, cookies, xhr, dns, probe, implies, excludes. A dom `text` pattern is
// ignored too: an article mentioning a product does not mean the site runs it. Only the products tech.ts publishes are
// compiled, so the third-party regular expressions run on untrusted pages stay a reviewed few hundred
// (test/tech.spec.ts runs every one against hostile input where the data is installed).

export type RuleKind = 'url' | 'html' | 'scriptSrc' | 'scripts' | 'meta' | 'headers' | 'dom';
export type RulePattern = { regex: RegExp | null; version: string; confidence: number };
export type CompiledRule = { kind: RuleKind; key?: string; attribute?: string; pattern: RulePattern };
export type CompiledTech = { name: string; rules: CompiledRule[] };
export type MatchInput = {
  url: string;
  html: string;
  scriptSrc: string[];
  scripts: string[];
  /** lower-case meta name → contents */
  meta: Map<string, string[]>;
  /** lower-case header name → values */
  headers: Map<string, string[]>;
  dom: cheerio.CheerioAPI;
  /** performance.now() after which no further rule runs on this page. */
  deadline?: number;
};
export type MatchResult = { confidence: number; generatorVersions: string[]; matched: RuleKind[]; generator: boolean };

const MAX_PATTERN = 600;
/** Inspected nodes (meta and script tags) per page. */
export const MAX_NODES = 2000;
/**
 * Some real rules (`<link rel="stylesheet" [^>]+/wp-…`) backtrack quadratically and take seconds on 512 KiB of repeated
 * `<link `. Long texts are tested in small overlapping windows (a match is a tag or a short phrase), and a page gets a
 * fixed time budget on top.
 */
export const MATCH_BUDGET_MS = 250;
const WINDOW = 4096;
const OVERLAP = 1024;
const expired = (deadline: number | undefined) => deadline !== undefined && performance.now() > deadline;

function testWindowed(pattern: RulePattern, text: string, deadline: number | undefined): boolean {
  const { regex } = pattern;
  if (regex === null) return true;
  if (text.length <= WINDOW) return regex.test(text);
  const start = regex.source.startsWith('^');
  const end = /(?<!\\)\$$/.test(regex.source);
  if (start && end) return false;
  if (start) return regex.test(text.slice(0, WINDOW));
  if (end) return regex.test(text.slice(-WINDOW));
  for (let at = 0; at < text.length; at += WINDOW - OVERLAP) {
    if (expired(deadline)) return false;
    if (regex.test(text.slice(at, at + WINDOW))) return true;
  }
  return false;
}

/** `regex\;version:\1\;confidence:50` → its parts; null when the regex does not compile. */
export function parsePattern(raw: unknown): RulePattern | null {
  if (typeof raw !== 'string') return null;
  const [source, ...attributes] = raw.split('\\;');
  if (source.length > MAX_PATTERN) return null;
  let confidence = 100;
  let version = '';
  for (const attribute of attributes) {
    const at = attribute.indexOf(':');
    if (at < 0) continue;
    const key = attribute.slice(0, at);
    const value = attribute.slice(at + 1);
    if (key === 'confidence') {
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0 && number <= 100) confidence = number;
    } else if (key === 'version') version = value;
  }
  if (source === '') return { regex: null, version, confidence };
  try {
    return { regex: new RegExp(source, 'i'), version, confidence };
  } catch {
    return null;
  }
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One technology's rules in the evaluated subset; unknown or unsafe fields are dropped. */
export function compileTech(name: string, raw: unknown): CompiledTech {
  const rules: CompiledRule[] = [];
  if (!isRecord(raw)) return { name, rules };
  const add = (kind: RuleKind, source: unknown, extra: { key?: string; attribute?: string } = {}) => {
    const pattern = parsePattern(source);
    if (pattern) rules.push({ kind, ...extra, pattern });
  };
  for (const kind of ['url', 'html', 'scriptSrc', 'scripts'] as const) for (const source of listOf(raw[kind])) add(kind, source);
  for (const kind of ['meta', 'headers'] as const) {
    const table = raw[kind];
    if (!isRecord(table)) continue;
    for (const [key, value] of Object.entries(table)) for (const source of listOf(value)) add(kind, source, { key: key.toLowerCase() });
  }
  const dom = raw.dom;
  if (typeof dom === 'string' || Array.isArray(dom)) {
    for (const selector of listOf(dom)) if (typeof selector === 'string') add('dom', '', { key: selector });
  } else if (isRecord(dom)) {
    for (const [selector, spec] of Object.entries(dom)) {
      if (!isRecord(spec)) {
        add('dom', '', { key: selector });
        continue;
      }
      if ('exists' in spec) add('dom', typeof spec.exists === 'string' ? spec.exists : '', { key: selector });
      if (isRecord(spec.attributes))
        for (const [attribute, source] of Object.entries(spec.attributes)) add('dom', source, { key: selector, attribute });
    }
  }
  return { name, rules };
}

const matches = (pattern: RulePattern, value: string) => pattern.regex === null || pattern.regex.test(value);

function matchRule(rule: CompiledRule, input: MatchInput): { hit: boolean; versions?: string[] } {
  const { pattern } = rule;
  switch (rule.kind) {
    case 'url':
      return { hit: matches(pattern, input.url) };
    case 'html':
      return { hit: testWindowed(pattern, input.html, input.deadline) };
    case 'scriptSrc':
      return { hit: input.scriptSrc.some((value) => !expired(input.deadline) && matches(pattern, value)) };
    case 'scripts':
      return { hit: input.scripts.some((value) => !expired(input.deadline) && testWindowed(pattern, value, input.deadline)) };
    case 'headers': {
      const values = input.headers.get(rule.key ?? '') ?? [];
      return { hit: pattern.regex === null ? values.length > 0 : values.some((value) => pattern.regex?.test(value)) };
    }
    case 'meta': {
      const values = input.meta.get(rule.key ?? '') ?? [];
      if (pattern.regex === null) return { hit: values.length > 0 };
      // Every matching tag counts: a page can carry stale or duplicated generators, and the caller decides on conflicts.
      const versions: string[] = [];
      let hit = false;
      for (const value of values) {
        const found = pattern.regex.exec(value);
        if (!found) continue;
        hit = true;
        if (pattern.version === '\\1' && found[1]) versions.push(found[1]);
      }
      return { hit, versions };
    }
    case 'dom': {
      let elements: ReturnType<cheerio.CheerioAPI>;
      try {
        elements = input.dom(rule.key ?? '');
      } catch {
        return { hit: false };
      }
      if (!elements.length) return { hit: false };
      if (!rule.attribute) return { hit: true };
      const attribute = rule.attribute;
      return {
        hit: elements.toArray().some((element) => {
          const value = input.dom(element).attr(attribute);
          return value !== undefined && matches(pattern, value);
        }),
      };
    }
  }
}

/** Every rule of one technology. Confidence is the capped sum of matched rules; a total of 0 is no detection. */
export function matchTech(tech: CompiledTech, input: MatchInput): MatchResult | null {
  let confidence = 0;
  let generator = false;
  const generatorVersions: string[] = [];
  const matched = new Set<RuleKind>();
  for (const rule of tech.rules) {
    if (expired(input.deadline)) break;
    const { hit, versions } = matchRule(rule, input);
    if (!hit) continue;
    confidence += rule.pattern.confidence;
    if (rule.pattern.confidence > 0) matched.add(rule.kind);
    if (rule.kind === 'meta' && rule.key === 'generator') {
      generator = true;
      generatorVersions.push(...(versions ?? []));
    }
  }
  if (confidence <= 0) return null;
  return { confidence: Math.min(100, confidence), generatorVersions, matched: [...matched], generator };
}

/** What the rules read out of one response: meta tags, script addresses and inline scripts, the headers, the document. */
export function matchInputOf(url: string, html: string, headers: Record<string, string | string[] | undefined> = {}) {
  const $ = cheerio.load(html);
  const meta = new Map<string, string[]>();
  const scriptSrc: string[] = [];
  const scripts: string[] = [];
  let inspectedNodes = 0;
  $('meta[name],meta[property],script')
    .slice(0, MAX_NODES)
    .each((_index, element) => {
      inspectedNodes++;
      const el = $(element);
      if (element.tagName === 'meta') {
        const name = (el.attr('name') ?? el.attr('property') ?? '').trim().toLowerCase();
        if (name) meta.set(name, [...(meta.get(name) ?? []), (el.attr('content') ?? '').slice(0, 512)]);
        return;
      }
      const src = el.attr('src');
      if (!src) scripts.push(el.html()?.slice(0, 65536) ?? '');
      else if (src.length <= 4096)
        try {
          scriptSrc.push(new URL(src, url).href);
        } catch {
          /* an unusable address proves nothing */
        }
    });
  const table = new Map<string, string[]>();
  for (const [name, value] of Object.entries(headers))
    for (const v of listOf(value))
      if (typeof v === 'string') table.set(name.toLowerCase(), [...(table.get(name.toLowerCase()) ?? []), v.slice(0, 512)]);
  const input: MatchInput = { url, html, scriptSrc, scripts, meta, headers: table, dom: $, deadline: performance.now() + MATCH_BUDGET_MS };
  return { input, inspectedNodes };
}

export type WappalyzerPin = { repository: string; commit: string; license: string; pinnedAt: string; files: Record<string, string> };
export type WappalyzerRules = {
  /** Stored as each observation's rule version: changes whenever the pinned data changes. */
  version: string;
  commit: string;
  /** product id → every compiled Wappalyzer entry for it */
  products: Map<string, CompiledTech[]>;
  /** Mapped names the data no longer has (a renamed technology): reported by tools/fetch-wappalyzer-rules.ts --check. */
  missing: string[];
};

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const PIN_PATH = new URL('../data/wappalyzer-pin.json', import.meta.url);
export const rulesDirectory = () => process.env.TRAFFIC_WAPPALYZER_RULES_DIR || join(homedir(), '.local/share/traffic-observe/wappalyzer');

export function readPin(path: URL | string = PIN_PATH): WappalyzerPin {
  const pin = JSON.parse(readFileSync(path, 'utf8')) as WappalyzerPin;
  if (!/^[0-9a-f]{40}$/.test(pin.commit) || typeof pin.files !== 'object') throw Error('invalid wappalyzer pin');
  return pin;
}

/** The named products (id → Wappalyzer names) out of a name → rule table. */
export function compileVocabulary(technologies: Record<string, unknown>, commit: string, names: Record<string, string[]>): WappalyzerRules {
  const products = new Map<string, CompiledTech[]>();
  const missing: string[] = [];
  for (const [id, list] of Object.entries(names)) {
    const compiled: CompiledTech[] = [];
    for (const name of list) {
      if (Object.hasOwn(technologies, name)) compiled.push(compileTech(name, technologies[name]));
      else missing.push(name);
    }
    if (compiled.length) products.set(id, compiled);
  }
  return { version: `wappalyzer-${commit.slice(0, 12)}`, commit, products, missing };
}

/** Reads and verifies the pinned files under `<directory>/<commit>/`; throws on a missing or altered file. */
export function loadRules(names: Record<string, string[]>, directory = rulesDirectory(), pin = readPin()): WappalyzerRules {
  const root = join(directory, pin.commit);
  const technologies: Record<string, unknown> = {};
  for (const [file, expected] of Object.entries(pin.files)) {
    const path = join(root, file);
    if (!existsSync(path)) throw Error(`wappalyzer rules incomplete: ${file}`);
    const data = readFileSync(path);
    if (sha256(data) !== expected) throw Error(`wappalyzer rules altered: ${file}`);
    if (file.startsWith('technologies/')) Object.assign(technologies, JSON.parse(data.toString('utf8')));
  }
  return compileVocabulary(technologies, pin.commit, names);
}
