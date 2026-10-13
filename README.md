# The Whatever Tracker 🗃️

A self-hosted tracker for anything: movies, TV, video games, board games, concerts, whiskey, wine, cheese, hot
sauces, the cats you've met… You define the lists and their fields. Built to run on a Synology NAS behind a
reverse proxy, and to work well on a phone.

- **One search bar for everything.** Type once and see matches from your own lists _and_ every connected source
  (TMDB, IGDB, BoardGameGeek, MusicBrainz) at the same time. There's no "pick a media type first" step.
- **Any list you like.** Templates for common things, or build your own with custom fields (text, number, date,
  pick-one, pick-several, yes/no, link). Fields can describe the item (distillery, vintage) or each log (tasting
  notes, who won).
- **Items with history.** Every time you watch, play, taste or meet something, add a dated log with its own rating,
  notes, place, photos, and for concerts, the setlist pulled from setlist.fm.
- **Your photos.** Take a picture with your phone's camera, upload one, or paste a link. Photos are resized and
  stripped of location data on the server. Links are copied to the NAS by default so they never break.
- **Barcode scanning.** Scan a bottle or a sauce. If you already have it, you jump straight to it. Otherwise
  Open Food Facts fills in the name and photo.
- **Household accounts.** Everyone gets private lists, ratings and photos.
- **Spreadsheet import.** Paste a table from Excel, Google Sheets or Numbers (or upload a CSV) and check it in a
  preview before anything is saved.
- **Yamtrack import**, nightly database snapshots, and JSON export.

---

### 1. Prepare a folder on the NAS

In **File Station**, create `docker/whatever-tracker` on `volume1`. That's `/volume1/docker/whatever-tracker`,
and it will hold the database, photos and backups.

Find your user and group IDs so the container writes files as you. SSH into the NAS and run:

```bash
id
```

You'll see something like `uid=1026(you) gid=100(users)`. Those are `PUID=1026` and `PGID=100`.

### 2. Create the stack in Portainer

1. **Stacks → Add stack**, name it `whatever-tracker`, and choose **Web editor**.
2. Paste in the contents of [`docker-compose.yml`](docker-compose.yml).
3. Under **Environment variables**, switch to **Advanced mode** and paste the variables from
   [`.env.example`](.env.example), filled in. At minimum you need `ORIGIN`, `PUID` and `PGID`.
   API keys can go here too, or you can add them later inside the app (see below).
4. Click **Deploy the stack**.
5. Open the container's **Logs**. You'll see a box with a **setup code**. You'll need it in a minute.

> **Trying it before the reverse proxy exists?** Temporarily set `ORIGIN=http://<nas-ip>:8765` and open that
> address. Switch `ORIGIN` to the HTTPS address once the proxy works, then redeploy. The camera and barcode
> scanner only work over HTTPS.

### 3. Point a reverse proxy at it

**Using DSM's built-in proxy:** go to **Control Panel → Login Portal → Advanced → Reverse Proxy → Create**.

|             | Protocol | Hostname                 | Port                      |
| ----------- | -------- | ------------------------ | ------------------------- |
| Source      | HTTPS    | `tracker.yourdomain.com` | 443                       |
| Destination | HTTP     | `localhost`              | `8765` (your `HOST_PORT`) |

