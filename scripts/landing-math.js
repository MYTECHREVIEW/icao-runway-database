/**
 * landing-math.js — Runway Landing Analysis Utilities
 *
 * Provides precise calculations for:
 *   - Touchdown distance from runway threshold
 *   - Centerline lateral deviation
 *   - Touchdown zone classification (TZ1/TZ2/TZ3)
 *   - Remaining runway after touchdown
 *
 * All calculations use the WGS-84 ellipsoid (standard GPS datum).
 * Works with runway records from the icao-runway-database.
 *
 * Usage (CommonJS):
 *   const { centerlineDeviation, touchdownDistance } = require('./landing-math');
 *
 * Usage (ESModule):
 *   import { centerlineDeviation, touchdownDistance } from './landing-math.js';
 */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6371000;        // Mean Earth radius in meters
const FT_PER_METER   = 3.28084;
const M_PER_FT       = 0.3048;
const RAD            = Math.PI / 180;
const DEG            = 180 / Math.PI;

// ── Core Haversine / Geodesic Helpers ────────────────────────────────────────

/**
 * Distance between two GPS points using the Haversine formula.
 * @param {number} lat1 - Point A latitude (degrees)
 * @param {number} lon1 - Point A longitude (degrees)
 * @param {number} lat2 - Point B latitude (degrees)
 * @param {number} lon2 - Point B longitude (degrees)
 * @returns {number} Distance in meters
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * True bearing from point A to point B (degrees, 0–360).
 */
function bearing(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * RAD;
    const la1  = lat1 * RAD;
    const la2  = lat2 * RAD;
    const y    = Math.sin(dLon) * Math.cos(la2);
    const x    = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * DEG) + 360) % 360;
}

/**
 * Cross-track distance (XTD) — lateral deviation from a great-circle path.
 *
 * Negative = left of centerline (from LE looking toward HE)
 * Positive = right of centerline
 *
 * @param {number} lat1   - Path start (LE threshold) latitude
 * @param {number} lon1   - Path start (LE threshold) longitude
 * @param {number} lat2   - Path end (HE threshold) latitude
 * @param {number} lon2   - Path end (HE threshold) longitude
 * @param {number} pLat   - Point latitude (touchdown GPS)
 * @param {number} pLon   - Point longitude (touchdown GPS)
 * @returns {number} Cross-track distance in meters (negative=left, positive=right)
 */
function crossTrackDistance(lat1, lon1, lat2, lon2, pLat, pLon) {
    const d13  = haversineDistance(lat1, lon1, pLat, pLon) / EARTH_RADIUS_M; // angular dist A→P
    const theta13 = bearing(lat1, lon1, pLat, pLon) * RAD;                  // bearing A→P
    const theta12 = bearing(lat1, lon1, lat2, lon2) * RAD;                  // bearing A→B (centerline)
    const xtd = Math.asin(Math.sin(d13) * Math.sin(theta13 - theta12));
    return xtd * EARTH_RADIUS_M; // meters
}

/**
 * Along-track distance — how far along the runway path the point projects.
 * i.e., distance from LE threshold to touchdown point projected onto centerline.
 *
 * @returns {number} Along-track distance in meters from LE threshold
 */
