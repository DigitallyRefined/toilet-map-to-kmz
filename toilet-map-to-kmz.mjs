#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const [major] = process.versions.node.split(".").map(Number);
if (major < 18) {
  console.error(
    `Error: Node.js 18 or newer is required (found ${process.versions.node})`,
  );
  process.exit(1);
}

const DATASET_PAGE_URL = "https://www.toiletmap.org.uk/dataset";
const PLACES_URL = "https://www.toiletmap.org.uk/loos";
const DEFAULT_DATA_DIR = "data";
const DEFAULT_KML_NAME = "doc.kml";
const KMZ_MIMETYPE = "application/vnd.google-earth.kmz";
const ATTRIBUTION =
  "Contains data from the Toilet Map \u00a9 2025 \u2013 CC BY 4.0 \u2013 https://www.toiletmap.org.uk/dataset";
const DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const FREE_PALETTE = { restricted: "teal", accessible: "blue", other: "green" };
const PAID_PALETTE = {
  restricted: "orange",
  accessible: "yellow",
  other: "red",
};
const PLACEMARK_COLOURS = {
  red: "e51b23",
  orange: "ff9600",
  yellow: "ffc800",
  teal: "00a58c",
  blue: "0066cc",
  green: "3c8c3c",
};
const CATEGORY_LABELS = {
  teal: "Free, gender/urinal restricted",
  blue: "Free, wheelchair accessible",
  green: "Free",
  orange: "Not free, gender/urinal restricted",
  yellow: "Not free, wheelchair accessible",
  red: "Not free",
};
const CATEGORY_ORDER = [
  ...Object.values(FREE_PALETTE),
  ...Object.values(PAID_PALETTE),
];
const CATEGORY_FIELD = "category";
const PERMANENTLY_CLOSED =
  /(?<!\bor |temporary\/\s*)\bperm[aei]n[ae]nt(?:ly)?\b[\s\-–—:,/]*\bclos(?:ure|e[sd]?|ing)\b|\bclos(?:ure|e[sd]?|ing)\b[\s\-–—:,/]*\bperm[aei]n[ae]nt(?:ly)?\b/i;
const ATTRIBUTE_FIELDS = [
  "id",
  "created_at",
  "accessible",
  "active",
  "attended",
  "automatic",
  "baby_change",
  "men",
  "name",
  "no_payment",
  "notes",
  "payment_details",
  "radar",
  "women",
  "updated_at",
  "urinal_only",
  "all_gender",
  "children",
  "geohash",
  "verified_at",
  "area_id",
  "opening_times",
];
const KML_SCHEMA_ID = "ToiletMapAttributesId";
const KML_SCHEMA_NAME = "ToiletMapAttributes";

const USAGE = `Usage: node toilet-map-to-kmz.mjs [options]

Downloads the latest Toilet Map export (when it is newer than the cached copy)
and converts it into a KMZ of placemark bookmarks readable by KML/KMZ apps.

Options:
  --out <file>        KMZ output path (default: toilets-<data date>.kmz)
  --data-dir <dir>    Cache directory for the JSON export (default: data)
  --force             Re-download even when the cached copy is up to date
  --offline           Never download, fail if the cached JSON is missing
  --limit <n>         Only convert the first n toilets (debugging)
  --quiet             Only print errors
  -h, --help          Show this help
`;

function parseArgs(argv) {
  const options = {
    out: null,
    dataDir: DEFAULT_DATA_DIR,
    force: false,
    offline: false,
    limit: Infinity,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "--out":
        options.out = next();
        break;
      case "--data-dir":
        options.dataDir = next();
        break;
      case "--force":
        options.force = true;
        break;
      case "--offline":
        options.offline = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--limit": {
        const value = Number.parseInt(next(), 10);
        if (!Number.isInteger(value) || value <= 0)
          throw new Error("--limit expects a positive integer");
        options.limit = value;
        break;
      }
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function makeLogger(quiet) {
  return {
    log: (...args) => {
      if (!quiet) console.log(...args);
    },
  };
}

function parseDatasetPage(html) {
  const nextData = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (nextData) {
    const parsed = JSON.parse(nextData[1]);
    const listing = parsed?.props?.pageProps?.fileListing;
    if (Array.isArray(listing) && listing.length) {
      const json =
        listing.find((entry) => entry.type === "json") ??
        listing.find((entry) => String(entry.pathname).endsWith(".json"));
      if (json?.downloadUrl) return json;
    }
  }
  const href = html.match(/href="(https:\/\/[^"]*?\.json\?download=1)"/);
  if (href)
    return {
      downloadUrl: href[1].replace(/&amp;/g, "&"),
      pathname: decodeURIComponent(new URL(href[1]).pathname.split("/").pop()),
    };
  throw new Error("Could not find a JSON export link on the dataset page");
}

