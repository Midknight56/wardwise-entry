"""Cuts the demo film from the raw takes made by dev/film.mjs.

python dev/film_edit.py            -> out/film/wardwise-film.mp4, captions.json, sheet.jpg
Each cut names its take, its raw start and end (seconds), a speed, an optional crop (x, y, w, h of the
1920 x 1080 frame, scaled back to 1920 x 1080) and the caption shown over it. The music bed and the
interface sounds are made here from plain sine waves, so they are original and need no licence.
"""
import io, json, subprocess, sys, wave
from pathlib import Path
# dev/secrets.py would hide the standard secrets module that numpy imports.
sys.path = [p for p in sys.path if Path(p or '.').resolve() != Path(__file__).resolve().parent]
import numpy as np
from scipy.signal import butter, sosfilt
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1] / 'out' / 'film'
WORK = ROOT / 'edit'
WORK.mkdir(parents=True, exist_ok=True)
FPS, SR = 30, 48000
# Every cut ends in standard TV range with HD colour tags, so mixed sources (screencast JPEGs are full range) match.
HD = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']
PAGE = '0xF3EEE4'
# Zoom boxes (x, y, w, h of the 1920 x 1080 frame). The money panel sits at x 1552 to 1912 on the desktop take.
def panel(y, w=640):
    return [1920 - w, y, w, w * 9 // 16]
LEFT = lambda y: [0, y, 960, 540]

# The film (take10 desktop, phone10 phone), in the order of the review's 2:50 timeline. Captions use the screen's own
# words. No dashes.
C = {
    'a1': '1,014,591 registered Chicagoans did not vote in 2023.\\NWardWise helps a small campaign decide where to knock doors.',
    'a1b': 'Fictional campaign. Sandbox test money.',
    'a2': 'Explore a budget. The campaign plan stays at $5,000.\\NThe vote numbers are simulated estimates, not measured.',
    'a3': 'Code calculates and checks every number.\\NThe AI only writes the explanation, and it is tagged.',
    'a4': 'A supporter gives $25 by test card, no login.\\NA real PayPal sandbox capture, with its id.',
    'a5a': '$50 twice makes $125, over the $100 demo cap.\\NThe app proposes a $25 refund. A person must approve it.',
    'a5b': 'Approved. PayPal refunds $25.\\N$100 stays donated.',
    'a6': 'Two crews log work. The server checks each log.\\NThe payroll preview shows the exact batch.',
    'a7a': 'A person approves that exact batch.\\NPayPal Payouts sends it as one batch.',
    'a7b': 'One crew is paid. One has no PayPal account yet,\\Nso PayPal holds its money as UNCLAIMED.',
    'a8': 'The evidence traces each amount\\Nto its rule and its PayPal receipt.',
    'a9': 'Last election: the 2019 forecast against 2023 turnout.\\NIt does not measure votes caused by spending.',
    'a10a': 'Every ward in one ledger.',
    'a10b': 'The same payment view on a phone.',
}
# Each cut starts and ends at a beat mark of its take plus an offset in seconds, so a new take of the same script
# cuts the same way. A plain number is a raw time in seconds.
D, P = 'take11', 'phone11'
CUTS = [
    # take, start, end, speed, crop, caption, hold (seconds of the last frame added)
    (D, ('beat1 load', 0.3), ('beat1 poured', 0), 1, None, 'a1'),
    (D, ('beat1 poured', 0), ('beat2 drag', 0), 1, [1152, 0, 768, 432], 'a1b'),
    (D, ('beat2 drag', 0), ('beat2 drag', 15.0), 1, LEFT(300), 'a2'),
    (D, ('beat3 ask', 0.24), ('beat3 end', 0.8), 1, LEFT(520), 'a3'),
    (D, ('beat4 ward', 0.78), ('give 25 COMPLETED', 0.3), 1, panel(250), 'a4'),
    (D, ('give 25 COMPLETED', 0.3), ('beat4 ids', 4.5), 1, panel(400), 'a4'),
    (D, ('beat4 ids', 4.5), ('beat5 cap', -0.1), 1, panel(250), 'a4'),
    (D, ('beat5 cap', 0.1), ('beat5 proposal', 0.3), 2, panel(280), 'a5a'),
    (D, ('beat5 proposal', 0.3), ('beat5 proposal', 5.8), 1, panel(300), 'a5a'),
    (D, ('refund COMPLETED', -4.0), ('refund COMPLETED', 2.0), 1, panel(300), 'a5b'),
    (D, ('beat5 refund evidence', 0), ('beat6 work', -0.1), 1, panel(440), 'a5b'),
    (D, ('beat6 work', 0.5), ('beat6 preview', -3.1), 1.5, panel(330), 'a6'),
    (D, ('beat6 preview', 0.3), ('beat7 pay', -0.1), 1, panel(40), 'a6'),
    (D, ('beat7 pay', -0.1), ('beat7 wait start', 0.4), 1, panel(250), 'a7a'),
    (D, ('beat7 wait start', 0.4), ('beat7 final', 0), 5, panel(250), 'a7a'),
    (D, ('beat7 final', 0.2), ('beat8 evidence', -0.1), 1, panel(40), 'a7b', 1.2),
    (D, ('beat8 evidence', 0.6), ('beat9 backtest', -1.2), 1, [1152, 20, 768, 432], 'a8'),
    (D, ('beat9 backtest', 0.3), ('beat10 grid', -0.2), 1, LEFT(440), 'a9'),
    (D, ('beat10 grid', 0.2), ('end', -0.1), 1, [16, 645, 768, 432], 'a10a', 1.0),
    (P, 3.4, 15.8, 1, 'phone', 'a10b'),
]
END_CARD = 7.0
CHIMES = ('give', 'refund COMPLETED', 'beat7 final')


def run(*args):
    subprocess.run(args, check=True, capture_output=True)


def marks(take):
    f = json.loads((ROOT / take / 'frames.json').read_text())
    m = json.loads((ROOT / take / 'marks.json').read_text())
    return [(x['t'] - f[0]['t'], x['label']) for x in m]


def at(take, when):
    """A raw time in seconds: a number as it is, or (label, offset) from the first mark whose label starts with label."""
    if not isinstance(when, tuple):
        return when
    label, offset = when
    for t, name in marks(take):
        if name.startswith(label):
            return round(t + offset, 3)
    raise SystemExit(f'{take} has no mark starting with {label!r}')


def make_raw(take):
    """Turns a take's screencast frames into raw.mp4 at 30 fps, each frame held until the next one came."""
    d = ROOT / take
    if (d / 'raw.mp4').exists():
        return
    f = json.loads((d / 'frames.json').read_text())
    rows = []
    for a, b in zip(f, f[1:] + [None]):
        rows.append(f"file 'frames/{a['file']}'\nduration {((b['t'] - a['t']) if b else 1.0):.4f}\n")
    rows.append(f"file 'frames/{f[-1]['file']}'\n")
    (d / 'list.txt').write_text(''.join(rows))
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-fps_mode', 'cfr',
                    '-r', str(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', 'raw.mp4'], cwd=d, check=True)


def render_cuts():
    files, timeline, t = [], [], 0.0
    for i, cut in enumerate(CUTS):
        take, a, b, speed, crop, cap = cut[:6]
        a, b = at(take, a), at(take, b)
        hold = cut[6] if len(cut) > 6 else 0
        make_raw(take)
        vf = []
        if crop == 'phone':
            # A phone take (780 x 1688) stands in the middle of the frame on the page colour.
            vf.append(f'scale=-2:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:0:color={PAGE}')
        elif crop:
            vf.append('crop={2}:{3}:{0}:{1},scale=1920:1080:flags=lanczos'.format(*crop))
        vf.append(f'setpts=(PTS-STARTPTS)/{speed}')
        if hold:
            vf.append(f'tpad=stop_mode=clone:stop_duration={hold}')
        vf.append(f'fps={FPS}')
        vf.append('scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709')
        out = WORK / f'cut{i:02d}.mp4'
        run('ffmpeg', '-y', '-v', 'error', '-ss', f'{a}', '-to', f'{b}', '-i', str(ROOT / take / 'raw.mp4'), '-vf', ','.join(vf),
            '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p', *HD, str(out))
        d = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(out)],
                                 capture_output=True, text=True).stdout)
        timeline.append({'cut': i, 'take': take, 'a': a, 'b': b, 'speed': speed, 'start': t, 'end': t + d, 'caption': cap})
        files.append(out)
        t += d
    return files, timeline, t


