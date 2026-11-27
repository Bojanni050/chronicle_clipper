// @vitest-environment jsdom
import { describe, test, expect } from 'vitest';
import { collectRedditGalleryImages, hoistRedditPostMedia, isRedditPageChromeImage, isRedditPostUrl } from './reddit-media';

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

const galleryPage = (carousel: string) => `<html><body><shreddit-post post-type="gallery"><h1>Post</h1>${carousel}<div slot="text-body"><p>Tekst</p></div></shreddit-post><shreddit-comment><img src="https://styles.redditmedia.com/avatar.png"></shreddit-comment></body></html>`;

describe('collectRedditGalleryImages', () => {
	test('neemt de beelden van de galerij in volgorde over', () => {
		const page = galleryPage('<gallery-carousel><img src="https://preview.redd.it/a.jpg?width=640"><img src="https://preview.redd.it/b.jpg?width=640"></gallery-carousel>');
		expect(collectRedditGalleryImages(page)).toEqual([
			'https://preview.redd.it/a.jpg?width=640',
			'https://preview.redd.it/b.jpg?width=640',
		]);
	});

	test('laat avatar- en award-iconen liggen en telt een beeld één keer', () => {
		const page = galleryPage('<gallery-carousel><img src="https://preview.redd.it/a.jpg?width=640"><img src="https://preview.redd.it/a.jpg?width=1080"><img src="https://styles.redditmedia.com/award.png"></gallery-carousel>');
		expect(collectRedditGalleryImages(page)).toEqual(['https://preview.redd.it/a.jpg?width=640']);
	});

	test('valt terug op srcset als er geen src is', () => {
		const page = galleryPage('<gallery-carousel><img srcset="https://preview.redd.it/c.jpg?width=320 320w, https://preview.redd.it/c.jpg?width=1080 1080w"></gallery-carousel>');
		expect(collectRedditGalleryImages(page)).toEqual(['https://preview.redd.it/c.jpg?width=1080']);
	});

	test('geeft niets terug buiten een Reddit-post', () => {
		expect(collectRedditGalleryImages('<html><body><div class="reddit post"><div class="post-content"><img src="https://i.redd.it/a.jpg"></div></div></body></html>')).toEqual([]);
		expect(collectRedditGalleryImages('geen html')).toEqual([]);
	});
});

describe('hoistRedditPostMedia met een galerij', () => {
	test('zet de galerij als reeks boven de tekst', () => {
		const html = wrapper('<p>Tekst</p>');
		const result = hoistRedditPostMedia(html, ['https://preview.redd.it/a.jpg', 'https://preview.redd.it/b.jpg']);
		const doc = new DOMParser().parseFromString(result, 'text/html');
		const postContent = doc.querySelector('.post-content')!;
		const strip = postContent.firstElementChild!;
		expect(strip.className).toBe('zett-gallery');
		expect(Array.from(strip.querySelectorAll('img')).map(img => img.getAttribute('src'))).toEqual([
			'https://preview.redd.it/a.jpg',
			'https://preview.redd.it/b.jpg',
		]);
		expect(postContent.lastElementChild!.textContent).toBe('Tekst');
	});

	test('zet een beeld dat al in de tekst staat er niet nog eens boven', () => {
		const html = wrapper('<div id="post-image"><img src="https://preview.redd.it/a.jpg"></div><p>Tekst</p>');
		expect(hoistRedditPostMedia(html, ['https://preview.redd.it/a.jpg?width=1080'])).toBe(html);
	});

	test('zet #post-image vóór de galerij', () => {
		const html = wrapper('<p>Tekst</p><div id="post-image"><img src="https://i.redd.it/v.png"></div>');
		const result = hoistRedditPostMedia(html, ['https://preview.redd.it/a.jpg']);
		const postContent = new DOMParser().parseFromString(result, 'text/html').querySelector('.post-content')!;
		expect(postContent.firstElementChild!.id).toBe('post-image');
		expect(postContent.children[1].className).toBe('zett-gallery');
	});
});

describe('isRedditPageChromeImage', () => {
	test('herkent avatars en iconen van Reddit zelf', () => {
		expect(isRedditPageChromeImage('https://styles.redditmedia.com/t5_abc/styles/communityIcon_x.png')).toBe(true);
		expect(isRedditPageChromeImage('https://www.redditstatic.com/awards2/0.png')).toBe(true);
	});

	test('laat post-media en andere sites met rust', () => {
		expect(isRedditPageChromeImage('https://preview.redd.it/a.jpg?width=640')).toBe(false);
		expect(isRedditPageChromeImage('https://i.imgur.com/a.jpg')).toBe(false);
		expect(isRedditPageChromeImage('geen adres')).toBe(false);
	});
});
