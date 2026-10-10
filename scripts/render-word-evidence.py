"""Render an actual browser-exported DOCX to all page PNGs, without modifying it.
Requires LibreOffice and Poppler. Output is evidence for human visual review,
not certification for Microsoft Word/WPS. No downloads, user profiles or keys.
"""
import argparse
import hashlib
import json
import re
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path


def run(command, timeout=90):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{Path(command[0]).name} failed: {result.stderr[-1200:]}")
    return result.stdout


def render(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    if not source.is_file() or source.suffix.lower() != '.docx':
        raise ValueError('Supply an existing browser-exported .docx file.')
    for program in ['soffice', 'pdfinfo', 'pdftoppm', 'pdftotext']:
        if not shutil.which(program):
            raise RuntimeError(f'Missing {program}; install LibreOffice and Poppler before validation.')
    output.mkdir(parents=True, exist_ok=True)
    # Isolated profile and conversion directory prevent cached/stale evidence.
    with tempfile.TemporaryDirectory(prefix='zhiti-word-render-') as scratch:
        scratch = Path(scratch)
        run(['soffice', '-env:UserInstallation=' + (scratch/'profile').as_uri(), '--headless', '--convert-to', 'pdf', '--outdir', str(scratch), str(source)])
        pdf = scratch/(source.stem+'.pdf')
        if not pdf.exists() or pdf.stat().st_size == 0:
            raise RuntimeError('LibreOffice did not produce a PDF.')
        count_match = re.search(r'^Pages:\s+(\d+)', run(['pdfinfo', str(pdf)]), re.M)
        if not count_match:
            raise RuntimeError('Cannot establish rendered page count.')
        count = int(count_match.group(1))
        text = run(['pdftotext', str(pdf), '-'])
        if count < 1 or not text.strip():
            raise RuntimeError('The exported document rendered as empty.')
        run(['pdftoppm', '-r', '120', '-png', str(pdf), str(scratch/'page')])
        pages = sorted(scratch.glob('page-*.png'), key=lambda p: int(p.stem.split('-')[-1]))
        if len(pages) != count:
            raise RuntimeError('Some document pages were not rendered.')
        evidence = []
        for index, page in enumerate(pages, 1):
            image = page.read_bytes()
            if image[:8] != b'\x89PNG\r\n\x1a\n':
                raise RuntimeError('Invalid rendered page PNG.')
            width, height = struct.unpack('>II', image[16:24])
            if min(width, height) < 500:
                raise RuntimeError('Rendered page is too small for visual inspection.')
            name = f'page-{index}.png'
            (output/name).write_bytes(image)
            evidence.append({'file': name, 'width': width, 'height': height, 'sha256': hashlib.sha256(image).hexdigest()})
        shutil.copyfile(pdf, output/'rendered.pdf')
        (output/'text.txt').write_text(text)
        report = {'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'renderer': run(['soffice', '--version']).strip(), 'pageCount': count, 'pages': evidence, 'visualReview': 'Review every page; automated rendering is not visual sign-off.', 'coverage': 'LibreOffice rendering; Word/WPS application acceptance is separate.'}
        (output/'render-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps(report, ensure_ascii=False))
        return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('docx')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    render(args.docx, args.out)
