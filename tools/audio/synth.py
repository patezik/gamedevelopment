#!/usr/bin/env python3
"""Synthesises the Hollow Signal audio library (CNT-011). Standard library only.

Every sound is built from sines, filtered noise and envelopes with a fixed seed, so
`python3 tools/audio/synth.py` writes the same bytes every time. Nothing here uses external
samples: the files are the project's own work (CC0). Parameters of each sound are in the
functions below; the table with roles and provenance is docs/game-design/audio-library.md.

Usage: python3 tools/audio/synth.py [--check]   (--check only verifies the files on disk)
"""
import hashlib
import json
import math
import random
import struct
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / "apps/desktop/assets/audio"
MOBILE = ROOT / "apps/mobile/assets/audio"
SR = 22050
TAU = 2.0 * math.pi
PEAK_ONE_SHOT = 0.708  # -3 dBFS
PEAK_AMBIENT = 0.32  # about -10 dBFS: beds sit under everything else
LOOP_SECONDS = 12


def n_of(seconds):
    return int(round(seconds * SR))


def lowpass(x, cutoff):
    a = 1.0 - math.exp(-TAU * cutoff / SR)
    y, out = 0.0, []
    for v in x:
        y += a * (v - y)
        out.append(y)
    return out


def noise(rng, n):
    return [rng.uniform(-1.0, 1.0) for _ in range(n)]


def normalise(x, peak):
    top = max(abs(v) for v in x) or 1.0
    return [v * peak / top for v in x]


