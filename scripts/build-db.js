#!/usr/bin/env node
/**
 * build-db.js — ICAO Runway Database Builder
 *
 * Source: OurAirports runways.csv (~50,000 runway entries)
 * https://davidmegginson.github.io/ourairports-data/runways.csv
 *
 * Output:
 *   data/runways.json       — Keyed by airport ICAO → array of runway objects
 *   data/runways-flat.json  — Flat array of all runways (for range/bbox queries)
 *   data/runways.csv        — Full CSV backup
 *   data/stats.json         — Build metadata and coverage stats
 *
 * Usage: node scripts/build-db.js
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ── HTTP Helper ──────────────────────────────────────────────────────────────

function fetchText(url) {
    return new Promise((resolve, reject) => {
        const opts = new URL(url);
        const options = {
            hostname: opts.hostname,
            path: opts.pathname + opts.search,
            method: 'GET',
            headers: {
                'User-Agent': 'MYTECHREVIEW/icao-runway-database (+https://github.com/MYTECHREVIEW/icao-runway-database)',
                'Accept': 'text/plain,*/*'
            }
        };
        const req = https.request(options, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchText(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        });
        req.on('error', reject);
        req.setTimeout(45000, () => req.destroy(new Error(`Timeout: ${url}`)));
        req.end();
    });
}

// ── CSV Parser ───────────────────────────────────────────────────────────────

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
            else { inQuotes = !inQuotes; }
        } else if (ch === ',' && !inQuotes) {
            result.push(current); current = '';
        } else {
            current += ch;
        }
    }
    result.push(current);
    return result;
}

// ── Surface Code Normalizer ──────────────────────────────────────────────────
// OurAirports uses codes like "ASPH-G", "CONC", "TURF", etc.

const SURFACE_MAP = {
    ASPH: 'asphalt',   ASP: 'asphalt',   A: 'asphalt',
    CONC: 'concrete',  CON: 'concrete',  C: 'concrete',
    TURF: 'turf',      GRAS: 'grass',    GRASS: 'grass',    G: 'grass',
    GRVL: 'gravel',    GRV: 'gravel',    GRAVEL: 'gravel',
    DIRT: 'dirt',      D: 'dirt',
    SAND: 'sand',
    WATER: 'water',    WAT: 'water',
    ICE: 'ice',
    SNOW: 'snow',
    CORAL: 'coral',
    CLAY: 'clay',
    OIL: 'oil treated',
    MATS: 'pierced steel planking',  PSP: 'pierced steel planking',
    BRICK: 'brick',    BRIK: 'brick',
    TARMAC: 'asphalt', TAR: 'asphalt',
    PAVED: 'paved',    PEM: 'paved',
    UNPAVED: 'unpaved', UNK: 'unknown',
    UNKNOWN: 'unknown'
};

function normalizeSurface(raw) {
    if (!raw || !raw.trim()) return 'unknown';
    // Strip qualifiers like "-G" (grooved), "-F" (fair), "-P" (poor) etc.
    const base = raw.trim().toUpperCase().split('-')[0].split('/')[0].trim();
    return SURFACE_MAP[base] || raw.trim().toLowerCase();
}

// ── Bearing Calculator ────────────────────────────────────────────────────────
// True bearing from point A (lat1, lon1) to point B (lat2, lon2) using Haversine

function computeBearing(lat1, lon1, lat2, lon2) {
    if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) return null;
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;
    const dLon = toRad(lon2 - lon1);
    const la1 = toRad(lat1);
    const la2 = toRad(lat2);
    const y = Math.sin(dLon) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return ((toDeg(Math.atan2(y, x)) + 360) % 360);
}

// ── ft ↔ m helpers ────────────────────────────────────────────────────────────

function ftToM(ft) {
    if (ft === null || ft === undefined || ft === '') return null;
    const v = parseFloat(ft);
    return isNaN(v) ? null : Math.round(v * 0.3048 * 10) / 10;
}

function parseNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : Math.round(n * 1000) / 1000;
}

function parseIntSafe(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
}

// ── Main ETL ─────────────────────────────────────────────────────────────────

