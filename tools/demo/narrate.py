# Narration for the demo film: one spoken line per caption, laid a moment after its caption appears.
#
#   python3 tools/demo/narrate.py <film.mp4> <captions.json> <out.mp4> [voice]
#
# `captions.json` is what `film.mjs join` writes (each caption's id, text and second in the film); the words to say are
# in `narration.json` beside this file, by caption id. A line is a list of pieces: a string is spoken, a number is a
# pause in seconds, and {"t": "...", "speed": 0.9} speaks one piece slower or faster, which is how a phrase is stressed.
# A caption with several possible lines (the ticket in hand differs from take to take) lists {"if": "...", "say": [...]}
# and the first whose "if" is found in the caption's text is used.
#
# The voice is made on this machine by Kokoro-82M through mlx-audio (NARRATE_PYTHON, by default VoiceStudio's Python).
# Nothing is sent anywhere. The pieces are kept in NARRATE_DIR by text, voice and speed, so a second run only mixes.
# A line longer than the room before the next one is spoken again a little faster (up to 15%); if it still does not fit
# it is reported and nothing is mixed (FORCE=1 mixes anyway). The voice track is brought to -16 LUFS by one fixed gain.
#
# A voice named `eleven:<name>` (brian, george, daniel, adam, eric) is asked of ElevenLabs instead, a whole line at a
# time: the line's words are sent to api.elevenlabs.io with the key in ELEVENLABS_API_KEY, or in the file
# ELEVENLABS_KEY_FILE names. Each line is kept by its words and settings, so it is paid for once.
# Kokoro spells a word in capitals letter by letter, so the lines say "Near", not "NEAR", and "Deed Lords" in two words.
import glob, hashlib, json, os, subprocess, sys, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON = os.environ.get("NARRATE_PYTHON") or os.path.expanduser("~/Library/Application Support/VoiceStudio/runtime/project/.venv/bin/python3")
KEEP = os.environ.get("NARRATE_DIR") or os.path.join(HERE, "..", "..", "_notes", "video", "narration")
REPO = "mlx-community/Kokoro-82M-bf16"
LEAD = 0.3  # seconds between a caption appearing and its line starting
GAP = 0.2  # silence a line must leave before the next one
FASTEST = 1.15


ELEVEN = {"brian": "nPczCjzI2devNBz1zQrb", "george": "JBFqnCBsd6RMkjVDRZzb", "daniel": "onwK4e9ZLuTAKqWW03F9", "adam": "pNInz6obpgDQGcFmaJgB", "eric": "cjVigY5qzO86Huf0OWal"}
ELEVEN_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_multilingual_v2")


def folder(voice):
    """Where a voice's sound is kept."""
    path = os.path.join(KEEP, "takes-" + os.path.basename(voice.rstrip("/")) if voice.startswith("takes:") else voice.replace(":", "-"))
    os.makedirs(path, exist_ok=True)
    return path


def eleven_line(voice, line, pace, out):
    """One whole line from ElevenLabs, its silence trimmed, as `out`. Returns its seconds. Pauses are left to the punctuation."""
    name = voice.split(":", 1)[1]
    words = " ".join(piece["t"] if isinstance(piece, dict) else piece for piece in (line if isinstance(line, list) else [line]) if not isinstance(piece, (int, float)))
    settings = {"stability": 0.42, "similarity_boost": 0.78, "style": 0.3, "use_speaker_boost": True, "speed": round(min(1.18, max(0.8, pace)), 2)}
    kept = os.path.join(folder(voice), hashlib.sha1(json.dumps([name, ELEVEN_MODEL, settings, words]).encode()).hexdigest()[:16] + ".mp3")
    if not os.path.exists(kept):
        key = os.environ.get("ELEVENLABS_API_KEY") or open(os.path.expanduser(os.environ.get("ELEVENLABS_KEY_FILE", "~/Documents/deedlords-work/.elevenlabs-key"))).read().strip()
        body = json.dumps({"text": words, "model_id": ELEVEN_MODEL, "voice_settings": settings}).encode()
        ask = urllib.request.Request("https://api.elevenlabs.io/v1/text-to-speech/%s?output_format=mp3_44100_128" % ELEVEN.get(name, name), data=body, headers={"xi-api-key": key, "content-type": "application/json"})
        try:
            sound = urllib.request.urlopen(ask, timeout=120).read()
        except urllib.error.HTTPError as error:
            raise SystemExit("ElevenLabs answered %d: %s" % (error.code, error.read().decode()[:300]))
        open(kept, "wb").write(sound)
    trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", kept, "-af", "aresample=48000,aformat=channel_layouts=mono,%s,areverse,%s,areverse" % (trim, trim), out], check=True)
    return seconds(out)


