// @vitest-environment jsdom
import { describe, test, expect, vi } from 'vitest';
import {
	appendVideoLinks,
	collectPageVideoLinks,
	collectRedditVideoLinks,
	formatDuration,
	pickBestMp4,
	redditPackagedMp4s,
	resolveTweetVideos,
	resolveVideoLinks,
	tweetIdFromUrl,
	videoLinkMarkdown,
	videoProviderFromUrl,
	videosFromSyndication,
} from './video-links';

const mp4Small = 'https://video.twimg.com/amplify_video/1/vid/avc1/480x270/a.mp4';
const mp4Large = 'https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/b.mp4';
const hls = 'https://video.twimg.com/amplify_video/1/pl/playlist.m3u8';

function syndicationResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

const bitmapTweet = {
	mediaDetails: [
		{
			type: 'video',
			media_url_https: 'https://pbs.twimg.com/poster.jpg',
			video_info: {
				duration_millis: 4200,
				variants: [
					{ content_type: 'application/x-mpegURL', url: hls },
					{ bitrate: 256000, content_type: 'video/mp4', url: mp4Small },
					{ bitrate: 2176000, content_type: 'video/mp4', url: mp4Large },
				],
			},
		},
	],
};

describe('tweetIdFromUrl', () => {
	test('herkent de adressen die X voor een status gebruikt', () => {
		expect(tweetIdFromUrl('https://x.com/bitmapstudio/status/2124906133660094712')).toBe('2124906133660094712');
		expect(tweetIdFromUrl('https://twitter.com/bitmapstudio/status/2124906133660094712?s=20')).toBe('2124906133660094712');
		expect(tweetIdFromUrl('https://mobile.twitter.com/bitmapstudio/status/2124906133660094712')).toBe('2124906133660094712');
		expect(tweetIdFromUrl('https://www.x.com/bitmapstudio/status/2124906133660094712/video/1')).toBe('2124906133660094712');
		expect(tweetIdFromUrl('https://x.com/i/status/2124906133660094712')).toBe('2124906133660094712');
		expect(tweetIdFromUrl('https://x.com/i/web/status/2124906133660094712')).toBe('2124906133660094712');
		expect(tweetIdFromUrl('https://x.com/@bitmapstudio/status/2124906133660094712')).toBe('2124906133660094712');
	});

	test('laat andere pagina\'s liggen', () => {
		expect(tweetIdFromUrl('https://x.com/bitmapstudio')).toBeNull();
		expect(tweetIdFromUrl('https://example.com/status/123')).toBeNull();
		expect(tweetIdFromUrl('https://notx.com/user/status/123')).toBeNull();
		expect(tweetIdFromUrl('niet eens een adres')).toBeNull();
	});
});

describe('pickBestMp4', () => {
	test('kiest de hoogste bitrate en slaat HLS over', () => {
		expect(pickBestMp4(bitmapTweet.mediaDetails[0].video_info.variants)).toEqual({
			url: mp4Large,
			bitrate: 2176000,
		});
	});

	test('werkt ook met de oude vorm zonder content_type', () => {
		expect(pickBestMp4([{ type: 'video/mp4', src: mp4Small }])).toEqual({ url: mp4Small, bitrate: undefined });
	});

	test('geeft null als er geen mp4 tussen zit', () => {
		expect(pickBestMp4([{ content_type: 'application/x-mpegURL', url: hls }])).toBeNull();
		expect(pickBestMp4([])).toBeNull();
		expect(pickBestMp4(undefined)).toBeNull();
	});
});

describe('formatDuration', () => {
	test('maakt mm:ss en h:mm:ss', () => {
		expect(formatDuration(4200)).toBe('0:04');
		expect(formatDuration(65000)).toBe('1:05');
		expect(formatDuration(3723000)).toBe('1:02:03');
	});

	test('laat onbekende duur leeg', () => {
		expect(formatDuration(undefined)).toBe('');
		expect(formatDuration(0)).toBe('');
	});
});

describe('videosFromSyndication', () => {
	test('leest mediaDetails met poster en duur', () => {
		expect(videosFromSyndication(bitmapTweet)).toEqual([
			{
				url: mp4Large,
				poster: 'https://pbs.twimg.com/poster.jpg',
				durationMs: 4200,
				bitrate: 2176000,
				source: 'tweet',
			},
		]);
	});

	test('leest de oudere video-vorm', () => {
		const links = videosFromSyndication({
			video: { poster: 'https://pbs.twimg.com/p.jpg', durationMs: 1000, variants: [{ type: 'video/mp4', src: mp4Small }] },
		});
		expect(links).toHaveLength(1);
		expect(links[0].url).toBe(mp4Small);
	});

	test('negeert tweets zonder video', () => {
		expect(videosFromSyndication({ mediaDetails: [{ type: 'photo' }] })).toEqual([]);
		expect(videosFromSyndication({})).toEqual([]);
		expect(videosFromSyndication(null)).toEqual([]);
	});
});

