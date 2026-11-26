// @vitest-environment jsdom
import { describe, test, expect } from 'vitest';
import { hoistRedditPostMedia, isRedditPostUrl } from './reddit-media';

describe('isRedditPostUrl', () => {
	test('herkent een post op Reddit', () => {
		expect(isRedditPostUrl('https://www.reddit.com/r/vibecoding/comments/1y59rf5/if_you_cant_follow/')).toBe(true);
		expect(isRedditPostUrl('https://old.reddit.com/r/webdev/comments/abc/x/')).toBe(true);
		expect(isRedditPostUrl('https://reddit.com/r/webdev/comments/abc/x/')).toBe(true);
	});

	test('laat de feed, een profiel en andere sites liggen', () => {
		expect(isRedditPostUrl('https://www.reddit.com/r/webdev/')).toBe(false);
		expect(isRedditPostUrl('https://www.reddit.com/user/someone/')).toBe(false);
		expect(isRedditPostUrl('https://example.com/r/webdev/comments/abc/x/')).toBe(false);
		expect(isRedditPostUrl('niet eens een adres')).toBe(false);
	});
});

const wrapper = (postContent: string) => `<article data-defuddle><div class="reddit post"><div class="post-content">${postContent}</div></div><hr><div class="reddit comments"><h2>Comments</h2></div></article>`;

describe('hoistRedditPostMedia', () => {
	test('zet de post-afbeelding boven de tekst', () => {
		const html = wrapper('<p>Tekst</p><div id="post-image"><img src="https://i.redd.it/a.jpg"></div>');
		const result = hoistRedditPostMedia(html);
		const doc = new DOMParser().parseFromString(result, 'text/html');
		const first = doc.querySelector('.post-content')!.firstElementChild!;
		expect(first.id).toBe('post-image');
	});

	test('laat de HTML met rust als de media er al bovenaan staat', () => {
		const html = wrapper('<div id="post-image"><img src="https://i.redd.it/a.jpg"></div><p>Tekst</p>');
		expect(hoistRedditPostMedia(html)).toBe(html);
	});

	test('laat een post zonder media met rust', () => {
		const html = wrapper('<p>Alleen tekst</p>');
		expect(hoistRedditPostMedia(html)).toBe(html);
	});

	test('raakt .post-content van een andere site niet aan', () => {
		const html = '<article><div class="hackernews post"><div class="post-content"><p>Tekst</p><div id="post-image"></div></div></div></article>';
		expect(hoistRedditPostMedia(html)).toBe(html);
	});
});
