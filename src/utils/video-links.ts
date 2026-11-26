/**
 * Videolinks uit een geclipte pagina halen.
 *
 * Waarom: X zet in de DOM een `<video>` met een `blob:`-adres (of helemaal geen `src`) en bewaart
 * de echte mp4 alleen in zijn bootstrap-JSON. De content-extractie laat `<script>` weg, dus een
 * tweet met video komt zonder enige verwijzing in de notitie terecht. Deze module haalt de
 * mp4-varianten op via de publieke syndication-API en zet ze als gewone Markdown-link onder de clip.
 *
 * Reddit doet hetzelfde met de zijne: `shreddit-player` speelt via MediaSource en de mp4's staan
 * in het `packaged-media-json`-attribuut van die speler, dat de content-extractie niet leest. Die
 * attributen halen we uit de volledige pagina-HTML (`fullHtml`), niet uit de geëxtraheerde inhoud.
 *
 * Alleen linken, niet bewaren: video's zijn groot en Zett's `/ingest/media` accepteert nu alleen
 * beelden (zie `docs/media-archivering.md` in de repo van Zett). De link is wat je nodig hebt om de
 * video terug te vinden; de bytes archiveren is een aparte stap.
 */

import { debugLog } from './debug';

export interface VideoLink {
	url: string;
	poster?: string;
	durationMs?: number;
	bitrate?: number;
	/** Naam van de externe speler (YouTube, Vimeo, …) als de video daar staat en niet hier. */
	provider?: string;
	source: 'tweet' | 'page';
}

export interface RawVariant {
	bitrate?: number;
	content_type?: string;
	type?: string;
	url?: string;
	src?: string;
}

export interface VideoMetaTag {
	name?: string | null;
	property?: string | null;
	content?: string | null;
}

export interface VideoLinkContext {
	pageUrl: string;
	contentHtml?: string;
	/** De volledige pagina-HTML; Reddit bewaart zijn mp4's in een attribuut daarin. */
	fullHtml?: string;
	metaTags?: VideoMetaTag[];
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

const SYNDICATION_ENDPOINT = 'https://cdn.syndication.twimg.com/tweet-result';
const DEFAULT_TIMEOUT_MS = 5000;

/** Zegt of deze HTML een Reddit-speler kan bevatten; scheelt een DOMParser over elke pagina. */
const REDDIT_SIGNAL = /packaged-media-json|v\.redd\.it/i;

/** Zegt of deze HTML een Reddit-post kan bevatten (voor de uitgaande videolink van een linkpost). */
const REDDIT_POST = /<shreddit-post[\s>]/i;

/**
 * Spelers die we herkennen als de video niet op de pagina zelf staat. Alleen de host telt: een
 * linkpost naar YouTube heeft in de HTML geen spoor van de video zelf.
 */
const VIDEO_PROVIDERS: Array<{ host: RegExp; name: string }> = [
	{ host: /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/, name: 'YouTube' },
	{ host: /(^|\.)(x\.com|twitter\.com)$/, name: 'X' },
	{ host: /(^|\.)vimeo\.com$/, name: 'Vimeo' },
	{ host: /(^|\.)streamable\.com$/, name: 'Streamable' },
	{ host: /(^|\.)twitch\.tv$/, name: 'Twitch' },
	{ host: /(^|\.)(dailymotion\.com|dai\.ly)$/, name: 'Dailymotion' },
	{ host: /(^|\.)redgifs\.com$/, name: 'RedGifs' },
	{ host: /(^|\.)gfycat\.com$/, name: 'Gfycat' },
	{ host: /(^|\.)imgur\.com$/, name: 'Imgur' },
];

/**
 * Het statusnummer uit een x.com/twitter.com-adres, of `null`.
 * Accepteert `/user/status/123`, `/i/status/123`, `/i/web/status/123`, `/statuses/123`,
 * een `/video/1`-staart en query-strings.
 */
export function tweetIdFromUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}

	const host = parsed.hostname.toLowerCase().replace(/^(www|mobile|m)\./, '');
	if (host !== 'x.com' && host !== 'twitter.com') return null;

	const match = /^\/(?:i\/web|i|[^/]+)\/status(?:es)?\/(\d+)/.exec(parsed.pathname);
	return match ? match[1] : null;
}

