#!/usr/bin/env python3
"""Reference values for the image core tests (test/image/), computed with Python imagehash and Pillow.

Run from the repo root (imagehash 4.3.2, Pillow, numpy and scipy must be installed), after
tools/make_similarity_fixtures.ts has written the images that this script hashes:
    python3 -I tools/gen_phash_vectors.py

Writes test/fixtures/phash-vectors.json and the tiny decoder fixtures in test/fixtures/images/decoder/. Every
expected value in them comes from imagehash or Pillow, never from the TypeScript code under test.
"""
import json
import sys
from pathlib import Path

import imagehash
import numpy as np
import scipy.fftpack
import scipy.ndimage
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'test/fixtures/phash-vectors.json'
IMAGES = ROOT / 'test/fixtures/images'
DECODER = IMAGES / 'decoder'
MIN_GAP = 1e-3  # a coefficient this close to the median can flip with float rounding, so the vector would be unstable

# TypeScript name -> numpy transform of the 32x32 matrix (rot90 = counter-clockwise, as np.rot90)
VARIANTS = {
    'mirror': lambda m: np.fliplr(m),
    'rot90': lambda m: np.rot90(m, 1),
    'rot90-mirror': lambda m: np.fliplr(np.rot90(m, 1)),
    'rot270': lambda m: np.rot90(m, 3),
    'rot270-mirror': lambda m: np.fliplr(np.rot90(m, 3)),
}


def phash_of(m):
    """imagehash.phash of a 32x32 gray matrix (imagehash resizes 32x32 to 32x32: a no-op) and the smallest
    distance of a DCT coefficient to the median."""
    m = np.ascontiguousarray(m, dtype=np.uint8)
    h = imagehash.phash(Image.fromarray(m, 'L'))
    dct = scipy.fftpack.dct(scipy.fftpack.dct(m.astype(np.float64), axis=0), axis=1)[:8, :8]
    med = np.median(dct)
    assert ((dct > med) == h.hash).all(), 'imagehash disagrees with its own formula'
    return str(h), float(np.abs(dct - med).min())


def synthetic():
    rng = np.random.default_rng(20261107)
    y, x = np.mgrid[0:32, 0:32].astype(np.float64)
    noise = lambda amp: rng.normal(0, amp, (32, 32))
    low = lambda: scipy.ndimage.gaussian_filter(rng.normal(128, 60, (32, 32)), 2.5)
    yield 'noise-1', rng.integers(0, 256, (32, 32))
    yield 'noise-2', rng.integers(0, 256, (32, 32))
    yield 'noise-3', rng.integers(0, 256, (32, 32))
    yield 'noise-4', rng.integers(0, 256, (32, 32))
    yield 'ramp-x+noise', x * 7 + noise(12)
    yield 'ramp-y+noise', y * 7 + noise(12)
    yield 'diagonal+noise', (x + y) * 3.5 + 20 + noise(15)
    yield 'blob+noise', 230 * np.exp(-(((x - 11) ** 2 + (y - 19) ** 2) / 90)) + 10 + noise(8)
    yield 'blocks+noise', np.kron(rng.integers(0, 256, (4, 4)), np.ones((8, 8))) + noise(6)
    yield 'lowpass-1', low()
    yield 'lowpass-2', low()
    yield 'lowpass-3', low()
    yield 'stripes+noise', 128 + 90 * np.sin(x * 0.9 + y * 0.2) + noise(10)
    yield 'dark-low-contrast', 25 + noise(4)
    yield 'bright-high-contrast', np.where(low() > 128, 250, 5) + noise(3)