async function fetchLatestExport() {
  const response = await fetch(DATASET_PAGE_URL, {
    headers: {
      "user-agent": "toilet-map-to-kmz/1.0 (+https://www.toiletmap.org.uk)",
    },
  });
  if (!response.ok)
    throw new Error(
      `Dataset page request failed: ${response.status} ${response.statusText}`,
    );
  return parseDatasetPage(await response.text());
}

function isoDateFromListing(listing) {
  const match = String(listing.lastUpdated ?? "").match(
    /(\d{2})\/(\d{2})\/(\d{4})/,
  );
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

async function readState(statePath) {
  try {
    return JSON.parse(await fsp.readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function fileSize(filePath) {
  try {
    return (await fsp.stat(filePath)).size;
  } catch {
    return null;
  }
}

async function isCacheFresh(statePath, jsonPath, latest) {
  const state = await readState(statePath);
  if (!state || state.pathname !== latest.pathname) return false;
  if (
    state.downloadUrl &&
    latest.downloadUrl &&
    state.downloadUrl !== latest.downloadUrl
  )
    return false;
  if (latest.size != null && state.size != null && latest.size !== state.size)
    return false;
  const size = await fileSize(jsonPath);
  if (size == null) return false;
  return latest.size == null ? true : size === latest.size;
}

async function downloadJson(latest, jsonPath, log) {
  const response = await fetch(latest.downloadUrl, {
    headers: {
      "user-agent": "toilet-map-to-kmz/1.0 (+https://www.toiletmap.org.uk)",
    },
  });
  if (!response.ok)
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`,
    );
  const total =
    Number(response.headers.get("content-length")) || latest.size || 0;
  const live = Boolean(process.stdout.isTTY);
  let read = 0;
  let lastPercent = -1;
  if (!live) log.log(`  downloading ${path.basename(jsonPath)}...`);
  const progress = new Transform({
    transform(chunk, encoding, callback) {
      read += chunk.length;
      if (live && total) {
        const percent = Math.floor((read / total) * 100);
        if (percent !== lastPercent) {
          lastPercent = percent;
          process.stdout.write(
            `\r  downloading... ${percent}% (${bytesLabel(read)} of ${bytesLabel(total)})   `,
          );
        }
      }
      callback(null, chunk);
    },
  });
  const tmpPath = `${jsonPath}.part`;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      progress,
      fs.createWriteStream(tmpPath),
    );
  } catch (error) {
    await fsp.rm(tmpPath, { force: true });
    throw error;
  }
  if (live) process.stdout.write("\r" + " ".repeat(60) + "\r");
  const size = await fileSize(tmpPath);
  if (size == null) {
    await fsp.rm(tmpPath, { force: true });
    throw new Error("Download produced no data");
  }
  if (total && size !== total) {
    await fsp.rm(tmpPath, { force: true });
    throw new Error(`Downloaded ${size} bytes but expected ${total}`);
  }
  if (latest.size != null && size !== latest.size) {
    await fsp.rm(tmpPath, { force: true });
    throw new Error(
      `Downloaded ${size} bytes but the dataset page reports ${latest.size}`,
    );
  }
  await fsp.rename(tmpPath, jsonPath);
  return size;
}

async function pruneOldExports(dataDir, keepName, log) {
  for (const entry of await fsp.readdir(dataDir)) {
    if (
      entry === keepName ||
      !entry.endsWith(".json") ||
      entry === "state.json"
    )
      continue;
    await fsp.rm(path.join(dataDir, entry), { force: true });
    log.log(`  removed stale export ${entry}`);
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function trimStrings(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(trimStrings);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, trimStrings(item)]),
    );
  return value;
}

function genderLabels(record) {
  const labels = [];
  if (record.all_gender === true) labels.push("All gender toilet");
  if (record.urinal_only === true) labels.push("Urinal only");
  else if (record.men === true && record.women === false)
    labels.push("Men only");
  else if (record.women === true && record.men === false)
    labels.push("Women only");
  return labels;
}

function isGenderRestricted(record) {
  if (record.all_gender === true) return false;
  return genderLabels(record).length > 0;
}

function amenityLines(record) {
  const lines = [...genderLabels(record)];
  const facilities = [];
  if (record.accessible === true) facilities.push("Wheelchair accessible");
  if (record.accessible === false) facilities.push("Not wheelchair accessible");
  if (record.baby_change) facilities.push("Baby changing");
  if (record.children) facilities.push("Children");
  if (record.attended) facilities.push("Attended");
  if (record.automatic) facilities.push("Automatic door");
  if (record.radar) facilities.push("RADAR key toilet");
  if (facilities.length) lines.push(facilities.join(", "));
  if (record.no_payment) lines.push("Free to use");
  if (
    !record.no_payment &&
    record.payment_details &&
    !/no charge|free|£0|0£/i.test(record.payment_details)
  )
    lines.push(`Payment: ${String(record.payment_details).trim()}`);
  return lines;
}

function openingTimesLines(openingTimes) {
  if (!Array.isArray(openingTimes) || !openingTimes.length) return [];
  const days = [];
  openingTimes.slice(0, DAY_NAMES.length).forEach((slot, index) => {
    if (!Array.isArray(slot) || slot.length < 2) return;
    const [open, close] = slot;
    if (!open && !close) return;
    days.push(
      `${DAY_NAMES[index][0]}${DAY_NAMES[index].slice(1).toLowerCase()}: ${open || "open"}-${close || "closed"}`,
    );
  });
  if (!days.length) return [];
  return [`Opening times: ${days.join(", ")}`];
}

function buildDescription(record) {
  const lines = [];
  const area = record.areas?.name;
  if (area) lines.push(area);
  lines.push(...amenityLines(record));
  lines.push(...openingTimesLines(record.opening_times));
  if (record.notes) lines.push(String(record.notes).trim());
  lines.push(record.id ? `${PLACES_URL}/${record.id}` : DATASET_PAGE_URL);
  return lines.filter(Boolean).join("\n");
}

function buildName(record) {
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name) return name;
  const area = record.areas?.name?.trim();
  const [label] = genderLabels(record);
  if (label) return area ? `${label} (${area})` : label;
  return area ? `Public toilet (${area})` : "Public toilet";
}

function kmlColorFromRgb(hex) {
  const value = hex.replace("#", "");
  const red = value.slice(0, 2);
  const green = value.slice(2, 4);
  const blue = value.slice(4, 6);
  return `ff${blue}${green}${red}`;
}

function attributeValue(record, field) {
  const value = record[field];
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value) || typeof value === "object")
    return JSON.stringify(value);
  return String(value);
}

function styleForRecord(record) {
  const palette = record.no_payment === true ? FREE_PALETTE : PAID_PALETTE;
  if (isGenderRestricted(record)) return palette.restricted;
  if (record.accessible === true) return palette.accessible;
  return palette.other;
}

function isPlacemarkable(record) {
  if (!record || typeof record !== "object") return false;
  if (record.active === false) return false;
  const coordinates = record.location?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return false;
  const [longitude, latitude] = coordinates;
  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

function isPermanentlyClosed(record) {
  const name = typeof record.name === "string" ? record.name : "";
  const notes = record.notes ? String(record.notes) : "";
  return PERMANENTLY_CLOSED.test(name) || PERMANENTLY_CLOSED.test(notes);
}

function formatCoordinate(value) {
  return Number(value.toFixed(6)).toString();
}

function buildColourKey(usedStyles) {
  const styles = CATEGORY_ORDER.filter(
    (style) => !usedStyles || usedStyles.has(style),
  );
  const rows = styles.map(
    (style) =>
      `${style[0].toUpperCase()}${style.slice(1)}: ${CATEGORY_LABELS[style]}`,
  );
  if (!rows.length) return "";
  return ["Colour key:", ...rows].join("\n");
}

function buildDocumentDescription(meta, usedStyles) {
  return [
    `${ATTRIBUTION}. ${meta.placeCount} toilets, exported ${meta.lastUpdated}.`,
    buildColourKey(usedStyles),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildKml(records, meta) {
  const usedStyles = new Set();
  const placemarks = records.map((record) => {
    const [longitude, latitude] = record.location.coordinates;
    const style = styleForRecord(record);
    usedStyles.add(style);
    const parts = ["    <Placemark>"];
    parts.push(`      <name>${escapeXml(buildName(record))}</name>`);
    const description = buildDescription(record);
    if (description)
      parts.push(`      <description>${escapeXml(description)}</description>`);
    parts.push(`      <styleUrl>#placemark-${style}</styleUrl>`);
    const attributes = { [CATEGORY_FIELD]: CATEGORY_LABELS[style] };
    for (const field of ATTRIBUTE_FIELDS) {
      const value = attributeValue(record, field);
      if (value !== "") attributes[field] = value;
    }
    parts.push("      <ExtendedData>");
    parts.push(`        <Data name="${CATEGORY_FIELD}">`);
    parts.push(
      `          <value>${escapeXml(attributes[CATEGORY_FIELD])}</value>`,
    );
    parts.push("        </Data>");
    parts.push(`        <SchemaData schemaUrl="#${KML_SCHEMA_ID}">`);
    for (const [field, value] of Object.entries(attributes)) {
      parts.push(
        `          <SimpleData name="${field}">${escapeXml(value)}</SimpleData>`,
      );
    }
    parts.push("        </SchemaData>");
    parts.push("      </ExtendedData>");
    parts.push(
      `      <Point><coordinates>${formatCoordinate(longitude)},${formatCoordinate(latitude)},0</coordinates></Point>`,
    );
    parts.push("    </Placemark>");
    return parts.join("\n");
  });

  const styles = [...usedStyles]
    .sort()
    .map((style) =>
      [
        `    <Style id="placemark-${style}">`,
        "      <IconStyle>",
        `        <color>${kmlColorFromRgb(PLACEMARK_COLOURS[style])}</color>`,
        "      </IconStyle>",
        "    </Style>",
      ].join("\n"),
    );

  const header = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    "  <Document>",
    `    <name>${escapeXml(meta.layerName)}</name>`,
    `    <description>${escapeXml(buildDocumentDescription(meta, usedStyles))}</description>`,
    `    <ExtendedData>`,
    `      <Schema name="${KML_SCHEMA_NAME}" id="${KML_SCHEMA_ID}">`,
    `        <SimpleField type="string" name="${CATEGORY_FIELD}">`,
    "          <displayName>Category</displayName>",
    "        </SimpleField>",
    ...ATTRIBUTE_FIELDS.map(
      (field) =>
        `        <SimpleField type="string" name="${field}"></SimpleField>`,
    ),
    "      </Schema>",
    "    </ExtendedData>",
  ];

  return [
    ...header,
    ...styles,
    ...placemarks,
    "  </Document>",
    "</kml>",
    "",
  ].join("\n");
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++)
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, "utf8");
    const deflated = entry.store ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const method = entry.store ? 0 : 8;
    const { time, date } = dosDateTime(entry.date);
    const checksum = crc32(raw);
    const flags = 0x0800;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(deflated.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    chunks.push(localHeader, nameBuffer, deflated);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x031e, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(deflated.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + deflated.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

function bytesLabel(bytes) {
  return bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

function displayPath(filePath) {
  const relative = path.relative(process.cwd(), filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const log = makeLogger(options.quiet);
  const dataDir = path.resolve(options.dataDir);
  const statePath = path.join(dataDir, "state.json");
  await fsp.mkdir(dataDir, { recursive: true });

  let latest = null;
  let jsonPath;
  if (options.offline) {
    const state = await readState(statePath);
    if (!state)
      throw new Error(
        "No cached export found in " + dataDir + " and --offline was requested",
      );
    latest = state;
    jsonPath = path.join(dataDir, path.basename(state.pathname));
    log.log(
      `Using cached export ${path.basename(jsonPath)} (${state.lastUpdated})`,
    );
  } else {
    latest = await fetchLatestExport();
    jsonPath = path.join(dataDir, path.basename(latest.pathname));
    log.log(
      `Latest export: ${latest.pathname} (${latest.lastUpdated}, ${bytesLabel(latest.size ?? 0)})`,
    );

    if (!options.force && (await isCacheFresh(statePath, jsonPath, latest))) {
      log.log("Cached copy is already up to date, skipping download");
    } else {
      const size = await downloadJson(latest, jsonPath, log);
      log.log(`  saved ${displayPath(jsonPath)} (${bytesLabel(size)})`);
      await fsp.writeFile(
        statePath,
        `${JSON.stringify({ pathname: latest.pathname, size, downloadUrl: latest.downloadUrl, lastUpdated: latest.lastUpdated ?? null, downloadedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      await pruneOldExports(dataDir, path.basename(jsonPath), log);
    }
  }

  if ((await fileSize(jsonPath)) == null)
    throw new Error("Cached export is missing: " + jsonPath);

  const raw = await fsp.readFile(jsonPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Cached export is not valid JSON: ${error.message}`);
  }
  const all = (Array.isArray(parsed) ? parsed : (parsed.features ?? [])).map(
    trimStrings,
  );
  const usable = all.filter(isPlacemarkable);
  const open = usable.filter((record) => !isPermanentlyClosed(record));
  const records = open.slice(
    0,
    options.limit === Infinity ? undefined : options.limit,
  );
  const skipped = all.length - usable.length;
  const closed = usable.length - open.length;
  log.log(
    `Toilets in export: ${all.length.toLocaleString()}${skipped ? ` (${skipped.toLocaleString()} skipped: inactive or no coordinates)` : ""}${closed ? ` (${closed.toLocaleString()} skipped: reported permanently closed)` : ""}`,
  );

  const kmzPath = path.resolve(
    options.out ?? `toilets-${isoDateFromListing(latest) ?? "latest"}.kmz`,
  );
  const layerName = path.basename(kmzPath, path.extname(kmzPath));
  const kml = buildKml(records, {
    placeCount: records.length,
    lastUpdated: latest.lastUpdated ?? "unknown date",
    layerName,
  });
  const zip = buildZip([
    { name: "mimetype", data: KMZ_MIMETYPE, store: true, date: new Date() },
    { name: DEFAULT_KML_NAME, data: kml, date: new Date() },
  ]);
  await fsp.mkdir(path.dirname(kmzPath), { recursive: true });
  await fsp.writeFile(kmzPath, zip);

  const freeCount = records.filter(
    (record) => record.no_payment === true,
  ).length;
  const paidCount = records.length - freeCount;
  log.log(
    `Wrote ${displayPath(kmzPath)} with ${freeCount.toLocaleString()} free, ${paidCount.toLocaleString()} paid, ${records.length.toLocaleString()} total placemarks (${bytesLabel(zip.length)})`,
  );

  const staleQmlPath = kmzPath.replace(/\.kmz$/i, "") + ".qml";
  if (fs.existsSync(staleQmlPath)) {
    await fsp.rm(staleQmlPath);
    log.log(
      `Removed ${displayPath(staleQmlPath)} (QGIS styles are no longer generated)`,
    );
  }

  log.log("Open the KMZ with an app that reads KML/KMZ bookmarks.");
  log.log(
    `QGIS: run qgis/apply-category-style.py to add the file and colour it by ${CATEGORY_FIELD}.`,
  );
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
