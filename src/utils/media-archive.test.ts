// @vitest-environment jsdom
import { describe, test, expect, vi } from 'vitest';
import {
	MAX_IMAGES,
	archiveImages,
	bestFromSrcset,
	collectImageUrls,
	fetchableUrl,
	isLocalHost,
	mediaSummary,
	prioritizeImageUrls,
	rewriteMarkdown,
	sha256Hex,
	sniffImageMime,
} from './media-archive';

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

function imageResponse(bytes: Uint8Array, status = 200, headers: Record<string, string> = {}) {
	return new Response(bytes, { status, headers: { 'content-type': 'image/png', ...headers } });
}

const connection = { baseUrl: 'http://127.0.0.1:4590', token: 'tok123', originUrl: 'https://example.com/artikel' };

describe('sniffImageMime', () => {
	test('herkent de typen die Zett bewaart', () => {
		expect(sniffImageMime(png)).toBe('image/png');
		expect(sniffImageMime(jpeg)).toBe('image/jpeg');
		expect(sniffImageMime(new TextEncoder().encode('GIF89a......'))).toBe('image/gif');
		expect(sniffImageMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8X'))).toBe('image/webp');
		expect(sniffImageMime(new TextEncoder().encode('\0\0\0\x1cftypavif'))).toBe('image/avif');
		expect(sniffImageMime(new TextEncoder().encode('BM\0\0\0\0'))).toBe('image/bmp');
	});

	test('laat alles wat geen afbeelding is liggen', () => {
		expect(sniffImageMime(new TextEncoder().encode('<!doctype html>'))).toBeNull();
		expect(sniffImageMime(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
		expect(sniffImageMime(new Uint8Array([]))).toBeNull();
		expect(sniffImageMime(new TextEncoder().encode('GIF'))).toBeNull();
	});
});

describe('fetchableUrl', () => {
	test('maakt van een relatief adres het adres op de pagina', () => {
		expect(fetchableUrl('/beeld.png', 'https://example.com/artikel')).toBe('https://example.com/beeld.png');
		expect(fetchableUrl('//cdn.example.com/a.png', 'https://example.com/artikel')).toBe('https://cdn.example.com/a.png');
		expect(fetchableUrl('https://example.com/a.png', 'https://example.com/artikel')).toBe('https://example.com/a.png');
	});

	test('weigert wat geen bytes is of niet openbaar is', () => {
		for (const candidate of [
			'data:image/png;base64,iVBORw0KGgo=',
			'blob:https://example.com/abc',
			'http://example.com/a.png',
			'file:///C:/x.png',
			'https://localhost/a.png',
			'https://127.0.0.1/a.png',
			'https://192.168.1.5/a.png',
			'https://10.0.0.2/a.png',
			'https://172.16.3.4/a.png',
			'https://169.254.1.1/a.png',
			'https://[::1]/a.png',
			'javascript:alert(1)',
			'',
			null,
		]) {
			expect(fetchableUrl(candidate, 'https://example.com/artikel')).toBeNull();
		}
		expect(isLocalHost('printer.local')).toBe(true);
		expect(isLocalHost('cdn.example.com')).toBe(false);
	});
});

describe('bestFromSrcset', () => {
	test('kiest de grootste kandidaat', () => {
		expect(bestFromSrcset('a.png 320w, b.png 1280w, c.png 640w')).toBe('b.png');
		expect(bestFromSrcset('a.png 1x, b.png 2x')).toBe('b.png');
		expect(bestFromSrcset('a.png')).toBe('a.png');
		// Breedte en dichtheid zijn niet in elkaar om te rekenen: een breedte wint van een dichtheid.
		expect(bestFromSrcset('a.png 1280w, b.png 2x')).toBe('a.png');
	});

	test('geen srcset: niets om uit te kiezen', () => {
		expect(bestFromSrcset('')).toBeNull();
		expect(bestFromSrcset(null)).toBeNull();
	});
});

describe('collectImageUrls', () => {
	const html = `
		<html><body>
			<img src="/klein.png" srcset="/klein.png 320w, /groot.png 1280w" alt="">
			<img src="https://cdn.example.com/tweede.jpg">
			<img src="https://cdn.example.com/tweede.jpg"> <!-- dubbel -->
			<img src="data:image/png;base64,iVBORw0KGgo=">
			<img src="http://example.com/onveilig.png">
			<img src="https://127.0.0.1/lokaal.png">
			<img>
			<picture><source srcset="/bron.webp 900w"></picture>
			<a href="/geen-beeld.png">een link, geen beeld</a>
		</body></html>`;

	test('pakt de srcset, slaat dubbelen over en weigert wat niet mag', () => {
		expect(collectImageUrls(html, 'https://example.com/artikel')).toEqual([
			'https://example.com/groot.png',
			'https://cdn.example.com/tweede.jpg',
			'https://example.com/bron.webp',
		]);
	});

	test('zonder HTML of buiten het maximum: niets of niet meer dan het maximum', () => {
		expect(collectImageUrls('', 'https://example.com')).toEqual([]);
		const many = Array.from({ length: MAX_IMAGES + 5 }, (_, i) => `<img src="/${i}.png">`).join('');
		expect(collectImageUrls(`<body>${many}</body>`, 'https://example.com')).toHaveLength(MAX_IMAGES);
	});
});

describe('archiveImages', () => {
	test('bewaart wat lukt en meldt wat niet lukt, met de reden', async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			const asString = String(url);
			if (asString.endsWith('/403.png')) return new Response('nee', { status: 403 });
			if (asString.endsWith('/geen.png')) return new Response('geen afbeelding', { status: 200 });
			if (asString.endsWith('/groot.png')) return imageResponse(png, 200, { 'content-length': String(30 * 1024 * 1024) });
			return imageResponse(png);
		}) as unknown as typeof fetch;

		const result = await archiveImages(
			[
				'https://cdn.example.com/goed.png',
				'https://cdn.example.com/403.png',
				'https://cdn.example.com/geen.png',
				'https://cdn.example.com/groot.png',
			],
			{ ...connection, fetchImpl },
		);

		expect(result.media).toEqual([await sha256Hex(png)]);
		expect(result.gaps.map((gap) => gap.reason)).toEqual(['HTTP 403', 'geen afbeelding die Zett bewaart', 'te groot (30 MB)']);
		expect(result.mapping.get('https://cdn.example.com/goed.png')).toBe(result.media[0]);

		// De upload: naar /ingest/media, met het type uit de bytes en de bron erbij.
		const upload = calls.find((call) => call.url.endsWith('/ingest/media'));
		expect(upload).toBeDefined();
		const headers = upload!.init?.headers as Record<string, string>;
		expect(headers['Content-Type']).toBe('image/png');
		expect(headers.Authorization).toBe('Bearer tok123');
		expect(headers['X-Zett-Origin']).toBe('https://example.com/artikel');
		expect(upload!.init?.method).toBe('POST');
		// Zonder cookies: een beeld dat de sessie vraagt laten we liggen.
		expect(calls[0]?.init?.credentials).toBe('omit');
	});

	test('een leeg antwoord en een weigering van Zett worden ook een gat', async () => {
		const fetchImpl = (async (url: string | URL | Request) => {
			const asString = String(url);
			if (asString.endsWith('/leeg.png')) return imageResponse(new Uint8Array([]));
			if (asString.endsWith('/ingest/media')) return new Response('{"error":"busy"}', { status: 503 });
			return imageResponse(png);
		}) as unknown as typeof fetch;

		const result = await archiveImages(['https://cdn.example.com/leeg.png', 'https://cdn.example.com/a.png'], {
			...connection,
			fetchImpl,
		});
		expect(result.media).toEqual([]);
		expect(result.gaps.map((gap) => gap.reason)).toEqual(['leeg antwoord', 'Zett gaf status 503']);
	});
});

