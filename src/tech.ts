import { loadRules, matchInputOf, matchTech, type RuleKind, type WappalyzerRules } from './wappalyzer.ts';

// Which technologies a site's homepage shows (moved from blog's /tech/, app/src/tech/detector.ts). One page proves
// what it carries, never what the site lacks: 未辨識 means no listed product left a trace there. Only the products
// below are looked for; the ids of blog's 36 are kept, so blog's observations import as they are.

export type TechCategory =
  | 'cms'
  | 'framework'
  | 'library'
  | 'server'
  | 'cdn'
  | 'hosting'
  | 'analytics'
  | 'ads'
  | 'consent'
  | 'media'
  | 'social'
  | 'security'
  | 'other'
  | 'theme'
  | 'plugin';
export const CATEGORY_LABEL: Record<TechCategory, string> = {
  cms: '內容管理系統',
  framework: '網站框架',
  library: '前端套件',
  server: '網頁伺服器',
  cdn: 'CDN',
  hosting: '主機',
  analytics: '分析追蹤',
  ads: '廣告',
  consent: 'Cookie 同意',
  media: '影音',
  social: '社群與留言',
  security: '防護與驗證',
  other: '其他',
  theme: 'WordPress 佈景',
  plugin: 'WordPress 外掛',
};
export const CATEGORIES = Object.keys(CATEGORY_LABEL) as TechCategory[];