def end_card(start):
    bg = tuple(int(PAGE[k:k + 2], 16) for k in (2, 4, 6))
    im = Image.new('RGB', (1920, 1080), bg)
    d = ImageDraw.Draw(im)
    ink, teal = (29, 29, 27), (31, 92, 90)
    serif = ImageFont.truetype('C:/Windows/Fonts/georgiab.ttf', 120)
    mono = ImageFont.truetype('C:/Windows/Fonts/consola.ttf', 54)
    sans = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 44)
    def centre(y, text, font, fill):
        w = d.textlength(text, font=font)
        d.text(((1920 - w) / 2, y), text, font=font, fill=fill)
    centre(330, 'WardWise', serif, ink)
    centre(520, 'wardwise.midknight-labs.workers.dev', mono, teal)
    centre(640, 'Try it: give $25 by test card, no login.', sans, ink)
    centre(712, 'Fictional campaign. Sandbox test money. Demo cap made up for this demo.', sans, (90, 86, 80))
    png = WORK / 'endcard.png'
    im.save(png)
    out = WORK / 'cut99.mp4'
    run('ffmpeg', '-y', '-v', 'error', '-loop', '1', '-t', f'{END_CARD}', '-i', str(png), '-vf', f'fps={FPS},fade=in:0:15,scale=out_range=tv:out_color_matrix=bt709',
        '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', *HD, str(out))
    return out