describe('rewriteMarkdown', () => {
	test('vervangt de bron van een afbeelding, en laat de rest staan', () => {
		const mapping = new Map([['https://cdn.example.com/a.png', 'a'.repeat(64)]]);
		const markdown = [
			'# Kop',
			'![een beeld](https://cdn.example.com/a.png)',
			'![met titel](https://cdn.example.com/a.png "De titel")',
			'![ander](https://cdn.example.com/b.png)',
			'[een link naar hetzelfde beeld](https://cdn.example.com/a.png)',
		].join('\n\n');

		const out = rewriteMarkdown(markdown, mapping);
		expect(out).toContain(`![een beeld](zett-media://${'a'.repeat(64)})`);
		expect(out).toContain(`![met titel](zett-media://${'a'.repeat(64)} "De titel")`);
		expect(out).toContain('![ander](https://cdn.example.com/b.png)');
		expect(out).toContain('[een link naar hetzelfde beeld](https://cdn.example.com/a.png)');
	});

	test('een adres met tekens die in een patroon betekenis hebben', () => {
		const url = 'https://cdn.example.com/a+b(c).png?x=1&y=2';
		const mapping = new Map([[url, 'b'.repeat(64)]]);
		expect(rewriteMarkdown(`![x](${url})`, mapping)).toBe(`![x](zett-media://${'b'.repeat(64)})`);
	});

	test('dezelfde afbeelding in een andere maat telt ook', () => {
		// De srcset vroeg ?width=1080 (die hebben we opgehaald), de Markdown heeft de src met ?width=640.
		const mapping = new Map([['https://preview.redd.it/x.png?width=1080&auto=webp', 'c'.repeat(64)]]);
		const out = rewriteMarkdown('![beeld](https://preview.redd.it/x.png?width=640&auto=webp)', mapping);
		expect(out).toBe(`![beeld](zett-media://${'c'.repeat(64)})`);
	});

	test('twee verschillende beelden op hetzelfde pad blijven staan', () => {
		const mapping = new Map([
			['https://cdn.example.com/sprite.png?v=1', 'd'.repeat(64)],
			['https://cdn.example.com/sprite.png?v=2', 'e'.repeat(64)],
		]);
		const out = rewriteMarkdown('![x](https://cdn.example.com/sprite.png?v=3)', mapping);
		expect(out).toBe('![x](https://cdn.example.com/sprite.png?v=3)');
	});
});

