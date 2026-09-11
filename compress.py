#!/usr/bin/env python3
"""
3-stage PDF compression pipeline for architectural/vector PDFs.

Usage:
  python3 compress.py <input.pdf> <output.pdf> <level>
  level: low | medium | high
"""

import sys
import os
import shutil
import tempfile
import subprocess

def stage1_pypdf(input_path, output_path):
    """Stage 1: lossless — remove duplicate/unreferenced objects, compress content streams."""
    try:
        from pypdf import PdfWriter
        writer = PdfWriter(clone_from=input_path)
        # Compress each page's content streams (zlib, lossless)
        for page in writer.pages:
            page.compress_content_streams()
        # Remove duplicate and unreferenced objects
        writer.compress_identical_objects(remove_duplicates=True, remove_unreferenced=True)
        with open(output_path, 'wb') as f:
            writer.write(f)
        return True
    except Exception as e:
        print(f"[pypdf] error: {e}", file=sys.stderr)
        return False

def stage2_pikepdf(input_path, output_path):
    """Stage 2: lossless — optimize structure, linearize, remove metadata bloat."""
    try:
        import pikepdf
        with pikepdf.open(input_path) as pdf:
            pdf.save(
                output_path,
                compress_streams=True,
                stream_decode_level=pikepdf.StreamDecodeLevel.generalized,
                object_stream_mode=pikepdf.ObjectStreamMode.generate,
                linearize=True,
                recompress_flate=True,
            )
        return True
    except Exception as e:
        print(f"[pikepdf] error: {e}", file=sys.stderr)
        return False

def stage3_ghostscript(input_path, output_path, level):
    """Stage 3: Ghostscript — image downsampling (medium/high only)."""
    if level == 'low':
        # Skip GS for low — keep fully lossless
        shutil.copy2(input_path, output_path)
        return True

    gs_args = [
        'gs',
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        '-dNOPAUSE', '-dQUIET', '-dBATCH',
        '-dEmbedAllFonts=true',
        '-dSubsetFonts=true',
        '-dDetectDuplicateImages=true',
        '-dCompressPages=true',
    ]

    if level == 'medium':
        # Medium: flatten transparency, modest image downsampling to 150dpi
        gs_args += [
            '-dPDFSETTINGS=/printer',
            '-dFlattenTransparency=true',
            '-dColorImageResolution=150',
            '-dGrayImageResolution=150',
            '-dMonoImageResolution=150',
            '-dDownsampleColorImages=true',
            '-dDownsampleGrayImages=true',
            '-dColorImageDownsampleType=/Bicubic',
            '-dGrayImageDownsampleType=/Bicubic',
        ]
    else:
        # High: maximum compression, rasterize at 150dpi
        gs_args += [
            '-dPDFSETTINGS=/screen',
            '-dFlattenTransparency=true',
            '-r150',
            '-dColorImageResolution=150',
            '-dGrayImageResolution=150',
            '-dMonoImageResolution=150',
            '-dDownsampleColorImages=true',
            '-dDownsampleGrayImages=true',
            '-dDownsampleMonoImages=true',
            '-dColorImageDownsampleType=/Bicubic',
            '-dGrayImageDownsampleType=/Bicubic',
            '-dAutoFilterColorImages=false',
            '-dColorImageFilter=/DCTEncode',
            '-dAutoFilterGrayImages=false',
            '-dGrayImageFilter=/DCTEncode',
        ]

    gs_args += ['-sOutputFile=' + output_path, input_path]

    try:
        result = subprocess.run(gs_args, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"[ghostscript] error: {result.stderr}", file=sys.stderr)
            return False
        return True
    except Exception as e:
        print(f"[ghostscript] exception: {e}", file=sys.stderr)
        return False

def pick_smallest(original, *candidates):
    """Return the path with the smallest file size, never larger than original."""
    original_size = os.path.getsize(original)
    best_path = None
    best_size = original_size  # never return something bigger than original

    for p in candidates:
        if p and os.path.exists(p):
            s = os.path.getsize(p)
            if s < best_size:
                best_size = s
                best_path = p

    return best_path  # None means keep original

def main():
    if len(sys.argv) != 4:
        print("Usage: compress.py <input> <output> <low|medium|high>", file=sys.stderr)
        sys.exit(1)

    input_path  = sys.argv[1]
    output_path = sys.argv[2]
    level       = sys.argv[3].lower()

    if not os.path.exists(input_path):
        print(f"Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    tmpdir = tempfile.mkdtemp()
    try:
        s1_out = os.path.join(tmpdir, 'stage1.pdf')
        s2_out = os.path.join(tmpdir, 'stage2.pdf')
        s3_out = os.path.join(tmpdir, 'stage3.pdf')

        # Run all stages
        s1_ok = stage1_pypdf(input_path, s1_out)
        s2_ok = stage2_pikepdf(s1_out if s1_ok else input_path, s2_out)
        s3_ok = stage3_ghostscript(s2_out if s2_ok else (s1_out if s1_ok else input_path), s3_out, level)

        # Collect successful outputs
        candidates = []
        if s1_ok and os.path.exists(s1_out): candidates.append(s1_out)
        if s2_ok and os.path.exists(s2_out): candidates.append(s2_out)
        if s3_ok and os.path.exists(s3_out): candidates.append(s3_out)

        best = pick_smallest(input_path, *candidates)

        if best:
            shutil.copy2(best, output_path)
            orig_size = os.path.getsize(input_path)
            new_size  = os.path.getsize(output_path)
            reduction = round((1 - new_size / orig_size) * 100, 1)
            print(f"OK: {orig_size} → {new_size} bytes ({reduction}% reduction)")
        else:
            # Nothing helped — return original unchanged
            shutil.copy2(input_path, output_path)
            print("OK: no reduction possible, returning original")

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

if __name__ == '__main__':
    main()
