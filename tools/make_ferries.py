"""Build public/data/ferries.json: the next three weeks of scheduled ferry crossings from the
operators' own open timetables (GTFS files on transport.data.gouv.fr, Licence Ouverte 2.0).

Run by .github/workflows/ferries.yml every week. Timetables are kept apart from live AIS:
the page shows them as "timetable", never as a ship's position.

    python3 tools/make_ferries.py [out.json]
"""
import csv
import io
import json
import sys
import urllib.request
import zipfile
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

FEEDS = [
    ('Brittany Ferries', 'https://www.data.gouv.fr/api/1/datasets/r/2b1461b3-da9c-42ad-92b9-ea78b198ff0c',
     'https://www.data.gouv.fr/datasets/horaires-des-traversees-brittany-ferries'),
    ('DFDS (Dieppe–Newhaven)', 'https://transport.data.gouv.fr/resources/83981/download',
     'https://transport.data.gouv.fr/datasets/transmanche-ferries'),
    ('Corsica Linea', 'https://www.data.gouv.fr/api/1/datasets/r/13977931-86ae-4b7a-9598-d222333a5fbd',
     'https://transport.data.gouv.fr/datasets/programme-des-rotations-corsica-linea'),
    ('Corsica Ferries', 'https://www.data.gouv.fr/api/1/datasets/r/b95d6838-1143-4653-840f-eebc33c16fa7',
     'https://transport.data.gouv.fr/datasets/programme-des-rotations-corsica-ferries'),
]
DAYS = 21


def rows(z, name):
    names = {n.split('/')[-1]: n for n in z.namelist()}
    if name not in names:
        return []
    text = z.read(names[name]).decode('utf-8-sig', errors='replace')
    return list(csv.DictReader(io.StringIO(text)))


def service_days(z, start, end):
    """service_id -> set of dates it runs between start and end."""
    days = {}
    for r in rows(z, 'calendar.txt'):
        a = datetime.strptime(r['start_date'], '%Y%m%d').date()
        b = datetime.strptime(r['end_date'], '%Y%m%d').date()
        week = [r[k] == '1' for k in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')]
        d = max(a, start)
        while d <= min(b, end):
            if week[d.weekday()]:
                days.setdefault(r['service_id'], set()).add(d)
            d += timedelta(days=1)
    for r in rows(z, 'calendar_dates.txt'):
        d = datetime.strptime(r['date'], '%Y%m%d').date()
        if not start <= d <= end:
            continue
        s = days.setdefault(r['service_id'], set())
        if r['exception_type'] == '1':
            s.add(d)
        else:
            s.discard(d)
    return days


def seconds(t):
    h, m, s = (int(x) for x in t.strip().split(':'))
    return h * 3600 + m * 60 + s


def build(feeds, today):
    end = today + timedelta(days=DAYS)
    ports, sailings, sources = {}, [], []
    for op, (name, url, page) in enumerate(feeds):
        req = urllib.request.Request(url, headers={'User-Agent': 'ship-track (github.com/danielromer-droid/ship-track)'})
        try:
            z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(req, timeout=60).read()))
        except Exception as err:  # one feed down should not stop the others
            print(f'{name}: {err}', file=sys.stderr)
            continue
        tz = ZoneInfo((rows(z, 'agency.txt') or [{}])[0].get('agency_timezone') or 'Europe/Paris')
        stops = {}
        for s in rows(z, 'stops.txt'):
            try:
                lat, lon = float(s['stop_lat']), float(s['stop_lon'])
            except (KeyError, ValueError):
                continue
            key = f'{op}:{s["stop_id"]}'
            stops[s['stop_id']] = key
            ports[key] = [s.get('stop_name', '').strip(), round(lat, 4), round(lon, 4)]
        routes = {r['route_id']: (r.get('route_long_name') or r.get('route_short_name') or '').strip() for r in rows(z, 'routes.txt')}
        days = service_days(z, today, end)
        calls = {}
        for st in rows(z, 'stop_times.txt'):
            calls.setdefault(st['trip_id'], []).append(st)
        n = 0
        for trip in rows(z, 'trips.txt'):
            seq = sorted(calls.get(trip['trip_id'], []), key=lambda c: int(c['stop_sequence']))
            if len(seq) < 2 or trip['service_id'] not in days:
                continue
            a, b = seq[0], seq[-1]
            if a['stop_id'] not in stops or b['stop_id'] not in stops:
                continue
            dep_s, arr_s = seconds(a['departure_time'] or a['arrival_time']), seconds(b['arrival_time'] or b['departure_time'])
            for d in days[trip['service_id']]:
                # GTFS times count from noon minus 12 h of the service day, in the agency's time zone.
                noon = datetime(d.year, d.month, d.day, 12, tzinfo=tz) - timedelta(hours=12)
                dep, arr = noon + timedelta(seconds=dep_s), noon + timedelta(seconds=arr_s)
                sailings.append([op, stops[a['stop_id']], stops[b['stop_id']],
                                 int(dep.timestamp() // 60), int(arr.timestamp() // 60), routes.get(trip['route_id'], '')])
                n += 1
        sources.append({'operator': name, 'page': page, 'licence': 'Licence Ouverte 2.0', 'sailings': n})
        print(f'{name}: {len(stops)} ports, {n} sailings', file=sys.stderr)
    sailings.sort(key=lambda s: s[3])
    used = {s[1] for s in sailings} | {s[2] for s in sailings}
    return {
        'built': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
        'note': 'Scheduled crossings from operators’ published timetables. Times are minutes since 1970 (UTC).',
        'operators': [f[0] for f in feeds],
        'sources': sources,
        'ports': {k: v for k, v in ports.items() if k in used},
        'sailings': sailings,
    }


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'public/data/ferries.json'
    data = build(FEEDS, date.today())
    if not data['sailings']:
        sys.exit('no sailings found, keeping the old file')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