Then give the hostname a certificate in **Control Panel → Security → Certificate** (Let's Encrypt works) and
assign it under **Settings**.

**Using Nginx Proxy Manager, Traefik or Caddy instead:** forward `tracker.yourdomain.com` to
`http://<nas-ip>:8765` with SSL enabled. Photo uploads can be up to 20 MB, so in NPM add
`client_max_body_size 25m;` under **Advanced**.

`ORIGIN` must be exactly the address you type in the browser, for example `https://tracker.yourdomain.com` with
no trailing slash. If it doesn't match, saving forms fails with "Cross-site POST form submissions are forbidden".

### 4. First sign-in

Open `https://tracker.yourdomain.com`. The app sends you to **/setup**. Enter the setup code from the logs and
create your admin account. Then pick your starting lists. To add household members, go to **Household** in the
sidebar (or **Me → Household** on a phone).

### Updating

GitHub builds a new `latest` image every time you push to `main`. To install it, go to Portainer → **Stacks →
whatever-tracker → Editor**, tick **Re-pull image**, and click **Update the stack**. Database changes are applied
automatically on startup. To pin a version instead, tag a release (`git tag v0.2.0 && git push --tags`) and set
`TAG=0.2.0`.

### Backups

Everything lives in the data folder:

- `tracker.db`: the database.
- `uploads/`: your photos.
- `backups/`: automatic nightly snapshots of the database, the last 7 kept. They're consistent copies, safe to
  take while the app runs.

Back up the whole folder with **Hyper Backup**. To restore, stop the stack, replace `tracker.db` with a snapshot
(renamed to `tracker.db`), and start the stack again.

---

## Metadata sources (API keys)

Every source is optional. A source with no key is simply left out of search.

**Entering keys in the app (admins):** go to **Me → Integrations**, click **Set up** (or **Change**) next to a
source, paste the key and click **Save & test**. The app tries the key right away:

- If the source rejects it, nothing is saved.
- If the source can't be reached (an outage, say), the key is saved and you're told the test didn't finish.

Keys saved in the app take priority over the ones in the Portainer stack. **Remove saved key** switches back to
the stack's value, or turns the source off if the stack has none. Saved keys live in the app's database on your
NAS (so they're in its backups too). After saving, the app only ever shows the last 4 characters.

**Or in the Portainer stack:** set the variables below and update the stack. Household members who aren't admins
can see which sources are connected, but can't view or change keys.

| Source            | Gives you                     | How to get access                                                                                                                      | Variables                                       |
| ----------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| TMDB              | Movies, TV shows              | Free account → [API settings](https://www.themoviedb.org/settings/api)                                                                 | `TMDB_API_KEY` (v3 key or v4 read token)        |
| IGDB              | Video games                   | [Twitch developer console](https://dev.twitch.tv/console/apps) → register an app                                                       | `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET`          |
| BoardGameGeek     | Board games                   | [Register an application](https://boardgamegeek.com/applications), then create a token. Approval is manual and can take a week or more | `BGG_API_TOKEN`                                 |
| MusicBrainz       | Artists, albums (+ cover art) | No key needed, just contact info                                                                                                       | `MUSICBRAINZ_CONTACT` (an email address or URL) |
| setlist.fm        | Concert setlists              | Free [API key](https://www.setlist.fm/settings/api)                                                                                    | `SETLISTFM_API_KEY`                             |
| Open Food Facts   | Barcode lookups               | Always on, no key                                                                                                                      | none                                            |
| Wikimedia, Deezer | Artist photos                 | Always on, no key. Used when adding a MusicBrainz artist                                                                               | none                                            |

Each list says what it holds under **List settings → Fill in details automatically** (Movies, TV shows, Music
artists…). The search bar only asks sources that one of your lists uses. For example, TV results appear only if a
list has **TV shows** ticked.

---

## Using it

- **Search:** tap Search, press `/`, or press `Ctrl+K`. Library hits come first, then each source as its results
  arrive. Tap a result to preview it, then choose the list, status and rating. The last row always offers
  "Create '<what you typed>' in…" for things no source knows about.
- **Adding something you've already done:** when you add an item with a finished status (Completed, Tasted, Seen,
  Played…), the form asks **When** (today by default) and saves that as the first entry in its history, with
  your rating. Clear the date to skip it. Planned statuses (Planning, Wishlist, Want to see…) don't ask.
- **Adding from a list:** in a list with a metadata source (TMDB for Movies and TV, IGDB, BoardGameGeek,
  MusicBrainz), the **Add** form looks the name up as you type. Pick a match and it saves the poster and details
  along with your rating and photos. Anything added without a match can get one later with **Find details on …**
  on its page.
- **Logs:** each log has a date, a rating for that time, a place, a price, notes, photos and the list's log
  fields. Logging something that was in a "planned" status (wishlist, to watch) moves it to the first "done"
  status automatically.
- **Concerts:** the item is the artist, and each show you attend is a log. Once setlist.fm is connected
  (**Me → Integrations**), any list with **Concert setlists** ticked under **List settings → Fill in details
  automatically → Extras** gets the lookup. That option appears once the list has **Music artists** ticked, and
  the Concerts template has both. To search for artists in the search bar, also connect MusicBrainz, which only
  needs an email address or URL as contact info.
  - **When adding the artist** (from search or the Add form): choose **Seen** and the date of the show. The show
    is saved right away, and if setlist.fm has it, the venue and full setlist come with it. On the rare day with
    more than one show, you're asked to pick yours.
  - **If setlist.fm doesn't have it yet:** the show is still saved with its date, and gets a **Find the setlist**
    button. Setlists usually appear within a few days of a show. **Check for updates** under a setlist re-fetches
    it once fans have filled in more songs.
  - **On the artist's page:** **Add log** for another show offers the same lookup, searchable by date or year,
    city and venue. To attach or change the show on an existing log, use its edit page.

  The newest show's setlist is shown open on the artist's page, split into its sets and encores. Artists added by
  hand (not from MusicBrainz) are looked up by name.

  Artists from MusicBrainz get a photo from Wikimedia Commons (via Wikidata), or from Deezer when Commons has
  none. For artists added before v0.2.6, open **About → Refresh details** on their page to fetch it.

- **Ratings:** everything is rated with a whole number from 1 to 10, on items and on each log. There are no
  half steps and no per-list scale, so ratings compare across lists. Tap a number to rate, tap **Clear** to
  remove it.
- **Lists:** **Manage lists** lets you rename lists, reorder them, pick an emoji and color, edit the statuses
  and their groups, choose what the list holds so details fill in automatically, and add or remove fields.
- **Spreadsheet import:** to bring in a table you already keep (a whiskey spreadsheet, say), open the list and
  tap the upload icon beside the settings gear (or **Me → Your data**, then pick the list). Select the cells in
  your spreadsheet **including the header row**, copy, and paste them in, or choose a CSV file. Only include the
  columns you want.
  - **Each column is matched to where it goes**, guessed from its header: the name, the list's own fields (a
    "Cost" column fills a Price field), status, rating, notes, tags, a photo link, or **Skip**. A column the
    list has no field for can become a new field (text, number, date, yes/no or link). Change any guess in the
    dropdown above the column.
  - **Ratings** like `2.5/5`, `8 out of 10`, `90%` or `★★★½` are converted to a whole number out of 10 (so `4.5/5`
    becomes 9). Text after the rating (`4.5/5  Really smooth`) goes into the item's notes.
  - **Status:** you say what each value means. By default a ✓ (or yes, x…) becomes the list's "done" status,
    like Tasted, Seen or Completed, and a blank cell becomes the first planned one, like Wishlist.
  - **Dates:** add a Date column and each row also gets a dated log, with Where, notes and the list's log fields
    (nose, palate…) if you map them.
  - **The preview** shows what every row will become, marks cells it couldn't use in red, and lets you untick
    rows. Nothing is saved until you press **Import**.
  - **Safe to repeat:** items are matched by name (ignoring case and punctuation), so importing an updated
    sheet updates what's there instead of duplicating it. Empty cells never erase anything, a blank status
    cell never downgrades an item, and the same date is never logged twice.
- **Yamtrack import:** in Yamtrack, export to CSV, then go to **Me → Import from Yamtrack**. You see a preview
  before anything is saved, and re-importing the same file doesn't create duplicates.

---

## Development

You need Node.js 24 or newer.

```bash
npm install
```

```bash
npm run dev
```

The dev server keeps its data in `./data`. Watch its console for the setup code. To enable sources locally, put
API keys in a `.env` file (see `.env.example`).

Other commands:

- `npm test`: unit tests (Vitest).
- `npm run check`: type check.
- `npm run build && node build`: run a production build locally.

Tech stack: SvelteKit 2, Svelte 5, Tailwind CSS 4 and SQLite (better-sqlite3 + Drizzle, FTS5 for search).
Images are processed with sharp. The server is a single Node process in one container.

Project layout:

- `src/lib/server/providers/`: one file per metadata source, all using the same `Provider` interface.
- `src/lib/server/services/`: lists, items, logs, images and tags. Every query is scoped to the signed-in user.
- `src/lib/server/import/yamtrack.ts`: the CSV importer.
- `src/lib/components/SearchOverlay.svelte`: the universal search.
- `drizzle/`: database migrations, applied automatically at startup.
