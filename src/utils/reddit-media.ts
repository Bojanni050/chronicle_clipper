/**
 * De media van een Reddit-post boven de tekst zetten.
 *
 * Waarom: de Reddit-extractor van defuddle plakt de post-tekst en de post-media aan elkaar
 * (`textBody + mediaBody`), dus de afbeelding komt onder de tekst terecht. Reddit zelf zet hem
 * bovenaan. Voor een clip is de volgorde van de pagina het uitgangspunt, niet de volgorde waarin
 * de extractor toevallig samenvoegt.
 *
 * We werken op de geëxtraheerde HTML, vóór `createMarkdownContent`: dan klopt de volgorde in de
 * Markdown én in de `contentHtml`-variabele, en de beeldarchivering ziet dezelfde volgorde.
 *
 * Een galerijpost is een tweede geval: defuddle neemt alleen `#post-image` mee, en dat element
 * bestaat bij een galerij niet. De beelden staan dan in `gallery-carousel` in de live DOM, die de
 * extractor niet kent. `collectRedditGalleryImages` haalt ze daar op en `hoistRedditPostMedia`
 * zet ze als reeks bovenaan, zodat ze in dezelfde volgorde in de Markdown belanden.
 */

/** Een post-pagina op Reddit, niet de feed of een profiel. */
export function isRedditPostUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}

	const host = parsed.hostname.toLowerCase().replace(/^(www|old|new|np|m)\./, '');
	if (host !== 'reddit.com') return false;
	return /\/comments\//.test(parsed.pathname);
}

/** Media die Reddit zelf host, en geen chrome van de pagina (avatars, community-iconen, awards). */
function isPostMediaUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}

	const host = parsed.hostname.toLowerCase();
	if (!/^(?:[a-z0-9-]+\.)*redd\.it$/.test(host)) return false;
	return !/^styles\./.test(host);
}

/** Het pad van een Reddit-media-URL zonder de formaat-parameters (`?width=…&format=…`). */
function mediaKey(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return url;
	}
}

/**
 * Chrome van de Reddit-pagina zelf: avatar- en award-iconen van `styles.redditmedia.com` en
 * `redditstatic.com`. Die staan wel in de HTML maar horen niet bij de post, dus ze horen ook niet
 * in de mediabibliotheek van Zett. Zonder dit filter bewaart elke Reddit-clip een stuk of twintig
 * avatars van reageerders.
 */
export function isRedditPageChromeImage(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}

	const host = parsed.hostname.toLowerCase();
	if (host === 'styles.redditmedia.com') return true;
	return /(?:^|\.)redditstatic\.com$/.test(host);
}

/** Het grootste adres dat een `<img>` noemt: `src`, anders het laatste item uit `srcset`. */
function imageSource(img: Element): string {
	const src = img.getAttribute('src') || '';
	return src || bestSrcsetUrl(img.getAttribute('srcset')) || '';
}

/** Het laatste (breedste) adres uit een `srcset`; `null` als er niets bruikbaars in staat. */
function bestSrcsetUrl(srcset: string | null): string | null {
	if (!srcset) return null;
	const candidates = srcset
		.split(',')
		.map(part => part.trim().split(/\s+/)[0])
		.filter(Boolean);
	return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

/**
 * De beelden van een galerijpost, in de volgorde van de galerij.
 *
 * Reddit rendert de galerij in `gallery-carousel` binnen `shreddit-post`; oudere varianten zetten
 * de beelden in `[slot="post-media-container"]` of in `#post-image`. We proberen die in volgorde en
 * vallen terug op alle Reddit-media in de post. Lukt niets, dan is de lijst leeg en verandert er
 * niets aan de clip.
 *
 * De aanroeper geeft de volledige pagina-HTML mee (`fullHtml` uit de content-script), niet het
 * `document` van de popup: daar staat de pagina niet in.
 */
export function collectRedditGalleryImages(page: Document | string): string[] {
	let root: Document;
	if (typeof page === 'string') {
		try {
			root = new DOMParser().parseFromString(page, 'text/html');
		} catch {
			return [];
		}
	} else {
		root = page;
	}

	const post = root.querySelector('shreddit-post');
	if (!post) return [];

	const containers: Element[] = [
		post.querySelector('gallery-carousel'),
		post.querySelector('[slot="post-media-container"]'),
		post.querySelector('#post-image'),
	].filter((element): element is Element => element !== null);

	const candidates: Element[] = containers.length > 0 ? containers : [post];
	const seen = new Set<string>();
	const images: string[] = [];

	for (const container of candidates) {
		for (const img of Array.from(container.querySelectorAll('img'))) {
			const src = imageSource(img);
			if (!src || !isPostMediaUrl(src)) continue;
			const key = mediaKey(src);
			if (seen.has(key)) continue;
			seen.add(key);
			images.push(src);
		}
	}

	// Een galerij heeft hooguit twintig beelden; alles daarboven is geen post-media.
	return images.slice(0, 20);
}

/**
 * Zet de post-media als eerste kind van `.post-content`: eerst `#post-image` (één beeld of video),
 * en de galerij erachter als die er is.
 *
 * Alleen binnen de Reddit-wrapper (`div.reddit.post`), want `.post-content` komt ook bij andere
 * extractors voor. Staat de media er al bovenaan of is er geen media, dan blijft de HTML zoals hij
 * is — de functie doet niets half.
 */
export function hoistRedditPostMedia(html: string, gallery: string[] = []): string {
	if (!html) return html;
	if (gallery.length === 0 && !/post-image/i.test(html)) return html;

	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(html, 'text/html');
	} catch {
		return html;
	}

	const postContent = doc.querySelector('.reddit.post .post-content');
	if (!postContent) return html;

	const known = new Set(
		Array.from(postContent.querySelectorAll('img'))
			.map(img => img.getAttribute('src') || '')
			.filter(Boolean)
			.map(mediaKey)
	);
	const fresh = gallery.filter(url => !known.has(mediaKey(url)));

	let changed = false;
	if (fresh.length > 0) {
		const strip = doc.createElement('div');
		strip.className = 'zett-gallery';
		for (const url of fresh) {
			const img = doc.createElement('img');
			img.setAttribute('src', url);
			img.setAttribute('alt', '');
			strip.appendChild(img);
		}
		postContent.insertBefore(strip, postContent.firstChild);
		changed = true;
	}

	const media = postContent.querySelector('#post-image');
	if (media && postContent.firstElementChild !== media) {
		postContent.insertBefore(media, postContent.firstChild);
		changed = true;
	}

	return changed ? doc.body.innerHTML : html;
}
