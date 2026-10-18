#!/usr/bin/env python3
"""Build the two data files the map uses to draw a ship's route to its destination.

public/data/ports.json  UN/LOCODE seaports: {"GB": {"SOU": ["Southampton", lat, lon] or ["Southampton"]}}
public/data/sea.json    a world shipping-lane network: {"nodes": [lon, lat, ...], "edges": [a, b, ...]}

Sources (downloaded when no local path is given):
  UN/LOCODE code list, via https://github.com/datasets/un-locode
  Eurostat MARNET shipping lanes, as packaged by https://github.com/johnx25bd/searoute (MIT)

Run: python3 tools/make_sea_data.py [code-list.csv] [marnet_densified.json]
"""
import csv, io, json, math, os, sys, urllib.request

LOCODE_URL = 'https://raw.githubusercontent.com/datasets/un-locode/main/data/code-list.csv'
MARNET_URL = 'https://raw.githubusercontent.com/johnx25bd/searoute/master/data/marnet_densified.json'
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'data')


def load(arg, url):
    if arg:
        with open(arg, encoding='utf-8') as f:
            return f.read()
    with urllib.request.urlopen(url) as r:
        return r.read().decode('utf-8')


def coord(s):
    # "5155N 00430E" -> (51.9167, 4.5)
    try:
        la, lo = s.split()
        lat = int(la[:2]) + int(la[2:4]) / 60
        lon = int(lo[:3]) + int(lo[3:5]) / 60
        return (round(-lat if la[-1] == 'S' else lat, 3), round(-lon if lo[-1] == 'W' else lon, 3))
    except (ValueError, IndexError):
        return None


# Big ports the code list gives no position for, and the AIS codes ships use for them.
PLACES = {
    'GBSOU': ['Southampton', 50.9, -1.41], 'GBFXT': ['Felixstowe', 51.95, 1.32], 'GBLON': ['London', 51.5, 0.05],
    'GBTIL': ['Tilbury', 51.46, 0.36], 'ESALG': ['Algeciras', 36.13, -5.43], 'MAPTM': ['Tanger Med', 35.89, -5.5],
    'GIGIB': ['Gibraltar', 36.14, -5.36], 'PLGDN': ['Gdansk', 54.4, 18.67], 'EGPSD': ['Port Said', 31.26, 32.3],
    'CNSHA': ['Shanghai', 31.35, 121.6], 'GBPME': ['Portsmouth', 50.81, -1.1],
}
# English names ships write that the code list spells the local way.
ALIASES = {
    'ANTWERP': 'BEANR', 'GOTHENBURG': 'SEGOT', 'DUNKIRK': 'FRDKK', 'LISBON': 'PTLIS', 'GENOA': 'ITGOA',
    'VENICE': 'ITVCE', 'NAPLES': 'ITNAP', 'LEGHORN': 'ITLIV', 'COPENHAGEN': 'DKCPH', 'ST PETERSBURG': 'RULED',
    'SAINT PETERSBURG': 'RULED', 'CORUNNA': 'ESLCG', 'SUEZ': 'EGSUZ', 'SYRACUSE': 'ITSIR', 'FLUSHING': 'NLVLI',
    'ATHENS': 'GRPIR', 'SHANGHAI': 'CNSHA', 'MARSEILLES': 'FRMRS',
}


def ports(text):
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        if r['Function'][:1] != '1' or r['Change'] == 'X':
            continue
        c = coord(r['Coordinates'])
        name = r['NameWoDiacritics'] or r['Name']
        out.setdefault(r['Country'], {})[r['Location']] = [name, *c] if c else [name]
    for code, place in PLACES.items():
        out.setdefault(code[:2], {})[code[2:]] = place
    out['='] = ALIASES
    return out


def sea(text):
    feats = json.loads(text)['features']
    index, nodes, edges, grid = {}, [], set(), {}

    # Lanes meet at points that differ by a few metres, so points closer than ~500 m are one.
    def node(lon, lat):
        k = (round(lon, 4), round(lat, 4))
        if k in index:
            return index[k]
        gx, gy = math.floor(lon / 0.01), math.floor(lat / 0.01)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in grid.get((gx + dx, gy + dy), ()):
                    if abs(nodes[i][0] - lon) < 0.005 and abs(nodes[i][1] - lat) < 0.005:
                        index[k] = i
                        return i
        index[k] = len(nodes)
        nodes.append(k)
        grid.setdefault((gx, gy), []).append(index[k])
        return index[k]

    for f in feats:
        pts = [node(*p[:2]) for p in f['geometry']['coordinates']]
        for a, b in zip(pts, pts[1:]):
            if a != b:
                edges.add((min(a, b), max(a, b)))
    # Lanes that run off one side of the map continue on the other.
    for (lon, lat), i in list(index.items()):
        if lon == -180 and (180, lat) in index:
            edges.add((min(i, index[(180, lat)]), max(i, index[(180, lat)])))
    # Keep only the connected world network; a few short lanes are islands of their own.
    parent = list(range(len(nodes)))

    def root(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in edges:
        parent[root(a)] = root(b)
    sizes = {}
    for i in range(len(nodes)):
        sizes[root(i)] = sizes.get(root(i), 0) + 1
    main = max(sizes, key=sizes.get)
    keep = [i for i in range(len(nodes)) if root(i) == main]
    new = {old: i for i, old in enumerate(keep)}
    edges = sorted((new[a], new[b]) for a, b in edges if a in new)
    return {'nodes': [round(v, 3) for i in keep for v in nodes[i]], 'edges': [v for e in edges for v in e]}


def main():
    os.makedirs(OUT, exist_ok=True)
    p = ports(load(sys.argv[1] if len(sys.argv) > 1 else None, LOCODE_URL))
    s = sea(load(sys.argv[2] if len(sys.argv) > 2 else None, MARNET_URL))
    for name, data in (('ports.json', p), ('sea.json', s)):
        path = os.path.join(OUT, name)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
        print(f'{path}: {os.path.getsize(path) // 1024} KB')
    print(f"{sum(map(len, p.values()))} ports, {len(s['nodes']) // 2} lane points, {len(s['edges']) // 2} lane segments")


if __name__ == '__main__':
    main()
