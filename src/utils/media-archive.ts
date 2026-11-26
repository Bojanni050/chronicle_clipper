/**
 * Beelden van een geclipte pagina door Zett laten bewaren.
 *
 * Waarom: een clip met een `<img src="https://…">` is een verwijzing, geen archief. Verdwijnt de
 * pagina of het CDN, dan is het beeld weg. Zett bewaart de bytes daarom zelf, inhoud-geadresseerd
 * op sha256 (zie `docs/media-archivering.md` in de repo van Zett); deze module haalt ze hier op,
 * stuurt ze naar `POST /ingest/media` en herschrijft de Markdown naar `zett-media://<hash>`.
 *
 * De regels komen uit `utils/imageFetch.ts` van de app: alleen https, geen adressen op deze machine
 * of in een privébereik, 25 MB per beeld, en het type komt uit de bytes in plaats van uit een kop.
 * Bewust zonder cookies (`credentials: 'omit'`): een beeld dat de sessie van de browser vraagt
 * laten we liggen en melden we als gat met reden, in plaats van eromheen te werken.
 */

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGES = 30;
const DEFAULT_TIMEOUT_MS = 15000;

export interface ImageGap {
	url: string;
	reason: string;
}

export interface ArchivedImages {
	/** sha256 per bewaard beeld, in de volgorde waarin ze zijn opgehaald. */
	media: string[];
	/** Wat niet opgehaald is, met de reden; nooit stil weglaten. */
	gaps: ImageGap[];
	/** Van de originele URL naar de hash, om de Markdown te herschrijven. */
	mapping: Map<string, string>;
}

export interface ArchiveOptions {
	baseUrl: string;
	token: string;
	originUrl: string;
	fetchImpl?: typeof fetch;
	maxBytes?: number;
	timeoutMs?: number;
	maxImages?: number;
}

