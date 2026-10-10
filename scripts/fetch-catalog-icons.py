#!/usr/bin/env python3
"""Collect crisp favicon candidates first, then homepage branding.
Run from the project root; --ids id1,id2 selects unverified entries.
Candidates require visual review before enabling them in sources.json.
Existing verified assets and fallback records remain intact.
"""
import base64, argparse, concurrent.futures, hashlib, io, json, subprocess, tempfile, re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from PIL import Image
ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'public/catalog'
MANIFEST = DEST / 'sources.json'

def fetch(url):
    if url.startswith('data:image/'):
        header, data = url.split(',', 1)
        if ';base64' not in header: raise ValueError('Unsupported data image')
        return base64.b64decode(data), url
    if urlsplit(url).scheme not in ('http', 'https'): raise ValueError('Invalid URL')
    with tempfile.NamedTemporaryFile() as out:
        result = subprocess.run(['curl', '--silent', '--show-error', '--location', '--fail', '--max-redirs', '5', '--connect-timeout', '5', '--max-time', '12', '--max-filesize', '4194304', '--user-agent', 'Mozilla/5.0 Chrome/140.0 Safari/537.36', '--output', out.name, '--write-out', '%{json}', url], capture_output=True)
        if result.returncode: raise ValueError(result.stderr.decode(errors='replace')[:120])
        info = json.loads(result.stdout)
        return Path(out.name).read_bytes(), info['url_effective']

def extract(data, mode, base=''):
    return subprocess.check_output(['node', str(ROOT / 'scripts/extract-page-logos.mjs'), mode, base], input=data, cwd=ROOT)

def image(data, favicon=False):
    if b'<svg' in data[:1000]:
        clean = extract(data, 'svg')
        if not clean: raise ValueError('Empty SVG')
        return clean, 'svg', tuple(int(re.search(rb'\b' + name + rb'="(\d+)"', clean).group(1)) for name in [b'width', b'height'])
    with Image.open(io.BytesIO(data)) as original:
        if original.format == 'ICO':
            if not favicon: raise ValueError('ICO must be classified as favicon')
            original = original.ico.getimage(max(original.ico.sizes(), key=lambda size: min(size)))
        if favicon and min(original.size) < 64: raise ValueError('Low-resolution favicon')
        original.load()
        if min(original.size) < 24 or max(original.size) > 4096: raise ValueError('Invalid dimensions')
        result = original.convert('RGBA')
        if not result.getchannel('A').getbbox(): raise ValueError('Empty image')
        result.thumbnail((512, 512), Image.Resampling.LANCZOS)
        output = io.BytesIO(); result.save(output, 'PNG', optimize=True)
        return output.getvalue(), 'png', result.size

def acquire(site, override=None):
    errors = []; candidates = []; title = ''; page = site['url']
    if override and override.get('kind') in ('page-logo', 'hd-favicon'): candidates.append(override)
    try:
        data, page = fetch(site['url']); result = json.loads(extract(data, 'page', page)); title = result.get('title', '')[:180]
        candidates += [{'url': url, 'kind': 'hd-favicon'} for url in result.get('icons', [])] + result['candidates']
    except Exception as error: errors.append(str(error))
    for candidate in candidates:
        url = candidate.get('url', '')
        favicon = candidate.get('kind') == 'hd-favicon'
        if not favicon and re.search(r'favicon|apple-touch-icon|\.ico(?:[?#]|$)', url, re.I): continue
        try:
            data, source = (candidate['svg'].encode(), page) if candidate.get('svg') else fetch(url)
            data, extension, size = image(data, favicon)
            path = DEST / f"{site['id']}-{'favicon' if favicon else 'candidate-logo'}.{extension}"; path.write_bytes(data)
            return site['id'], {'file': path.name, 'kind': 'candidate-favicon' if favicon else 'candidate-logo', 'source': page if source.startswith('data:') else source, 'website': site['url'], 'page': candidate.get('page', page), 'title': title, 'width': size[0], 'height': size[1], 'sha256': hashlib.sha256(data).hexdigest(), 'retrieved': datetime.now(timezone.utc).date().isoformat()}
        except Exception as error: errors.append(f'{url}: {error}')
    return site['id'], {'error': '; '.join(errors)[:500] or 'No homepage logo found in static HTML', 'page': page, 'title': title}

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--ids'); parser.add_argument('--overrides', type=Path, default=ROOT / 'scripts/catalog-icon-overrides.json'); args = parser.parse_args()
    sites = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', "import {SITE_CATALOG} from './lib/site-catalog.js'; console.log(JSON.stringify(SITE_CATALOG.filter(site=>!site.builtin)))"], cwd=ROOT))
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    sites = [site for site in sites if manifest.get(site['id'], {}).get('kind') not in ('page-logo', 'brand-artwork', 'hd-favicon') and site['id'] != 'bilibili']
    if args.ids: sites = [site for site in sites if site['id'] in args.ids.split(',')]
    overrides = json.loads(args.overrides.read_text()) if args.overrides else {}; failures = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        jobs = [pool.submit(acquire, site, overrides.get(site['id'])) for site in sites]
        for job in concurrent.futures.as_completed(jobs):
            key, result = job.result()
            if 'error' in result: failures[key] = result; print(f'MISSING {key}: {result["error"][:100]}', flush=True)
            else: manifest[key] = result; print(f'OK {key}: {result["file"]}', flush=True)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    Path('/tmp/tabcat-catalog-logo-failures.json').write_text(json.dumps(failures, ensure_ascii=False, indent=2))
    print(f'{len(sites)-len(failures)}/{len(sites)} artwork candidates found.')
if __name__ == '__main__': main()