def fade_edges(x, seconds=0.006):
    k = min(n_of(seconds), len(x) // 2)
    for i in range(k):
        w = i / k
        x[i] *= w
        x[-1 - i] *= w
    return x


def seamless(x, blend):
    """Loop of len(x) - blend samples whose tail is crossfaded (equal power) into its head."""
    n = len(x) - blend
    out = x[:n]
    for i in range(blend):
        w = i / blend
        out[i] = x[i] * math.sin(w * math.pi / 2) + x[n + i] * math.cos(w * math.pi / 2)
    return out


def loop_noise(rng, seconds, cutoff, blend=1.0):
    raw = lowpass(noise(rng, n_of(seconds + blend)), cutoff)
    return seamless(raw, n_of(blend))


def cycles_sine(n, cycles, phase=0.0):
    """A sine with a whole number of cycles in n samples: it joins itself at the loop seam."""
    return [math.sin(TAU * cycles * i / n + phase) for i in range(n)]


def add_at(buf, start, sound, gain=1.0):
    for i, v in enumerate(sound):
        j = start + i
        if 0 <= j < len(buf):
            buf[j] += v * gain


def hann(n):
    return [0.5 - 0.5 * math.cos(TAU * i / (n - 1)) for i in range(n)]


def creak(rng, seconds=0.7, base=380.0):
    n = n_of(seconds)
    env = hann(n)
    phase, out = 0.0, []
    for i in range(n):
        t = i / SR
        f = base * (1.0 + 0.25 * math.sin(TAU * 3.1 * t)) * (1.0 - 0.3 * t / seconds)
        f *= 1.0 + 0.04 * rng.uniform(-1.0, 1.0)
        phase += TAU * f / SR
        stutter = 0.6 + 0.4 * math.sin(TAU * 31.0 * t)
        out.append((math.sin(phase) + 0.5 * math.sin(2.01 * phase)) * env[i] * stutter)
    return out


def drip(freq=1500.0, seconds=0.35):
    n = n_of(seconds)
    out = []
    for i in range(n):
        t = i / SR
        f = freq * (1.0 + 0.5 * math.exp(-t * 45.0))
        out.append(math.sin(TAU * f * t) * math.exp(-t * 22.0))
    return out


def groan(freq, seconds):
    n = n_of(seconds)
    env = hann(n)
    out = []
    for i in range(n):
        t = i / SR
        f = freq * (1.0 - 0.06 * t / seconds)
        vib = 1.0 + 0.012 * math.sin(TAU * 4.5 * t)
        out.append((math.sin(TAU * f * vib * t) + 0.5 * math.sin(TAU * f * 1.498 * t)) * env[i])
    return out


# ---- ambient loops ---------------------------------------------------------------------------


def amb_bright():
    """Daylight hall: a faint room tone, a soft draught and a distant tick."""
    rng = random.Random(101)
    n = n_of(LOOP_SECONDS)
    wind = loop_noise(rng, LOOP_SECONDS, 700.0)
    swell = cycles_sine(n, 2, 0.0)
    hum = cycles_sine(n, 50 * LOOP_SECONDS)
    x = [wind[i] * (0.5 + 0.25 * swell[i]) * 0.9 + hum[i] * 0.05 for i in range(n)]
    for t in (2.4, 7.9):
        add_at(x, n_of(t), drip(2300.0, 0.2), 0.05)
    return normalise(x, PEAK_AMBIENT * 0.8)


def amb_dim():
    """Dim corridor: low building drone, wind and the occasional creak."""
    rng = random.Random(202)
    n = n_of(LOOP_SECONDS)
    wind = loop_noise(rng, LOOP_SECONDS, 420.0)
    swell = cycles_sine(n, 3, 1.0)
    drone = cycles_sine(n, 55 * LOOP_SECONDS)
    fifth = cycles_sine(n, 82 * LOOP_SECONDS, 0.5)
    x = [0.55 * drone[i] + 0.22 * fifth[i] + wind[i] * (0.9 + 0.4 * swell[i]) for i in range(n)]
    add_at(x, n_of(3.0), creak(rng, 0.7, 360.0), 0.12)
    add_at(x, n_of(8.6), creak(rng, 0.9, 300.0), 0.1)
    return normalise(x, PEAK_AMBIENT)


def amb_dark():
    """Dark room: a lower drone, dark wind, drips and a slow groan in the structure."""
    rng = random.Random(303)
    n = n_of(LOOP_SECONDS)
    wind = loop_noise(rng, LOOP_SECONDS, 260.0)
    breath = cycles_sine(n, 2, 2.0)
    d1 = cycles_sine(n, 41 * LOOP_SECONDS)
    d2 = cycles_sine(n, 61 * LOOP_SECONDS, 1.0)
    x = [(0.6 * d1[i] + 0.28 * d2[i]) * (0.8 + 0.2 * breath[i]) + wind[i] * 1.3 for i in range(n)]
    for t, f in ((1.7, 1700.0), (4.1, 1350.0), (9.6, 1550.0)):
        add_at(x, n_of(t), drip(f), 0.1)
    add_at(x, n_of(5.4), groan(92.0, 3.2), 0.28)
    return normalise(x, PEAK_AMBIENT)


def amb_night():
    """Night: colder and quieter than dark, thin high wind and rare tonal moans."""
    rng = random.Random(404)
    n = n_of(LOOP_SECONDS)
    wind = loop_noise(rng, LOOP_SECONDS, 900.0)
    gust = cycles_sine(n, 1, 0.3)
    d1 = cycles_sine(n, 36 * LOOP_SECONDS)
    x = [d1[i] * 0.35 + wind[i] * (0.7 + 0.5 * gust[i]) for i in range(n)]
    add_at(x, n_of(2.0), groan(138.0, 3.6), 0.2)
    add_at(x, n_of(8.0), groan(104.0, 3.0), 0.17)
    return normalise(x, PEAK_AMBIENT * 0.85)


def amb_boiler():
    """Boiler room: a low machine hum with a slow pulse, rumble and pipe knocks."""
    rng = random.Random(505)
    n = n_of(LOOP_SECONDS)
    rumble = loop_noise(rng, LOOP_SECONDS, 150.0)
    pulse = cycles_sine(n, 6, 0.0)
    h1 = cycles_sine(n, 48 * LOOP_SECONDS)
    h2 = cycles_sine(n, 96 * LOOP_SECONDS, 0.7)
    h3 = cycles_sine(n, 144 * LOOP_SECONDS, 1.9)
    x = [
        (0.6 * h1[i] + 0.35 * h2[i] + 0.15 * h3[i]) * (0.8 + 0.2 * pulse[i]) + rumble[i] * 2.4
        for i in range(n)
    ]
    for t in (3.3, 3.55, 9.1):
        add_at(x, n_of(t), drip(420.0, 0.3), 0.18)
    return normalise(x, PEAK_AMBIENT)


# ---- stingers (events of the Godot AudioDirector plus two spare ones) -------------------------


def thump(freq_from, freq_to, seconds, decay):
    n = n_of(seconds)
    out, phase = [], 0.0
    for i in range(n):
        t = i / SR
        f = freq_to + (freq_from - freq_to) * math.exp(-t * 18.0)
        phase += TAU * f / SR
        out.append(math.sin(phase) * math.exp(-t * decay))
    return out


def st_cluster():
    """sanity_drop: a dissonant low cluster that swells and cuts off."""
    rng = random.Random(11)
    n = n_of(1.8)
    hiss = lowpass(noise(rng, n), 900.0)
    freqs = (110.0, 116.5, 123.5, 164.8, 174.6)
    x = []
    for i in range(n):
        t, p = i / SR, i / n
        swell = math.sin(min(p / 0.8, 1.0) * math.pi / 2) ** 2 * (1.0 - max(0.0, (p - 0.85) / 0.15))
        trem = 0.8 + 0.2 * math.sin(TAU * 7.0 * t)
        tone = sum(math.sin(TAU * f * t) for f in freqs) / len(freqs)
        x.append((tone * 0.8 + hiss[i] * 1.2) * swell * trem)
    return fade_edges(normalise(x, PEAK_ONE_SHOT))


def st_riser():
    """static_threshold: noise and a gliding tone rising into a crackling cut."""
    rng = random.Random(12)
    n = n_of(1.2)
    x, phase, gate = [], 0.0, 1.0
    for i in range(n):
        p = i / n
        if i % 330 == 0:
            gate = 1.0 if rng.random() < 0.3 + 0.6 * p else 0.1
        phase += TAU * (180.0 + 1100.0 * p * p) / SR
        x.append((math.sin(phase) * 0.5 + rng.uniform(-1.0, 1.0) * 0.5 * gate) * p**1.5)
    return fade_edges(normalise(x, PEAK_ONE_SHOT), 0.01)


def st_ring():
    """incoming_call: a detuned two-tone ring with a hiss; wrong in a quiet building."""
    rng = random.Random(13)
    n = n_of(2.0)
    x = []
    for i in range(n):
        t = i / SR
        cycle = t % 0.7
        env = math.sin(math.pi * cycle / 0.42) ** 0.5 if cycle < 0.42 else 0.0
        tone = math.sin(TAU * 440.0 * t) + math.sin(TAU * 466.0 * t) * 0.9
        x.append(tone * env * 0.5 + rng.uniform(-1.0, 1.0) * 0.05 * (1.0 - t / 2.0))
    return fade_edges(normalise(x, PEAK_ONE_SHOT), 0.01)


def st_fall():
    """game_over: a heavy hit and a long tone sinking toward silence."""
    rng = random.Random(14)
    n = n_of(3.5)
    body = lowpass(noise(rng, n), 300.0)
    x, phase = [], 0.0
    for i in range(n):
        p = i / n
        phase += TAU * (98.0 - 56.0 * p) / SR
        env = (1.0 - p) ** 1.6
        x.append((math.sin(phase) * 0.7 + body[i] * 2.0) * env)
    add_at(x, 0, thump(110.0, 38.0, 1.2, 3.0), 1.0)
    return fade_edges(normalise(x, PEAK_ONE_SHOT))


def st_hit():
    """A short low hit (spare)."""
    rng = random.Random(15)
    x = thump(120.0, 32.0, 0.9, 5.5)
    burst = lowpass(noise(rng, len(x)), 1200.0)
    for i in range(n_of(0.12)):
        x[i] += burst[i] * math.exp(-i / SR * 30.0) * 1.5
    return fade_edges(normalise(x, PEAK_ONE_SHOT))


def st_heartbeat():
    """Two heartbeats (spare)."""
    x = [0.0] * n_of(2.0)
    for start in (0.0, 0.9):
        add_at(x, n_of(start), thump(75.0, 45.0, 0.25, 16.0), 1.0)
        add_at(x, n_of(start + 0.26), thump(65.0, 40.0, 0.25, 18.0), 0.7)
    return fade_edges(normalise(x, PEAK_ONE_SHOT))


# ---- phone OS sounds --------------------------------------------------------------------------


def bell(freq, seconds, decay):
    n = n_of(seconds)
    return [
        (
            math.sin(TAU * freq * i / SR)
            + 0.35 * math.sin(TAU * freq * 2.76 * i / SR) * math.exp(-i / SR * 6.0)
        )
        * math.exp(-i / SR * decay)
        for i in range(n)
    ]


def ph_notify():
    x = [0.0] * n_of(0.9)
    add_at(x, 0, bell(880.0, 0.6, 7.0))
    add_at(x, n_of(0.14), bell(1318.5, 0.7, 6.0), 0.9)
    return fade_edges(normalise(x, PEAK_ONE_SHOT))


def ph_message():
    x = [0.0] * n_of(0.45)
    add_at(x, 0, bell(660.0, 0.3, 14.0))
    add_at(x, n_of(0.09), bell(990.0, 0.35, 13.0), 0.9)
    return fade_edges(normalise(x, PEAK_ONE_SHOT))


def ph_ring():
    """A ring cadence, 4 s: a double burst of a two-tone, a pause, again."""
    n = n_of(4.0)
    x = []
    for i in range(n):
        t = i / SR
        cycle = t % 2.0
        on = 1.0 if (cycle < 0.4 or 0.6 <= cycle < 1.0) else 0.0
        flutter = 0.75 + 0.25 * math.sin(TAU * 20.0 * t)
        tone = math.sin(TAU * 440.0 * t) + math.sin(TAU * 480.0 * t)
        x.append(tone * on * flutter)
    return fade_edges(normalise(x, PEAK_ONE_SHOT), 0.01)


def ph_call_end():
    x = [0.0] * n_of(0.8)
    for k, f in enumerate((520.0, 390.0)):
        add_at(x, n_of(0.28 * k), bell(f, 0.4, 9.0))
    return fade_edges(normalise(x, PEAK_ONE_SHOT))


def ph_scan_ok():
    n = n_of(0.3)
    x, phase = [], 0.0
    for i in range(n):
        t = i / SR
        phase += TAU * (880.0 + 880.0 * min(t / 0.15, 1.0)) / SR
        x.append(math.sin(phase) * math.exp(-t * 9.0))
    click = [math.sin(TAU * 3000.0 * i / SR) * math.exp(-i / SR * 400.0) for i in range(n_of(0.02))]
    add_at(x, 0, click, 0.8)
    return fade_edges(normalise(x, PEAK_ONE_SHOT))


def ph_error():
    n = n_of(0.5)
    x = []
    for i in range(n):
        t = i / SR
        on = 1.0 if (t % 0.25) < 0.14 else 0.0
        saw = 2.0 * ((t * 150.0) % 1.0) - 1.0
        x.append((saw * 0.6 + math.sin(TAU * 150.0 * t) * 0.6) * on)
    return fade_edges(normalise(lowpass(x, 1100.0), PEAK_ONE_SHOT), 0.008)


SOUNDS = [
    (DESKTOP / "ambient/ambient_bright.wav", amb_bright, "ambient"),
    (DESKTOP / "ambient/ambient_dim.wav", amb_dim, "ambient"),
    (DESKTOP / "ambient/ambient_dark.wav", amb_dark, "ambient"),
    (DESKTOP / "ambient/ambient_night.wav", amb_night, "ambient"),
    (DESKTOP / "ambient/ambient_boiler.wav", amb_boiler, "ambient"),
    (DESKTOP / "stingers/stinger_sanity_drop.wav", st_cluster, "oneshot"),
    (DESKTOP / "stingers/stinger_static_threshold.wav", st_riser, "oneshot"),
    (DESKTOP / "stingers/stinger_incoming_call.wav", st_ring, "oneshot"),
    (DESKTOP / "stingers/stinger_game_over.wav", st_fall, "oneshot"),
    (DESKTOP / "stingers/stinger_hit.wav", st_hit, "oneshot"),
    (DESKTOP / "stingers/stinger_heartbeat.wav", st_heartbeat, "oneshot"),
    (MOBILE / "notify.wav", ph_notify, "oneshot"),
    (MOBILE / "message.wav", ph_message, "oneshot"),
    (MOBILE / "ring.wav", ph_ring, "oneshot"),
    (MOBILE / "call_end.wav", ph_call_end, "oneshot"),
    (MOBILE / "scan_ok.wav", ph_scan_ok, "oneshot"),
    (MOBILE / "error.wav", ph_error, "oneshot"),
]


def encode(samples):
    pcm = bytearray()
    for v in samples:
        pcm += struct.pack("<h", max(-32767, min(32767, int(round(v * 32767.0)))))
    return bytes(pcm)


def write_wav(path, samples):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(encode(samples))


def verify(path, kind):
    """Peak below clipping and, for loops, a seam no rougher than the signal itself."""
    with wave.open(str(path), "rb") as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, SR), path
        raw = w.readframes(w.getnframes())
    s = [v[0] / 32768.0 for v in struct.iter_unpack("<h", raw)]
    peak = max(abs(v) for v in s)
    limit = PEAK_AMBIENT + 0.01 if kind == "ambient" else PEAK_ONE_SHOT + 0.01
    assert peak <= limit and peak < 0.95, f"{path.name}: peak {peak:.3f}"
    if kind == "ambient":
        steps = sorted(abs(s[i + 1] - s[i]) for i in range(len(s) - 1))
        p99 = steps[int(len(steps) * 0.99)]
        seam = abs(s[0] - s[-1])
        assert seam <= max(p99, 1e-4) * 2.0, f"{path.name}: seam {seam:.5f} vs p99 step {p99:.5f}"
    return peak, len(s) / SR, len(raw) + 44