/** [id, shown name, category, Wappalyzer names]. */
const VOCABULARY: Array<[string, string, TechCategory, string[]]> = [
  ['wordpress', 'WordPress', 'cms', ['WordPress']],
  ['drupal', 'Drupal', 'cms', ['Drupal']],
  ['joomla', 'Joomla', 'cms', ['Joomla']],
  ['movabletype', 'Movable Type', 'cms', ['Movable Type']],
  ['arcxp', 'Arc XP', 'cms', ['Arc XP']],
  ['aem', 'Adobe Experience Manager', 'cms', ['Adobe Experience Manager']],
  ['blogger', 'Blogger', 'cms', ['Blogger']],
  ['ghost', 'Ghost', 'cms', ['Ghost']],
  ['hugo', 'Hugo', 'cms', ['Hugo']],
  ['hexo', 'Hexo', 'cms', ['Hexo']],
  ['jekyll', 'Jekyll', 'cms', ['Jekyll']],
  ['medium', 'Medium', 'cms', ['Medium']],
  ['substack', 'Substack', 'cms', ['Substack']],
  ['pixnet', '痞客邦', 'cms', ['Pixnet']],
  ['notion', 'Notion', 'cms', ['Notion']],
  ['squarespace', 'Squarespace', 'cms', ['Squarespace']],
  ['wix', 'Wix', 'cms', ['Wix']],
  ['webflow', 'Webflow', 'cms', ['Webflow']],
  ['shopify', 'Shopify', 'cms', ['Shopify']],
  ['next', 'Next.js', 'framework', ['Next.js']],
  ['nuxt', 'Nuxt', 'framework', ['Nuxt.js']],
  ['gatsby', 'Gatsby', 'framework', ['Gatsby']],
  ['astro', 'Astro', 'framework', ['Astro']],
  ['remix', 'Remix', 'framework', ['Remix']],
  ['react', 'React', 'framework', ['React']],
  ['vue', 'Vue.js', 'framework', ['Vue.js']],
  ['angular', 'Angular', 'framework', ['Angular']],
  ['angularjs', 'AngularJS', 'framework', ['AngularJS']],
  ['svelte', 'Svelte', 'framework', ['Svelte']],
  ['alpinejs', 'Alpine.js', 'framework', ['Alpine.js']],
  ['laravel', 'Laravel', 'framework', ['Laravel']],
  ['django', 'Django', 'framework', ['Django']],
  ['rails', 'Ruby on Rails', 'framework', ['Ruby on Rails']],
  ['aspnet', 'ASP.NET', 'framework', ['Microsoft ASP.NET']],
  ['php', 'PHP', 'framework', ['PHP']],
  ['jquery', 'jQuery', 'library', ['jQuery']],
  ['bootstrap', 'Bootstrap', 'library', ['Bootstrap']],
  ['tailwind', 'Tailwind CSS', 'library', ['Tailwind CSS']],
  ['fontawesome', 'Font Awesome', 'library', ['Font Awesome']],
  ['googlefonts', 'Google Fonts', 'library', ['Google Font API']],
  ['swiper', 'Swiper', 'library', ['Swiper']],
  ['lodash', 'Lodash', 'library', ['Lodash']],
  ['corejs', 'core-js', 'library', ['core-js']],
  ['gsap', 'GSAP', 'library', ['GSAP']],
  ['modernizr', 'Modernizr', 'library', ['Modernizr']],
  ['webpack', 'webpack', 'library', ['Webpack']],
  ['vite', 'Vite', 'library', ['Vite']],
  ['nginx', 'Nginx', 'server', ['Nginx']],
  ['apache', 'Apache HTTP Server', 'server', ['Apache HTTP Server']],
  ['litespeed', 'LiteSpeed', 'server', ['LiteSpeed']],
  ['iis', 'IIS', 'server', ['IIS']],
  ['varnish', 'Varnish', 'server', ['Varnish']],
  ['envoy', 'Envoy', 'server', ['Envoy']],
  ['cloudflare', 'Cloudflare', 'cdn', ['Cloudflare']],
  ['akamai', 'Akamai', 'cdn', ['Akamai']],
  ['fastly', 'Fastly', 'cdn', ['Fastly']],
  ['cloudfront', 'Amazon CloudFront', 'cdn', ['Amazon CloudFront']],
  ['googlecloudcdn', 'Google Cloud CDN', 'cdn', ['Google Cloud CDN']],
  ['azurecdn', 'Azure CDN', 'cdn', ['Azure CDN']],
  ['alibabacdn', 'Alibaba Cloud CDN', 'cdn', ['Alibaba Cloud CDN']],
  ['gcore', 'Gcore', 'cdn', ['Gcore']],
  ['keycdn', 'KeyCDN', 'cdn', ['KeyCDN']],
  ['jsdelivr', 'jsDelivr', 'cdn', ['jsDelivr']],
  ['cdnjs', 'cdnjs', 'cdn', ['cdnjs']],
  ['googlehosted', 'Google Hosted Libraries', 'cdn', ['Google Hosted Libraries']],
  ['aws', 'Amazon Web Services', 'hosting', ['Amazon Web Services']],
  ['googlecloud', 'Google Cloud', 'hosting', ['Google Cloud']],
  ['azure', 'Azure', 'hosting', ['Azure']],
  ['firebase', 'Firebase', 'hosting', ['Firebase']],
  ['vercel', 'Vercel', 'hosting', ['Vercel']],
  ['netlify', 'Netlify', 'hosting', ['Netlify']],
  ['githubpages', 'GitHub Pages', 'hosting', ['GitHub Pages']],
  ['wpvip', 'WordPress VIP', 'hosting', ['WordPress VIP']],
  ['kinsta', 'Kinsta', 'hosting', ['Kinsta']],
  ['wpengine', 'WP Engine', 'hosting', ['WP Engine']],
  ['ga', 'Google Analytics', 'analytics', ['Google Analytics']],
  ['gtm', 'Google Tag Manager', 'analytics', ['Google Tag Manager']],
  ['matomo', 'Matomo', 'analytics', ['Matomo Analytics']],
  ['plausible', 'Plausible', 'analytics', ['Plausible']],
  ['chartbeat', 'Chartbeat', 'analytics', ['Chartbeat']],
  ['hotjar', 'Hotjar', 'analytics', ['Hotjar']],
  ['clarity', 'Microsoft Clarity', 'analytics', ['Microsoft Clarity']],
  ['facebookpixel', 'Meta Pixel', 'analytics', ['Facebook Pixel']],
  ['tiktokpixel', 'TikTok Pixel', 'analytics', ['TikTok Pixel']],
  ['adobeanalytics', 'Adobe Analytics', 'analytics', ['Adobe Analytics']],
  ['mixpanel', 'Mixpanel', 'analytics', ['Mixpanel']],
  ['segment', 'Segment', 'analytics', ['Segment']],
  ['tealium', 'Tealium', 'analytics', ['Tealium']],
  ['yahootagmanager', 'Yahoo! Tag Manager', 'analytics', ['Yahoo! Tag Manager']],
  ['cxense', 'Cxense', 'analytics', ['Cxense']],
  ['newrelic', 'New Relic', 'analytics', ['New Relic']],
  ['sentry', 'Sentry', 'analytics', ['Sentry']],
  ['adsense', 'Google AdSense', 'ads', ['Google AdSense']],
  ['gpt', 'Google Publisher Tag', 'ads', ['Google Publisher Tag']],
  ['prebid', 'Prebid', 'ads', ['Prebid']],
  ['taboola', 'Taboola', 'ads', ['Taboola']],
  ['outbrain', 'Outbrain', 'ads', ['Outbrain']],
  ['criteo', 'Criteo', 'ads', ['Criteo']],
  ['dable', 'Dable', 'ads', ['Dable']],
  ['yahooads', 'Yahoo Advertising', 'ads', ['Yahoo Advertising']],
  ['twitterads', 'X (Twitter) Ads', 'ads', ['Twitter Ads']],
  ['ezoic', 'Ezoic', 'ads', ['Ezoic']],
  ['mediavine', 'Mediavine', 'ads', ['Mediavine']],
  ['onetrust', 'OneTrust', 'consent', ['OneTrust']],
  ['cookiebot', 'Cookiebot', 'consent', ['Cookiebot']],
  ['didomi', 'Didomi', 'consent', ['Didomi']],
  ['fundingchoices', 'Google Funding Choices', 'consent', ['Funding Choices']],
  ['youtube', 'YouTube', 'media', ['YouTube']],
  ['vimeo', 'Vimeo', 'media', ['Vimeo']],
  ['jwplayer', 'JW Player', 'media', ['JW Player']],
  ['brightcove', 'Brightcove', 'media', ['Brightcove']],
  ['disqus', 'Disqus', 'social', ['Disqus']],
  ['addthis', 'AddThis', 'social', ['AddThis']],
  ['sharethis', 'ShareThis', 'social', ['ShareThis']],
  ['pinterest', 'Pinterest', 'social', ['Pinterest']],
  ['hcaptcha', 'hCaptcha', 'security', ['hCaptcha']],
  ['turnstile', 'Cloudflare Turnstile', 'security', ['Cloudflare Turnstile']],
  ['cloudflarebot', 'Cloudflare Bot Management', 'security', ['Cloudflare Bot Management']],
  ['imperva', 'Imperva', 'security', ['Imperva']],
  ['sucuri', 'Sucuri', 'security', ['Sucuri']],
  ['piano', 'Piano', 'other', ['Piano']],
  ['onesignal', 'OneSignal', 'other', ['OneSignal']],
  ['googlemaps', 'Google Maps', 'other', ['Google Maps']],
  ['wp-theme:astra', 'Astra', 'theme', ['Astra']],
  ['wp-theme:generatepress', 'GeneratePress', 'theme', ['GeneratePress']],
  ['wp-theme:kadence', 'Kadence', 'theme', ['Kadence WP Kadence']],
  ['wp-theme:oceanwp', 'OceanWP', 'theme', ['OceanWP']],
  ['wp-theme:neve', 'Neve', 'theme', ['Neve']],
  ['wp-theme:twentytwenty', 'Twenty Twenty', 'theme', ['Twenty Twenty']],
  ['wp-theme:twentytwentyone', 'Twenty Twenty-One', 'theme', ['Twenty Twenty-One']],
  ['wp-theme:twentytwentytwo', 'Twenty Twenty-Two', 'theme', ['Twenty Twenty-Two']],
  ['wp-theme:twentytwentythree', 'Twenty Twenty-Three', 'theme', ['Twenty Twenty-Three']],
  ['wp-theme:twentytwentyfour', 'Twenty Twenty-Four', 'theme', ['Twenty Twenty-Four']],
  ['wp-theme:twentytwentyfive', 'Twenty Twenty-Five', 'theme', ['Twenty Twenty-Five']],
  ['wp-plugin:wordpress-seo', 'Yoast SEO', 'plugin', ['Yoast SEO']],
  ['wp-plugin:jetpack', 'Jetpack', 'plugin', ['Jetpack']],
  ['wp-plugin:elementor', 'Elementor', 'plugin', ['Elementor']],
  ['wp-plugin:contact-form-7', 'Contact Form 7', 'plugin', ['Contact Form 7']],
  ['wp-plugin:wpforms-lite', 'WPForms Lite', 'plugin', ['WPForms']],
  ['wp-plugin:woocommerce', 'WooCommerce', 'plugin', ['WooCommerce']],
  ['wp-plugin:wp-rocket', 'WP Rocket', 'plugin', ['WP Rocket']],
  ['wp-plugin:litespeed-cache', 'LiteSpeed Cache', 'plugin', ['LiteSpeed Cache', 'Litespeed Cache']],
  ['wp-plugin:all-in-one-seo-pack', 'All in One SEO', 'plugin', ['All in One SEO', 'All in One SEO Pack']],
];
export const PRODUCTS = new Map(VOCABULARY.map(([id, name, category]) => [id, { id, name, category }]));
export const WAPPALYZER_NAMES: Record<string, string[]> = Object.fromEntries(VOCABULARY.map(([id, , , names]) => [id, names]));

