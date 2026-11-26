/**
 * De video's van een clip: herkennen, ophalen, bij Zett neerzetten en de Markdown herschrijven.
 *
 * De bytes zijn klein en verzonnen; het gaat om de weg erlangs, niet om een speelbare film.
 */

import { describe, expect, test, vi } from 'vitest';
import {
	MAX_VIDEOS,
	archiveVideos,
	collectVideoUrls,
	isVideoFile,
	rewriteVideoMarkdown,
	sniffVideoMime,
} from './video-archive';

function mp4Bytes(): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([0x00, 0x00, 0x00, 0x18], 0);
	bytes.set(new TextEncoder().encode('ftypmp41'), 4);
	return bytes;
}

function webmBytes(): Uint8Array {
	return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
}

const HASH = 'a'.repeat(64);

describe('sniffVideoMime', () => {
	test('herkent mp4, webm en ogg aan de bytes', () => {
		expect(sniffVideoMime(mp4Bytes())).toBe('video/mp4');
		expect(sniffVideoMime(webmBytes())).toBe('video/webm');
		expect(sniffVideoMime(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00]))).toBe('video/ogg');
	});

	test('een avif of heic is geen video, ook al begint het met ftyp', () => {
		const avif = new Uint8Array(16);
		avif.set(new TextEncoder().encode('ftypavif'), 4);
		expect(sniffVideoMime(avif)).toBeNull();
		const heic = new Uint8Array(16);
		heic.set(new TextEncoder().encode('ftypheic'), 4);
		expect(sniffVideoMime(heic)).toBeNull();
	});

	test('een beeld of rommel is geen video', () => {
		expect(sniffVideoMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
		expect(sniffVideoMime(new Uint8Array())).toBeNull();
	});
});

describe('isVideoFile', () => {
	test('kijkt naar het pad en laat een query staan', () => {
		expect(isVideoFile('https://packaged-media.redd.it/x/pb/m2-res_720p.mp4?m=DASHPlaylist.mpd&e=1&s=abc')).toBe(true);
		expect(isVideoFile('https://cdn.example.com/a.webm')).toBe(true);
		expect(isVideoFile('https://cdn.example.com/a.mov#t=1')).toBe(true);
		expect(isVideoFile('https://cdn.example.com/a.jpg')).toBe(false);
		expect(isVideoFile('https://cdn.example.com/geen-extensie')).toBe(false);
		expect(isVideoFile('niet eens een adres')).toBe(false);
	});
});

describe('collectVideoUrls', () => {
	const page = 'https://www.reddit.com/r/vibecoding/comments/1y59rf5/if_you_cant/';

	test('pakt een kaal adres op een eigen regel, een beeld en een link', () => {
		const markdown = [
			'---',
			'title: Iets',
			'source: https://example.com/video.mp4',
			'---',
			'',
			'https://cdn.example.com/boven.mp4',
			'',
			'![onderschrift](https://cdn.example.com/beeld.webm)',
			'',
			'[Video (Reddit)](https://packaged-media.redd.it/x/pb/m2-res_720p.mp4?e=1&s=abc)',
		].join('\n');
		expect(collectVideoUrls(markdown, page)).toEqual([
			'https://cdn.example.com/boven.mp4',
			'https://cdn.example.com/beeld.webm',
			'https://packaged-media.redd.it/x/pb/m2-res_720p.mp4?e=1&s=abc',
		]);
	});

	test('een adres midden in een zin is een verwijzing, geen speler', () => {
		expect(collectVideoUrls('Zie https://cdn.example.com/a.mp4 voor het filmpje.', page)).toEqual([]);
	});

	test('laat http, localhost en dubbelen vallen', () => {
		const markdown = [
			'http://cdn.example.com/a.mp4',
			'https://localhost/a.mp4',
			'https://127.0.0.1/a.mp4',
			'https://cdn.example.com/b.mp4',
			'https://cdn.example.com/b.mp4',
		].join('\n');
		expect(collectVideoUrls(markdown, page)).toEqual(['https://cdn.example.com/b.mp4']);
	});
});