/** Het type aan de eerste bytes. Onbekend = geen afbeelding die Zett bewaart. */
export function sniffImageMime(bytes: Uint8Array): string | null {
	const at = (i: number) => bytes[i] ?? -1;
	if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
	if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
	if (bytes.length >= 6 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
	if (
		bytes.length >= 12 &&
		at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
		at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
	) return 'image/webp';
	if (bytes.length >= 12 && String.fromCharCode(at(4), at(5), at(6), at(7)) === 'ftyp') {
		const brand = String.fromCharCode(at(8), at(9), at(10), at(11));
		if (brand === 'avif' || brand === 'avis') return 'image/avif';
	}
	if (bytes.length >= 2 && at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp';
	return null;
}

/** Adressen waar we niet naartoe gaan: deze machine en privébereiken. */
export function isLocalHost(host: string): boolean {
	const h = (host || '').toLowerCase().replace(/^\[|\]$/g, '');
	if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
	if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return h.includes(':');
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Een adres dat we mogen ophalen, of `null`. Alleen https op een openbaar adres:
 * `data:` en `blob:` dragen hun bytes al zelf en hebben niets te archiveren.
 */
export function fetchableUrl(candidate: string | null | undefined, pageUrl: string): string | null {
	if (!candidate) return null;
	try {
		const url = new URL(candidate.trim(), pageUrl);
		if (url.protocol !== 'https:') return null;
		if (isLocalHost(url.hostname)) return null;
		return url.toString();
	} catch {
		return null;
	}
}

/**
 * Uit een `srcset` de grootste kandidaat. Breedtedescriptors (`1280w`) zeggen hoeveel pixels breed
 * het bestand is en die zijn onderling te vergelijken; dichtheden (`2x`) zeggen alleen iets over de
 * scherm van de bezoeker. Zijn er breedtes, dan wint de grootste breedte; anders de hoogste
 * dichtheid. Zo kiezen we nooit een 2x-beeld boven een image dat duizend pixels breder is.
 */
export function bestFromSrcset(srcset: string | null | undefined): string | null {
	if (!srcset) return null;
	const candidates = srcset
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const [url, ...rest] = part.split(/\s+/);
			const descriptor = rest.join(' ');
			const width = /^(\d+)w$/.exec(descriptor);
			const density = /^([\d.]+)x$/.exec(descriptor);
			return { url, width: width ? Number(width[1]) : null, density: density ? Number(density[1]) : null };
		});
	if (!candidates.length) return null;
	const withWidth = candidates.filter((candidate) => candidate.width !== null);
	const pool = withWidth.length ? withWidth : candidates;
	const score = (candidate: { width: number | null; density: number | null }) =>
		candidate.width ?? candidate.density ?? 1;
	return pool.reduce((best, candidate) => (score(candidate) > score(best) ? candidate : best), pool[0]).url;
}

/** De beelden van een pagina, in de volgorde waarin ze in de HTML staan. */
export function collectImageUrls(html: string, pageUrl: string, max = MAX_IMAGES): string[] {
	if (!html) return [];
	const found: string[] = [];
	const push = (candidate: string | null | undefined) => {
		const url = fetchableUrl(candidate, pageUrl);
		if (url && !found.includes(url) && found.length < max) found.push(url);
	};
	try {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		doc.querySelectorAll('img').forEach((img) => push(bestFromSrcset(img.getAttribute('srcset')) || img.getAttribute('src')));
		doc.querySelectorAll('picture source[srcset]').forEach((source) => push(bestFromSrcset(source.getAttribute('srcset'))));
	} catch {
		return [];
	}
	return found;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	// Een eigen kopie met een gewone ArrayBuffer: `digest` accepteert geen view met een
	// gedeelde buffer, en bij een subview zou `.buffer` de verkeerde reeks hashen.
	const copy = new Uint8Array(bytes.length);
	copy.set(bytes);
	const digest = await crypto.subtle.digest('SHA-256', copy);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/** Haalt één beeld op en zet het bij Zett neer. Geeft de hash terug, of de reden waarom het niet lukte. */
async function archiveOne(
	url: string,
	options: ArchiveOptions,
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
		const mime = sniffImageMime(bytes);
		if (!mime) return { reason: 'geen afbeelding die Zett bewaart' };
		const hash = await sha256Hex(bytes);
		const uploaded = await doFetch(`${options.baseUrl}/ingest/media`, {
			method: 'POST',
			headers: {
				'Content-Type': mime,
				Authorization: `Bearer ${options.token}`,
				...(options.originUrl ? { 'X-Zett-Origin': options.originUrl } : {}),
			},
			body: bytes as unknown as BodyInit,
		});
		if (!uploaded.ok) return { reason: `Zett gaf status ${uploaded.status}` };
		return hash;
	} catch (error) {
		const aborted = error instanceof Error && error.name === 'AbortError';
		return { reason: aborted ? `geen antwoord binnen ${Math.round(timeoutMs / 1000)} s` : 'niet op te halen' };
	} finally {
		clearTimeout(timer);
	}
}

/** Haalt de beelden op en zet ze bij Zett neer; wat mislukt wordt een gat met een reden. */
export async function archiveImages(urls: string[], options: ArchiveOptions): Promise<ArchivedImages> {
	const doFetch = options.fetchImpl ?? fetch;
	const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const media: string[] = [];
	const gaps: ImageGap[] = [];
	const mapping = new Map<string, string>();

	for (const url of urls.slice(0, options.maxImages ?? MAX_IMAGES)) {
		const result = await archiveOne(url, options, doFetch, maxBytes, timeoutMs);
		if (typeof result === 'string') {
			if (!media.includes(result)) media.push(result);
			mapping.set(url, result);
		} else {
			gaps.push({ url, reason: result.reason });
		}
	}
	return { media, gaps, mapping };
}

/** Een beeld zonder de maat die de pagina ervan vroeg: `origin + pad`. */
function imageKey(raw: string): string | null {
	try {
		const url = new URL(raw);
		return `${url.origin}${url.pathname}`;
	} catch {
		return null;
	}
}

/**
 * Zet de beelden die in de Markdown staan vooraan. Een pagina heeft tientallen logo's, avatars en
 * pictogrammen; staan die eerst, dan vullen ze de dertig plaatsen en blijven de beelden van de clip
 * zelf onbewaard. De volgorde binnen beide groepen blijft die van de pagina.
 */
export function prioritizeImageUrls(urls: string[], markdown: string): string[] {
	const inBody = new Set<string>();
	for (const match of (markdown || '').matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g)) inBody.add(match[1]);
	const keys = new Set<string>();
	for (const url of inBody) {
		const key = imageKey(url);
		if (key) keys.add(key);
	}
	const inClip = (url: string) => inBody.has(url) || keys.has(imageKey(url) ?? '');
	return [...urls.filter(inClip), ...urls.filter((url) => !inClip(url))];
}