export type TechStatus = 'detected' | 'unknown' | 'failed' | 'blocked';
/**
 * Why an attempt gave no page: a WAF or rate limit, an HTTP status, the response type, or the connection. 'robots' is
 * only on attempts made before 2026-10-25, when robots.txt was still read.
 */
export type TechErrorCode = 'robots' | 'waf' | 'rate-limit' | 'http-error' | 'not-html' | 'timeout' | 'network' | 'address';
export const ERROR_CODES: TechErrorCode[] = ['robots', 'waf', 'rate-limit', 'http-error', 'not-html', 'timeout', 'network', 'address'];
export type TechEvidence = { kind: 'generator' | 'asset' | 'marker' | 'header'; value: string };
export interface TechDetection {
  id: string;
  name: string;
  category: TechCategory;
  /** 0–1; hosting and CDN signals are hints and stay at most 0.4. */
  confidence: number;
  /** Only from an explicit `meta generator`; 'unknown' otherwise or when declarations conflict. */
  version: string;
  ruleId: string;
  ruleVersion: string;
  observedAt: string;
  evidence: TechEvidence[];
}
/** One attempt. detected/unknown carry the page's detections; failed/blocked say why there was no page. */
export interface TechObservation {
  status: TechStatus;
  /** Where the page came from after redirects, without query, fragment or sensitive path parts. */
  sourceUrl: string | null;
  httpStatus: number | null;
  errorCode: TechErrorCode | null;
  ruleVersion: string;
  at: string;
  detections: TechDetection[];
}

