# ICAO Runway Database

Precision GPS runway database for every airport — threshold coordinates, dimensions, surface type, and heading vectors. Designed for **touchdown location analysis** and **centerline deviation calculation** in flight simulation and real-world landing grading systems.

> Companion project to [icao-airport-database](https://github.com/MYTECHREVIEW/icao-airport-database)

---

## 📊 Coverage

- **50,000+ runway entries** across 30,000+ airports worldwide
- Source: [OurAirports](https://ourairports.com) `runways.csv` (Public Domain)
- Updated automatically every month via GitHub Actions

---

## 📁 Files

| File | Description |
|------|-------------|
| `data/runways.json` | Keyed by ICAO → array of runways per airport |
| `data/runways-flat.json` | Flat array of all runways (for range/bbox queries) |
| `data/runways.csv` | Full database in CSV format |
| `data/stats.json` | Build metadata and surface/type breakdown |

---

## 🗂 Schema

Each runway record:

```json
{
  "airport_icao": "KJFK",
  "le_ident": "04L",
  "he_ident": "22R",
  "length_ft": 14511,
  "length_m": 4423.1,
  "width_ft": 200,
  "width_m": 61.0,
  "surface": "asphalt",
  "lighted": true,
  "closed": false,
  "le_latitude": 40.6188,
  "le_longitude": -73.7488,
  "le_elevation_ft": 12,
  "le_heading_deg": 40.0,
  "le_displaced_threshold_ft": 0,
  "le_displaced_threshold_m": 0,
  "he_latitude": 40.6476,
  "he_longitude": -73.7761,
  "he_elevation_ft": 13,
  "he_heading_deg": 220.0,
  "he_displaced_threshold_ft": 0,
  "he_displaced_threshold_m": 0,
  "centerline_bearing_deg": 40.1
}
```

### Field Reference

| Field | Unit | Description |
|-------|------|-------------|
| `le_ident` / `he_ident` | — | Runway designators (e.g. `04L` / `22R`) |
| `length_ft` / `length_m` | ft / m | Full runway length |
| `width_ft` / `width_m` | ft / m | Runway width |
| `surface` | string | Normalized surface type |
| `le_latitude` / `le_longitude` | degrees | GPS coordinates of the **low-end threshold** |
| `he_latitude` / `he_longitude` | degrees | GPS coordinates of the **high-end threshold** |
| `le_heading_deg` / `he_heading_deg` | degrees | True magnetic heading for each landing direction |
| `le_displaced_threshold_ft` | ft | Displaced threshold offset from LE (affects TORA/LDA) |
| `centerline_bearing_deg` | degrees | GPS-computed bearing from LE → HE threshold |

---

## 🛬 Landing Math Utility

The `scripts/landing-math.js` module provides ready-to-use functions for touchdown and centerline analysis.

### Centerline Deviation

```js
const { centerlineDeviation } = require('./scripts/landing-math');

const runway = runways['KJFK'][0]; // 04L/22R
const result = centerlineDeviation(40.6310, -73.7572, runway, 'he'); // landing on 22R

// result.deviation_ft => -12.4  (12.4 ft LEFT of centerline)
// result.deviation_m  => -3.78
// result.side         => 'left'
```

### Touchdown Distance

```js
const { touchdownDistance } = require('./scripts/landing-math');

const td = touchdownDistance(40.6310, -73.7572, runway, 'he');
// td.distance_ft      => 987.2   (987 ft from 22R threshold)
// td.pct_runway_used  => 6.8     (6.8% of runway used at touchdown)
// td.remaining_ft     => 13523.8 (remaining runway)
// td.in_bounds        => true
```

### Touchdown Zone Classification

```js
const { touchdownZone } = require('./scripts/landing-math');

touchdownZone(987);   // { zone: 'TZ1', description: 'Touchdown Zone 1 (0–1,000 ft)' }
touchdownZone(1500);  // { zone: 'TZ2', description: 'Touchdown Zone 2 (1,000–2,000 ft)' }
```

### Full Analysis

```js
const { analyzeLanding } = require('./scripts/landing-math');

const result = analyzeLanding(40.6310, -73.7572, runway, 'he');
console.log(result.summary);
// "Landed on 22R: 987 ft from threshold, 12.4 ft left of centerline (TZ1)"
```

---

## 🚀 Usage

### Direct JSON (Raw GitHub)
```js
// Get all runways for an airport
const res = await fetch('https://raw.githubusercontent.com/MYTECHREVIEW/icao-runway-database/main/data/runways.json');
const runways = await res.json();
const kjfkRunways = runways['KJFK'];

// All runways flat
const flat = await fetch('https://raw.githubusercontent.com/MYTECHREVIEW/icao-runway-database/main/data/runways-flat.json');
const allRunways = await flat.json();
```

---

## 🔧 Build from Source

```bash
node scripts/build-db.js
```

Rebuilds all data files from the latest OurAirports upstream data.

---

## 📆 Auto-Update

The database is automatically rebuilt every month on the **1st at 02:00 UTC** via GitHub Actions. Only committed if data has changed.

---

## License
Source data: [OurAirports](https://ourairports.com) — Public Domain  
`landing-math.js` utility © MYTECHREVIEW — MIT License
