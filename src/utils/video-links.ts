/**
 * Videolinks uit een geclipte pagina halen.
 *
 * Waarom: X zet in de DOM een `<video>` met een `blob:`-adres (of helemaal geen `src`) en bewaart
 * de echte mp4 alleen in zijn bootstrap-JSON. De content-extractie laat `<script>` weg, dus een
 * tweet met video komt zonder enige verwijzing in de notitie terecht. Deze module haalt de
 * mp4-varianten op via de publieke syndication-API en zet ze als gewone Markdown-link onder de clip.
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
	metaTags?: VideoMetaTag[];
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

const SYNDICATION_ENDPOINT = 'https://cdn.syndication.twimg.com/tweet-result';
const DEFAULT_TIMEOUT_MS = 5000;

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
	const label = `Video${index ? ` ${index}` : ''}${duration ? ` (${duration})` : ''}`;
	return `[${label}](${link.url})`;
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

/** Alle videolinks die bij deze pagina horen: eerst de tweet zelf, dan wat de inhoud aanwijst. */
export async function resolveVideoLinks(context: VideoLinkContext): Promise<VideoLink[]> {
	const links: VideoLink[] = [];

	if (tweetIdFromUrl(context.pageUrl)) {
		try {
			links.push(...await resolveTweetVideos(context.pageUrl, context.fetchImpl, context.timeoutMs));
		} catch (error) {
			debugLog('Video links', 'Tweet ophalen mislukt:', error instanceof Error ? error.message : error);
		}
	}

	if (context.contentHtml) {
		links.push(...collectPageVideoLinks(context.contentHtml, context.pageUrl, context.metaTags));
	}

	return dedupe(links);
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
