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
- **Yamtrack import**, nightly database snapshots, and JSON export.

---

## Deploying on a Synology NAS

The flow: GitHub builds the Docker image → Portainer pulls it onto the NAS → DSM's reverse proxy serves it over
HTTPS. It takes about 20 minutes the first time.

### 1. The code on GitHub

The code lives at [github.com/curtis9735/The-Whatever-Tracker](https://github.com/curtis9735/The-Whatever-Tracker).
Every push to `main` triggers the _Test and publish image_ workflow (repo → **Actions** tab). It runs the
tests, then builds the image for both Intel/AMD and ARM Synology models. The first run takes around 10 minutes.

### 2. Let the NAS pull the image

GitHub stores the image at `ghcr.io/curtis9735/the-whatever-tracker`. Container image names are always
lowercase. Because the repo is private, the image starts out private too. Pick one:

- **Simplest:** on GitHub open your profile → **Packages** → `the-whatever-tracker` → **Package settings** →
  **Change visibility → Public**. The image contains only the app, never your data or keys.
- **Keep it private:** create a classic personal access token with only the `read:packages` scope
  (GitHub → Settings → Developer settings → Personal access tokens). In Portainer go to **Registries → Add
  registry → Custom**, with URL `ghcr.io`, your GitHub username, and the token as the password.

### 3. Prepare a folder on the NAS

In **File Station**, create `docker/whatever-tracker` on `volume1`. That's `/volume1/docker/whatever-tracker`,
and it will hold the database, photos and backups.

Find your user and group IDs so the container writes files as you. SSH into the NAS and run:

```bash
id
```

You'll see something like `uid=1026(you) gid=100(users)`. Those are `PUID=1026` and `PGID=100`.

### 4. Create the stack in Portainer

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

### 5. Point a reverse proxy at it

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

### 6. First sign-in

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

| Source          | Gives you                     | How to get access                                                                                                                      | Variables                                       |
| --------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| TMDB            | Movies, TV shows              | Free account → [API settings](https://www.themoviedb.org/settings/api)                                                                 | `TMDB_API_KEY` (v3 key or v4 read token)        |
| IGDB            | Video games                   | [Twitch developer console](https://dev.twitch.tv/console/apps) → register an app                                                       | `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET`          |
| BoardGameGeek   | Board games                   | [Register an application](https://boardgamegeek.com/applications), then create a token. Approval is manual and can take a week or more | `BGG_API_TOKEN`                                 |
| MusicBrainz     | Artists, albums (+ cover art) | No key needed, just contact info                                                                                                       | `MUSICBRAINZ_CONTACT` (an email address or URL) |
| setlist.fm      | Concert setlists              | Free [API key](https://www.setlist.fm/settings/api)                                                                                    | `SETLISTFM_API_KEY`                             |
| Open Food Facts | Barcode lookups               | Always on, no key                                                                                                                      | none                                            |

Search only asks sources that match one of your lists. For example, TV results appear only if a list has
"TV show (TMDB)" ticked under **List settings → Metadata sources**.

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
  (**Me → Integrations**), any list with **Concert setlists (setlist.fm)** ticked under **List settings →
  Metadata sources → When logging** gets the lookup. The Concerts template has it ticked. To search for artists
  in the search bar, also connect MusicBrainz, which only needs an email address or URL as contact info.
  - **When adding the artist** (from search or the Add form): choose **Seen** and the date. You land on the
    artist's page with the show already looked up; if there was one show that day, it's picked automatically.
  - **On the artist's page:** **Add log** offers the same lookup, searchable by date or year, city and venue.
  - **For an existing log:** use its edit page to attach or change the show.

  Picking a show fills in the date, the venue and the full setlist. Artists added by hand (not from MusicBrainz)
  are looked up by name. Setlists usually appear on setlist.fm within a few days of a show.

- **Lists:** **Manage lists** lets you rename lists, reorder them, pick an emoji and color, choose a rating scale
  (5 stars with halves, 10 points or 100 points; existing ratings convert automatically), edit the statuses and
  their groups, choose metadata sources (for search, and setlist.fm for logging), and add or remove fields.
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