/** Een mp4-variant, bij voorkeur de hoogste bitrate; HLS-playlists vallen af. */
export function pickBestMp4(variants: RawVariant[] | undefined): { url: string; bitrate?: number } | null {
	if (!Array.isArray(variants)) return null;

	let best: { url: string; bitrate?: number; score: number } | null = null;

	for (const variant of variants) {
		const url = variant?.url || variant?.src;
		if (!url) continue;

		const type = (variant.content_type || variant.type || '').toLowerCase();
		const path = safePath(url);
		const isMp4 = type.includes('mp4') || path.endsWith('.mp4');
		if (!isMp4) continue;

		const bitrate = Number(variant.bitrate) || 0;
		const resolution = /(\d{2,5})x(\d{2,5})/.exec(path);
		const pixels = resolution ? Number(resolution[1]) * Number(resolution[2]) : 0;
		const score = bitrate * 1e6 + pixels;

		if (!best || score > best.score) {
			best = { url, bitrate: bitrate || undefined, score };
		}
	}

	return best ? { url: best.url, bitrate: best.bitrate } : null;
}

/** `0:04`, `1:02:03`; leeg als de duur onbekend is. */
export function formatDuration(ms: number | undefined): string {
	if (!ms || ms <= 0) return '';
	const total = Math.round(ms / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const pad = (value: number) => String(value).padStart(2, '0');
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function videoLinkMarkdown(link: VideoLink, index?: number): string {
	const duration = formatDuration(link.durationMs);
	const provider = link.provider ? ` (${link.provider})` : '';
	const label = `Video${index ? ` ${index}` : ''}${provider}${duration ? ` (${duration})` : ''}`;
	return `[${label}](${link.url})`;
}

/** De naam van de speler waar deze link naartoe gaat, of `null` als het geen bekende videoservice is. */
export function videoProviderFromUrl(url: string): string | null {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
	} catch {
		return null;
	}
	const match = VIDEO_PROVIDERS.find(entry => entry.host.test(host));
	return match ? match.name : null;
}

/** Haalt de mp4-varianten van een tweet op. Stille mislukking: geen video is geen fout. */
export async function resolveTweetVideos(
	tweetUrl: string,
	fetchImpl: typeof fetch = fetch,
	timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<VideoLink[]> {
	const id = tweetIdFromUrl(tweetUrl);
	if (!id) return [];

	const endpoint = `${SYNDICATION_ENDPOINT}?id=${encodeURIComponent(id)}&lang=en&token=4`;

	let timer: ReturnType<typeof setTimeout> | undefined;
	const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
	if (controller && timeoutMs > 0) {
		timer = setTimeout(() => controller.abort(), timeoutMs);
	}

	try {
		const response = await fetchImpl(endpoint, {
			headers: { accept: 'application/json' },
			credentials: 'omit',
			signal: controller?.signal,
		});
		if (!response.ok) {
			debugLog('Video links', `Syndication gaf ${response.status} voor ${id}`);
			return [];
		}

		const payload: any = await response.json();
		return videosFromSyndication(payload);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** De vormen die de syndication-API door de jaren heen gebruikt: `mediaDetails` en `video`. */
export function videosFromSyndication(payload: any): VideoLink[] {
	const links: VideoLink[] = [];

	const details: any[] = Array.isArray(payload?.mediaDetails) ? payload.mediaDetails : [];
	for (const detail of details) {
		if (detail?.type && detail.type !== 'video' && detail.type !== 'animated_gif') continue;

		const info = detail?.video_info || {};
		const best = pickBestMp4(info.variants);
		if (!best) continue;

		links.push({
			url: best.url,
			poster: typeof detail.media_url_https === 'string' ? detail.media_url_https : undefined,
			durationMs: typeof info.duration_millis === 'number' ? info.duration_millis : undefined,
			bitrate: best.bitrate,
			source: 'tweet',
		});
	}

	if (links.length === 0 && payload?.video) {
		const video = payload.video;
		const best = pickBestMp4(video.variants);
		if (best) {
			links.push({
				url: best.url,
				poster: typeof video.poster === 'string' ? video.poster : undefined,
				durationMs: typeof video.durationMs === 'number' ? video.durationMs : undefined,
				bitrate: best.bitrate,
				source: 'tweet',
			});
		}
	}

	return dedupe(links);
}

/** `<video src>`, `<source src>` en de meta-tags die een pagina expliciet als video aanwijzen. */
export function collectPageVideoLinks(
	html: string,
	pageUrl: string,
	metaTags: VideoMetaTag[] = []
): VideoLink[] {
	const links: VideoLink[] = [];

	if (html) {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		const candidates: string[] = [];

		doc.querySelectorAll('video[src]').forEach(video => {
			const src = video.getAttribute('src');
			if (src) candidates.push(src);
		});
		doc.querySelectorAll('video source[src]').forEach(source => {
			const src = source.getAttribute('src');
			if (src) candidates.push(src);
		});

		addPageLinks(links, candidates, pageUrl);
	}

	const metaNames = new Set([
		'og:video',
		'og:video:url',
		'og:video:secure_url',
		'twitter:player:stream',
	]);
	const metaCandidates = metaTags
		.filter(tag => metaNames.has((tag.property || tag.name || '').toLowerCase()))
		.map(tag => tag.content || '')
		.filter(Boolean);
	addPageLinks(links, metaCandidates, pageUrl);

	return dedupe(links);
}

/**
 * De mp4-adressen uit het `packaged-media-json` van een Reddit-speler, hoogste resolutie eerst.
 * Vorm: `{ "playbackMp4s": { "permutations": [{ "source": { "url": ..., "dimensions": {...} } }] } }`.
 * In HTML staan de aanhalingstekens als `&quot;`; DOMParser decodeert die meestal al, vandaar de
 * tweede poging.
 */
export function redditPackagedMp4s(raw: string | null | undefined): string[] {
	if (!raw) return [];

	let payload: any;
	try {
		payload = JSON.parse(raw);
	} catch {
		try {
			payload = JSON.parse(raw.replace(/&quot;/g, '"'));
		} catch {
			return [];
		}
	}

	const permutations: any[] = Array.isArray(payload?.playbackMp4s?.permutations)
		? payload.playbackMp4s.permutations
		: Array.isArray(payload?.playbackMp4s)
			? payload.playbackMp4s
			: [];

	const ranked = permutations
		.map(entry => {
			const url = entry?.source?.url || entry?.url || entry?.src;
			const dimensions = entry?.source?.dimensions || {};
			const area = (Number(dimensions.width) || 0) * (Number(dimensions.height) || 0);
			return { url: typeof url === 'string' ? url : '', area };
		})
		.filter(entry => /^https?:\/\//i.test(entry.url))
		.sort((a, b) => b.area - a.area);

	const seen = new Set<string>();
	const urls: string[] = [];
	for (const entry of ranked) {
		if (seen.has(entry.url)) continue;
		seen.add(entry.url);
		urls.push(entry.url);
	}
	return urls;
}

/**
 * De uitgaande videolink van een Reddit-linkpost: staat de video bij YouTube, Vimeo, Streamable of
 * een andere bekende speler, dan is de link het enige spoor in de HTML. We kijken alleen binnen
 * `<shreddit-post>`, want de rest van de pagina staat vol links naar andere posts.
 */
export function redditExternalVideoLinks(html: string, pageUrl: string): VideoLink[] {
	if (!html || !REDDIT_POST.test(html)) return [];

	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(html, 'text/html');
	} catch {
		return [];
	}

	return externalVideoLinksFromDoc(doc, pageUrl);
}

function externalVideoLinksFromDoc(doc: Document, pageUrl: string): VideoLink[] {
	const links: VideoLink[] = [];
	doc.querySelectorAll('shreddit-post').forEach(post => {
		const candidates: string[] = [];
		for (const name of ['content-href', 'url', 'post-url', 'link-url']) {
			const value = post.getAttribute(name);
			if (value) candidates.push(value);
		}
		post.querySelectorAll('a[href]').forEach(anchor => candidates.push(anchor.getAttribute('href') || ''));

		for (const candidate of candidates) {
			const absolute = absoluteHttpUrl(candidate, pageUrl);
			if (!absolute) continue;

			const provider = videoProviderFromUrl(absolute);
			if (!provider && !isMp4Url(absolute)) continue;

			links.push({ url: absolute, provider: provider || undefined, source: 'page' });
		}
	});

	return dedupe(links);
}

/**
 * De videolinks van een Reddit-post. Eerst de mp4's uit de speler-JSON; heeft de speler die nog
 * niet, dan blijft de HLS-playlist of de DASH-manifest over. De `preview` slaan we over: dat is
 * een stille 96p-clip voor de seek-balk, geen video.
 */
export function collectRedditVideoLinks(html: string, pageUrl: string): VideoLink[] {
	if (!html || (!REDDIT_SIGNAL.test(html) && !REDDIT_POST.test(html))) return [];

	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(html, 'text/html');
	} catch {
		return [];
	}

	const links: VideoLink[] = [];
	if (REDDIT_SIGNAL.test(html)) {
		doc.querySelectorAll('[packaged-media-json]').forEach(player => {
			// Eén link per speler: de resoluties zijn dezelfde video in verschillende maten.
			const [url] = redditPackagedMp4s(player.getAttribute('packaged-media-json'));
			if (!url) return;
			const poster = absoluteHttpUrl(player.getAttribute('poster') || '', pageUrl) || undefined;
			links.push({ url, poster, source: 'page' });
		});
	}
	if (links.length === 0) {
		const candidates: string[] = [];
		doc.querySelectorAll('shreddit-player, [data-hls-url], [data-mpd-url]').forEach(player => {
			for (const name of ['src', 'data-hls-url', 'data-mpd-url', 'preview']) {
				const value = player.getAttribute(name);
				if (value && !/(?:CMAF|DASH)_96\.mp4/i.test(value)) candidates.push(value);
			}
		});
		addPageLinks(links, candidates, pageUrl);
	}

	return dedupe([...links, ...externalVideoLinksFromDoc(doc, pageUrl)]);
}

/**
 * Alle videolinks die bij deze pagina horen: eerst de tweet zelf, dan wat de inhoud aanwijst.
 * Linkt een Reddit-post naar een tweet, dan halen we de mp4's van die tweet op en vervangen we de
 * tweet-link; zonder video blijft de tweet-link staan.
 */
export async function resolveVideoLinks(context: VideoLinkContext): Promise<VideoLink[]> {
	const links: VideoLink[] = [];

	if (tweetIdFromUrl(context.pageUrl)) {
		try {
			links.push(...await resolveTweetVideos(context.pageUrl, context.fetchImpl, context.timeoutMs));
		} catch (error) {
			debugLog('Video links', 'Tweet ophalen mislukt:', error instanceof Error ? error.message : error);
		}
	}

	// Reddit: de mp4's staan in een attribuut op de speler in de volledige pagina-HTML. De
	// geëxtraheerde inhoud (`contentHtml`) bevat dat attribuut niet.
	const redditLinks = collectRedditVideoLinks(context.fullHtml || context.contentHtml || '', context.pageUrl);
	links.push(...redditLinks);

	if (redditLinks.some(link => link.provider === 'X')) {
		const resolved = new Map<string, VideoLink[]>();
		for (const link of redditLinks) {
			if (link.provider !== 'X') continue;
			try {
				const videos = await resolveTweetVideos(link.url, context.fetchImpl, context.timeoutMs);
				if (videos.length > 0) {
					resolved.set(link.url, videos.map(video => ({ ...video, provider: 'X' })));
				}
			} catch (error) {
				debugLog('Video links', 'Tweet uit een Reddit-post mislukt:', error instanceof Error ? error.message : error);
			}
		}

		if (resolved.size > 0) {
			links.splice(0, links.length, ...links.flatMap(link => {
				const videos = link.provider === 'X' ? resolved.get(link.url) : undefined;
				return videos || [link];
			}));
		}
	}

	if (context.contentHtml) {
		links.push(...collectPageVideoLinks(context.contentHtml, context.pageUrl, context.metaTags));
	}

	return preferRedditMp4(dedupe(links));
}

/**
 * Zet de videolinks onder de Markdown, tenzij het adres er al in staat.
 * Geeft de Markdown onveranderd terug als er niets toe te voegen valt.
 */
export function appendVideoLinks(markdown: string, links: VideoLink[]): string {
	const fresh = dedupe(links).filter(link => link.url && !markdown.includes(link.url));
	if (fresh.length === 0) return markdown;

	const block = fresh.map((link, i) => videoLinkMarkdown(link, fresh.length > 1 ? i + 1 : undefined)).join('\n');
	return `${markdown.trimEnd()}\n\n${block}`;
}

/** De variant die de content-extractie gebruikt: nooit gooien, een clip mag niet stukgaan op een video. */
export async function appendVideoLinksFromPage(
	markdown: string,
	context: VideoLinkContext
): Promise<string> {
	try {
		const links = await resolveVideoLinks(context);
		return appendVideoLinks(markdown, links);
	} catch (error) {
		debugLog('Video links', 'Overgeslagen:', error instanceof Error ? error.message : error);
		return markdown;
	}
}

/**
 * Staat er een mp4 van v.redd.it tussen, laat dan de HLS-playlist en de DASH-manifest van die host
 * vallen: dat zijn dezelfde video in een vorm die je later niet zonder speler kunt openen.
 */
function preferRedditMp4(links: VideoLink[]): VideoLink[] {
	const redditLinks = links.filter(link => isRedditMediaHost(link.url));
	if (!redditLinks.some(link => isMp4Url(link.url))) return links;
	return links.filter(link => !isRedditMediaHost(link.url) || isMp4Url(link.url));
}

function isRedditMediaHost(url: string): boolean {
	try {
		return new URL(url).hostname.toLowerCase() === 'v.redd.it';
	} catch {
		return false;
	}
}

function isMp4Url(url: string): boolean {
	return safePath(url).endsWith('.mp4');
}

function addPageLinks(links: VideoLink[], candidates: string[], pageUrl: string): void {
	for (const candidate of candidates) {
		const absolute = absoluteHttpUrl(candidate, pageUrl);
		if (absolute) links.push({ url: absolute, source: 'page' });
	}
}

function absoluteHttpUrl(candidate: string, pageUrl: string): string | null {
	const trimmed = (candidate || '').trim();
	if (!trimmed || /^(blob|data):/i.test(trimmed)) return null;

	try {
		const url = new URL(trimmed, pageUrl);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		return url.toString();
	} catch {
		return null;
	}
}

function safePath(url: string): string {
	try {
		return new URL(url).pathname.toLowerCase();
	} catch {
		return url.toLowerCase().split(/[?#]/)[0];
	}
}

function dedupe(links: VideoLink[]): VideoLink[] {
	const seen = new Set<string>();
	return links.filter(link => {
		if (!link.url || seen.has(link.url)) return false;
		seen.add(link.url);
		return true;
	});
}
