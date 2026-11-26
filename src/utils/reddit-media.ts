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

/**
 * Zet `#post-image` als eerste kind van `.post-content`.
 *
 * Alleen binnen de Reddit-wrapper (`div.reddit.post`), want `.post-content` komt ook bij andere
 * extractors voor. Staat de media er al bovenaan of is er geen media, dan blijft de HTML zoals hij
 * is — de functie doet niets half.
 */
export function hoistRedditPostMedia(html: string): string {
	if (!html || !/post-image/i.test(html)) return html;

	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(html, 'text/html');
	} catch {
		return html;
	}

	const postContent = doc.querySelector('.reddit.post .post-content');
	if (!postContent) return html;

	const media = postContent.querySelector('#post-image');
	if (!media) return html;

	const first = postContent.firstElementChild;
	if (first === media) return html;

	postContent.insertBefore(media, postContent.firstChild);
	return doc.body.innerHTML;
}