/**
 * Vervangt in de Markdown elke bewaarde afbeelding door de hash. Alleen de bron van een
 * Markdown-afbeelding (`![alt](url)`), niet elke keer dat het adres ergens in de tekst staat: een
 * link naar dezelfde afbeelding hoort te blijven wijzen waar hij wees.
 *
 * Hetzelfde beeld staat in de HTML vaak in meerdere maten: de `srcset` vraagt `?width=1080` en de
 * `src` (die de Markdown overneemt) `?width=640`. We halen de grootste maat op, dus het volledige
 * adres is dan niet gelijk en zonder de tweede blik op `origin + pad` bleef het beeld een hotlink
 * terwijl het al bewaard was. Twee verschillende hashes met hetzelfde pad is dubbelzinnig: dan
 * laten we het beeld staan in plaats van te gokken.
 */
export function rewriteMarkdown(markdown: string, mapping: Map<string, string>): string {
	let out = markdown;
	for (const [url, hash] of mapping) {
		const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const pattern = new RegExp(`!\\[([^\\]]*)\\]\\(\\s*<?${escaped}>?(\\s+["'][^"']*["'])?\\s*\\)`, 'g');
		out = out.replace(pattern, (_match, alt: string, title?: string) => `![${alt}](zett-media://${hash}${title ?? ''})`);
	}

	// Tweede ronde: wat overbleef kan dezelfde afbeelding in een andere maat zijn.
	const byPath = new Map<string, string | null>();
	for (const [url, hash] of mapping) {
		const key = imageKey(url);
		if (!key) continue;
		const known = byPath.get(key);
		byPath.set(key, known === undefined || known === hash ? hash : null);
	}
	return out.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(\s+["'][^"']*["'])?\s*\)/g, (match, alt: string, src: string, title?: string) => {
		const key = imageKey(src);
		const hash = key ? byPath.get(key) : null;
		return hash ? `![${alt}](zett-media://${hash}${title ?? ''})` : match;
	});
}

/** De regel onder de knop, in de taal van de gebruiker (de rest van de fork doet dit ook zo). */
export function mediaSummary(archived: number, failed: number, videos = 0): string {
	const dutch = typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('nl');
	const saved = (() => {
		const videoText = videos === 1 ? '1 video' : `${videos} ${dutch ? "video's" : 'videos'}`;
		if (!videos) {
			return dutch ? `${archived} afbeeldingen bewaard` : `${archived} images saved`;
		}
		if (!archived) {
			return dutch ? `${videoText} bewaard` : `${videoText} saved`;
		}
		return dutch
			? `${archived} afbeeldingen en ${videoText} bewaard`
			: `${archived} images and ${videoText} saved`;
	})();
	if (!failed) return saved;
	return dutch ? `${saved}, ${failed} niet opgehaald` : `${saved}, ${failed} not fetched`;
}
