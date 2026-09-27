# Toilet Map → KMZ

[![downloads](https://img.shields.io/github/downloads/DigitallyRefined/toilet-map-to-kmz/total.svg)](https://github.com/DigitallyRefined/toilet-map-to-kmz/releases)

Download the [latest release](https://github.com/DigitallyRefined/toilet-map-to-kmz/releases) and use
with [Organic Maps app](https://organicmaps.app) via: **Open with Organic Maps** (Android) or
**Import with Organic Maps** (iOS), or *Bookmarks and Tracks ▸ Import Bookmarks and Tracks* to batch
import a folder. On desktop, see [QGIS](#qgis).

Releases contain a KMZ file which is the converted [Toilet Map](https://www.toiletmap.org.uk) dataset
of placemark bookmarks that any KML/KMZ app can read.

## Bookmark colours

| Category | Colour | Hex | KML style id |
| --- | --- | --- | --- |
| Free, gender/urinal restricted | Teal | `#00a58c` | `#placemark-teal` |
| Free, wheelchair accessible | Blue | `#0066cc` | `#placemark-blue` |
| Free | Green | `#3c8c3c` | `#placemark-green` |
| Not free, gender/urinal restricted | Orange | `#ff9600` | `#placemark-orange` |
| Not free, wheelchair accessible | Yellow | `#ffc800` | `#placemark-yellow` |
| Not free | Red | `#e51b23` | `#placemark-red` |

"Not free" means the dataset does not record the toilet as free, whether or not it lists payment
details. Within each group the order is restriction first, then accessibility, then the group default
(green or red) — so a men-only, wheelchair-accessible toilet is orange when paid and teal when free.
Facilities are always spelled out in the description, so nothing is lost to that priority.

"Restricted" means urinal-only, or explicitly single-gender (`men` true with `women` false, or the
reverse). An `all_gender` record is *not* restricted, so it takes the accessible or default colour,
though the `All gender toilet` line still appears in the description, and in the name where the
dataset has no name of its own.

## Running

```sh
node toilet-map-to-kmz.mjs
```

Requires Node.js LTS.

| Option | Description |
| --- | --- |
| `--out <file>` | KMZ output path (default: `toilets-<data date>.kmz`) |
| `--data-dir <dir>` | Cache directory for the JSON export (default: `data`) |
| `--force` | Re-download even when the cached copy is up to date |
| `--offline` | Never download, fail if the cached JSON is missing |
| `--limit <n>` | Only convert the first `n` toilets (debugging) |
| `--quiet` | Only print errors |
| `-h`, `--help` | Show usage |

## Output

`toilets-<data date>.kmz` is a standard KMZ: a stored `mimetype` entry followed by a deflated
`doc.kml` holding one `<Placemark>` per toilet as a `<Point>` in `longitude,latitude,0` order. The
`<Document>` is named after the KMZ file, and the attributes below are the whole vocabulary. They
are declared once in a `<Schema>`, as KML 2.2 requires, and written per placemark as
`SchemaData`/`SimpleData`; `category` is repeated in the older `Data`/`value` form too, for readers
that understand only that.

**Missing means "not recorded", not "no".** A field the dataset leaves `null` is left out of the
placemark, while the `<Schema>` still declares it, so readers keep the same columns: `accessible`
missing is unknown, `accessible` `false` is a recorded "no". Everything is text, so `true`/`false`
and timestamps are stored as strings.

## What a bookmark contains

**Name** — the toilet's own name, falling back to the area and restriction, e.g. `Public toilet
(Chelmsford)` or `Men only (Leeds)`.

**Description** — the area, the facilities (wheelchair access, baby change, children, attended,
automatic door, RADAR key), whether it is free or what payment it takes, the opening hours per
weekday, the submitted notes, and a link to the toilet's page on the site.

Records that are inactive, have no coordinates, or whose name or notes report a permanent closure are
skipped.

## Attributes

Every placemark carries the dataset's own fields that the record answers, plus `category` and the
usual KML `name` and `description`. The field names are the dataset's, unchanged, so they match
[the export](https://www.toiletmap.org.uk/dataset), and any of them may be absent.

| Attribute | Meaning | Values |
| --- | --- | --- |
| `id` | Toilet Map record id, the last part of the link in the description | text |
| `category` | The label from the colour table above; the field the QGIS helper styles on | one of the six labels |
| `name` | The facility's own name, which is often blank | text |
| `created_at`, `updated_at`, `verified_at` | When the record was created, last edited and last verified | ISO 8601 timestamp |
| `accessible` | Wheelchair accessible | `true`, `false` |
| `active` | Whether the facility is still open; always `true`, as closed ones are skipped | `true` |
| `attended` | Staffed | `true`, `false` |
| `automatic` | Automatic doors and self-cleaning cycles between use | `true`, `false` |
| `baby_change` | Baby changing facilities | `true`, `false` |
| `children` | Suitable for children | `true`, `false` |
| `men`, `women` | Single-gender facilities | `true`, `false` |
| `urinal_only` | Urinals only, no cubicles | `true`, `false` |
| `all_gender` | A facility for everyone, which is why it is not counted as restricted | `true`, `false` |
| `radar` | Needs a radar key or similar, usually issued for accessibility needs | `true`, `false` |
| `no_payment` | Free to use; this is what decides the free half of the colour scheme | `true`, `false` |
| `payment_details` | Free text about charges | text |
| `notes` | Free text notes | text |
| `opening_times` | Seven `[open, close]` pairs, Monday first, as compact JSON, e.g. `[["09:00","17:00"],…]` | JSON |
| `geohash` | The dataset's own geohash | text |
| `area_id` | Id of the area (town or district) the facility is in | text |

## Apps that can read the file

KMZ is an OGC standard, so most KML-capable apps open it. Bookmark apps keep the names, descriptions
and pin colours; GIS and mapping tools show them as point features on a layer.

### Mobile

| App | Platform | What to expect |
| --- | --- | --- |
| [Organic Maps](https://organicmaps.app) (recommended) | iOS, Android | The intended target: imports KMZ as bookmarks, keeping names, descriptions and pin colours |
| [Google Earth](https://support.google.com/earth/answer/15479344) | iOS, Android, web | Opens KML/KMZ directly; files with more than ~10,000 features load as a data layer rather than editable placemarks |
| [OsmAnd](https://osmand.net/docs/user/personal/import-export/) | iOS, Android | Accepts `.kml`/`.kmz` and converts them to GPX favourites/waypoints on import |
| [Gaia GPS](https://help.gaiagps.com/hc/en-us/articles/360052763513-Import-GPX-KML-KMZ-GeoJSON-or-FIT-Files-on-gaiagps-com) | iOS, Android, web | Imports KMZ waypoints (the archive contains a `.kml`); iOS/Android then sync them |
| [Locus Map](https://docs.locusmap.app/doku.php?id=manual:user_guide:items:import) | Android | KML and KMZ for both points and tracks |

### Desktop

| App | Platform | What to expect |
| --- | --- | --- |
| [QGIS](https://qgis.org) (recommended) | Windows, macOS, Linux | Point layer read through OGR, coloured by the `category` field with [the helper](#qgis) |
| [Google Earth Pro](https://earth.google.com/download/) | Windows, macOS, Linux | Opens the KMZ as a placemark folder; the reference implementation for KML |
| [MapDraw](https://www.mapdraw.net/) | Any browser | Imports and exports KML and KMZ, entirely in the browser with no upload |
| [uMap](https://umap.openstreetmap.fr/) | Any browser | Imports `.kml` (unzip the KMZ and use `doc.kml`), mapping name and description onto an OpenStreetMap layer |
| [GPSBabel](https://www.gpsbabel.org/) | Command line | Converts to other formats, e.g. `gpsbabel -i kml -f toilets-2026-09-27.kmz -o gpx -F toilets.gpx`; if your build refuses zip input, unzip the KMZ and point it at `doc.kml` |

### QGIS

Download the latest [KMZ](https://github.com/DigitallyRefined/toilet-map-to-kmz/releases) and
[apply-category-style.py](https://github.com/DigitallyRefined/toilet-map-to-kmz/raw/refs/heads/main/qgis/apply-category-style.py),
put them in the same directory, and in *Plugins ▸ Python Console* run:

```python
exec(open("[full path to]/apply-category-style.py").read())
```

### Unsupported apps

- **Garmin BaseCamp** — imports `.kml`/`.kmz` only as a KML Ground Overlay "Garmin Custom Map";
  placemarks are not turned into waypoints.
- **Mapy.com (Mapy.cz)** — GPX only, no KML/KMZ import.
- **Pocket Earth** — imports GPX and CSV, not KML.
- **Google My Maps** — accepts KMZ, but caps unzipped files at 5 MB (this one is larger) and drops
  parts of the KML, so use `gpsbabel` to convert to CSV or GeoJSON first.
- **Apple Maps and the Google Maps phone apps** — have no KML/KMZ import.

## AI generated code disclaimer

Some of the code in this repository may be generated with the assistance of AI tools. All changes are reviewed and tested on a real device with a human in the loop before being released.

## Data source

- Data: the [Toilet Map](https://www.toiletmap.org.uk) project, downloaded from the
  [dataset page](https://www.toiletmap.org.uk/dataset) and cached, re-downloading when the upstream
  export changes.
- Licence: Creative Commons Attribution 4.0 International (CC BY 4.0). This project is adapted,
  so please keep the attribution when you share the KMZ:

  > Contains data from the Toilet Map (c) 2025 – CC BY 4.0

  The attribution is also embedded in the KMZ's own `doc.kml` document description.

Coordinates are taken from the export as-is, so any misplaced or out-of-area pins come from the
upstream data, not from the conversion.
