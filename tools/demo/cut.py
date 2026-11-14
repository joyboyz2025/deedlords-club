# The pitch cut of the demo film: beats taken out of filmed clips, a band of words under each, chapter cards, a voice.
#
#   python3 tools/demo/cut.py <script.json> <out.mp4> [voice]
#
# The script names the folders its clips are in (`clips`), a `pace` for the voice, and the beats in order:
#   {"card": "Title", "sub": "smaller line", "over": "clip", "at": 3.0, "seconds": 1.4}     a chapter card over a blurred picture
#   {"id": "A1", "clip": "n1-wallets", "from": 0.5, "say": [...], "show": "words with <b>stress</b>", "tech": "LABEL"}
#   {"id": "T1", "slide": "Title", "over": "clip", "at": 1.0, "say": [...], "table": {"head": [...], "rows": [[...], ...]}}   a table
#   {"id": "U1", "slide": "Title", "over": "clip", "at": 1.0, "say": [...], "points": ["...", ...]}                         a list
# A beat lasts as long as its line takes to say (plus `pad`, at least `min`); `"from": "+"` goes on where the last beat
# of the same clip stopped. Nothing is sped up: a beat is a piece of a clip at the speed it was filmed. The clips were
# filmed with captions of their own at the bottom; the band covers that strip, so the words under the picture are
# always this script's. `say` is spoken as in narrate.py (pieces, pauses, a speed per piece).
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import narrate

LEAD, PAD = 0.2, 0.3
BAND_TOP, HEIGHT, WIDTH = 896, 1080, 1920
GOLD, WHITE, CREAM = "&H003FC9F8&", "&H00FFFFFF&", "&H00CFE6F3&"
ASS_HEAD = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Avenir Next Demi Bold,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,150,150,0,1
Style: Tech,Avenir Next Demi Bold,26,&H003FC9F8,&H003FC9F8,&H00000000,&H00000000,0,0,0,0,100,100,3,0,1,0,0,5,60,60,0,1
Style: Title,Rockwell,132,&H003FC9F8,&H003FC9F8,&H00060A17,&H00000000,1,0,0,0,100,100,0,0,1,0,3,5,120,120,0,1
Style: Sub,Avenir Next Demi Bold,46,&H00CFE6F3,&H00CFE6F3,&H00000000,&H00000000,0,0,0,0,100,100,1,0,1,0,2,5,160,160,0,1
Style: Head,Rockwell,84,&H003FC9F8,&H003FC9F8,&H00060A17,&H00000000,1,0,0,0,100,100,0,0,1,0,2,5,100,100,0,1
Style: Col,Avenir Next Demi Bold,27,&H003FC9F8,&H003FC9F8,&H00000000,&H00000000,0,0,0,0,100,100,3,0,1,0,0,4,40,40,0,1
Style: Label,Avenir Next Demi Bold,38,&H00CFE6F3,&H00CFE6F3,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,4,40,40,0,1
Style: Dim,Avenir Next Medium,37,&H0097AEBB,&H0097AEBB,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,4,40,40,0,1
Style: Cell,Avenir Next Demi Bold,38,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,4,40,40,0,1
Style: Point,Avenir Next Demi Bold,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,4,40,40,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def run(cmd):
    done = subprocess.run(cmd, capture_output=True, text=True)
    if done.returncode != 0:
        raise SystemExit("ffmpeg: " + done.stderr[-900:])


def ass_words(html):
    return html.replace("<b>", "{\\c" + GOLD + "}").replace("</b>", "{\\c" + WHITE + "}").replace("\n", "\\N")


def write_ass(path, lines):
    with open(path, "w") as f:
        f.write(ASS_HEAD)
        for style, x, y, words in lines:
            f.write("Dialogue: 0,0:00:00.00,0:10:00.00,%s,,0,0,0,,{\\pos(%d,%d)}%s\n" % (style, x, y, words))


