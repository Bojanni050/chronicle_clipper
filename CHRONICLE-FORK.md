# Chronicle-fork van obsidian-clipper

Dit is een fork van [obsidianmd/obsidian-clipper](https://github.com/obsidianmd/obsidian-clipper)
(MIT-licentie, vertrokken vanaf versie 1.7.1), met de save-stap omgebouwd naar een eigen
bestemming in plaats van Obsidian. Sinds 25 november 2026 staat de clipper in zijn eigen repo,
[`Bojanni050/chronicle_clipper`](https://github.com/Bojanni050/chronicle_clipper); daarvoor was
het de map `clipper/` in `Chronicle-Gaia`. De geschiedenis van de upstream staat eronder
(`git log 1.7.1`, remote `upstream`), zodat een latere versie van de clipper te mergen is.
De content-extractie (Defuddle, inclusief `flatten-shadow-dom.js`), de popup-UI, templates,
highlighter en reader-mode zijn onaangeroerd — dat was precies het punt: hun extractie is
rijper dan wat `plugin/content/webclip.js` zelf doet.

## Wat is gewijzigd

- **`src/utils/chronicle-note-creator.ts`** (nieuw) — `saveToChronicle(fileContent, noteName, url)`
  POST't naar Chronicle's lokale ingest-listener (`{chronicleUrl}/ingest/chat`), met dezelfde
  payload-vorm (`content`, `title`, `url`, `sourceProvider: 'web'`, `occurredAt`) als
  `plugin/service-worker.js` al gebruikt, plus `object: 'web'` en `source: <url>`: Chronicle
  slaat een clip op als **web-object** (ItemType.WEB) met de pagina-URL als bron, in plaats van
  als chat. Foundation krijgt hem nog steeds als chat-capture (daar bestaat geen web-type).
  Analoog aan `saveToObsidian()` in `src/utils/obsidian-note-creator.ts`, die ongewijzigd is
  gebleven.
- **`src/utils/chronicle-connection.ts`** (nieuw) — haalt URL én ingest-token op bij de app
  via `GET /ingest/config` (nieuw endpoint in `services/ingest-listener.js`). Het token wordt
  bewust **niet** bewaard: `general_settings` staat in `storage.sync`, en een ingest-token is
  per machine. De verbinding leeft in het geheugen van de extensie; na een 401 (app herstart
  met een nieuw token) wordt de cache gewist en volgt één retry.
- **`src/core/popup.ts`** — `handleClipObsidian()` roept nu `saveToChronicle(...)` i.p.v.
  `saveToObsidian(...)`. Vault/pad/behavior (Obsidian-vaultconcepten) zitten nog in de code
  maar zijn verborgen (`.vault-path-container { display: none !important }` in
  `styles/popup.scss`, want de JS zet inline `display: flex`), en worden alleen nog gebruikt
  voor `incrementStat`
  (de ingebouwde gebruiksstatistieken, verder ongemoeid). CLI-fouten komen nu in een
  inline regel (`#clip-status`) i.p.v. de popup te vervangen door "failed to save file",
  zodat een niet-draaiende app of een 4xx leesbaar is en de knop bruikbaar blijft.
- **`src/types/types.ts`, `src/utils/storage-utils.ts`, `src/utils/cli-stubs.ts`** —
  één nieuwe setting: `chronicleUrl` (default `http://127.0.0.1:4580`). Geen
  `chronicleToken` meer in de settings.
- **`src/settings.html`, `src/managers/general-settings.ts`** — een "Chronicle"-sectie met
  een URL-veld, een statusregel en een knop **Test verbinding**. De status wordt bij het
  openen van de instellingen automatisch gepeild.
- **`src/manifest.chrome.json`** — naam/omschrijving/versie aangepast zodat de extensie
  herkenbaar is naast de bestaande "Chronicle Chat Exporter" (`plugin/`); permissies
  ongewijzigd.

## Niet gewijzigd (bewust)

- Alle content-extractie, templates, highlighter, reader-mode — puur cosmetisch, functioneel
  onveranderd. De i18n-strings zijn ongewijzigd, behalve het hoofdknoplabel: `addToObsidian`
  heet in `nl` en `en` nu "Toevoegen aan Chronicle" / "Add to Chronicle". De overige
  tientallen locales zeggen nog "Obsidian"; die zie je alleen als je browser op zo'n taal staat,
  en de sleutelnaam `addToObsidian` is intern gebleven om de templates niet te raken.
- `host_permissions: ["<all_urls>", ...]` — deze extensie draait (anders dan `plugin/`'s
  activeTab-aanpak) een altijd-geladen content script op elke pagina (voor highlighter/reader
  mode). Dat is een bewust bredere permissie-voetafdruk dan de minimale aanpak in
  `plugin/content/webclip.js` — een expliciete trade-off voor de rijkere extractie.

## Build

```
cd clipper
npm install
npm run build:chrome   # -> clipper/dist/ en clipper/builds/*.zip
```

Laad `clipper/dist/` als "Uitgepakte extensie" via `chrome://extensions`. Verdere configuratie
is niet nodig: de extensie vraagt de listener-URL en het ingest-token zelf op bij de draaiende
Chronicle-app (`GET /ingest/config`). Draait de app niet, dan zegt de popup dat bij de knop.
De Chronicle-sectie in de extensie-instellingen toont de verbindingsstatus en heeft een knop
**Test verbinding**; alleen de URL is handmatig aan te passen (voor een afwijkende poort).

`GET /ingest/config` is bewust smal: alleen loopback-Host (`127.0.0.1`, `localhost`, `::1`),
alleen een browser-extensie-Origin, en nooit een CORS-header. Een webpagina kan het antwoord
dus niet lezen; een ander lokaal proces kan dat wel — net als het `foundation.local.json` op
deze machine. Zonder dat endpoint zou de gebruiker het token alsnog met de hand moeten plakken.

De manifestversie is `1.7.1.4` (Chrome accepteert alleen 1–4 puntgescheiden integers; de
eerdere `1.7.1-chronicle.1` zou bij het laden geweigerd zijn).

## Bekende afwijking buiten deze fork

`npx vitest run` faalt op 9 testbestanden met `Cannot find package 'webextension-polyfill'`,
terwijl het package wél in `node_modules` staat en de echte `webpack`-build het probleemloos
oplost. Dit is een Vite/Vitest-resolutiequirk van de upstream-testinfrastructuur, niet iets
dat door deze fork is veroorzaakt — de 139 individuele tests die wél draaiden, slaagden
allemaal.

## Tweede bestemming: Zett

Naast Chronicle kan de clipper ook naar **Zett** sturen, de notitie-app op `K:\Projects\CapacitiesDev`. Chronicle blijft de standaard, dus bestaande installaties merken niets.

- **`src/utils/zett-note-creator.ts`** (nieuw) combineert wat `chronicle-connection.ts` en `chronicle-note-creator.ts` doen, voor Zett's luisteraar (`127.0.0.1:4590`): `GET /ingest/config` voor URL en token (alleen in het geheugen, na een 401 opnieuw opgehaald), `POST /ingest/clip` met een Bearer-token. Hij controleert dat het antwoord `app: "zett"` zegt, zodat een clip nooit per ongeluk naar Chronicle of een andere app gaat.
- **`src/utils/clip-destination.ts`** (nieuw) kiest de bestemming (`saveClip`) en de tekst van de hoofdknop (`clipButtonLabel`).
- **`src/core/popup.ts`**: `saveToChronicle(...)` werd `saveClip(...)`, en de hoofdknop zegt "Toevoegen aan Zett" als dat de bestemming is. Verder niets.
- **Instellingen**: `clipDestination` (`chronicle` of `zett`, standaard `chronicle`) en `zettUrl` in `types.ts`, `storage-utils.ts`, `cli-stubs.ts`; in `settings.html` en `general-settings.ts` een sectie "Bestemming" en een sectie "Zett" met een URL-veld, een statusregel en **Test verbinding**.
- **Zett-kant**: zet in Zett onder Instellingen, tabblad **Web clipper**, de optie aan (standaard aan). Details van de luisteraar staan in `docs/api-contract.md`, sectie 12, van Zett.
- **Tests**: `zett-note-creator.test.ts` en `clip-destination.test.ts` (16 tests). De 9 bestaande mislukte testbestanden (het `webextension-polyfill`-probleem hierboven) zijn onveranderd.
- **Overnemen**: bouw met `npm run build:chrome` en herlaad de extensie in `chrome://extensions`. Kies daarna in de extensie-instellingen bij **Bestemming** voor Zett.
- **Rebrandings (2026-11-18)**: de app heette eerst Mindstack, daarna Mindloom, nu Zett. De oude opgeslagen waarden `clipDestination: 'mindstack'`/`'mindloom'` en de oude sleutels `mindstackUrl`/`mindloomUrl` worden nog gelezen, zodat een bestaande installatie haar keuze en URL houdt.
- **Naam van de extensie (2026-11-18)**: de extensie heette in Chrome "Chronicle Web Clipper" en in de instellingen en de popup nog "Obsidian Web Clipper". Die naam is nu overal **Zett Web Clipper**: `manifest.chrome.json`, `manifest.firefox.json`, `manifest.safari.json`, de `<title>` van `popup.html`, `settings.html`, `side-panel.html` en `reader.html` ("Zett Reader"), de `extensionName` in alle `_locales`, en de titel in de navigatiebalk van `settings.html`. Het Obsidian-logo in de zijbalk en de navigatiebalk is vervangen door het Zett-merkteken (`src/icons/zett-mark.png`), net als de extensie-iconen (16/48/128). De twee bestemmingen blijven Chronicle en Zett; de teksten over Obsidian-vaults in de instellingen zijn van de fork overgenomen en niet aangeraakt.

## Beelden lokaal bewaren (2026-11-25)

Een clip met `![x](https://…/beeld.png)` was een verwijzing: verdween de pagina of het CDN, dan was
het beeld weg. Bij bestemming **Zett** haalt de extensie de beelden nu op en laat ze daar bewaren,
inhoud-geadresseerd op sha256 — dezelfde afspraak als in `docs/media-archivering.md` van de
Zett-repo. Bij bestemming Chronicle verandert er niets (die app regelt het zelf).

- **`src/utils/media-archive.ts`** (nieuw): `collectImageUrls` leest de `<img>`- en
  `<picture><source>`-kandidaten uit de HTML (uit een `srcset` de grootste), `archiveImages` haalt
  ze op en zet ze bij Zett neer, `sha256Hex` rekent de hash, `rewriteMarkdown` vervangt in de
  Markdown de bron van een afbeelding door `zett-media://<hash>`.
- **Regels**, dezelfde als `utils/imageFetch.ts` van de app: alleen https, geen `localhost` of
  privébereiken, 25 MB per beeld, maximaal 30 per clip, en het type komt uit de eerste bytes.
  Bewust **zonder cookies**: een beeld dat de sessie van de browser vraagt wordt overgeslagen en
  als gat met reden gemeld (`HTTP 403`) — er wordt geen toegangscontrole omzeild.
- **`src/utils/zett-note-creator.ts`**: `saveToZett(…, pageHtml?)` bewaart eerst de beelden en
  stuurt dan de clip, met `media` (hashes) en `media_gaps` (wat niet lukte) in de payload. De
  Markdown verwijst naar de hash; de oorspronkelijke URL blijft alleen aan de Zett-kant bewaard
  (`media.origin_url`), zodat het openen van de notitie de bronsite niet meer pingt.
- **`src/utils/clip-destination.ts`**: `saveClip(…, pageHtml?)` geeft door en geeft het aantal
  bewaarde en mislukte beelden terug. Zonder HTML is de aanroep naar `saveToZett` ongewijzigd.
- **Instelling** "Bewaar de afbeeldingen van de pagina in Zett" in de Zett-sectie, standaard aan
  (`archiveImages` in `types.ts`, `storage-utils.ts`, `cli-stubs.ts`, `settings.html` en
  `general-settings.ts`). De popup toont onder de knop *"12 afbeeldingen bewaard, 2 niet
  opgehaald"*; met die regel eronder blijft de popup 2,5 s staan in plaats van 0,5 s.
- **`src/_locales/en|nl/messages.json`**: twee sleutels erbij (`archiveImages`,
  `archiveImagesDescription`); de andere locales vallen terug op Engels, zoals `getMessage` al doet.
- **CLI**: `archiveImages: false` — de CLI knipt zonder browser, er valt geen beeld op te halen.
- **Tests**: `src/utils/media-archive.test.ts` (sniffen, srcset-keuze, adrescontrole, dedupe,
  403/leeg/te groot, de hash, het herschrijven en de samenvatting).

## Ontvanger per clip in het menu (2026-11-26)

De bestemming stond alleen in de instellingen, dus je moest vooraf kiezen naar welke app een clip
ging. Dat is nu een standaard in plaats van een voorwaarde: het uitklapmenu naast de hoofdknop biedt
de **andere** ontvanger aan ("Toevoegen aan Zett" of "Toevoegen aan Chronicle") en slaat de clip
meteen daar op. De instelling blijft bepalen wat de hoofdknop doet.

- **`src/utils/clip-destination.ts`**: `saveClip(…, pageHtml?, destination?)` — de vijfde parameter
  laat één clip afwijken van `generalSettings.clipDestination`; zonder die parameter verandert er
  niets. Nieuw is `destinationLabel(destination)`: de menu-tekst in de taal van de browser (NL/EN),
  dezelfde regel als `clipButtonLabel` al gebruikte.
- **`src/core/popup.ts`**: `determineMainAction` zet het menu-item voor de andere ontvanger bovenaan
  de secundaire acties; `handleClipObsidian(destination?)` geeft die keuze door aan `saveClip`.
  `addSecondaryAction` kreeg een optionele `label`, zodat een ontvangernaam niet door `data-i18n`
  wordt overschreven, en sluit het menu na een klik. De twee menu-items die naar de standaard
  bestemming sturen gebruiken nu `clipButtonLabel(...)` als tekst — anders zei het menu "Add to
  Chronicle" terwijl de instelling op Zett stond.
- **`src/icons/icons.ts`**: `Notebook` toegevoegd (voor Zett); Chronicle gebruikt het bestaande
  `archive`.
- **`src/manifest.chrome.json`**: versie 1.7.1.5.
- **Tests**: `clip-destination.test.ts` dekt de override in beide richtingen en de labels in NL en EN.

## Videolinks uit tweets (2026-11-26)

Een tweet met een video kwam zonder verwijzing in de notitie terecht. X zet in de DOM een
`<video>` met een `blob:`-adres (of helemaal geen `src`) en bewaart de echte mp4 alleen in zijn
bootstrap-JSON; de content-extractie laat `<script>` weg, en de statuspagina heeft geen
`og:video`-meta. De clip bevatte dus de tekst van de tweet, maar geen enkele manier om de video
terug te vinden.

- **`src/utils/video-links.ts`** (nieuw): `tweetIdFromUrl` leest het statusnummer uit x.com- en
  twitter.com-adressen (`/user/status/…`, `/i/status/…`, `/i/web/status/…`, `/statuses/…`, met
  `/video/1` of query erachter). `resolveTweetVideos` vraagt
  `https://cdn.syndication.twimg.com/tweet-result?id=…&token=4` op en `pickBestMp4` kiest de
  mp4-variant met de hoogste bitrate (HLS-playlists vallen af). `collectPageVideoLinks` doet hetzelfde
  voor gewone pagina's: `<video src>`, `<source src>` en de meta-tags `og:video`,
  `og:video:url`, `og:video:secure_url` en `twitter:player:stream`.
- **`src/utils/content-extractor.ts`**: `initializePageContent` zet de links onder `{{content}}`
  als `[Video (0:04)](https://video.twimg.com/…mp4)` (bij meerdere video's genummerd). Dat gebeurt
  alleen bij een volledige clip: bij een tekstselectie of `replace-content`-highlight blijft de
  inhoud zoals hij is. Mislukt het ophalen, dan gaat de clip gewoon door — een video is geen
  voorwaarde. Staat het adres al in de Markdown (bijvoorbeeld omdat Defuddle de `<video>` bewaarde),
  dan wordt er niets toegevoegd.
- **Alleen linken, niet bewaren**: Zett's `/ingest/media` accepteert nu alleen beelden en 25 MB per
  bestand (zie `docs/media-archivering.md` daar). De bytes archiveren vraagt een wijziging aan de
  Zett-kant en een ruimer budget; dit is bewust een aparte stap.
- **`src/manifest.chrome.json`**: versie 1.7.1.6.
- **Tests**: `src/utils/video-links.test.ts` (adresherkenning, variantkeuze, duur, beide
  API-vormen, pagina- en metavideo's, dedupe, idempotent toevoegen, genummerde video's).

## Reddit-video's in dezelfde module (2026-11-26)

Een Reddit-post met video gaf hetzelfde gat: de tekst kwam mee, de video niet. Reddit speelt zijn
video's via MediaSource — het `<video>`-element krijgt een `blob:`-adres — en de echte mp4's staan
in het `packaged-media-json`-attribuut van `<shreddit-player>`. Dat attribuut zit niet in de
geëxtraheerde inhoud, en de postpagina heeft geen bruikbare `og:video`. De mp4's zijn wel te lezen
uit de volledige pagina-HTML die de clipper al ophaalt (`fullHtml`).

- **`collectRedditVideoLinks`** (zelfde bestand) leest `playbackMp4s.permutations` uit elke speler
  (`source.url`, hoogste `dimensions` eerst) en geeft één mp4 per speler. Zonder die JSON blijft de
  HLS-playlist (`shreddit-player[src]`, `[data-hls-url]`) of de DASH-manifest (`[data-mpd-url]`)
  over; de `preview` wordt overgeslagen, want dat is een stille 96p-clip voor de seek-balk.
  `redditPackagedMp4s` doet alleen het JSON-deel (en decodeert `&quot;` als de parser dat niet al
  deed).
- **`resolveVideoLinks`** krijgt er `fullHtml` bij en zet de Reddit-links vóór de generieke
  pagina-links. `preferRedditMp4` laat de HLS-playlist en de MPD van `v.redd.it` vallen zodra er
  een mp4 van die host is: dat is dezelfde video in een vorm die je later niet zonder speler opent.
- **`src/utils/content-extractor.ts`** geeft `fullHtml` mee aan `appendVideoLinksFromPage`.
- **Kosten**: de HTML wordt alleen geparsed als er `packaged-media-json`, `v.redd.it` of
  `<shreddit-post` in staat, dus elke andere pagina betaalt één regex.
- **Externe spelers** krijgen ook een link: bij een linkpost staat de video bij YouTube, Vimeo,
  Streamable, Twitch, Dailymotion, RedGifs, Gfycat of Imgur en is het adres het enige spoor in de
  HTML. `redditExternalVideoLinks` kijkt daarvoor binnen `<shreddit-post>` naar `content-href`,
  `url`, `post-url`, `link-url` en de titel-link; de rest van de pagina staat vol links naar andere
  posts en blijft buiten beeld. `videoProviderFromUrl` levert de naam die in het label komt:
  `[Video (YouTube)](https://youtu.be/…)`. Een rauwe `.mp4`-link telt ook mee, zonder naam.
- **Tweets** tellen als externe speler (`provider: 'X'`). Linkt de post naar een tweet, dan haalt
  `resolveVideoLinks` de mp4's van die tweet op met dezelfde syndication-fetch en vervangt de
  tweet-link; heeft de tweet geen video, dan blijft de tweet-link staan. Kost één verzoek, alleen
  als er echt een tweet-link in de post staat.
- **`src/manifest.chrome.json`**: versie 1.7.1.9.
- **Tests**: elf nieuwe tests in `video-links.test.ts` (permutatievolgorde en dedupe, mp4 boven
  HLS, HLS/MPD-terugval zonder 96p, pagina zonder speler, manifesten weg zodra er een mp4 is,
  YouTube-linkpost, titel-link als terugval, linkpost naar een gewone pagina, spelernaam in het
  label, tweet-video uit een linkpost, tweet zonder video); 33 tests groen,
  `npm run build:chrome` ok.

## Media boven de tekst (2026-11-26)

- **Probleem**: een geclipte Reddit-post zette de afbeelding onder de tekst, terwijl reddit.com hem
  bovenaan toont; de video van de post kwam helemaal niet mee. Oorzaak van de volgorde zit in
  defuddles Reddit-extractor: `getPostContent()` geeft `textBody + mediaBody` terug en plakt
  daarmee `#post-image` achter de tekst. De video staat alleen in `<shreddit-player>` en werd door
  `collectRedditVideoLinks` wel gevonden, maar als gelabelde link onderaan gezet — en een gelabelde
  link maakt Zett niet tot speler (alleen een kaal adres of `![](url)`).
- **Keuze**: de volgorde repareren op de geëxtraheerde HTML, vóór `createMarkdownContent`, in plaats
  van de Markdown achteraf herschrijven. Dan klopt de volgorde ook in de `contentHtml`-variabele en
  in de beeldarchivering, en de reparatie is één DOM-verplaatsing. Alleen op een Reddit-post-URL
  (`/comments/`) en alleen binnen `div.reddit.post`, want `.post-content` bestaat ook bij andere
  extractors. Een kaal adres is gekozen boven `![](url)`: Zett maakt er een speler van, Obsidian
  laat het als werkende link zien. Externe spelers (YouTube, Vimeo) blijven gelabeld — dat is geen
  bestand — maar staan bij een Reddit-post ook bovenaan.
- **Actions**: `src/utils/reddit-media.ts` toegevoegd (`isRedditPostUrl`, `hoistRedditPostMedia`);
  `src/utils/video-links.ts` kreeg `embed` en `position` (`VideoLinkOptions`,
  `AppendVideoLinkOptions`, `DIRECT_VIDEO_PATH`, `isDirectVideoFile`);
  `src/utils/content-extractor.ts` hoogt de media vóór de Markdown-conversie en geeft Reddit-posts
  `{ position: 'top', embed: true }` mee; `src/utils/reddit-media.test.ts` (6 tests) en vier extra
  tests in `src/utils/video-links.test.ts`; `src/manifest.chrome.json` naar 1.7.2.0. 45 tests groen,
  `npm run build:chrome` ok.

## Video's bij het clippen bewaren (2026-11-26)

- **Probleem**: een geclipte Reddit-video stond als adres in de notitie, en zo'n adres is
  ondertekend (`e=` in de query) en verloopt binnen uren tot een dag. De speler ging daarna dood;
  de Save-knop in Zett werkt, maar is een handeling per clip. Zett's `/ingest/media` nam alleen
  beeld aan, dus de clipper kon de bytes niet brengen.
- **Keuze**: video's bij het clippen meteen naar Zett, door hetzelfde endpoint, met dezelfde regels
  als beelden (https, geen privébereik, geen cookies, type uit de bytes) en de videogrens van 200
  MB. De adressen komen uit de Markdown die de popup al maakte: een native speler levert een
  `blob:`-bron en geen downloadbaar adres, dus de HTML heeft niets bruikbaars. Een kaal adres,
  `![](…)` en `[url](url)` worden vervangen; een gelabelde link blijft, want dat label is een keuze
  van de gebruiker. Wat niet lukt wordt een gat met een reden, nooit stil weggelaten. Standaard
  aan, max 3 video's, 180 s per stuk: een clip mag niet stukgaan op een video.
- **Actions**: `src/utils/video-archive.ts` (nieuw: `isVideoFile`, `sniffVideoMime`,
  `collectVideoUrls`, `archiveVideos`, `rewriteVideoMarkdown`) met 13 tests; `src/utils/zett-note-creator.ts`
  (`archiveVideos` na de beelden, `ZettClipResult.videos`); instelling `archiveVideos` in
  `types.ts`, `storage-utils.ts`, `cli-stubs.ts`, `settings.html`, `general-settings.ts` en de
  locales en/nl; `mediaSummary` noemt video's apart; `src/manifest.chrome.json` naar 1.7.3.0.
  32 tests groen, `npm run build:chrome` ok.
