"""Generate the traffic.observe.tw SVG and PNG brand assets.

Requires fontTools, Pillow, rsvg-convert and Noto Serif CJK TC SemiBold.
The default font matches the observe.tw family wordmarks. Pass a TTC path
as the first argument to use another installation of the same font.
Run: python tools/brand-assets.py [NotoSerifCJK-SemiBold.ttc]
"""
from pathlib import Path
from fontTools.ttLib import TTCollection
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
import subprocess, shutil, sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/brand'
OUT.mkdir(parents=True, exist_ok=True)
collection = TTCollection(sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/noto-cjk/NotoSerifCJK-SemiBold.ttc')
font = next(f for f in collection.fonts if f['name'].getDebugName(1) == 'Noto Serif CJK TC SemiBold')
glyphs, cmap = font.getGlyphSet(), font.getBestCmap()
U = font['head'].unitsPerEm

def outlined(text, x, baseline, size, color, spacing=0):
    paths = []
    for char in text:
        name = cmap[ord(char)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        paths.append(f'<path transform="translate({x:g} {baseline:g}) scale({size/U:g} {-size/U:g})" d="{pen.getCommands()}"/>')
        x += glyphs[name].width * size/U + spacing
    return f'<g fill="{color}">'+''.join(paths)+'</g>'

def mark(ink, accent, small=False):
    weight = 5 if small else 4.5
    return f'<g fill="none" stroke="{ink}" stroke-width="{weight}" stroke-linecap="round"><path d="M39.42 9.17a24 24 0 1 0 15.41 15.41"/><path d="M22 35v8m10-18v18m10-13v13"/></g><circle cx="48.97" cy="15.03" r="4.25" fill="{accent}"/>'

def svg(name, width, height, body, title='臺灣流量觀察站'):
    value = f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title"><title id="title">{title}</title>{body}</svg>\n'
    (OUT / name).write_text(value)
    return value

# C lockup: 30px Chinese name, no URL; center the visible glyph bounds.
NAME = '臺灣流量觀察站'
boxes = []
for ch in NAME:
    pen = BoundsPen(glyphs)
    glyphs[cmap[ord(ch)]].draw(pen)
    boxes.append(pen.bounds)
name_midline = (min(b[1] for b in boxes) + max(b[3] for b in boxes)) / 2

for variant, ink, accent in [('dark','#EDEDED','#FB923C'),('light','#18181B','#C2410C'),('black','#18181B','#18181B'),('white','#FFFFFF','#FFFFFF')]:
    svg(f'logo-mark-{variant}.svg',64,64,mark(ink,accent))
    body = '<g transform="translate(0 3) scale(.75)">'+mark(ink,accent)+'</g>'
    body += outlined(NAME,58,27+name_midline*30/U,30,ink,.3)
    svg(f'logo-horizontal-{variant}.svg',273.8,54,body)
    body = '<g transform="translate(90 10) scale(1.625)">'+mark(ink,accent)+'</g>'
    name_width = sum(glyphs[cmap[ord(ch)]].width*36/U for ch in NAME)+.3*(len(NAME)-1)
    body += outlined(NAME,(284-name_width)/2,152+name_midline*36/U,36,ink,.3)
    svg(f'logo-stacked-{variant}.svg',284,190,body)

# A separate optical size: heavier circle and bars; no text or tiny details.
fav = '<rect width="64" height="64" rx="14" fill="#18181B"/>' + '<g transform="translate(2 2) scale(.9375)">'+mark('#EDEDED','#FB923C',True)+'</g>'
svg('favicon.svg',64,64,fav)
# Apple draws its own mask: keep this full-bleed with no pre-rounded corners.
app = '<rect width="512" height="512" fill="#18181B"/><g transform="translate(48 48) scale(6.5)">'+mark('#EDEDED','#FB923C')+'</g>'
svg('app-icon.svg',512,512,app)
for variant in ['dark','light']:
    for layout in ['horizontal','stacked','mark']:
        name = f'logo-{layout}-{variant}'
        width = {'horizontal':1095,'stacked':1136,'mark':1024}[layout]
        subprocess.run(['rsvg-convert','-w',str(width),'-o',str(OUT/f'{name}.png'),str(OUT/f'{name}.svg')],check=True)
for size, name in [(180,'apple-touch-icon.png'),(192,'icon-192.png'),(512,'icon-512.png')]:
    subprocess.run(['rsvg-convert','-w',str(size),'-o',str(OUT/name),str(OUT/'app-icon.svg')],check=True)
from PIL import Image
subprocess.run(['rsvg-convert','-w','64','-o','/tmp/traffic-favicon.png',str(OUT/'favicon.svg')],check=True)
Image.open('/tmp/traffic-favicon.png').save(OUT/'favicon.ico',sizes=[(16,16),(32,32),(48,48),(64,64)])
shutil.copyfile('/usr/share/licenses/noto-fonts-cjk/LICENSE', OUT/'FONT-LICENSE.txt')