def ass_time(s):
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f'{int(h)}:{int(m):02d}:{sec:05.2f}'


def captions(timeline):
    lines = []
    for seg in timeline:
        if lines and lines[-1]['id'] == seg['caption']:
            lines[-1]['end'] = seg['end']
        else:
            lines.append({'id': seg['caption'], 'text': C[seg['caption']], 'start': seg['start'], 'end': seg['end']})
    head = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Segoe UI Semibold,54,&H00FFFFFF,&H00FFFFFF,&H281B1D1D,&H00000000,0,0,0,0,100,100,0,0,3,16,0,2,120,120,64,1
Style: Speed,Segoe UI Semibold,40,&H00FFFFFF,&H00FFFFFF,&H00275CC9,&H00000000,0,0,0,0,100,100,0,0,3,12,0,9,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    body = ''.join(f"Dialogue: 0,{ass_time(c['start'] + 0.15)},{ass_time(c['end'] - 0.1)},Cap,,0,0,0,,{{\\fad(200,200)}}{c['text']}\n" for c in lines)
    # Any part shown faster than real time says so on screen, top right, for as long as it runs.
    body += ''.join(f"Dialogue: 1,{ass_time(s['start'])},{ass_time(s['end'])},Speed,,0,0,0,,Sped up {s['speed']:g}x\n" for s in timeline if s['speed'] > 1)
    (WORK / 'captions.ass').write_text(head + body, encoding='utf-8')
    return lines


def to_out(timeline, take, t):
    for seg in timeline:
        if seg['take'] == take and seg['a'] <= t <= seg['b']:
            return seg['start'] + (t - seg['a']) / seg['speed']
    return None


