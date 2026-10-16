#!/usr/bin/env python3
"""Render the native workbench's deterministic ANSI frame, without private data."""
import json
from pathlib import Path
import re
import subprocess
import sys
import unicodedata
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
binary = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "c/build/test_workbench"
target = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/dito-workbench-preview.png")
rows = json.loads(subprocess.check_output([str(binary), "--preview"], text=True))
mono = subprocess.check_output(["fc-match", "-f", "%{file}", "DejaVu Sans Mono"], text=True)
cjk = subprocess.check_output(["fc-match", "-f", "%{file}", "Noto Sans Mono CJK SC"], text=True)
fonts = [ImageFont.truetype(mono, 16), ImageFont.truetype(cjk, 16)]
cell, height, background = 10, 23, (29, 40, 55)
image = Image.new("RGB", (220 * cell, len(rows) * height), background)
draw = ImageDraw.Draw(image)
ansi = re.compile(r"\x1b\[([0-9;]*)m")
for y, row in enumerate(rows):
    x, foreground, fill = 0, (219, 224, 232), background
    for part in re.split(r"(\x1b\[[0-9;]*m)", row):
        match = ansi.fullmatch(part)
        if match:
            codes = [int(n) if n else 0 for n in match[1].split(";")]
            i = 0
            while i < len(codes):
                code = codes[i]
                if code == 0:
                    foreground, fill = (219, 224, 232), background
                elif code in (38, 48) and codes[i+1:i+2] == [2] and i + 4 < len(codes):
                    color = tuple(codes[i+2:i+5])
                    if code == 38:
                        foreground = color
                    else:
                        fill = color
                    i += 4
                i += 1
            continue
        for ch in part:
            width = 0 if unicodedata.combining(ch) else 2 if unicodedata.east_asian_width(ch) in "WF" else 1
            if not width:
                continue
            draw.rectangle((x*cell, y*height, (x+width)*cell-1, (y+1)*height-1), fill=fill)
            draw.text((x*cell, y*height + 2), ch, font=fonts[ord(ch) > 127], fill=foreground)
            x += width
image.save(target)
print(target)
