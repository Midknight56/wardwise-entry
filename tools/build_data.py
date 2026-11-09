"""Build the public, aggregate-only Chicago dataset. Python 3.14.

Usage: python tools/build_data.py [--raw-dir data/raw] [--output PATH]
Requires xlrd and shapely. No candidate identities or demographic categories
other than population and adult age bands leave this process.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import sys
import urllib.request

try:
    import xlrd
    from shapely.geometry import shape
    from shapely import make_valid
    from shapely.ops import transform, unary_union
    from shapely.strtree import STRtree
except ModuleNotFoundError as error:
    raise SystemExit(f'Data build requires xlrd and shapely: {error}. '
                     'Install with: python -m pip install xlrd shapely') from None

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 900_000
FORBIDDEN = ('white', 'black', 'asian', 'hispanic', 'latino', 'race')
AGE_KEYS = tuple(f'{sex}_{age}' for sex in ('male', 'female')
                 for age in ('18_to_24', '25_to_34', '35_to_49', '50_to_64', '65'))
GEO_FILES = {
    'wards': ('chicago-wards-2023-p293-wvbd.geojson', 'p293-wvbd'),
    'new': ('chicago-precincts-2023-2024-6piy-vbxa.geojson', '6piy-vbxa'),
    'old': ('chicago-precincts-2013-2022-nvke-umup.geojson', 'nvke-umup'),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def integer(value):
    number = float(str(value).replace(',', '').strip())
    require(math.isfinite(number) and number >= 0 and number.is_integer(),
            f'Expected a nonnegative integer, got {value!r}')
    return int(number)


def read_election(path, mayor=False):
    """Parse each printed block and reconcile every count column, not percentages."""
    book = xlrd.open_workbook(str(path), ignore_workbook_corruption=True)
    try:
        sheet = book.sheet_by_index(0)
        rows = [sheet.row_values(i) for i in range(sheet.nrows)]
        rows = [r for r in rows if any(str(v).strip() for v in r)]
        header = [str(v).strip() for v in rows[0]]
        columns = ([i for i in range(1, len(header)) if header[i] and header[i] != '%']
                   if mayor else [0, 1])
        # City block omits the precinct column present in ward blocks.
        if mayor and header[0] in ('Total Voters', 'Total Votes'):
            columns = [0] + columns
        columns = [i for i in columns if header[i] not in ('Turnout', '%')]
        city = tuple(integer(rows[1][i]) for i in columns)
        names = tuple(header[i] for i in columns[1:]) if mayor else ()
        precincts, totals = {}, {}
        ward = None
        ward_columns = None
        for row in rows[2:]:
            first = str(row[0]).strip()
            match = re.fullmatch(r'Ward\s+(\d+)', first, re.IGNORECASE)
            if match:
                ward = int(match[1])
                ward_columns = None
            elif first == 'Precinct':
                ward_header = [str(v).strip() for v in row]
                ward_columns = ([i for i in range(1, len(row))
                                 if ward_header[i] and ward_header[i] != '%']
                                if mayor else [1, 2])
                # The Board calls the city subtotal "Total Votes" and the
                # corresponding ward column "Total Voters".
                offset = 1 if mayor else 0
                require(tuple(ward_header[i] for i in ward_columns[offset:]) ==
                        tuple(header[i] for i in columns[offset:]),
                        f'{path.name}: inconsistent headers')
            elif first.lower() == 'total':
                require(ward is not None and ward_columns is not None,
                        f'{path.name}: Total without ward/header')
                require(ward not in totals, f'{path.name}: duplicate ward Total {ward}')
                totals[ward] = tuple(integer(row[i]) for i in ward_columns)
            elif first and ward_columns is not None:
                try:
                    precinct = integer(row[0])
                except (ValueError, TypeError):
                    raise ValueError(f'{path.name}: unexpected row {row[0]!r}') from None
                key = (ward, precinct)
                require(key not in precincts, f'{path.name}: duplicate precinct {key}')
                precincts[key] = tuple(integer(row[i]) for i in ward_columns)
        require(set(totals) == set(range(1, 51)), f'{path.name}: expected exactly wards 1..50')
        for ward, total in totals.items():
            summed = tuple(sum(v[i] for (w, _), v in precincts.items() if w == ward)
                           for i in range(len(city)))
            require(summed == total, f'{path.name}: ward {ward} sum {summed} != Total {total}')
        summed = tuple(sum(v[i] for v in totals.values()) for i in range(len(city)))
        require(summed == city, f'{path.name}: ward sums {summed} != city {city}')
        if mayor:
            for key, counts in precincts.items():
                require(counts[0] == sum(counts[1:]),
                        f'{path.name}: candidate sum differs from Total Voters at {key}')
        return precincts, totals, city, names
    finally:
        book.release_resources()


def load_shapes(raw, kind):
    filename, dataset = GEO_FILES[kind]
    path = raw / filename
    if not path.exists():
        # Keep downloaded caches within this job's allowed tools/ directory.
        path = ROOT / 'tools' / 'cache' / filename
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            url = f'https://data.cityofchicago.org/api/geospatial/{dataset}?method=export&format=GeoJSON'
            print(f'Downloading {url}', file=sys.stderr)
            with urllib.request.urlopen(url, timeout=120) as response:
                payload = response.read()
            json.loads(payload)
            path.write_bytes(payload)
    grouped = defaultdict(list)
    repaired = 0
    for feature in json.loads(path.read_text(encoding='utf-8'))['features']:
        props = feature['properties']
        ward = integer(props['ward'])
        key = ward if kind == 'wards' else (ward, integer(props['precinct']))
        geom = shape(feature['geometry'])
        if not geom.is_valid:
            geom = make_valid(geom)
            repaired += 1
            polygons = []
            if geom.geom_type == 'Polygon':
                polygons = [geom]
            elif geom.geom_type == 'MultiPolygon':
                polygons = list(geom.geoms)
            elif hasattr(geom, 'geoms'):
                polygons = [part for part in geom.geoms
                            if part.geom_type in ('Polygon', 'MultiPolygon')]
            if polygons:
                geom = unary_union(polygons)
        require(not geom.is_empty and geom.is_valid and geom.area > 0 and
                geom.geom_type in ('Polygon', 'MultiPolygon'),
                f'{filename}: invalid polygon {key}')
        grouped[key].append(geom)
    return ({key: unary_union(parts) for key, parts in grouped.items()}, repaired)


def equal_area(x, y, z=None):
    """Spherical Lambert azimuthal equal area, metres, centred on Chicago."""
    lon, lat = math.radians(x + 87.63), math.radians(y)
    phi = math.radians(41.84)
    k = math.sqrt(2 / (1 + math.sin(phi)*math.sin(lat) +
                       math.cos(phi)*math.cos(lat)*math.cos(lon)))
    return (6371008.8*k*math.cos(lat)*math.sin(lon),
            6371008.8*k*(math.cos(phi)*math.sin(lat) - math.sin(phi)*math.cos(lat)*math.cos(lon)))


def make_svg(wards):
    cosine = math.cos(math.radians(41.84))
    bounds = unary_union(list(wards.values())).bounds
    left, top = bounds[0]*cosine, -bounds[3]
    scale = 1000 / ((bounds[2]-bounds[0])*cosine)

    def point(x, y):
        return [round((x*cosine-left)*scale, 1), round((-y-top)*scale, 1)]

    def path(geom, tolerance):
        geom = geom.simplify(tolerance, preserve_topology=True)
        polygons = [geom] if geom.geom_type == 'Polygon' else geom.geoms
        pieces = []
        for polygon in polygons:
            for ring in [polygon.exterior, *polygon.interiors]:
                coordinates = [point(x, y) for x, y in list(ring.coords)[:-1]]
                pieces.append('M' + 'L'.join(f'{x:.1f},{y:.1f}' for x, y in coordinates) + 'Z')
        return ''.join(pieces)
    return point, path, [0, 0, 1000, math.ceil((bounds[3]-bounds[1])*scale*10)/10]


def validate_keys(value, names=()):
    forbidden = (*FORBIDDEN, *(name.casefold() for name in names))
    if isinstance(value, dict):
        for key, item in value.items():
            require(not any(word in key.casefold() for word in forbidden),
                    f'Forbidden output key: {key}')
            validate_keys(item, names)
    elif isinstance(value, list):
        for item in value:
            validate_keys(item, names)


def shares(counts):
    total = sum(counts)
    require(total > 0, 'Ward has no valid mayor votes')
    top = sorted(counts, reverse=True)
    return {'topShare': top[0]/total, 'secondShare': top[1]/total}


def build(raw):
    t23, wt23, city23, _ = read_election(raw / 'cboe-2023-02-28-turnout-by-precinct.xls')
    t19, _, city19, _ = read_election(raw / 'cboe-2019-02-26-turnout-by-precinct.xls')
    m23, _, _, names23 = read_election(raw / 'cboe-2023-02-28-mayor-by-precinct.xls', True)
    ma, _, _, namesa = read_election(raw / 'cboe-2019-02-26-mayor-1-7-by-precinct.xls', True)
    mb, _, _, namesb = read_election(raw / 'cboe-2019-02-26-mayor-8-14-by-precinct.xls', True)
    require(set(t23) == set(m23), '2023 turnout/mayor precinct sets differ')
    require(set(t19) == set(ma) == set(mb), '2019 turnout/mayor precinct sets differ')
    loaded_shapes = {kind: load_shapes(raw, kind) for kind in ('wards', 'new', 'old')}
    wards, new, old = (loaded_shapes[kind][0] for kind in ('wards', 'new', 'old'))
    repaired_polygons = {Path(GEO_FILES[kind][0]).stem: loaded_shapes[kind][1]
                         for kind in ('wards', 'new', 'old')}
    require(set(wards) == set(range(1, 51)), 'Expected exactly 50 ward polygons, ids 1..50')
    misses = sorted(set(t23)-set(new))
    require(not misses, f'2023 result precincts missing polygons: {misses}')
    ids = sorted(wards)
    tree = STRtree([wards[w] for w in ids])
    counts19 = {w: [0, 0] for w in ids}
    votes19 = {w: [0]*14 for w in ids}
    votes23 = {w: [0]*len(names23) for w in ids}
    matched = 0
    unmatched = []
    for key, counts in t19.items():
        candidates = []
        if key in old:
            point = old[key].representative_point()
            candidates = [ids[int(i)] for i in tree.query(point)
                          if wards[ids[int(i)]].contains(point)]
        require(len(candidates) <= 1, f'2019 precinct {key} maps to multiple wards: {candidates}')
        if not candidates:
            unmatched.append(key)
            continue
        ward = candidates[0]
        matched += 1
        counts19[ward] = [a+b for a, b in zip(counts19[ward], counts)]
        votes = ma[key][1:] + mb[key][1:]
        require(len(votes) == 14, 'Expected 14 mayor vote columns in 2019')
        votes19[ward] = [a+b for a, b in zip(votes19[ward], votes)]
    registered_share = sum(v[0] for v in counts19.values()) / city19[0]
    require(registered_share >= .99,
            f'2019 crosswalk matched {registered_share:.4%} registered voters; unmatched: {unmatched}')
    for (ward, _), counts in m23.items():
        votes23[ward] = [a+b for a, b in zip(votes23[ward], counts[1:])]
    acs = {}
    for row in json.loads((raw / 'chicago-acs-5yr-by-ward-awnk-6fvc.json').read_text()):
        ward = integer(row['ward'])
        require(ward not in acs, f'Duplicate ACS ward {ward}')
        acs[ward] = (integer(row['total_population']), sum(integer(row[k]) for k in AGE_KEYS))
    require(set(acs) == set(ids), 'ACS must contain exactly wards 1..50')
    point, path, viewbox = make_svg(wards)
    output_wards = []
    for ward in ids:
        geom = wards[ward]
        label = geom.simplify(.0002, preserve_topology=True).representative_point()
        population, adults = acs[ward]
        require(0 < adults <= population, f'Invalid ACS population for ward {ward}')
        output_wards.append({
            'id': ward, 'path': path(geom, .0002), 'label': point(label.x, label.y),
            'areaSqKm': round(transform(equal_area, geom).area/1e6, 6),
            'population': population, 'adults': adults,
            'y2023': dict(zip(('registered', 'ballots'), wt23[ward])) | shares(votes23[ward]),
            'y2019': dict(zip(('registered', 'ballots'), counts19[ward])) | shares(votes19[ward]),
        })
    result = {
        'city': 'Chicago',
        'election': {'name': 'Municipal General Election', 'date': '2027-02-23',
                     'source': 'https://chicagoelections.gov/getting-ballot/election-calendar'},
        'viewBox': viewbox,
        'totals': {year: dict(zip(('registered', 'ballots'), counts))
                   for year, counts in (('y2023', city23), ('y2019', city19))},
        'wards': output_wards,
        'precincts': [{'ward': w, 'precinct': p, 'path': path(new[w, p], .0003),
                       'registered': counts[0], 'ballots': counts[1]}
                      for (w, p), counts in sorted(t23.items())],
        'backtestCrosswalk': {'precincts2019': len(t19), 'matched': matched,
                              'unmatched': len(unmatched), 'registeredMatchedShare': registered_share},
        'repairedPolygons': repaired_polygons,
        'builtAt': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
    }
    validate_keys(result, names23 + namesa + namesb)
    if unmatched:
        print(f'Unmatched 2019 precincts: {unmatched}', file=sys.stderr)
    return result


def write_output(data, destination):
    payload = json.dumps(data, separators=(',', ':'), allow_nan=False).encode('utf-8')
    require(len(payload) < MAX_BYTES, f'Output {len(payload):,} bytes exceeds {MAX_BYTES:,} byte limit')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + '.tmp')
    try:
        temporary.write_bytes(payload)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return len(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw-dir', type=Path, default=ROOT / 'data' / 'raw')
    parser.add_argument('--output', type=Path, default=ROOT / 'public' / 'data' / 'chicago.json')
    args = parser.parse_args()
    try:
        data = build(args.raw_dir)
        size = write_output(data, args.output)
    except (ValueError, OSError, KeyError, xlrd.XLRDError) as error:
        parser.exit(1, f'Data build failed: {error}\n')
    print('Ward  2023 registered / ballots  2019 registered / ballots (crosswalk)')
    for ward in data['wards']:
        a, b = ward['y2023'], ward['y2019']
        print(f"{ward['id']:>4}  {a['registered']:>10,} / {a['ballots']:>7,}  {b['registered']:>10,} / {b['ballots']:>7,}")
    print('Printed city totals:', data['totals'])
    print('Ward sums:', {y: {k: sum(w[y][k] for w in data['wards']) for k in ('registered', 'ballots')}
                         for y in ('y2023', 'y2019')})
    print('Crosswalk:', data['backtestCrosswalk'])
    print('Repaired polygons:', data['repairedPolygons'])
    print(f'File size: {size:,} bytes ({size/1000:.1f} KB)')
    for title, key in [('Most 2023 non voters', lambda w: -(w['y2023']['registered']-w['y2023']['ballots'])),
                       ('Lowest 2023 turnout', lambda w: w['y2023']['ballots']/w['y2023']['registered'])]:
        print(title + ':')
        for w in sorted(data['wards'], key=lambda w: (key(w), w['id']))[:5]:
            t = w['y2023']
            print(f"  Ward {w['id']}: {t['registered']-t['ballots']:,} non voters, {t['ballots']/t['registered']:.2%} turnout")


if __name__ == '__main__':
    main()