describe('resolveTweetVideos', () => {
	test('vraagt de syndication-API met het statusnummer', async () => {
		const fetchImpl = vi.fn(async () => syndicationResponse(bitmapTweet));
		const links = await resolveTweetVideos('https://x.com/bitmapstudio/status/2124906133660094712', fetchImpl as any);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const calls = fetchImpl.mock.calls as unknown as string[][];
		expect(calls[0][0]).toContain('id=2124906133660094712');
		expect(links.map(link => link.url)).toEqual([mp4Large]);
	});

	test('geeft een lege lijst bij een fout of een niet-tweet', async () => {
		const failing = vi.fn(async () => syndicationResponse({}, 404));
		expect(await resolveTweetVideos('https://x.com/user/status/123', failing as any)).toEqual([]);
		expect(await resolveTweetVideos('https://example.com/artikel', failing as any)).toEqual([]);
		expect(failing).toHaveBeenCalledTimes(1);
	});
});

describe('collectPageVideoLinks', () => {
	test('leest video- en source-adressen en maakt ze absoluut', () => {
		const html = `
			<video src="/media/clip.mp4" poster="/poster.jpg"></video>
			<video><source src="https://cdn.example.com/b.webm"><source src="//cdn.example.com/c.mp4"></video>
		`;
		const links = collectPageVideoLinks(html, 'https://example.com/artikel');
		expect(links.map(link => link.url)).toEqual([
			'https://example.com/media/clip.mp4',
			'https://cdn.example.com/b.webm',
			'https://cdn.example.com/c.mp4',
		]);
		expect(links.every(link => link.source === 'page')).toBe(true);
	});

	test('leest og:video en laat blob en data liggen', () => {
		const html = '<video src="blob:https://x.com/abc"></video>';
		const links = collectPageVideoLinks(html, 'https://example.com/artikel', [
			{ property: 'og:video', content: 'https://example.com/video.mp4' },
			{ property: 'og:image', content: 'https://example.com/beeld.jpg' },
			{ name: 'twitter:player:stream', content: 'https://example.com/stream.mp4' },
		]);
		expect(links.map(link => link.url)).toEqual([
			'https://example.com/video.mp4',
			'https://example.com/stream.mp4',
		]);
	});
});