/** Source location only: never credentials, query or hash values, mail addresses, or tracking ids in paths. */
export function safeSourceUrl(raw: string): string | null {
  try {
    if (raw.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(raw)) return null;
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port)))
      return null;
    let redactNext = false;
    const path = url.pathname
      .split('/')
      .map((part) => {
        let decoded: string;
        try {
          decoded = decodeURIComponent(part);
        } catch {
          return 'redacted';
        }
        const sensitive = /^(?:token|secret|api[-_]?key|password|reset|auth|session|email)$/i.test(decoded);
        const omit = redactNext;
        redactNext = sensitive;
        return omit ||
          sensitive ||
          /@.*\.|(?:GTM-|G-|UA-)\w|[a-f\d]{32,}/i.test(decoded) ||
          /^[A-Za-z0-9_-]{25,}$/.test(decoded) ||
          decoded.length > 180
          ? 'redacted'
          : part;
      })
      .join('/');
    return `${url.origin}${path}`.slice(0, 1024);
  } catch {
    return null;
  }
}

const VERSION = /^\d{1,3}(?:\.\d{1,3}){0,3}(?:-(?:alpha|beta|rc)\d{0,3})?$/;
/** A matched rule says only a fixed phrase per rule kind as evidence, never the page's own text. */
const RULE_EVIDENCE: Record<Exclude<RuleKind, 'meta'>, TechEvidence> = {
  url: { kind: 'marker', value: 'URL rule' },
  html: { kind: 'marker', value: 'page markup rule' },
  dom: { kind: 'marker', value: 'page markup rule' },
  scripts: { kind: 'marker', value: 'inline script rule' },
  scriptSrc: { kind: 'asset', value: 'script URL rule' },
  headers: { kind: 'header', value: 'response header rule' },
};
export const MAX_HTML = 512 * 1024;
const MAX_DETECTIONS = 40;