async function build() {
    console.log('🛬  ICAO Runway Database Builder');
    console.log('='.repeat(45));
    console.log('Started:', new Date().toISOString(), '\n');

    // ── Download ──
    console.log('📥 Downloading OurAirports runways.csv ...');
    const RUNWAYS_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';
    let csvText;
    try {
        csvText = await fetchText(RUNWAYS_URL);
    } catch (e) {
        console.error('❌ Failed to download:', e.message);
        process.exit(1);
    }

    const lines = csvText.split('\n').filter(l => l.trim());
    const header = parseCSVLine(lines[0]).map(h => h.replace(/"/g, '').trim());
    const idx = {};
    header.forEach((h, i) => { idx[h] = i; });

    console.log(`  CSV columns: ${header.join(', ')}`);
    console.log(`  Total rows (incl. header): ${lines.length.toLocaleString()}\n`);

    // ── Parse ──
    const byAirport = {};   // { ICAO: [ runway, ... ] }
    const flat = [];
    let skipped = 0;

    for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        const airport = (cols[idx['airport_ident']] || '').replace(/"/g, '').trim().toUpperCase();
        if (!airport) { skipped++; continue; }

        const leIdent = (cols[idx['le_ident']] || '').replace(/"/g, '').trim();
        const heIdent = (cols[idx['he_ident']] || '').replace(/"/g, '').trim();
        const lengthFt = parseIntSafe(cols[idx['length_ft']]);
        const widthFt  = parseIntSafe(cols[idx['width_ft']]);
        const surface  = normalizeSurface((cols[idx['surface']] || '').replace(/"/g, ''));
        const lighted  = parseInt(cols[idx['lighted']] || 0) === 1;
        const closed   = parseInt(cols[idx['closed']] || 0) === 1;

        const leLat  = parseNum(cols[idx['le_latitude_deg']]);
        const leLon  = parseNum(cols[idx['le_longitude_deg']]);
        const leElev = parseIntSafe(cols[idx['le_elevation_ft']]);
        const leHdg  = parseNum(cols[idx['le_heading_degT']]);
        const leDT   = parseIntSafe(cols[idx['le_displaced_threshold_ft']]);

        const heLat  = parseNum(cols[idx['he_latitude_deg']]);
        const heLon  = parseNum(cols[idx['he_longitude_deg']]);
        const heElev = parseIntSafe(cols[idx['he_elevation_ft']]);
        const heHdg  = parseNum(cols[idx['he_heading_degT']]);
        const heDT   = parseIntSafe(cols[idx['he_displaced_threshold_ft']]);

        // Compute GPS-based centerline bearing (LE → HE)
        const centerlineBearing = computeBearing(leLat, leLon, heLat, heLon);

        const rwy = {
            airport_icao: airport,
            le_ident: leIdent || null,
            he_ident: heIdent || null,
            length_ft: lengthFt,
            length_m: ftToM(lengthFt),
            width_ft: widthFt,
            width_m: ftToM(widthFt),
            surface,
            lighted,
            closed,
            // Low-end threshold
            le_latitude: leLat,
            le_longitude: leLon,
            le_elevation_ft: leElev,
            le_heading_deg: leHdg,
            le_displaced_threshold_ft: leDT || 0,
            le_displaced_threshold_m: ftToM(leDT || 0),
            // High-end threshold
            he_latitude: heLat,
            he_longitude: heLon,
            he_elevation_ft: heElev,
            he_heading_deg: heHdg,
            he_displaced_threshold_ft: heDT || 0,
            he_displaced_threshold_m: ftToM(heDT || 0),
            // Computed
            centerline_bearing_deg: centerlineBearing !== null
                ? Math.round(centerlineBearing * 10) / 10
                : null
        };

        if (!byAirport[airport]) byAirport[airport] = [];
        byAirport[airport].push(rwy);
        flat.push(rwy);
    }

    const airportCount = Object.keys(byAirport).length;
    const runwayCount  = flat.length;
    console.log(`✅ Parsed ${runwayCount.toLocaleString()} runway entries across ${airportCount.toLocaleString()} airports`);
    if (skipped) console.log(`   Skipped ${skipped} rows (missing airport ICAO)`);

    // ── Stats ──
    const byType = {};
    const bySurface = {};
    for (const rwy of flat) {
        bySurface[rwy.surface] = (bySurface[rwy.surface] || 0) + 1;
        if (rwy.closed) byType.closed = (byType.closed || 0) + 1;
        else if (rwy.lighted) byType.lighted = (byType.lighted || 0) + 1;
        else byType.unlighted = (byType.unlighted || 0) + 1;
    }

    // ── Write outputs ──
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    console.log('\n📦 Writing data/runways.json ...');
    fs.writeFileSync(
        path.join(DATA_DIR, 'runways.json'),
        JSON.stringify(byAirport, null, 2),
        'utf-8'
    );

    console.log('📦 Writing data/runways-flat.json ...');
    fs.writeFileSync(
        path.join(DATA_DIR, 'runways-flat.json'),
        JSON.stringify(flat, null, 2),
        'utf-8'
    );

    console.log('📦 Writing data/runways.csv ...');
    const csvHeaders = [
        'airport_icao','le_ident','he_ident',
        'length_ft','length_m','width_ft','width_m','surface','lighted','closed',
        'le_latitude','le_longitude','le_elevation_ft','le_heading_deg','le_displaced_threshold_ft','le_displaced_threshold_m',
        'he_latitude','he_longitude','he_elevation_ft','he_heading_deg','he_displaced_threshold_ft','he_displaced_threshold_m',
        'centerline_bearing_deg'
    ];
    const esc = v => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return (s.includes(',') || s.includes('"') || s.includes('\n'))
            ? '"' + s.replace(/"/g, '""') + '"'
            : s;
    };
    const csvRows = [csvHeaders.join(',')];
    for (const r of flat) {
        csvRows.push(csvHeaders.map(h => esc(r[h])).join(','));
    }
    fs.writeFileSync(path.join(DATA_DIR, 'runways.csv'), csvRows.join('\n'), 'utf-8');

    const stats = {
        total_runways: runwayCount,
        total_airports_with_runways: airportCount,
        by_surface: bySurface,
        by_type: byType,
        built_at: new Date().toISOString(),
        source: 'https://davidmegginson.github.io/ourairports-data/runways.csv'
    };
    fs.writeFileSync(path.join(DATA_DIR, 'stats.json'), JSON.stringify(stats, null, 2), 'utf-8');

    const jsonMB = (fs.statSync(path.join(DATA_DIR, 'runways.json')).size / 1024 / 1024).toFixed(1);
    console.log('\n📊 Build Stats:');
    console.log(`   Total runway entries : ${runwayCount.toLocaleString()}`);
    console.log(`   Airports with runways: ${airportCount.toLocaleString()}`);
    console.log(`   runways.json size    : ${jsonMB} MB`);
    console.log('\n   By surface (top 10):');
    Object.entries(bySurface)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .forEach(([s, c]) => console.log(`     ${s.padEnd(20)} ${c.toLocaleString()}`));
    console.log('\n✅ Done!', new Date().toISOString());
}

build().catch(err => { console.error('❌', err); process.exit(1); });