describe('Reddit', () => {
	const packaged = JSON.stringify({
		playbackMp4s: {
			permutations: [
				{ source: { url: 'https://v.redd.it/abc123/CMAF_480.mp4?source=fallback', dimensions: { width: 480, height: 270 } } },
				{ source: { url: 'https://v.redd.it/abc123/CMAF_1080.mp4?source=fallback', dimensions: { width: 1080, height: 608 } } },
				{ source: { url: 'https://v.redd.it/abc123/CMAF_1080.mp4?source=fallback', dimensions: { width: 1080, height: 608 } } },
			],
		},
	});
	const escaped = packaged.replace(/"/g, '&quot;');

	test('leest de mp4-permutaties op resolutie, zonder dubbelen', () => {
		expect(redditPackagedMp4s(packaged)).toEqual([
			'https://v.redd.it/abc123/CMAF_1080.mp4?source=fallback',
			'https://v.redd.it/abc123/CMAF_480.mp4?source=fallback',
		]);
		expect(redditPackagedMp4s(escaped)).toHaveLength(2);
		expect(redditPackagedMp4s('geen json')).toEqual([]);
		expect(redditPackagedMp4s(null)).toEqual([]);
	});

	test('haalt de mp4 uit packaged-media-json en laat de HLS-playlist liggen', () => {
		const html = `<shreddit-player poster="https://preview.redd.it/p.jpg?width=640" src="https://v.redd.it/abc123/HLSPlaylist.m3u8?source=fallback" packaged-media-json="${escaped}"></shreddit-player>`;
		const links = collectRedditVideoLinks(html, 'https://www.reddit.com/r/vibecoding/comments/1y59rf5/x/');

		expect(links.map(link => link.url)).toEqual(['https://v.redd.it/abc123/CMAF_1080.mp4?source=fallback']);
		expect(links[0].poster).toBe('https://preview.redd.it/p.jpg?width=640');
	});

	test('valt terug op de HLS-playlist en slaat de 96p-preview over', () => {
		const html = `
			<shreddit-player src="https://v.redd.it/abc123/HLSPlaylist.m3u8?source=fallback" preview="https://v.redd.it/abc123/CMAF_96.mp4?source=preview"></shreddit-player>
			<div class="reddit-video-player-root" data-hls-url="//v.redd.it/xyz/HLSPlaylist.m3u8" data-mpd-url="https://v.redd.it/xyz/DASHPlaylist.mpd"></div>
		`;
		const links = collectRedditVideoLinks(html, 'https://www.reddit.com/r/vibecoding/comments/1y59rf5/x/');
		expect(links.map(link => link.url)).toEqual([
			'https://v.redd.it/abc123/HLSPlaylist.m3u8?source=fallback',
			'https://v.redd.it/xyz/HLSPlaylist.m3u8',
			'https://v.redd.it/xyz/DASHPlaylist.mpd',
		]);
	});

	test('haalt de uitgaande videolink van een linkpost', () => {
		const html = `<shreddit-post content-href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" post-title="filmpje"><a slot="full-post-link" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">filmpje</a></shreddit-post>`;
		expect(collectRedditVideoLinks(html, 'https://www.reddit.com/r/x/comments/1y59rf5/x/')).toEqual([
			{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', provider: 'YouTube', source: 'page' },
		]);
	});

	test('valt terug op de titel-link als content-href ontbreekt', () => {
		const html = '<shreddit-post><a slot="full-post-link" href="https://youtu.be/abc123">filmpje</a></shreddit-post>';
		const links = collectRedditVideoLinks(html, 'https://www.reddit.com/r/x/comments/1y59rf5/x/');
		expect(links.map(link => link.url)).toEqual(['https://youtu.be/abc123']);
		expect(videoProviderFromUrl('https://vimeo.com/12345')).toBe('Vimeo');
	});

	test('negeert een linkpost naar een gewone pagina', () => {
		const html = `<shreddit-post content-href="https://example.com/artikel"><a slot="full-post-link" href="https://example.com/artikel">artikel</a></shreddit-post>`;
		expect(collectRedditVideoLinks(html, 'https://www.reddit.com/r/x/comments/1y59rf5/x/')).toEqual([]);
	});

	test('zet de spelernaam in het label', () => {
		expect(videoLinkMarkdown({ url: 'https://youtu.be/abc', provider: 'YouTube', source: 'page' }))
			.toBe('[Video (YouTube)](https://youtu.be/abc)');
	});

	test('haalt de video op van een tweet waarnaar de post linkt', async () => {
		const fetchImpl = vi.fn(async () => syndicationResponse(bitmapTweet)) as unknown as typeof fetch;
		const links = await resolveVideoLinks({
			pageUrl: 'https://www.reddit.com/r/x/comments/1y59rf5/x/',
			fullHtml: '<shreddit-post content-href="https://twitter.com/bitmapstudio/status/2124906133660094712"><a slot="full-post-link" href="https://twitter.com/bitmapstudio/status/2124906133660094712">filmpje</a></shreddit-post>',
			fetchImpl,
		});

		expect(links).toEqual([
			{
				url: mp4Large,
				poster: 'https://pbs.twimg.com/poster.jpg',
				durationMs: 4200,
				bitrate: 2176000,
				provider: 'X',
				source: 'tweet',
			},
		]);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	test('laat de tweet-link staan als de tweet geen video heeft', async () => {
		const fetchImpl = vi.fn(async () => syndicationResponse({}, 404)) as unknown as typeof fetch;
		const url = 'https://x.com/bitmapstudio/status/2124906133660094712';
		const links = await resolveVideoLinks({
			pageUrl: 'https://www.reddit.com/r/x/comments/1y59rf5/x/',
			fullHtml: `<shreddit-post content-href="${url}"></shreddit-post>`,
			fetchImpl,
		});

		expect(links).toEqual([{ url, provider: 'X', source: 'page' }]);
	});

	test('doet niets op een pagina zonder Reddit-speler', () => {
		expect(collectRedditVideoLinks('<p>gewoon een artikel</p>', 'https://example.com/artikel')).toEqual([]);
		expect(collectRedditVideoLinks('', 'https://www.reddit.com/r/x/comments/abc/')).toEqual([]);
	});

	test('laat de manifesten vallen zodra er een mp4 is', async () => {
		const fullHtml = `<shreddit-player src="https://v.redd.it/abc123/HLSPlaylist.m3u8?source=fallback" packaged-media-json="${escaped}"></shreddit-player>`;
		const links = await resolveVideoLinks({
			pageUrl: 'https://www.reddit.com/r/vibecoding/comments/1y59rf5/x/',
			fullHtml,
			contentHtml: '<video src="https://v.redd.it/abc123/HLSPlaylist.m3u8?source=fallback"></video>',
		});
		expect(links.map(link => link.url)).toEqual(['https://v.redd.it/abc123/CMAF_1080.mp4?source=fallback']);
	});
});

describe('appendVideoLinks', () => {
	test('zet de link onder de Markdown', () => {
		const markdown = 'De tekst van de tweet.';
		const result = appendVideoLinks(markdown, [{ url: mp4Large, durationMs: 4200, source: 'tweet' }]);
		expect(result).toBe(`De tekst van de tweet.\n\n[Video (0:04)](${mp4Large})`);
	});

	test('voegt niets toe als het adres er al in staat', () => {
		const markdown = `Zie [de video](${mp4Large}).`;
		expect(appendVideoLinks(markdown, [{ url: mp4Large, source: 'tweet' }])).toBe(markdown);
	});

	test('voegt niets toe zonder links', () => {
		expect(appendVideoLinks('tekst', [])).toBe('tekst');
	});

	test('dedupliceert meerdere keren hetzelfde adres', () => {
		const result = appendVideoLinks('tekst', [
			{ url: mp4Large, source: 'tweet' },
			{ url: mp4Large, source: 'page' },
		]);
		expect(result.match(new RegExp(mp4Large, 'g'))).toHaveLength(1);
	});

	test('nummert meerdere video\'s', () => {
		const result = appendVideoLinks('tekst', [
			{ url: mp4Small, durationMs: 4200, source: 'tweet' },
			{ url: mp4Large, durationMs: 65000, source: 'tweet' },
		]);
		expect(result).toBe(`tekst\n\n[Video 1 (0:04)](${mp4Small})\n[Video 2 (1:05)](${mp4Large})`);
	});

	test('zet de link met position top boven de Markdown', () => {
		const result = appendVideoLinks('De post-tekst.', [{ url: mp4Large, source: 'page' }], { position: 'top', embed: true });
		expect(result).toBe(`${mp4Large}\n\nDe post-tekst.`);
	});

	test('zet met embed een videobestand als kaal adres neer', () => {
		const result = appendVideoLinks('tekst', [{ url: mp4Large, durationMs: 4200, source: 'page' }], { embed: true });
		expect(result).toBe(`tekst\n\n${mp4Large}`);
	});

	test('laat een externe speler ook met embed gelabeld', () => {
		const result = appendVideoLinks('tekst', [{ url: 'https://youtu.be/abc', provider: 'YouTube', source: 'page' }], { embed: true });
		expect(result).toBe('tekst\n\n[Video (YouTube)](https://youtu.be/abc)');
	});
});

describe('resolveVideoLinks', () => {
	test('gebruikt voor een tweet de syndication-API', async () => {
		const fetchImpl = vi.fn(async () => syndicationResponse(bitmapTweet));
		const links = await resolveVideoLinks({
			pageUrl: 'https://x.com/bitmapstudio/status/2124906133660094712',
			fetchImpl: fetchImpl as any,
			contentHtml: '<video poster="https://pbs.twimg.com/poster.jpg"></video>',
		});
		expect(links.map(link => link.url)).toEqual([mp4Large]);
	});

	test('valt bij een mislukte tweet terug op wat de inhoud aanwijst', async () => {
		const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
		const links = await resolveVideoLinks({
			pageUrl: 'https://x.com/user/status/123',
			fetchImpl: fetchImpl as any,
			contentHtml: '<video src="https://cdn.example.com/clip.mp4"></video>',
		});
		expect(links.map(link => link.url)).toEqual(['https://cdn.example.com/clip.mp4']);
	});
});

describe('videoLinkMarkdown', () => {
	test('gebruikt een neutraal label met duur', () => {
		expect(videoLinkMarkdown({ url: mp4Large, source: 'tweet' })).toBe(`[Video](${mp4Large})`);
		expect(videoLinkMarkdown({ url: mp4Large, durationMs: 4200, source: 'tweet' })).toBe(`[Video (0:04)](${mp4Large})`);
	});
});