def audio(timeline, total):
    n = int(total * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(7)
    note = lambda m: 440.0 * 2 ** ((m - 69) / 12)
    # Fmaj7, C/E, Am7, G(add9): each chord 6 s, a slow warm pad with a soft arpeggio above it.
    chords = [[53, 57, 60, 64], [52, 55, 60, 67], [45, 57, 60, 64], [43, 55, 59, 62]]
    span = 6.0
    pad = np.zeros(n)
    for k in range(int(total / span) + 2):
        chord = chords[k % len(chords)]
        s0, s1 = int(max(0, (k * span - 1.0)) * SR), int(min(total, (k + 1) * span + 1.5) * SR)
        if s0 >= n:
            break
        seg = t[s0:s1] - t[s0]
        env = np.minimum(1, seg / 1.6) * np.minimum(1, (seg[-1] - seg) / 1.8)
        for m in chord:
            for det in (-0.12, 0.12):
                pad[s0:s1] += env * np.sin(2 * np.pi * note(m) * (1 + det / 100) * seg + rng.uniform(0, 6.28)) * 0.08
        pad[s0:s1] += env * np.sin(2 * np.pi * note(chord[0] - 12) * seg) * 0.10
    arp = np.zeros(n)
    step = 0.5
    for k in range(int(total / step)):
        chord = chords[int(k * step / span) % len(chords)]
        m = chord[[0, 2, 1, 3, 2, 1, 3, 2][k % 8]] + 12
        s0 = int(k * step * SR)
        seg = np.arange(int(1.2 * SR)) / SR
        s1 = min(n, s0 + len(seg))
        tone = (np.sin(2 * np.pi * note(m) * seg) + 0.25 * np.sin(4 * np.pi * note(m) * seg)) * np.exp(-seg * 3.2) * np.minimum(1, seg / 0.01)
        arp[s0:s1] += tone[:s1 - s0] * 0.05
    music = sosfilt(butter(2, 2600, 'low', fs=SR, output='sos'), pad + arp)
    fade = np.minimum(1, t / 2.0) * np.minimum(1, (total - t) / 4.0)
    music *= fade
    fx = np.zeros(n)
    def put(at, sound):
        s0 = int(at * SR)
        if 0 <= s0 < n:
            s1 = min(n, s0 + len(sound))
            fx[s0:s1] += sound[:s1 - s0]
    cs = np.arange(int(0.06 * SR)) / SR
    click = (np.sin(2 * np.pi * 1900 * cs) * 0.5 + rng.normal(0, 0.25, len(cs))) * np.exp(-cs * 90) * 0.16
    click = sosfilt(butter(2, [700, 5000], 'band', fs=SR, output='sos'), click)
    ch = np.arange(int(0.9 * SR)) / SR
    chime = sum(np.sin(2 * np.pi * note(m) * ch) * np.exp(-ch * 5) * np.where(ch >= d, 1, 0) for m, d in ((79, 0), (84, 0.11))) * 0.09
    used = []
    for take in sorted({s['take'] for s in timeline}):
        for at, label in marks(take):
            o = to_out(timeline, take, at)
            if o is None:
                continue
            if label == 'click':
                put(o - 0.01, click)
            elif label.startswith(CHIMES) and ('COMPLETED' in label or 'final' in label) and all(abs(o - u) > 0.5 for u in used):
                used.append(o)
                put(o, chime)
    mix = music + fx
    mix = mix / max(1e-9, np.max(np.abs(mix))) * 0.7
    stereo = np.stack([mix, mix], axis=1)
    pcm = (stereo * 32767).astype(np.int16)
    with wave.open(str(WORK / 'mix.wav'), 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())


def loudnorm(src, dst):
    first = subprocess.run(['ffmpeg', '-hide_banner', '-i', str(src), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
                           capture_output=True, text=True).stderr
    j = json.loads(first[first.rindex('{'):first.rindex('}') + 1])
    af = (f"loudnorm=I=-16:TP=-1.5:LRA=11:measured_I={j['input_i']}:measured_TP={j['input_tp']}:measured_LRA={j['input_lra']}"
          f":measured_thresh={j['input_thresh']}:offset={j['target_offset']}:linear=true:print_format=json")
    run('ffmpeg', '-y', '-v', 'error', '-i', str(src), '-af', af, '-ar', str(SR), str(dst))


def main():
    files, timeline, t = render_cuts()
    files.append(end_card(t))
    total = t + END_CARD
    (WORK / 'list.txt').write_text(''.join(f"file '{f.as_posix()}'\n" for f in files))
    run('ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', str(WORK / 'list.txt'), '-c', 'copy', str(WORK / 'video.mp4'))
    lines = captions(timeline)
    audio(timeline, total)
    loudnorm(WORK / 'mix.wav', WORK / 'mix-norm.wav')
    ass = (WORK / 'captions.ass').as_posix().replace(':', '\\:')
    out = ROOT / 'wardwise-film.mp4'
    run('ffmpeg', '-y', '-v', 'error', '-i', str(WORK / 'video.mp4'), '-i', str(WORK / 'mix-norm.wav'), '-vf', f"ass='{ass}'",
        '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', *HD, '-r', str(FPS),
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', str(out))
    (ROOT / 'captions.json').write_text(json.dumps({'total': total, 'captions': lines, 'timeline': timeline}, indent=1))
    print(f'{out}  {total:.2f} s  {len(lines)} captions')


if __name__ == '__main__':
    main()