def main():
    script_path, out = sys.argv[1:3]
    voice = sys.argv[3] if len(sys.argv) > 3 else "am_michael"
    script = json.load(open(script_path))
    work = os.path.splitext(out)[0] + ".parts"
    os.makedirs(work, exist_ok=True)
    pace = script.get("pace", 1.0)

    def clip_path(name):
        for folder in script["clips"]:
            path = os.path.join(os.path.expanduser(folder), name + ".mp4")
            if os.path.exists(path):
                return path
        raise SystemExit("no clip %s in %s" % (name, script["clips"]))

    beats = script["beats"]
    spoken = [beat for beat in beats if beat.get("say")]
    narrate.speak(voice, [narrate.pieces_of(beat["say"], pace * beat.get("pace", 1.0)) for beat in spoken])
    for beat in spoken:
        beat["wav"] = os.path.join(narrate.folder(voice), "cut-%s.wav" % beat["id"])
        beat["said"] = narrate.line_audio(voice, beat["say"], pace * beat.get("pace", 1.0), beat["wav"])

    parts, clock, where, captions = [], 0.0, {}, []
    for n, beat in enumerate(beats):
        part = os.path.join(work, "part-%02d.mp4" % n)
        ass = os.path.join(work, "part-%02d.ass" % n)
        look = "libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -r 30".split()
        if "slide" in beat:
            seconds = beat.get("len") or max(beat.get("min", 3.0), beat.get("said", 0) + LEAD + beat.get("pad", 0.5))
            still = os.path.join(work, "part-%02d.png" % n)
            run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "%.2f" % beat.get("at", 0), "-i", clip_path(beat["over"]), "-frames:v", "1", still])
            lines, boxes = [("Head", WIDTH // 2, 150, beat["slide"])], []
            if beat.get("table"):
                xs, top, step = [150, 640, 1230], 300, 122
                rows = beat["table"]["rows"]
                boxes.append("drawbox=x=1190:y=255:w=640:h=%d:color=0xf8c93f@0.10:t=fill" % (step * len(rows) + 90))
                for x, words in zip(xs, beat["table"]["head"]):
                    lines.append(("Col", x, top, words.upper()))
                for r, row in enumerate(rows):
                    y = top + 105 + r * step
                    boxes.append("drawbox=x=130:y=%d:w=1700:h=2:color=0xf8c93f@0.28:t=fill" % (y - step // 2))
                    for x, style, words in zip(xs, ("Label", "Dim", "Cell"), row):
                        lines.append((style, x, y, ass_words(words)))
            for i, point in enumerate(beat.get("points", [])):
                y = 330 + i * (640 // max(len(beat["points"]), 4))
                lines.append(("Point", 290, y, "{\\c" + GOLD + "}" + str(i + 1) + "{\\c" + WHITE + "}     " + ass_words(point)))
            write_ass(ass, lines)
            see = "scale=%d:%d,boxblur=26:3,eq=brightness=-0.42:saturation=0.6,%sass=%s,fade=t=in:d=0.2,fade=t=out:st=%.2f:d=0.2" % (WIDTH, HEIGHT, "".join(box + "," for box in boxes), ass, seconds - 0.2)
            run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-t", "%.2f" % seconds, "-i", still, "-vf", see, "-an", "-c:v"] + look + [part])
            if beat.get("say"):
                beat["at"] = clock + LEAD
                captions.append({"id": beat["id"], "at": round(clock, 2), "clip": "slide", "from": 0, "text": beat["slide"]})
            print("%-4s %6.1f  %4.1f s  slide: %s  %s" % (beat.get("id", ""), clock, seconds, beat["slide"], "said %.1f" % beat["said"] if beat.get("say") else ""))
        elif "card" in beat:
            seconds = beat.get("seconds", 1.15)
            still = os.path.join(work, "part-%02d.png" % n)
            run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "%.2f" % beat.get("at", 0), "-i", clip_path(beat["over"]), "-frames:v", "1", still])
            write_ass(ass, [("Title", WIDTH // 2, 470 if beat.get("sub") else 540, beat["card"]), ("Sub", WIDTH // 2, 640, beat.get("sub", ""))])
            see = "scale=%d:%d,boxblur=22:3,eq=brightness=-0.34:saturation=0.7,ass=%s,fade=t=in:d=0.18,fade=t=out:st=%.2f:d=0.18" % (WIDTH, HEIGHT, ass, seconds - 0.18)
            run(["ffmpeg", "-y", "-loglevel", "error", "-loop", "1", "-t", "%.2f" % seconds, "-i", still, "-vf", see, "-an", "-c:v"] + look + [part])
        else:
            seconds = beat.get("len") or max(beat.get("min", 2.0), beat.get("said", 0) + LEAD + beat.get("pad", PAD))
            start = where.get(beat["clip"], 0.0) if beat.get("from", 0) == "+" else float(beat.get("from", 0))
            where[beat["clip"]] = start + seconds
            words = [("Cap", WIDTH // 2, 1000 if beat.get("tech") else 988, ass_words(beat.get("show", "")))]
            if beat.get("tech"):
                words.append(("Tech", WIDTH // 2, 925, beat["tech"]))
            write_ass(ass, words)
            see = "fps=30,scale=%d:%d,tpad=stop_mode=clone:stop_duration=30,trim=0:%.3f,setpts=PTS-STARTPTS,drawbox=x=0:y=%d:w=%d:h=%d:color=0x170a06:t=fill,drawbox=x=0:y=%d:w=%d:h=2:color=0xf8c93f@0.55:t=fill,ass=%s" % (
                WIDTH, HEIGHT, seconds, BAND_TOP, WIDTH, HEIGHT - BAND_TOP, BAND_TOP, WIDTH, ass)
            run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "%.3f" % start, "-i", clip_path(beat["clip"]), "-vf", see, "-an", "-c:v"] + look + [part])
            if beat.get("say"):
                beat["at"] = clock + LEAD
                captions.append({"id": beat["id"], "at": round(clock, 2), "clip": beat["clip"], "from": round(start, 2), "text": beat.get("show", "").replace("<b>", "").replace("</b>", "")})
            print("%-4s %6.1f  %4.1f s  %-11s from %5.1f  %s" % (beat.get("id", ""), clock, seconds, beat["clip"], start, "said %.1f" % beat["said"] if beat.get("say") else ""))
        parts.append(part)
        clock += narrate.seconds(part)
    listing = os.path.join(work, "list.txt")
    open(listing, "w").write("".join("file '%s'\n" % os.path.abspath(part) for part in parts))
    silent = os.path.splitext(out)[0] + "-silent.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", "-movflags", "+faststart", silent])
    total = narrate.seconds(silent)
    json.dump({"seconds": round(total, 2), "captions": captions}, open(os.path.splitext(out)[0] + ".captions.json", "w"), indent=1)
    narrate.mix(silent, [beat for beat in beats if beat.get("say")], out, voice, total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
