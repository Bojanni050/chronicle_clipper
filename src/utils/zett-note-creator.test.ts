import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./storage-utils', () => ({
	generalSettings: { zettUrl: 'http://127.0.0.1:4590', clipDestination: 'zett', chronicleUrl: '' },
	saveSettings: vi.fn(async () => {}),
}));

import { generalSettings, saveSettings } from './storage-utils';
import { clearZettConnection, resolveZettConnection, saveToZett } from './zett-note-creator';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const config = (token = 'tok1', extra: Record<string, unknown> = {}) =>
	json({ app: 'zett', version: '0.1.0', baseUrl: 'http://127.0.0.1:4590', listenerUrl: 'http://127.0.0.1:4590', token, ...extra });

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	vi.mocked(saveSettings).mockClear();
	(generalSettings as { zettUrl: string }).zettUrl = 'http://127.0.0.1:4590';
	clearZettConnection();
});

describe('resolveZettConnection', () => {
	it('asks Zett for its URL and token, and remembers them for the session', async () => {
		fetchMock.mockResolvedValueOnce(config('tok1'));
		const c = await resolveZettConnection();
		expect(c).toEqual({ baseUrl: 'http://127.0.0.1:4590', token: 'tok1' });
		expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4590/ingest/config', expect.objectContaining({ method: 'GET' }));
		await resolveZettConnection(); // uit het geheugen
		expect(fetchMock).toHaveBeenCalledTimes(1);
		fetchMock.mockResolvedValueOnce(config('tok2'));
		expect((await resolveZettConnection({ force: true })).token).toBe('tok2');
	});

	it('refuses to talk to something that is not Zett (for example Chronicle on a wrong port)', async () => {
		fetchMock.mockResolvedValue(json({ app: 'chronicle', token: 'x' }));
		await expect(resolveZettConnection()).rejects.toThrow(/niet Zett/);
	});

	it('refuses a response without a token', async () => {
		fetchMock.mockResolvedValue(json({ app: 'zett' }));
		await expect(resolveZettConnection()).rejects.toThrow(/geen token/);
	});

	it('names every address it tried when the app is not reachable', async () => {
		(generalSettings as { zettUrl: string }).zettUrl = 'http://127.0.0.1:5555/';
		fetchMock.mockRejectedValue(new Error('Failed to fetch'));
		await expect(resolveZettConnection()).rejects.toThrow(/127\.0\.0\.1:5555[\s\S]*127\.0\.0\.1:4590/);
		expect(fetchMock).toHaveBeenCalledTimes(2); // eerst de ingestelde URL, dan de standaard
	});

	it('stores the address it actually found, but never the token', async () => {
		(generalSettings as { zettUrl: string }).zettUrl = 'http://127.0.0.1:5555';
		fetchMock.mockRejectedValueOnce(new Error('weg')).mockResolvedValueOnce(config('tok1'));
		await resolveZettConnection();
		expect(saveSettings).toHaveBeenCalledWith({ zettUrl: 'http://127.0.0.1:4590' });
		expect(JSON.stringify(vi.mocked(saveSettings).mock.calls)).not.toContain('tok1');
	});
});

describe('saveToZett', () => {
	const sent = () => JSON.parse(String(fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/ingest/clip'))![1].body));

	it('posts the clip with the bearer token', async () => {
		fetchMock.mockResolvedValueOnce(config('tok1')).mockResolvedValueOnce(json({ ok: true, created: true }, 201));
		await saveToZett('---\ntitle: T\n---\ntekst', 'Naam', 'https://example.com/a');
		const [url, init] = fetchMock.mock.calls[1];
		expect(url).toBe('http://127.0.0.1:4590/ingest/clip');
		expect(init.method).toBe('POST');
		expect(init.headers).toMatchObject({ Authorization: 'Bearer tok1', 'Content-Type': 'application/json' });
		expect(sent()).toMatchObject({ content: '---\ntitle: T\n---\ntekst', title: 'Naam', url: 'https://example.com/a', source: 'https://example.com/a', sourceProvider: 'web' });
		expect(typeof sent().occurredAt).toBe('string');
	});

	it('falls back to the address as title when there is no note name', async () => {
		fetchMock.mockResolvedValueOnce(config()).mockResolvedValueOnce(json({ ok: true }));
		await saveToZett('tekst', '', 'https://example.com/a');
		expect(sent().title).toBe('https://example.com/a');
	});

	it('fetches a new token and retries once after a 401 (the app restarted)', async () => {
		fetchMock
			.mockResolvedValueOnce(config('oud'))
			.mockResolvedValueOnce(json({ error: 'missing or invalid bearer token' }, 401))
			.mockResolvedValueOnce(config('nieuw'))
			.mockResolvedValueOnce(json({ ok: true }, 200));
		await saveToZett('tekst', 'N', 'https://example.com/a');
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer nieuw');
	});

	it('gives up after a second 401 and reports it', async () => {
		fetchMock
			.mockResolvedValueOnce(config('a'))
			.mockResolvedValueOnce(json({ error: 'missing or invalid bearer token' }, 401))
			.mockResolvedValueOnce(config('b'))
			.mockResolvedValueOnce(json({ error: 'missing or invalid bearer token' }, 401));
		await expect(saveToZett('t', 'N', 'https://example.com/a')).rejects.toThrow(/bearer token/);
		expect(fetchMock).toHaveBeenCalledTimes(4); // niet eindeloos blijven proberen
	});

	it('shows the error text from Zett and does not retry other failures', async () => {
		fetchMock.mockResolvedValueOnce(config()).mockResolvedValueOnce(json({ error: 'url must be an http or https address' }, 422));
		await expect(saveToZett('t', 'N', 'javascript:alert(1)')).rejects.toThrow('url must be an http or https address');
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('falls back to the status code when the error has no body', async () => {
		fetchMock.mockResolvedValueOnce(config()).mockResolvedValueOnce(new Response('kapot', { status: 500 }));
		await expect(saveToZett('t', 'N', 'https://example.com/a')).rejects.toThrow('Zett gaf status 500');
	});
});