/** One page through the rules. Pure: no requests. */
export function detect(
  rules: WappalyzerRules,
  page: { url: string; html: string; headers: Record<string, string | string[] | undefined>; status?: number },
  at = new Date(),
): TechObservation {
  const when = at.toISOString();
  const { input } = matchInputOf(page.url, page.html.slice(0, MAX_HTML), page.headers);
  const found: TechDetection[] = [];
  for (const [id, entries] of rules.products) {
    const product = PRODUCTS.get(id);
    if (!product) continue;
    let confidence = 0;
    let generator = false;
    const versions = new Set<string>();
    const kinds = new Set<RuleKind>();
    for (const entry of entries) {
      const result = matchTech(entry, input);
      if (!result) continue;
      confidence = Math.max(confidence, result.confidence);
      generator ||= result.generator;
      for (const version of result.generatorVersions) if (VERSION.test(version)) versions.add(version);
      for (const kind of result.matched) kinds.add(kind);
    }
    if (confidence <= 0) continue;
    // Conflicting explicit versions prove the product but not which one is running.
    const version = versions.size === 1 ? [...versions][0] : 'unknown';
    const evidence: TechEvidence[] = [];
    if (generator) evidence.push({ kind: 'generator', value: `${product.name}${version === 'unknown' ? '' : ` ${version}`}` });
    else if (kinds.has('meta')) evidence.push({ kind: 'marker', value: 'meta tag rule' });
    for (const kind of kinds) {
      if (kind === 'meta') continue;
      const item = RULE_EVIDENCE[kind];
      if (!evidence.some((e) => e.kind === item.kind && e.value === item.value)) evidence.push(item);
    }
    if (!evidence.length) continue;
    found.push({
      ...product,
      confidence: ['hosting', 'cdn'].includes(product.category) ? Math.min(0.4, confidence / 100) : confidence / 100,
      version,
      ruleId: `wappalyzer:${id}`,
      ruleVersion: rules.version,
      observedAt: when,
      evidence: evidence.slice(0, 3),
    });
  }
  const detections = found
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, MAX_DETECTIONS)
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    status: detections.length ? 'detected' : 'unknown',
    sourceUrl: safeSourceUrl(page.url),
    httpStatus: page.status ?? null,
    errorCode: null,
    ruleVersion: rules.version,
    at: when,
    detections,
  };
}

/**
 * A Cloudflare or WAF challenge page in place of the site. Not Cloudflare's /cdn-cgi/challenge-platform/ script alone:
 * Cloudflare adds it to ordinary pages too (104.com.tw's homepage carries it), so only the challenge's own markers count.
 */
export const isChallenge = (html: string, headers: Record<string, string | string[] | undefined>) => {
  const head = html.slice(0, 65536);
  return (
    String(headers['cf-mitigated'] ?? '').toLowerCase() === 'challenge' ||
    /(?:\b_?cf[-_]chl[-_][\w-]+|<title[^>]*>\s*(?:Just a moment|請稍候|Attention Required!\s*\|\s*Cloudflare))/i.test(head) ||
    /<title[^>]*>\s*(?:Access Denied|Request blocked|Security verification)/i.test(head)
  );
};

let cached: WappalyzerRules | null | undefined;
let problem = '';
/** The installed rules, loaded once; null when they are missing or altered (then no scan runs). */
export function activeRules(): WappalyzerRules | null {
  if (cached !== undefined) return cached;
  try {
    cached = loadRules(WAPPALYZER_NAMES);
  } catch (error) {
    cached = null;
    problem = error instanceof Error ? error.message : 'unknown';
  }
  return cached;
}
export const rulesProblem = () => (activeRules() ? null : problem);
/** Test seam: install a rules table, or null for none. */
export const setRulesForTest = (rules: WappalyzerRules | null | undefined) => {
  cached = rules;
};