describe('prioritizeImageUrls', () => {
	test('de beelden van de clip gaan voor de rest van de pagina', () => {
		const urls = ['https://cdn.example.com/logo.png', 'https://cdn.example.com/foto.png', 'https://cdn.example.com/avatar.png'];
		const markdown = '# Kop\n\n![foto](https://cdn.example.com/foto.png)';
		expect(prioritizeImageUrls(urls, markdown)).toEqual([
			'https://cdn.example.com/foto.png',
			'https://cdn.example.com/logo.png',
			'https://cdn.example.com/avatar.png',
		]);
	});

	test('herkent een beeld uit de Markdown dat in een andere maat is opgehaald', () => {
		const urls = ['https://cdn.example.com/logo.png', 'https://cdn.example.com/foto.png?width=1080'];
		const markdown = '![foto](https://cdn.example.com/foto.png?width=640)';
		expect(prioritizeImageUrls(urls, markdown)[0]).toBe('https://cdn.example.com/foto.png?width=1080');
	});

	test('zonder beelden in de Markdown blijft de volgorde van de pagina', () => {
		const urls = ['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png'];
		expect(prioritizeImageUrls(urls, 'alleen tekst')).toEqual(urls);
	});
});

describe('mediaSummary', () => {
	test('vertelt hoeveel er bewaard is en of er iets misging', () => {
		vi.stubGlobal('navigator', { language: 'nl-NL' });
		expect(mediaSummary(3, 0)).toBe('3 afbeeldingen bewaard');
		expect(mediaSummary(3, 2)).toBe('3 afbeeldingen bewaard, 2 niet opgehaald');
		vi.stubGlobal('navigator', { language: 'en-US' });
		expect(mediaSummary(1, 1)).toBe('1 images saved, 1 not fetched');
		vi.unstubAllGlobals();
	});

	test('noemt een video apart, en alleen een video als er geen beeld bij was', () => {
		vi.stubGlobal('navigator', { language: 'nl-NL' });
		expect(mediaSummary(0, 0, 1)).toBe('1 video bewaard');
		expect(mediaSummary(2, 0, 1)).toBe('2 afbeeldingen en 1 video bewaard');
		expect(mediaSummary(2, 0, 3)).toBe("2 afbeeldingen en 3 video's bewaard");
		expect(mediaSummary(0, 1, 1)).toBe('1 video bewaard, 1 niet opgehaald');
		vi.stubGlobal('navigator', { language: 'en-US' });
		expect(mediaSummary(0, 0, 2)).toBe('2 videos saved');
		expect(mediaSummary(1, 0, 1)).toBe('1 images and 1 video saved');
		vi.unstubAllGlobals();
	});
});
