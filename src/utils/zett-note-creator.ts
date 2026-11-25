import { generalSettings, saveSettings } from './storage-utils';
import { archiveImages, collectImageUrls, prioritizeImageUrls, rewriteMarkdown } from './media-archive';

/**
 * Stuurt een clip naar Zett's lokale luisteraar. Naar het model van
 * chronicle-note-creator.ts en chronicle-connection.ts, in één bestand.
 *
 * Zett luistert alleen op 127.0.0.1 (standaard poort 4590) en biedt
 * GET /ingest/config aan voor browserextensies: alleen loopback-Host, alleen
 * een extensie-Origin en nooit een CORS-header. Het token wordt daar bij elke
 * start van de app opnieuw gemaakt; het wordt hier bewust niet bewaard (alleen
 * in het geheugen van de extensie), want general_settings staat in
 * storage.sync en een token hoort bij één machine. Na een 401 (de app is
 * herstart) wordt het token opnieuw opgehaald en volgt één nieuwe poging.
 */

export interface ZettConnection {
	baseUrl: string;
	token: string;
}

const DEFAULT_URL = 'http://127.0.0.1:4590';

let cached: ZettConnection | null = null;

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, '');
}

function candidateUrls(): string[] {
	const configured = normalizeBaseUrl(generalSettings.zettUrl || '');
	const urls: string[] = [];
	if (configured) urls.push(configured);
	if (!urls.includes(DEFAULT_URL)) urls.push(DEFAULT_URL);
	return urls;
}

async function fetchConfig(baseUrl: string): Promise<ZettConnection> {
	const response = await fetch(`${baseUrl}/ingest/config`, {
		method: 'GET',
		headers: { Accept: 'application/json' },
		cache: 'no-store',
	});
	if (!response.ok) {
		throw new Error(`Zett gaf status ${response.status}`);
	}
	const body = await response.json().catch(() => null) as
		{ app?: unknown; token?: unknown; listenerUrl?: unknown } | null;
	// Chronicle gebruikt hetzelfde pad: zo gaat een clip nooit per ongeluk naar de verkeerde app.
	if (!body || body.app !== 'zett') {
		throw new Error('Dit is niet Zett: controleer de poort in de instellingen');
	}
	if (typeof body.token !== 'string' || !body.token) {
		throw new Error('Zett stuurde geen token terug');
	}
	const listenerUrl = typeof body.listenerUrl === 'string' && body.listenerUrl.trim()
		? normalizeBaseUrl(body.listenerUrl)
		: baseUrl;
	return { baseUrl: listenerUrl, token: body.token };
}

/**
 * Geeft de luisteraar-URL en het token terug; vraagt het Zett één keer per sessie.
 * `force` slaat het geheugen over, bijvoorbeeld na een 401.
 */
export async function resolveZettConnection(options: { force?: boolean } = {}): Promise<ZettConnection> {
	if (cached && !options.force) return cached;

	const failures: string[] = [];
	for (const baseUrl of candidateUrls()) {
		try {
			const connection = await fetchConfig(baseUrl);
			cached = connection;
			if (generalSettings.zettUrl !== connection.baseUrl) {
				await saveSettings({ zettUrl: connection.baseUrl });
			}
			return connection;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failures.push(`${baseUrl} (${reason})`);
		}
	}

	cached = null;
	throw new Error(
		`Zett is niet bereikbaar: draait de app, en staat de webclipper aan in de instellingen? Geprobeerd: ${failures.join(', ')}`,
	);
}

/** Vergeet het token, zodat de volgende aanroep het opnieuw opvraagt. */
export function clearZettConnection(): void {
	cached = null;
}

/**
 * Stuurt een clip naar Zett. `fileContent` bevat de YAML-kop die de popup
 * maakt; Zett haalt die eruit (titel, auteur, datum, tags) en bewaart de
 * rest als Markdown. Dezelfde pagina twee keer knippen werkt de bestaande clip bij.
 */
export interface ZettClipResult {
	/** Hoeveel beelden Zett bewaarde, en hoeveel er niet opgehaald konden worden. */
	archived: number;
	failed: number;
}

/**
 * Stuurt een clip naar Zett. `fileContent` bevat de YAML-kop die de popup
 * maakt; Zett haalt die eruit (titel, auteur, datum, tags) en bewaart de
 * rest als Markdown. Dezelfde pagina twee keer knippen werkt de bestaande clip bij.
 *
 * Met `pageHtml` worden eerst de beelden van de pagina opgehaald en bij Zett
 * bewaard, en verwijst de Markdown naar `zett-media://<hash>` in plaats van
 * naar de hotlink. Wat niet lukt wordt een gat met een reden.
 */
export async function saveToZett(
	fileContent: string,
	noteName: string,
	url: string,
	pageHtml?: string,
): Promise<ZettClipResult | null> {
	let content = fileContent;
	let media: string[] | undefined;
	let mediaGaps: { url: string; reason: string }[] | undefined;
	let result: ZettClipResult | null = null;

	let connection = await resolveZettConnection();

	// Eerst de beelden, dan de clip: zo verwijst een opgeslagen clip nooit naar een beeld dat er
	// niet is. Wat mislukt gaat als gat mee, zodat de notitie kan vertellen wat er ontbreekt.
	if (generalSettings.archiveImages && pageHtml) {
		const urls = prioritizeImageUrls(collectImageUrls(pageHtml, url), content);
		const archived = await archiveImages(urls, {
			baseUrl: connection.baseUrl,
			token: connection.token,
			originUrl: url,
		});
		if (archived.mapping.size || archived.gaps.length) {
			content = rewriteMarkdown(content, archived.mapping);
			media = archived.media;
			mediaGaps = archived.gaps;
			result = { archived: archived.media.length, failed: archived.gaps.length };
		}
	}

	const payload = {
		content,
		title: noteName || url,
		url,
		source: url || undefined,
		sourceProvider: 'web',
		occurredAt: new Date().toISOString(),
		...(media ? { media } : {}),
		...(mediaGaps ? { media_gaps: mediaGaps } : {}),
	};

	let response = await post(connection, payload);

	if (response.status === 401) {
		clearZettConnection();
		connection = await resolveZettConnection({ force: true });
		response = await post(connection, payload);
	}

	const body = await response.json().catch(() => ({} as { error?: string }));
	if (!response.ok) {
		throw new Error(body.error || `Zett gaf status ${response.status}`);
	}
	return result;
}

function post(connection: ZettConnection, payload: unknown): Promise<Response> {
	return fetch(`${connection.baseUrl}/ingest/clip`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${connection.token}`,
		},
		body: JSON.stringify(payload),
	});
}