def line_audio(voice, line, pace, out):
    """One line as `out`, by whichever engine the voice names. For Kokoro the pieces must have been spoken (`speak`)."""
    if voice.startswith("eleven:"):
        return eleven_line(voice, line, pace, out)
    return assemble(voice, pieces_of(line, pace), out)


def worker(jobs_path):
    """Runs under NARRATE_PYTHON: speaks every piece that is not on disk yet. The model is loaded once."""
    from pathlib import Path
    from mlx_audio.tts.generate import generate_audio
    from mlx_audio.tts.utils import load_model
    from mlx_audio.utils import get_model_name_parts

    jobs = [job for job in json.load(open(jobs_path)) if not os.path.exists(job["out"])]
    if not jobs:
        return
    snap = sorted(glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--" + REPO.replace("/", "--") + "/snapshots/*")))[-1]
    model = load_model(Path(snap), model_name_parts=get_model_name_parts(REPO))
    model.repo_id = REPO
    for job in jobs:
        folder, name = os.path.split(job["out"])
        generate_audio(text=job["text"], model=model, voice=job["voice"], speed=job["speed"], lang_code=job["voice"][0], output_path=folder, file_prefix=name[:-4], audio_format="wav", join_audio=True, verbose=False)


def seconds(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    return float(out.strip())


def pieces_of(line, quicker):
    """[(text, speed) | pause]: the pieces of one line, each speed multiplied by `quicker`."""
    out = []
    for piece in line if isinstance(line, list) else [line]:
        if isinstance(piece, (int, float)):
            out.append(float(piece))
        elif isinstance(piece, dict):
            out.append((piece["t"], round(piece.get("speed", 1.0) * quicker, 3)))
        else:
            out.append((piece, round(quicker, 3)))
    return out


def piece_path(voice, text, speed):
    name = hashlib.sha1(("%s|%s|%s" % (voice, speed, text)).encode()).hexdigest()[:16]
    return os.path.join(folder(voice), name + ".wav")


def speak(voice, lines):
    if voice.startswith("eleven:"):
        return
    jobs = [{"text": p[0], "speed": p[1], "voice": voice, "out": piece_path(voice, *p)} for line in lines for p in line if isinstance(p, tuple)]
    path = os.path.join(folder(voice), "jobs.json")
    json.dump(jobs, open(path, "w"))
    env = dict(os.environ, HF_HUB_OFFLINE="1")
    subprocess.run([PYTHON, "-I", os.path.abspath(__file__), "--worker", path], check=True, env=env, stdout=subprocess.DEVNULL)


def assemble(voice, pieces, out):
    """One line: its pieces with the silence trimmed off both ends, and the pauses between them."""
    cmd, parts, names = ["ffmpeg", "-y", "-loglevel", "error"], [], []
    trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02"
    spoken = 0
    for i, piece in enumerate(pieces):
        if isinstance(piece, tuple):
            cmd += ["-i", piece_path(voice, *piece)]
            parts.append("[%d:a]aresample=48000,aformat=channel_layouts=mono,%s,areverse,%s,areverse[p%d]" % (spoken, trim, trim, i))
            spoken += 1
        else:
            parts.append("anullsrc=r=48000:cl=mono,atrim=0:%.3f[p%d]" % (piece, i))
        names.append("[p%d]" % i)
    parts.append("%sconcat=n=%d:v=0:a=1[line]" % ("".join(names), len(names)))
    subprocess.run(cmd + ["-filter_complex", ";".join(parts), "-map", "[line]", out], check=True)
    return seconds(out)


def mix(film, said, out, voice, film_seconds):
    """Lays each line's sound at its second (`at`, `wav`) over the film and writes `out`."""
    inputs, parts = [], []
    for i, entry in enumerate(said):
        inputs += ["-i", entry["wav"]]
        parts.append("[%d:a]adelay=%d:all=1[a%d]" % (i, int(entry["at"] * 1000), i))
    parts.append("%samix=inputs=%d:normalize=0,apad=whole_dur=%.2f[voice]" % ("".join("[a%d]" % i for i in range(len(said))), len(said), film_seconds))
    track = os.path.join(folder(voice), "track.wav")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error"] + inputs + ["-filter_complex", ";".join(parts), "-map", "[voice]", track], check=True)
    report = subprocess.run(["ffmpeg", "-hide_banner", "-i", track, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], capture_output=True, text=True).stderr
    loud = float(json.JSONDecoder().raw_decode(report[report.rindex("{") :])[0]["input_i"])
    gain = -15.0 - loud  # the limiter takes about one decibel back
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", film, "-i", track, "-filter_complex", "[1:a]volume=%.2fdB,alimiter=limit=0.75:level=false[voice]" % gain]
    subprocess.run(cmd + ["-map", "0:v", "-map", "[voice]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out], check=True)
    print("voice %s: %d lines, %.1f LUFS before a gain of %+.1f dB; wrote %s, %.1f s" % (voice, len(said), loud, gain, out, seconds(out)))


def main():
    film, captions_path, out = sys.argv[1:4]
    voice = sys.argv[4] if len(sys.argv) > 4 else "am_michael"
    film_seconds = seconds(film)
    captions = json.load(open(captions_path))["captions"]
    script = json.load(open(os.path.join(HERE, "narration.json")))
    said = []
    for caption in captions:
        line = script.get(caption["id"])
        if isinstance(line, list) and line and isinstance(line[0], dict) and "if" in line[0]:
            line = next((choice["say"] for choice in line if choice["if"] in caption["text"]), None)
        if line:
            said.append({"id": caption["id"], "at": caption["at"] + LEAD, "line": line})
    for i, entry in enumerate(said):
        entry["room"] = (said[i + 1]["at"] if i + 1 < len(said) else film_seconds) - entry["at"]
        entry["quicker"] = 1.0
    late = 0
    for attempt in (1, 2):
        speak(voice, [pieces_of(entry["line"], entry["quicker"]) for entry in said])
        late = 0
        for entry in said:
            entry["wav"] = os.path.join(folder(voice), "line-%s.wav" % entry["id"])
            entry["length"] = assemble(voice, pieces_of(entry["line"], entry["quicker"]), entry["wav"])
            over = entry["length"] - (entry["room"] - GAP)
            if over > 0 and attempt == 1:
                entry["quicker"] = min(FASTEST, round(entry["length"] / (entry["room"] - GAP) + 0.02, 2))
            late += over > 0
        if not late:
            break
    for entry in said:
        over = entry["length"] - (entry["room"] - GAP)
        note = ("  x%.2f" % entry["quicker"] if entry["quicker"] != 1 else "") + ("  <-- %.1f s too long" % over if over > 0 else "")
        print("%-4s %6.1f  %4.1f s of %4.1f%s" % (entry["id"], entry["at"], entry["length"], entry["room"], note))
    if late and not os.environ.get("FORCE"):
        print("%d lines too long: not mixed" % late)
        return 1
    mix(film, said, out, voice, film_seconds)
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--worker":
        worker(sys.argv[2])
    else:
        sys.exit(main())
