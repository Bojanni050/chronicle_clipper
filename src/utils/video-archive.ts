/**
 * Video's van een geclipte pagina door Zett laten bewaren.
 *
 * Waarom: een adres als `https://packaged-media.redd.it/…mp4?…&e=1795748400&s=…` is ondertekend en
 * verloopt. De post staat dan nog in de clip, de speler niet. Zett bewaart de bytes daarom zelf,
 * inhoud-geadresseerd op sha256 (zie `docs/media-archivering.md` in de repo van Zett); deze module
 * haalt ze hier op, stuurt ze naar `POST /ingest/media` en herschrijft de Markdown naar
 * `![](zett-media://<hash>.<ext>)`.
 *
 * De regels zijn dezelfde als bij `media-archive.ts`: alleen https, geen adressen op deze machine of
 * in een privébereik, geen cookies, en het type komt uit de bytes. Het budget is dat van een video
 * (200 MB, de grens die Zett ook voor de Save-knop aanhoudt), niet van een beeld.
 *
 * Anders dan bij een beeld staat een video als kaal adres in de Markdown (zo maakt de clipper hem
 * speelbaar in Zett). Daarom herschrijft `rewriteVideoMarkdown` een regel die alleen uit dat adres
 * bestaat, en een `[url](url)`-link; een link met een eigen label blijft staan, net als in Zett.
 */

import { fetchableUrl } from './media-archive';

export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MAX_VIDEOS = 3;
const DEFAULT_TIMEOUT_MS = 180000;

const VIDEO_PATH = /\.(mp4|m4v|webm|ogv|mov|ogg)$/i;

/** Een gat: dit adres is niet bewaard, en dit is waarom. Nooit stil weglaten. */
export interface VideoGap {
	url: string;
	reason: string;
}

export interface ArchivedVideos {
	/** sha256 per bewaard bestand, in de volgorde waarin ze zijn opgehaald. */
	media: string[];
	gaps: VideoGap[];
	/** Van het originele adres naar `zett-media://<hash>.<ext>`, om de Markdown te herschrijven. */
	mapping: Map<string, string>;
}

export interface ArchiveVideoOptions {
	baseUrl: string;
	token: string;
	originUrl: string;
	fetchImpl?: typeof fetch;
	maxBytes?: number;
	timeoutMs?: number;
	maxVideos?: number;
}

/**
 * Het type aan de eerste bytes, of `null`. Alleen wat Zett bewaart en de webview kan spelen:
 * mp4/mov (de `ftyp`-familie), webm (EBML) en ogg. AVIF en HEIC beginnen ook met `ftyp` maar zijn
 * beelden; die mogen hier niet als video doorgaan.
 */
export function sniffVideoMime(bytes: Uint8Array): string | null {
	const at = (i: number) => bytes[i] ?? -1;
	if (bytes.length >= 12 && String.fromCharCode(at(4), at(5), at(6), at(7)) === 'ftyp') {
		const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
		if (brand === 'avif' || brand === 'avis' || brand === 'heic' || brand === 'heix' || brand === 'mif1') return null;
		return 'video/mp4';
	}
	if (bytes.length >= 4 && at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return 'video/webm';
	if (bytes.length >= 4 && at(0) === 0x4f && at(1) === 0x67 && at(2) === 0x67 && at(3) === 0x53) return 'video/ogg';
	return null;
}

/** De extensie die Zett onder de hash zet, uit het type dat de server teruggaf. */
function extensionForMime(mime: string): string | null {
	switch (mime) {
		case 'video/mp4': return 'mp4';
		case 'video/webm': return 'webm';
		case 'video/ogg': return 'ogv';
		default: return null;
	}
}

/** Wijst het pad op een videobestand, ook met een query erachter. */
export function isVideoFile(url: string): boolean {
	try {
		const path = new URL(url).pathname;
		return VIDEO_PATH.test(path);
	} catch {
		return false;
	}
}

/** De YAML-kop eraf: daarin staat de pagina-URL, en die mag nooit herschreven worden. */
function splitFrontMatter(markdown: string): [string, string] {
	const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown);
	if (!match) return ['', markdown];
	return [match[0], markdown.slice(match[0].length)];
}

/**
 * De video's die in de Markdown staan: een kaal adres op een eigen regel, een `![alt](url)` of een
 * `[tekst](url)`. Een adres midden in een zin telt niet mee: dat is een verwijzing in de tekst, geen
 * speler, en het vervangen zou de zin breken.
 */