describe('archiveVideos', () => {
	const options = { baseUrl: 'http://127.0.0.1:4590', token: 'geheim', originUrl: 'https://example.com/post' };

	test('haalt de video op, zet hem bij Zett en levert de verwijzing', () => {
		const seen: { url: string; method?: string; type?: string; auth?: string; body?: unknown }[] = [];
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			seen.push({ url, method: init?.method, type: headers.get('content-type') ?? undefined, auth: headers.get('authorization') ?? undefined, body: init?.body });
			if (init?.method === 'POST') {
				return new Response(JSON.stringify({ ok: true, hash: HASH, reused: false, mime: 'video/mp4', bytes: 24, width: null, height: null }), { status: 201, headers: { 'Content-Type': 'application/json' } });
			}
			return new Response(mp4Bytes(), { status: 200, headers: { 'Content-Type': 'video/mp4' } });
		}) as unknown as typeof fetch;

		return archiveVideos(['https://cdn.example.com/a.mp4'], { ...options, fetchImpl }).then((archived) => {
			expect(archived.media).toEqual([HASH]);
			expect(archived.gaps).toEqual([]);
			expect(archived.mapping.get('https://cdn.example.com/a.mp4')).toBe(`zett-media://${HASH}.mp4`);
			expect(seen[0].url).toBe('https://cdn.example.com/a.mp4');
			expect(seen[1].url).toBe('http://127.0.0.1:4590/ingest/media');
			expect(seen[1].method).toBe('POST');
			expect(seen[1].type).toBe('video/mp4');
			expect(seen[1].auth).toBe('Bearer geheim');
			expect((seen[1].body as Uint8Array).length).toBe(24);
		});
	});

	test('een 403, een verkeerd type en een ontbrekende hash worden elk een gat met een reden', async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('verboden')) return new Response('nee', { status: 403 });
			if (init?.method === 'POST') {
				if (url.includes('zonder-hash')) return new Response(JSON.stringify({ ok: true }), { status: 201 });
				return new Response(JSON.stringify({ hash: 'niet-hex', mime: 'video/mp4' }), { status: 201 });
			}
			if (url.includes('beeld')) return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });
			return new Response(mp4Bytes(), { status: 200 });
		}) as unknown as typeof fetch;

		const archived = await archiveVideos(
			[
				'https://cdn.example.com/verboden.mp4',
				'https://cdn.example.com/beeld.mp4',
				'https://cdn.example.com/zonder-hash.mp4',
				'https://cdn.example.com/niet-hex.mp4',
			],
			{ ...options, fetchImpl, maxVideos: 4 },
		);
		expect(archived.media).toEqual([]);
		expect(archived.gaps.map((gap) => gap.reason)).toEqual([
			'HTTP 403',
			'geen video die Zett bewaart',
			'Zett gaf geen hash terug',
			'Zett gaf geen hash terug',
		]);
	});

	test('meer dan het maximum wordt niet stil weggelaten', async () => {
		const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
			init?.method === 'POST'
				? new Response(JSON.stringify({ hash: HASH, mime: 'video/webm' }), { status: 200 })
				: new Response(webmBytes(), { status: 200 })
		)) as unknown as typeof fetch;
		const urls = Array.from({ length: MAX_VIDEOS + 1 }, (_, i) => `https://cdn.example.com/${i}.webm`);
		const archived = await archiveVideos(urls, { ...options, fetchImpl });
		expect(archived.media).toEqual([HASH]);
		expect(archived.gaps).toEqual([
			{ url: urls[MAX_VIDEOS], reason: `te veel video's voor één clip (max ${MAX_VIDEOS})` },
		]);
		expect(archived.mapping.get(urls[0])).toBe(`zett-media://${HASH}.webm`);
	});
});

describe('rewriteVideoMarkdown', () => {
	const url = 'https://packaged-media.redd.it/x/pb/m2-res_720p.mp4?e=1&s=abc';
	const stored = `zett-media://${HASH}.mp4`;

	test('een kaal adres, een beeld en [url](url) worden een speler', () => {
		const markdown = `---\nsource: ${url}\n---\n\n${url}\n\ntekst\n\n![oud](${url})\n\n[${url}](${url})\n`;
		const out = rewriteVideoMarkdown(markdown, new Map([[url, stored]]));
		expect(out).toContain(`source: ${url}`);
		expect(out).toContain(`![](${stored})\n\ntekst`);
		expect(out).not.toContain('![oud]');
		expect(out.match(new RegExp(`!\\[\\]\\(${stored.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'g'))?.length).toBe(3);
	});

	test('een link met een eigen label blijft staan', () => {
		const markdown = `[bekijk de video](${url})`;
		expect(rewriteVideoMarkdown(markdown, new Map([[url, stored]]))).toBe(markdown);
	});

	test('zonder treffers blijft de tekst letterlijk gelijk', () => {
		const markdown = 'alleen tekst\n';
		expect(rewriteVideoMarkdown(markdown, new Map())).toBe(markdown);
	});
});