function alongTrackDistance(lat1, lon1, lat2, lon2, pLat, pLon) {
    const d13  = haversineDistance(lat1, lon1, pLat, pLon) / EARTH_RADIUS_M;
    const theta13 = bearing(lat1, lon1, pLat, pLon) * RAD;
    const theta12 = bearing(lat1, lon1, lat2, lon2) * RAD;
    const xtd  = Math.asin(Math.sin(d13) * Math.sin(theta13 - theta12));
    const atd  = Math.acos(Math.cos(d13) / Math.cos(xtd));
    return atd * EARTH_RADIUS_M; // meters
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Calculate lateral deviation of a point from the runway centerline.
 *
 * @param {number} lat      - Touchdown point latitude
 * @param {number} lon      - Touchdown point longitude
 * @param {object} runway   - Runway record from runways.json
 * @param {string} [landingEnd='le'] - Which end was used for landing ('le' or 'he')
 * @returns {{
 *   deviation_m: number,    // lateral deviation in meters (negative=left, positive=right)
 *   deviation_ft: number,   // lateral deviation in feet
 *   side: string            // 'left', 'right', or 'center'
 * }}
 */
function centerlineDeviation(lat, lon, runway, landingEnd = 'le') {
    const useLEasOrigin = landingEnd.toLowerCase() === 'le';

    const lat1 = useLEasOrigin ? runway.le_latitude  : runway.he_latitude;
    const lon1 = useLEasOrigin ? runway.le_longitude : runway.he_longitude;
    const lat2 = useLEasOrigin ? runway.he_latitude  : runway.le_latitude;
    const lon2 = useLEasOrigin ? runway.he_longitude : runway.le_longitude;

    if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) {
        return { deviation_m: null, deviation_ft: null, side: null, error: 'Missing threshold coordinates' };
    }

    const xtd_m  = crossTrackDistance(lat1, lon1, lat2, lon2, lat, lon);
    const xtd_ft = xtd_m * FT_PER_METER;

    // When landing toward HE (le→he direction), right side = positive
    // Flip sign if landing toward LE to keep left/right meaningful from pilot's perspective
    const sign   = useLEasOrigin ? 1 : -1;
    const dev_m  = xtd_m * sign;
    const dev_ft = xtd_ft * sign;

    return {
        deviation_m:  Math.round(dev_m * 100) / 100,
        deviation_ft: Math.round(dev_ft * 10) / 10,
        side: Math.abs(dev_m) < 0.5 ? 'center' : dev_m < 0 ? 'left' : 'right'
    };
}

/**
 * Calculate touchdown distance from the runway threshold.
 *
 * @param {number} lat      - Touchdown point latitude
 * @param {number} lon      - Touchdown point longitude
 * @param {object} runway   - Runway record from runways.json
 * @param {string} [landingEnd='le'] - Which end was used for landing ('le' or 'he')
 * @returns {{
 *   distance_m: number,         // distance from threshold in meters
 *   distance_ft: number,        // distance from threshold in feet
 *   pct_runway_used: number,    // percentage of runway used at touchdown (0-100)
 *   remaining_m: number,        // runway remaining after touchdown in meters
 *   remaining_ft: number,       // runway remaining after touchdown in feet
 *   in_bounds: boolean          // whether the touchdown was within the runway length
 * }}
 */
function touchdownDistance(lat, lon, runway, landingEnd = 'le') {
    const useLEasOrigin = landingEnd.toLowerCase() === 'le';

    // Apply displaced threshold offset to the effective threshold point
    const dt_m = (useLEasOrigin
        ? (runway.le_displaced_threshold_ft || 0)
        : (runway.he_displaced_threshold_ft || 0)) * M_PER_FT;

    const lat1 = useLEasOrigin ? runway.le_latitude  : runway.he_latitude;
    const lon1 = useLEasOrigin ? runway.le_longitude : runway.he_longitude;
    const lat2 = useLEasOrigin ? runway.he_latitude  : runway.le_latitude;
    const lon2 = useLEasOrigin ? runway.he_longitude : runway.le_longitude;

    if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) {
        return { distance_m: null, distance_ft: null, error: 'Missing threshold coordinates' };
    }

    const atd_m      = alongTrackDistance(lat1, lon1, lat2, lon2, lat, lon);
    const effective_m = atd_m - dt_m;                          // from effective threshold
    const total_m     = (runway.length_ft || 0) * M_PER_FT;
    const remaining_m = Math.max(0, total_m - atd_m);         // from physical LE
    const pct         = total_m > 0 ? (atd_m / total_m) * 100 : null;

    return {
        distance_m:       Math.round(effective_m * 10) / 10,
        distance_ft:      Math.round(effective_m * FT_PER_METER * 10) / 10,
        pct_runway_used:  pct !== null ? Math.round(pct * 10) / 10 : null,
        remaining_m:      Math.round(remaining_m * 10) / 10,
        remaining_ft:     Math.round(remaining_m * FT_PER_METER * 10) / 10,
        in_bounds:        effective_m >= 0 && atd_m <= total_m
    };
}

