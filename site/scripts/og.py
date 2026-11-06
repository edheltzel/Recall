# Generates public/og.png (1200x630) in the GAP/DoSkills family style.
# Recall accent #7c8cff (violet-blue). TODO(recall-brief): override if the brief picks another.
import math, random
from PIL import Image, ImageDraw, ImageFont
W, H = 1200, 630
BG = (11, 17, 19); ACC = (124, 140, 255); TEXT = (237, 237, 237); T2 = (161, 161, 161); T3 = (140, 140, 140)
G = '/usr/share/fonts/truetype/sand-box/google/Geist/Geist-VariableFont_wght.ttf'
M = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
def geist(size, w=600):
    f = ImageFont.truetype(G, size)
    try: f.set_variation_by_axes([w])
    except Exception: pass
    return f
img = Image.new('RGB', (W, H), BG); d = ImageDraw.Draw(img)
# Dithered glyph disc, lit on its upper-left rim.
random.seed(7); mono = ImageFont.truetype(M, 11); ramp = " .:-=+*#%"
cx, cy, r = 1010, 255, 330
for y in range(-40, H, 13):
    for x in range(560, W + 20, 7):
        dx, dy = (x - cx) / r, (y - cy) / r; dd = dx*dx + dy*dy
        if dd > 1: continue
        z = math.sqrt(1 - dd); light = max(0, (-dx*0.6 - dy*0.55 + z*0.55)); light = light**1.6
        v = min(len(ramp)-1, int(light * len(ramp) + random.random()*1.2))
        if v <= 0: continue
        t = 0.25 + 0.75*light
        c = tuple(int(BG[i] + (ACC[i]-BG[i])*t) for i in range(3)) if light > 0.35 else tuple(int(BG[i] + (T3[i]-BG[i])*(0.35+light)) for i in range(3))
        d.text((x, y), ramp[v], font=mono, fill=c)
# fade the left edge of the disc under the copy
for x in range(560, 760):
    a = (760 - x) / 200
    d.line([(x, 0), (x, H)], fill=BG, width=1) if a > 0.98 else None
ov = Image.new('L', (W, H), 0); od = ImageDraw.Draw(ov)
for x in range(540, 760): od.line([(x, 0), (x, H)], fill=int(255*max(0, (760-x)/220)))
img.paste(Image.new('RGB', (W, H), BG), (0, 0), ov); d = ImageDraw.Draw(img)
# Mark: accent disc with dark core and thin outer ring.
mx, my = 120, 122
d.ellipse([mx-62, my-62, mx+62, my+62], outline=tuple(int(c*0.45) for c in ACC), width=2)
d.ellipse([mx-55, my-55, mx+55, my+55], fill=ACC)
d.ellipse([mx-17, my-17, mx+17, my+17], fill=BG)
# Copy
ft = geist(68, 600)
d.text((72, 228), 'Recall:', font=ft, fill=ACC)
w = d.textlength('Recall: ', font=ft)
d.text((72 + w, 228), 'Memory for', font=ft, fill=TEXT)
d.text((72, 312), 'Coding Agents', font=ft, fill=TEXT)
d.text((72, 420), 'Capture, distill, recall at session start.', font=geist(28, 400), fill=T2)
d.text((72, 568), 'recall.edheltzel.codes', font=ImageFont.truetype(M, 20), fill=T2)
img.save('public/og.png', optimize=True)