ROLES = {
    "ambient_bright.wav": ("loop", "Фон светлых мест (lighting bright)", "AudioDirector"),
    "ambient_dim.wav": ("loop", "Фон места с тусклым светом и запасной фон", "AudioDirector"),
    "ambient_dark.wav": ("loop", "Фон тёмных мест (lighting dark)", "AudioDirector"),
    "ambient_night.wav": ("loop", "Ночной фон: холоднее, тише, тоновые стоны", "AudioDirector"),
    "ambient_boiler.wav": ("loop", "Фон котельной: низкий гул", "AudioDirector"),
    "stinger_sanity_drop.wav": ("stinger", "Падение рассудка: диссонансный кластер", "AudioDirector"),
    "stinger_static_threshold.wav": ("stinger", "Порог Static: нарастающий шум", "AudioDirector"),
    "stinger_incoming_call.wav": ("stinger", "Входящий вызов на компьютере", "AudioDirector"),
    "stinger_game_over.wav": ("stinger", "Конец игры: удар и спад", "AudioDirector"),
    "stinger_hit.wav": ("stinger", "Резкий низкий удар", "резерв, не подключён"),
    "stinger_heartbeat.wav": ("stinger", "Сердцебиение", "резерв, не подключён"),
    "notify.wav": ("os", "Уведомление", "apps/mobile/src/os/feedback.ts"),
    "message.wav": ("os", "Сообщение", "apps/mobile/src/os/feedback.ts"),
    "ring.wav": ("os", "Входящий вызов (рингтон)", "apps/mobile/src/os/feedback.ts"),
    "call_end.wav": ("os", "Конец звонка", "apps/mobile/src/os/feedback.ts"),
    "scan_ok.wav": ("os", "Улика отсканирована", "apps/mobile/src/os/feedback.ts"),
    "error.wav": ("os", "Отказ или ошибка скана", "apps/mobile/src/os/feedback.ts"),
}


def main():
    check_only = "--check" in sys.argv[1:]
    total = 0
    entries = []
    for path, build, kind in SOUNDS:
        if not check_only:
            write_wav(path, build())
        peak, seconds, size = verify(path, kind)
        total += size
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        db = 20.0 * math.log10(peak)
        print(f"{path.relative_to(ROOT)}: {seconds:5.1f} s {size / 1024:6.0f} KB peak {db:5.1f} dB")
        role, what, used_by = ROLES[path.name]
        entries.append(
            {
                "path": str(path.relative_to(ROOT)),
                "role": role,
                "description": what,
                "usedBy": used_by,
                "origin": "procedural",
                "tool": "tools/audio/synth.py",
                "author": "AI-агент Claude (Anthropic), задача CNT-011",
                "license": "CC0-1.0",
                "bytes": size,
                "sha256": digest,
            }
        )
    print(f"total {total / 1024 / 1024:.2f} MB")
    if not check_only:
        registry = {
            "$comment": "Происхождение звуков: docs/game-design/audio-library.md. Файл пишет tools/audio/synth.py.",
            "assets": entries,
        }
        (ROOT / "tools/audio/provenance.json").write_text(
            json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


if __name__ == "__main__":
    main()