/**
 * Classify the touchdown into ICAO Touchdown Zone (TZ1/TZ2/TZ3).
 *
 * TZ1 — 0   to 1,000 ft from threshold (optimal)
 * TZ2 — 1,000 to 2,000 ft from threshold
 * TZ3 — 2,000 to 3,000 ft from threshold
 *
 * @param {number} distance_ft - Touchdown distance from threshold in feet
 * @returns {{ zone: string, description: string }}
 */
function touchdownZone(distance_ft) {
    if (distance_ft === null || distance_ft === undefined) {
        return { zone: 'UNKNOWN', description: 'No distance data' };
    }
    if (distance_ft < 0) {
        return { zone: 'BEFORE_THRESHOLD', description: 'Touchdown before threshold (undershoot)' };
    }
    if (distance_ft <= 1000) {
        return { zone: 'TZ1', description: 'Touchdown Zone 1 (0–1,000 ft)' };
    }
    if (distance_ft <= 2000) {
        return { zone: 'TZ2', description: 'Touchdown Zone 2 (1,000–2,000 ft)' };
    }
    if (distance_ft <= 3000) {
        return { zone: 'TZ3', description: 'Touchdown Zone 3 (2,000–3,000 ft)' };
    }
    return { zone: 'BEYOND_TZ', description: `Touchdown beyond TZ3 (${Math.round(distance_ft).toLocaleString()} ft from threshold)` };
}

/**
 * Full landing analysis — combines all metrics into one result object.
 *
 * @param {number} lat       - Touchdown GPS latitude
 * @param {number} lon       - Touchdown GPS longitude
 * @param {object} runway    - Runway record from runways.json
 * @param {string} [landingEnd='le'] - 'le' or 'he'
 * @returns {object} Complete landing analysis result
 *
 * @example
 * const rwy = runways['KJFK'][0]; // 04L/22R
 * const result = analyzeLanding(40.6310, -73.7572, rwy, 'he'); // landing on 22R
 * // result.centerline.deviation_ft => e.g. -12.4 (12.4 ft left)
 * // result.touchdown.distance_ft   => e.g. 987.2 (987 ft from 22R threshold)
 * // result.touchdown_zone.zone     => 'TZ1'
 */
function analyzeLanding(lat, lon, runway, landingEnd = 'le') {
    const cl  = centerlineDeviation(lat, lon, runway, landingEnd);
    const td  = touchdownDistance(lat, lon, runway, landingEnd);
    const tz  = touchdownZone(td.distance_ft);

    return {
        input: { lat, lon, landing_end: landingEnd.toUpperCase() },
        runway: {
            designator: landingEnd === 'le'
                ? (runway.le_ident || '?')
                : (runway.he_ident || '?'),
            length_ft: runway.length_ft,
            width_ft: runway.width_ft,
            surface: runway.surface
        },
        centerline: cl,
        touchdown: td,
        touchdown_zone: tz,
        summary: td.distance_ft !== null && cl.deviation_ft !== null
            ? `Landed on ${landingEnd === 'le' ? runway.le_ident : runway.he_ident}: ` +
              `${Math.round(td.distance_ft).toLocaleString()} ft from threshold, ` +
              `${Math.abs(cl.deviation_ft).toFixed(1)} ft ${cl.side} of centerline ` +
              `(${tz.zone})`
            : 'Insufficient runway coordinate data'
    };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
    haversineDistance,
    bearing,
    crossTrackDistance,
    alongTrackDistance,
    centerlineDeviation,
    touchdownDistance,
    touchdownZone,
    analyzeLanding
};

// ESModule-compatible named export hint for bundlers
if (typeof module !== 'undefined') {
    module.exports.default = module.exports;
}