def decoder_fixtures():
    """Tiny files for the decoder tests. expected.json holds the gray image that Pillow decodes from each file."""
    DECODER.mkdir(parents=True, exist_ok=True)
    y, x = np.mgrid[0:24, 0:32]
    rgb = np.stack([x * 8, y * 10, 128 + 100 * np.sin((x + y) / 5)], -1).clip(0, 255).astype(np.uint8)
    rgb[4:12, 6:14] = (220, 30, 30)  # hard color edges
    rgb[12:20, 18:28] = (20, 40, 200)
    im = Image.fromarray(rgb, 'RGB')
    gray = np.asarray(im.convert('L'))
    low = (gray.astype(np.uint16) * 7 + 91) % 256  # a low byte that differs from the high byte
    alpha = ((x * 9 + y * 5) % 256).astype(np.uint8)
    files = {
        'baseline.jpg': lambda p: im.save(p, quality=90),
        'progressive.jpg': lambda p: im.save(p, quality=90, progressive=True),
        'rgb.png': lambda p: im.save(p),
        'rgba.png': lambda p: im.convert('RGBA').save(p),
        'gray.png': lambda p: Image.fromarray(gray, 'L').save(p),
        'palette.png': lambda p: im.quantize(16).save(p),
        'gray16.png': lambda p: Image.fromarray(gray.astype(np.uint16) * 257).save(p),
        'gray16-varied.png': lambda p: Image.fromarray(gray.astype(np.uint16) * 256 + low).save(p),
        'gray-alpha.png': lambda p: Image.merge('LA', (Image.fromarray(gray), Image.fromarray(alpha))).save(p),
        'palette-alpha.png': lambda p: im.quantize(16).save(p, transparency=3),  # tRNS: the palette entries get an alpha value
    }
    # not decodable: the decoder must reject them
    im.save(DECODER / 'image.webp', quality=80)
    Image.fromarray(gray > 128).save(DECODER / 'bilevel.png')  # 1 bit per pixel
    expected = {}
    for name, save in files.items():
        save(DECODER / name)
        loaded = Image.open(DECODER / name)
        if loaded.mode.startswith('I;16'):  # Pillow clips 16 bit to 8 bit; the rule here is the high byte
            g = (np.asarray(loaded).astype(np.uint16) >> 8).astype(np.uint8)
        else:
            g = np.asarray(loaded.convert('L'))
        if name == 'palette-alpha.png':
            assert 'transparency' in loaded.info and (g == np.asarray(loaded.convert('RGB').convert('L'))).all()
        expected[name] = {'width': g.shape[1], 'height': g.shape[0], 'gray': g.flatten().tolist()}
    with (DECODER / 'expected.json').open('w') as f:
        f.write('{\n' + ',\n'.join('"%s":%s' % (k, json.dumps(v, separators=(',', ':'))) for k, v in expected.items()) + '\n}\n')
    print(f'wrote {len(files) + 2} decoder fixtures in {DECODER.relative_to(ROOT)}')


def image_hashes():
    """imagehash.phash of every fixture image: the reference for decode + resize + pHash in TypeScript."""
    files = sorted(IMAGES.glob('*.jpg')) + sorted(IMAGES.glob('*.png'))
    return [{'file': p.name, 'hash': str(imagehash.phash(Image.open(p)))} for p in files]


def window_hashes():
    """The 18 phone-window hashes of each base image: 9 positions of a full-height window, 9:16 and 9:19.5."""
    out = []
    for p in sorted(IMAGES.glob('base-*.jpg')):
        gray = Image.open(p).convert('L')
        w, h = gray.size
        hashes = []
        for ww in (h * 9 // 16, h * 18 // 39):
            for i in range(9):
                x = (w - ww) * i // 8
                hashes.append(str(imagehash.phash(gray.crop((x, 0, x + ww, h)))))
        out.append({'file': p.name, 'hashes': hashes})
    return out


def from_images():
    """The 32x32 gray matrix that imagehash itself computes from a fixture image (convert('L') and a Lanczos resize)."""
    for name in ('base-valley.jpg', 'base-shrine-a.jpg', 'base-shrine-b.jpg', 't3-phone.jpg', 't4-mirror-up-crop-letterbox.jpg'):
        image = Image.open(IMAGES / name)
        m = np.asarray(image.convert('L').resize((32, 32), Image.Resampling.LANCZOS))
        assert phash_of(m)[0] == str(imagehash.phash(image)), f'{name}: not the input of imagehash.phash'
        yield f'image {name}', m


def main():
    decoder_fixtures()
    vectors = []
    for name, raw in [*synthetic(), *from_images()]:
        m = np.clip(np.rint(raw), 0, 255).astype(np.uint8)
        h, gap = phash_of(m)
        variants, gaps = {}, [gap]
        for vname, f in VARIANTS.items():
            variants[vname], g = phash_of(f(m))
            gaps.append(g)
        if min(gaps) < MIN_GAP:
            print(f'skip {name}: a coefficient is {min(gaps):.2e} from the median', file=sys.stderr)
            continue
        vectors.append({'name': name, 'matrix': m.flatten().tolist(), 'hash': h, 'variants': variants})
    with OUT.open('w') as f:
        f.write('{"generator":"imagehash %s, Pillow %s, numpy %s, scipy %s",\n"vectors":[\n' % (
            imagehash.__version__, Image.__version__, np.__version__, scipy.__version__))
        f.write(',\n'.join(json.dumps(v, separators=(',', ':')) for v in vectors))
        f.write('\n],\n"images":[\n')
        f.write(',\n'.join(json.dumps(i, separators=(',', ':')) for i in image_hashes()))
        f.write('\n],\n"windows":[\n')
        f.write(',\n'.join(json.dumps(i, separators=(',', ':')) for i in window_hashes()))
        f.write('\n]}\n')
    print(f'wrote {OUT.relative_to(ROOT)}: {len(vectors)} vectors')


if __name__ == '__main__':
    main()
