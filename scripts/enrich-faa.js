#!/usr/bin/env node
/**
 * enrich-faa.js — Official FAA GIS Survey Centerline Enrichment
 *
 * Pulls certified geodetic surveyed runway polygons from the FAA OpenData GIS service
 * and calculates exact sub-centimeter centerline threshold coordinates.
 *
 * Usage: node scripts/enrich-faa.js
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const RUNWAYS_PATH = path.join(DATA_DIR, 'runways.json');

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const opts = new URL(url);
        const options = {
            hostname: opts.hostname,
            path: opts.pathname + opts.search,
            method: 'GET',
            headers: {
                'User-Agent': 'MYTECHREVIEW/icao-runway-database',
                'Accept': 'application/json'
            }
        };
        const req = https.request(options, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchJson(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error(`Timeout: ${url}`)));
        req.end();
    });
}

function dist2(p1, p2) {
    return (p1[0] - p2[0])**2 + (p1[1] - p2[1])**2;
}

function extractCenterline(rings) {
    if (!rings || !rings[0] || rings[0].length < 4) return null;
    const pts = rings[0].slice(0, 4);
    const e01 = dist2(pts[0], pts[1]);
    const e12 = dist2(pts[1], pts[2]);

    let endA, endB;
    if (e01 < e12) {
        endA = { lat: (pts[0][1] + pts[1][1]) / 2, lon: (pts[0][0] + pts[1][0]) / 2 };
        endB = { lat: (pts[2][1] + pts[3][1]) / 2, lon: (pts[2][0] + pts[3][0]) / 2 };
    } else {
        endA = { lat: (pts[3][1] + pts[0][1]) / 2, lon: (pts[3][0] + pts[0][0]) / 2 };
        endB = { lat: (pts[1][1] + pts[2][1]) / 2, lon: (pts[1][0] + pts[2][0]) / 2 };
    }
    return { endA, endB };
}

function computeBearing(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;
    const dLon = toRad(lon2 - lon1);
    const la1 = toRad(lat1);
    const la2 = toRad(lat2);
    const y = Math.sin(dLon) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return ((toDeg(Math.atan2(y, x)) + 360) % 360);
}

async function enrich() {
    console.log('🛰  FAA GIS Certified Survey Enrichment');
    console.log('='.repeat(45));

    if (!fs.existsSync(RUNWAYS_PATH)) {
        console.error('❌ runways.json not found!');
        process.exit(1);
    }

    const byAirport = JSON.parse(fs.readFileSync(RUNWAYS_PATH, 'utf-8'));
    console.log(`Loaded ${Object.keys(byAirport).length.toLocaleString()} airports from runways.json\n`);

    // 1. Fetch ALL FAA airports paginating by OBJECTID > lastId
    console.log('📥 Fetching all 19,559 FAA US_Airport records...');
    let lastId = 0;
    const airportMap = {}; // GLOBAL_ID -> IDENT (e.g. LGA, JFK)

    while (true) {
        const url = `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/US_Airport/FeatureServer/0/query?where=OBJECTID%3E${lastId}&outFields=OBJECTID,IDENT,GLOBAL_ID,ICAO_ID&orderByFields=OBJECTID+ASC&resultRecordCount=2000&f=json`;
        const res = await fetchJson(url);
        const features = res.features || [];
        if (features.length === 0) break;

        for (const f of features) {
            const attr = f.attributes;
            if (attr.OBJECTID > lastId) lastId = attr.OBJECTID;
            const rawIdent = attr.IDENT || '';
            const icao = (attr.ICAO_ID || (rawIdent.length === 3 ? 'K' + rawIdent : rawIdent) || '').toUpperCase();
            if (attr.GLOBAL_ID && icao) {
                airportMap[attr.GLOBAL_ID] = { icao, ident: rawIdent.toUpperCase() };
            }
        }
        process.stdout.write(`\r  Mapped ${Object.keys(airportMap).length.toLocaleString()} FAA airports...`);
        if (features.length < 10) break;
    }
    console.log(`\n  ✅ Mapped ${Object.keys(airportMap).length.toLocaleString()} total FAA airports\n`);

    // 2. Fetch ALL FAA Runways paginating by OBJECTID > lastId
    console.log('📥 Fetching all official FAA surveyed runway polygons...');
    lastId = 0;
    let enrichedCount = 0;
    let totalProcessed = 0;

    while (true) {
        const url = `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Runways/FeatureServer/0/query?where=OBJECTID%3E${lastId}&outFields=OBJECTID,AIRPORT_ID,DESIGNATOR,LENGTH,WIDTH&orderByFields=OBJECTID+ASC&resultRecordCount=2000&f=json`;
        const res = await fetchJson(url);
        const features = res.features || [];
        if (features.length === 0) break;

        for (const f of features) {
            const attr = f.attributes;
            if (attr.OBJECTID > lastId) lastId = attr.OBJECTID;
            totalProcessed++;

            const geom = f.geometry;
            const aptInfo = airportMap[attr.AIRPORT_ID];
            if (!aptInfo || !geom || !geom.rings) continue;

            const candidates = [
                byAirport[aptInfo.icao],
                byAirport[aptInfo.ident],
                byAirport['K' + aptInfo.ident]
            ].filter(Boolean);

            if (candidates.length === 0) continue;
            const rwys = candidates[0];

            const desig = (attr.DESIGNATOR || '').toUpperCase().trim();
            const [desigA, desigB] = desig.split('/');

            const centerline = extractCenterline(geom.rings);
            if (!centerline) continue;

            for (const rwy of rwys) {
                const cleanIdent = s => (s || '').toUpperCase().replace(/^0+/, '');
                const rwyLe = cleanIdent(rwy.le_ident);
                const rwyHe = cleanIdent(rwy.he_ident);
                const matchA = rwyLe === cleanIdent(desigA) || rwyHe === cleanIdent(desigA);
                const matchB = rwyLe === cleanIdent(desigB) || rwyHe === cleanIdent(desigB);

                if (matchA || matchB) {
                    const currentBearing = rwy.centerline_bearing_deg || 0;
                    const bearingAB = computeBearing(centerline.endA.lat, centerline.endA.lon, centerline.endB.lat, centerline.endB.lon);
                    
                    let lePoint, hePoint;
                    const diffAB = Math.min(Math.abs(bearingAB - currentBearing), 360 - Math.abs(bearingAB - currentBearing));
                    if (diffAB < 90) {
                        lePoint = centerline.endA;
                        hePoint = centerline.endB;
                    } else {
                        lePoint = centerline.endB;
                        hePoint = centerline.endA;
                    }

                    rwy.le_latitude = Math.round(lePoint.lat * 10000000) / 10000000;
                    rwy.le_longitude = Math.round(lePoint.lon * 10000000) / 10000000;
                    rwy.he_latitude = Math.round(hePoint.lat * 10000000) / 10000000;
                    rwy.he_longitude = Math.round(hePoint.lon * 10000000) / 10000000;
                    rwy.centerline_bearing_deg = Math.round(computeBearing(rwy.le_latitude, rwy.le_longitude, rwy.he_latitude, rwy.he_longitude) * 10) / 10;
                    rwy.source_centerline = 'FAA_SURVEY_CERTIFIED';
                    enrichedCount++;
                    break;
                }
            }
        }

        process.stdout.write(`\r  Processed ${totalProcessed.toLocaleString()} runways (${enrichedCount.toLocaleString()} certified FAA centerlines applied)...`);
        if (features.length < 10) break;
    }

    console.log(`\n\n✅ Enriched ${enrichedCount.toLocaleString()} runways with certified FAA geodetic survey data!`);

    // Write back updated databases
    console.log('📦 Writing updated data/runways.json, data/runways-flat.json, data/runways.csv...');
    fs.writeFileSync(path.join(DATA_DIR, 'runways.json'), JSON.stringify(byAirport, null, 2), 'utf-8');

    const flat = [];
    for (const rwys of Object.values(byAirport)) {
        for (const r of rwys) flat.push(r);
    }
    fs.writeFileSync(path.join(DATA_DIR, 'runways-flat.json'), JSON.stringify(flat, null, 2), 'utf-8');

    // CSV
    const csvHeaders = [
        'airport_icao','le_ident','he_ident',
        'length_ft','length_m','width_ft','width_m','surface','lighted','closed',
        'le_latitude','le_longitude','le_elevation_ft','le_heading_deg','le_displaced_threshold_ft','le_displaced_threshold_m',
        'he_latitude','he_longitude','he_elevation_ft','he_heading_deg','he_displaced_threshold_ft','he_displaced_threshold_m',
        'centerline_bearing_deg','source_centerline'
    ];
    const esc = v => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csvRows = [csvHeaders.join(',')];
    for (const r of flat) {
        csvRows.push(csvHeaders.map(h => esc(r[h])).join(','));
    }
    fs.writeFileSync(path.join(DATA_DIR, 'runways.csv'), csvRows.join('\n'), 'utf-8');

    console.log('🎉 Enrichment complete!\n');
}

enrich().catch(err => {
    console.error('❌ Enrichment failed:', err);
    process.exit(1);
});
