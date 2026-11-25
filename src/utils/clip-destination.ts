import { generalSettings } from './storage-utils';
import { saveToChronicle } from './chronicle-note-creator';
import { saveToZett, type ZettClipResult } from './zett-note-creator';

/**
 * Waar een clip naartoe gaat. Standaard Chronicle, zodat bestaande installaties
 * niets merken; Zett kies je in de instellingen.
 */
export type ClipDestination = 'chronicle' | 'zett';

export function clipDestination(): ClipDestination {
	return generalSettings.clipDestination === 'zett' ? 'zett' : 'chronicle';
}

/**
 * Slaat de clip op bij de gekozen bestemming. Bij Zett worden ook de beelden van de pagina
 * bewaard (`pageHtml`); Chronicle regelt dat via de app zelf en geeft niets terug.
 */
export async function saveClip(
	fileContent: string,
	noteName: string,
	url: string,
	pageHtml?: string,
): Promise<ZettClipResult | null> {
	if (clipDestination() === 'zett') {
		// Zonder HTML blijft de aanroep zoals hij was: er valt dan niets te bewaren.
		return pageHtml ? saveToZett(fileContent, noteName, url, pageHtml) : saveToZett(fileContent, noteName, url);
	}
	await saveToChronicle(fileContent, noteName, url);
	return null;
}

/** Tekst van de hoofdknop. Bij Chronicle blijft het de bestaande, vertaalde tekst (`fallback`). */
export function clipButtonLabel(fallback: string): string {
	if (clipDestination() !== 'zett') return fallback;
	const dutch = typeof navigator !== 'undefined' && (navigator.language || '').toLowerCase().startsWith('nl');
	return dutch ? 'Toevoegen aan Zett' : 'Add to Zett';
}
