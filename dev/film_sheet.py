"""One frame per caption from the finished film, with the caption's own text under it.

python dev/film_sheet.py -> out/film/wardwise-film-sheet.jpg
"""
import io, json, subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1] / 'out' / 'film'
film = ROOT / 'wardwise-film.mp4'
data = json.loads((ROOT / 'captions.json').read_text())
font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 22)
bold = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 22)
TW, TH, TEXT = 768, 432, 92
tiles = []
shots = data['captions'] + [{'start': data['total'] - 4, 'end': data['total'] - 1, 'text': 'End card (no caption): the address, Try it, no login.'}]
for i, c in enumerate(shots, 1):
    at = (c['start'] + c['end']) / 2
    png = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{at:.2f}', '-i', str(film), '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'],
                         capture_output=True).stdout
    tile = Image.new('RGB', (TW, TH + TEXT), 'white')
    tile.paste(Image.open(io.BytesIO(png)).convert('RGB').resize((TW, TH), Image.LANCZOS), (0, 0))
    d = ImageDraw.Draw(tile)
    m, s = divmod(at, 60)
    d.text((10, TH + 6), f'{i}. {int(m)}:{s:04.1f}  ({c["start"]:.1f} to {c["end"]:.1f} s)', font=bold, fill=(30, 30, 30))
    for k, line in enumerate(c['text'].split('\\N')):
        d.text((10, TH + 34 + k * 26), line, font=font, fill=(60, 60, 60))
    tiles.append(tile)
cols = 3
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new('RGB', (cols * TW + (cols + 1) * 12, rows * (TH + TEXT) + (rows + 1) * 12), (220, 220, 220))
for i, tile in enumerate(tiles):
    sheet.paste(tile, (12 + (i % cols) * (TW + 12), 12 + (i // cols) * (TH + TEXT + 12)))
out = ROOT / 'wardwise-film-sheet.jpg'
sheet.save(out, quality=88)
print(out, len(tiles), 'frames')