export function collectVideoUrls(markdown: string, pageUrl: string): string[] {
	const [, body] = splitFrontMatter(markdown || '');
	const found: string[] = [];
	const push = (candidate: string) => {
		const url = fetchableUrl(candidate, pageUrl);
		if (!url || !isVideoFile(url) || found.includes(url)) return;
		found.push(url);
	};
	for (const match of body.matchAll(/^[ \t]*(https?:\/\/[^\s<>]+)[ \t]*$/gm)) push(match[1]);
	for (const match of body.matchAll(/!?\[[^\]]*\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) push(match[1]);
	return found;
}

async function archiveOne(
	url: string,
	options: ArchiveVideoOptions,
	doFetch: typeof fetch,
	maxBytes: number,
	timeoutMs: number,
): Promise<string | { reason: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await doFetch(url, { signal: controller.signal, credentials: 'omit' });
		if (!response.ok) return { reason: `HTTP ${response.status}` };
		const claimed = Number(response.headers.get('content-length') || 0);
		if (claimed > maxBytes) return { reason: `te groot (${Math.round(claimed / 1024 / 1024)} MB)` };
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (!bytes.length) return { reason: 'leeg antwoord' };
		if (bytes.length > maxBytes) return { reason: `te groot (${Math.round(bytes.length / 1024 / 1024)} MB)` };
		const mime = sniffVideoMime(bytes);
		if (!mime) return { reason: 'geen video die Zett bewaart' };
		// De hash van de server is de waarheid; dezelfde bytes geven hier weliswaar dezelfde hash,
		// maar het antwoord bepaalt ook het type en dus de extensie.
		const uploaded = await doFetch(`${options.baseUrl}/ingest/media`, {
			method: 'POST',
			headers: {
				'Content-Type': mime,
				Authorization: `Bearer ${options.token}`,
				...(options.originUrl ? { 'X-Zett-Origin': options.originUrl } : {}),
			},
			body: bytes as unknown as BodyInit,
		});
		const answer = await uploaded.json().catch(() => null) as
			{ hash?: unknown; mime?: unknown; error?: unknown } | null;
		if (!uploaded.ok) {
			const detail = typeof answer?.error === 'string' ? ` (${answer.error})` : '';
			return { reason: `Zett gaf status ${uploaded.status}${detail}` };
		}
		const hash = typeof answer?.hash === 'string' ? answer.hash : '';
		if (!/^[0-9a-f]{64}$/.test(hash)) return { reason: 'Zett gaf geen hash terug' };
		const storedMime = typeof answer?.mime === 'string' ? answer.mime : mime;
		const ext = extensionForMime(storedMime);
		if (!ext) return { reason: `Zett bewaarde een onbekend type (${storedMime})` };
		return `zett-media://${hash}.${ext}`;
	} catch (error) {
		const aborted = error instanceof Error && error.name === 'AbortError';
		return { reason: aborted ? `geen antwoord binnen ${Math.round(timeoutMs / 1000)} s` : 'niet op te halen' };
	} finally {
		clearTimeout(timer);
	}
}

/** Haalt de video's op en zet ze bij Zett neer; wat mislukt wordt een gat met een reden. */
export async function archiveVideos(urls: string[], options: ArchiveVideoOptions): Promise<ArchivedVideos> {
	const doFetch = options.fetchImpl ?? fetch;
	const maxBytes = options.maxBytes ?? MAX_VIDEO_BYTES;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxVideos = options.maxVideos ?? MAX_VIDEOS;
	const media: string[] = [];
	const gaps: VideoGap[] = [];
	const mapping = new Map<string, string>();

	urls.forEach((url, index) => {
		if (index >= maxVideos) gaps.push({ url, reason: `te veel video's voor één clip (max ${maxVideos})` });
	});
	for (const url of urls.slice(0, maxVideos)) {
		const result = await archiveOne(url, options, doFetch, maxBytes, timeoutMs);
		if (typeof result === 'string') {
			const hash = result.slice('zett-media://'.length).split('.')[0];
			if (!media.includes(hash)) media.push(hash);
			mapping.set(url, result);
		} else {
			gaps.push({ url, reason: result.reason });
		}
	}
	return { media, gaps, mapping };
}

/**
 * Vervangt elke bewaarde video door de versie uit de bibliotheek. Alleen een kaal adres op een eigen
 * regel, een `![alt](url)` en een `[url](url)` (wat GFM zelf van een los adres maakt); een link met
 * een eigen label blijft staan, want dat label zou bij vervanging verloren gaan.
 */
export function rewriteVideoMarkdown(markdown: string, mapping: Map<string, string>): string {
	if (!mapping.size) return markdown;
	const [front, body] = splitFrontMatter(markdown);
	let out = body;
	for (const [url, stored] of mapping) {
		const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		out = out.replace(new RegExp(`^[ \\t]*${escaped}[ \\t]*$`, 'gm'), `![](${stored})`);
		out = out.replace(new RegExp(`!\\[[^\\]]*\\]\\(\\s*<?${escaped}>?(\\s+["'][^"']*["'])?\\s*\\)`, 'g'), `![](${stored})`);
		out = out.replace(new RegExp(`\\[${escaped}\\]\\(\\s*<?${escaped}>?(\\s+["'][^"']*["'])?\\s*\\)`, 'g'), `![](${stored})`);
	}
	return front + out;
}
