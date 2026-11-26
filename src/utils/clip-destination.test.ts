import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock wordt naar boven gehaald, dus de gedeelde instelling moet ook via vi.hoisted worden gemaakt.
const settings = vi.hoisted(() => ({ clipDestination: 'chronicle' as string }));
vi.mock('./storage-utils', () => ({ generalSettings: settings }));
vi.mock('./chronicle-note-creator', () => ({ saveToChronicle: vi.fn(async () => {}) }));
vi.mock('./zett-note-creator', () => ({ saveToZett: vi.fn(async () => {}) }));

import { saveToChronicle } from './chronicle-note-creator';
import { saveToZett } from './zett-note-creator';
import { clipButtonLabel, clipDestination, destinationLabel, saveClip } from './clip-destination';

beforeEach(() => {
	vi.mocked(saveToChronicle).mockClear();
	vi.mocked(saveToZett).mockClear();
	settings.clipDestination = 'chronicle';
});
afterEach(() => vi.unstubAllGlobals());

describe('clip destination', () => {
	it('defaults to Chronicle, so existing installations are unaffected', async () => {
		expect(clipDestination()).toBe('chronicle');
		await saveClip('c', 'n', 'https://example.com');
		expect(saveToChronicle).toHaveBeenCalledWith('c', 'n', 'https://example.com');
		expect(saveToZett).not.toHaveBeenCalled();
	});

	it('sends to Zett when that is chosen, and only there', async () => {
		settings.clipDestination = 'zett';
		await saveClip('c', 'n', 'https://example.com');
		expect(saveToZett).toHaveBeenCalledWith('c', 'n', 'https://example.com');
		expect(saveToChronicle).not.toHaveBeenCalled();
	});

	it('treats an unknown or corrupt value as Chronicle', () => {
		settings.clipDestination = 'iets-anders';
		expect(clipDestination()).toBe('chronicle');
	});

	it('keeps the translated button text for Chronicle and names Zett otherwise', () => {
		expect(clipButtonLabel('Toevoegen aan Chronicle')).toBe('Toevoegen aan Chronicle');
		settings.clipDestination = 'zett';
		vi.stubGlobal('navigator', { language: 'nl-NL' });
		expect(clipButtonLabel('x')).toBe('Toevoegen aan Zett');
		vi.stubGlobal('navigator', { language: 'en-US' });
		expect(clipButtonLabel('x')).toBe('Add to Zett');
	});

	it('propagates a failure so the popup can show it', async () => {
		settings.clipDestination = 'zett';
		vi.mocked(saveToZett).mockRejectedValueOnce(new Error('Zett is niet bereikbaar'));
		await expect(saveClip('c', 'n', 'https://example.com')).rejects.toThrow('niet bereikbaar');
	});

	it('lets a single clip override the setting, so the menu can pick either receiver', async () => {
		settings.clipDestination = 'chronicle';
		await saveClip('c', 'n', 'https://example.com', undefined, 'zett');
		expect(saveToZett).toHaveBeenCalledWith('c', 'n', 'https://example.com');
		expect(saveToChronicle).not.toHaveBeenCalled();

		vi.mocked(saveToChronicle).mockClear();
		vi.mocked(saveToZett).mockClear();
		settings.clipDestination = 'zett';
		await saveClip('c', 'n', 'https://example.com', undefined, 'chronicle');
		expect(saveToChronicle).toHaveBeenCalledWith('c', 'n', 'https://example.com');
		expect(saveToZett).not.toHaveBeenCalled();
	});

	it('names both receivers in the browser language, for the menu', () => {
		vi.stubGlobal('navigator', { language: 'nl-NL' });
		expect(destinationLabel('chronicle')).toBe('Toevoegen aan Chronicle');
		expect(destinationLabel('zett')).toBe('Toevoegen aan Zett');
		vi.stubGlobal('navigator', { language: 'en-US' });
		expect(destinationLabel('chronicle')).toBe('Add to Chronicle');
		expect(destinationLabel('zett')).toBe('Add to Zett');
	});
});
