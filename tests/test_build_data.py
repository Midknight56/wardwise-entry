"""Run with python -m unittest tests.test_build_data."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from tools import build_data as builder


class DataBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='wardwise-data-test-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.path = Path(cls.temp.name) / 'chicago.json'
        result = subprocess.run(
            [sys.executable, str(builder.ROOT / 'tools/build_data.py'), '--output', str(cls.path)],
            cwd=builder.ROOT, capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise AssertionError(f'Build exited {result.returncode}:\n{result.stdout}\n{result.stderr}')
        cls.data = json.loads(cls.path.read_text())

    def test_contract_and_size(self):
        d = self.data
        self.assertEqual(set(d), {'city', 'election', 'viewBox', 'totals', 'wards', 'precincts',
                                  'backtestCrosswalk', 'repairedPolygons', 'builtAt'})
        self.assertEqual(d['city'], 'Chicago')
        self.assertEqual(d['election']['date'], '2027-02-23')
        self.assertEqual([w['id'] for w in d['wards']], list(range(1, 51)))
        self.assertLess(self.path.stat().st_size, 900_000)
        self.assertEqual(len(d['viewBox']), 4)
        for ward in d['wards']:
            self.assertEqual(set(ward), {'id', 'path', 'label', 'areaSqKm', 'population', 'adults', 'y2023', 'y2019'})
            self.assertGreater(ward['areaSqKm'], 0)
            self.assertGreater(ward['adults'], 0)
            self.assertLessEqual(ward['adults'], ward['population'])
            self.assertTrue(ward['path'].startswith('M') and ward['path'].endswith('Z'))
            for year in ('y2023', 'y2019'):
                t = ward[year]
                self.assertEqual(set(t), {'registered', 'ballots', 'topShare', 'secondShare'})
                self.assertLessEqual(t['ballots'], t['registered'])
                self.assertTrue(0 <= t['secondShare'] <= t['topShare'] <= 1)
                self.assertLessEqual(t['topShare'] + t['secondShare'], 1 + 1e-12)

    def test_city_and_ward_totals(self):
        expected = {'y2023': {'registered': 1581564, 'ballots': 566973},
                    'y2019': {'registered': 1581755, 'ballots': 560701}}
        self.assertEqual(self.data['totals'], expected)
        for year in expected:
            for field, total in expected[year].items():
                actual = sum(w[year][field] for w in self.data['wards'])
                if year == 'y2023':
                    self.assertEqual(actual, total)
                else:
                    self.assertLessEqual(actual, total)
                    self.assertGreaterEqual(actual, total*.99)
        for ward in self.data['wards']:
            precincts = [p for p in self.data['precincts'] if p['ward'] == ward['id']]
            for field in ('registered', 'ballots'):
                self.assertEqual(sum(p[field] for p in precincts), ward['y2023'][field])

    def test_every_source_file_reconciles_and_names_do_not_escape(self):
        names = []
        for path in sorted((builder.ROOT / 'data/raw').glob('*.xls')):
            mayor = 'mayor' in path.name
            with contextlib.redirect_stdout(io.StringIO()):
                precincts, totals, city, candidates = builder.read_election(path, mayor)
            names.extend(candidates)
            self.assertEqual(len(totals), 50)
            for index, count in enumerate(city):
                self.assertEqual(sum(v[index] for v in precincts.values()), count)
                for ward, total in totals.items():
                    self.assertEqual(sum(v[index] for (w, _), v in precincts.items() if w == ward), total[index])
        builder.validate_keys(self.data, names)
        serialized = self.path.read_text().casefold()
        for name in names:
            self.assertNotIn(name.casefold(), serialized)

    def test_polygon_coverage_and_precinct_uniqueness(self):
        polygons, _ = builder.load_shapes(builder.ROOT / 'data/raw', 'new')
        keys = [(p['ward'], p['precinct']) for p in self.data['precincts']]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertTrue(set(keys) <= set(polygons))
        for p in self.data['precincts']:
            self.assertEqual(set(p), {'ward', 'precinct', 'path', 'registered', 'ballots'})
            self.assertTrue(p['path'].startswith('M') and p['path'].endswith('Z'))

    def test_crosswalk_counts_and_registered_share(self):
        crosswalk = self.data['backtestCrosswalk']
        with contextlib.redirect_stdout(io.StringIO()):
            precincts, _, city, _ = builder.read_election(
                builder.ROOT / 'data/raw/cboe-2019-02-26-turnout-by-precinct.xls')
        wards, _ = builder.load_shapes(builder.ROOT / 'data/raw', 'wards')
        old, _ = builder.load_shapes(builder.ROOT / 'data/raw', 'old')
        matched, registered = 0, 0
        # Independently recompute membership without the builder's spatial index.
        for key, counts in precincts.items():
            if key in old and any(g.contains(old[key].representative_point()) for g in wards.values()):
                matched += 1
                registered += counts[0]
        self.assertEqual(crosswalk['precincts2019'], len(precincts))
        self.assertEqual(crosswalk['matched'], matched)
        self.assertEqual(crosswalk['unmatched'], len(precincts)-matched)
        self.assertAlmostEqual(crosswalk['registeredMatchedShare'], registered/city[0])
        self.assertGreaterEqual(crosswalk['registeredMatchedShare'], .99)
        self.assertEqual(sum(w['y2019']['registered'] for w in self.data['wards']), registered)

    def test_adult_counts_use_only_explicit_age_bands(self):
        rows = json.loads((builder.ROOT / 'data/raw/chicago-acs-5yr-by-ward-awnk-6fvc.json').read_text())
        expected = {builder.integer(row['ward']): (builder.integer(row['total_population']),
                                       sum(builder.integer(row[k]) for k in builder.AGE_KEYS)) for row in rows}
        for ward in self.data['wards']:
            self.assertEqual((ward['population'], ward['adults']), expected[ward['id']])


class ValidationFailureTests(unittest.TestCase):
    def fixture(self, mayor=False):
        header = ['Total Voters', 'Candidate One', '%', 'Candidate Two', '%'] if mayor else [
            'Registered Voters', 'Ballots Cast', 'Turnout']
        counts = [10, 6, 60, 4, 40] if mayor else [10, 4, 40]
        city = [500, 300, 60, 200, 40] if mayor else [500, 200, 40]
        rows = [header, city]
        for ward in range(1, 51):
            rows.extend([[f'Ward {ward}'], ['Precinct'] + header,
                         [1.0] + counts, ['Total'] + counts])
        return rows

    def read_fixture(self, rows, mayor=False):
        class Sheet:
            nrows = len(rows)
            def row_values(self, index):
                return rows[index]
        class Book:
            def sheet_by_index(self, index):
                return Sheet()
            def release_resources(self):
                pass
        with patch.object(builder.xlrd, 'open_workbook', return_value=Book()) as opened:
            result = builder.read_election(Path('fixture.xls'), mayor)
            opened.assert_called_once_with('fixture.xls', ignore_workbook_corruption=True)
            return result

    def test_good_fixture(self):
        self.assertEqual(self.read_fixture(self.fixture())[2], (500, 200))
        self.assertEqual(self.read_fixture(self.fixture(True), True)[2], (500, 300, 200))

    def test_city_total_votes_header_alias(self):
        rows = self.fixture(True)
        rows[0][0] = 'Total Votes'
        self.assertEqual(self.read_fixture(rows, True)[2], (500, 300, 200))

    def test_bad_ward_total(self):
        rows = self.fixture()
        rows[5][1] = 11
        with self.assertRaisesRegex(ValueError, 'ward 1 sum'):
            self.read_fixture(rows)

    def test_bad_city_total(self):
        rows = self.fixture()
        rows[1][0] = 501
        with self.assertRaisesRegex(ValueError, 'ward sums.*city'):
            self.read_fixture(rows)

    def test_missing_ward(self):
        with self.assertRaisesRegex(ValueError, 'exactly wards 1..50'):
            self.read_fixture(self.fixture()[:-4])

    def test_candidate_subtotal_mismatch(self):
        rows = self.fixture(True)
        rows[1][0] = 550
        for row in rows[2:]:
            if len(row) == 6 and row[0] != 'Precinct':
                row[1] = 11
        with self.assertRaisesRegex(ValueError, 'candidate sum'):
            self.read_fixture(rows, True)

    def test_forbidden_nested_keys(self):
        for key in (*builder.FORBIDDEN, 'Candidate One'):
            with self.assertRaisesRegex(ValueError, 'Forbidden output key'):
                builder.validate_keys({'wards': [{'prefix' + key.upper(): 1}]}, ['Candidate One'])

    def test_oversize_output_does_not_replace_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'data.json'
            path.write_text('original')
            with self.assertRaisesRegex(ValueError, 'byte limit'):
                builder.write_output({'path': 'x'*builder.MAX_BYTES}, path)
            self.assertEqual(path.read_text(), 'original')

    def test_load_shapes_repairs_bow_tie_polygon(self):
        feature = {'type': 'Feature', 'properties': {'ward': 1, 'precinct': 1},
                   'geometry': {'type': 'Polygon', 'coordinates': [[
                       [0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]]}}
        payload = {'type': 'FeatureCollection', 'features': [feature]}
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory)
            filename = builder.GEO_FILES['new'][0]
            (raw / filename).write_text(json.dumps(payload))
            polygons, repaired = builder.load_shapes(raw, 'new')
        self.assertEqual(repaired, 1)
        self.assertEqual(set(polygons), {(1, 1)})
        self.assertIn(polygons[(1, 1)].geom_type, ('Polygon', 'MultiPolygon'))
        self.assertGreater(polygons[(1, 1)].area, 0)

    def test_load_shapes_rejects_zero_area_polygon(self):
        feature = {'type': 'Feature', 'properties': {'ward': 1, 'precinct': 1},
                   'geometry': {'type': 'Polygon', 'coordinates': [[
                       [0, 0], [1, 0], [2, 0], [0, 0]]]}}
        payload = {'type': 'FeatureCollection', 'features': [feature]}
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory)
            filename = builder.GEO_FILES['new'][0]
            (raw / filename).write_text(json.dumps(payload))
            with self.assertRaisesRegex(ValueError, 'invalid polygon \(1, 1\)'):
                builder.load_shapes(raw, 'new')


if __name__ == '__main__':
    unittest.main()
