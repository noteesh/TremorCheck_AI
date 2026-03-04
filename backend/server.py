import os
import re
import json
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS
import numpy as np
from scipy.signal import butter, filtfilt, welch
from google import genai

app = Flask(__name__)
CORS(app)

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env")
except ImportError:
    pass

client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY", ""))

SAMPLE_RATE = 60  # Hz — matches frontend 60fps

# ─── Signal processing ────────────────────────────────────────────────────────

def bandpass(signal, low=3.5, high=7.5, fs=SAMPLE_RATE, order=3):
    """3rd-order Butterworth bandpass — Salarian et al. / PMC12635349 validated band."""
    nyq = fs / 2
    b, a = butter(order, [low / nyq, high / nyq], btype='band')
    if len(signal) < max(len(a), len(b)) * 3:
        return np.zeros_like(signal)
    return filtfilt(b, a, signal)


def compute_tsi(signal, fs=SAMPLE_RATE):
    """
    Tremor Stability Index: IQR of cycle-by-cycle frequency variation.
    Di Biase et al. (2017) Brain, PMC5493195.
    PD ≤ 1.05 Hz (stable), ET > 1.05 Hz (variable).
    Sensitivity 95%, specificity 88%.
    """
    if len(signal) < 8:
        return None
    filtered = bandpass(signal)
    if np.all(filtered == 0):
        return None
    # Zero-crossing rate on band-filtered signal to get instantaneous cycles
    zc = [i for i in range(1, len(filtered)) if filtered[i - 1] * filtered[i] < 0]
    if len(zc) < 6:
        return None
    # Full cycles = every other zero crossing pair
    cycle_ends = zc[::2]
    if len(cycle_ends) < 3:
        return None
    periods = np.diff(cycle_ends) / fs
    freqs = 1.0 / np.maximum(periods, 1e-6)
    delta_f = np.abs(np.diff(freqs))
    if len(delta_f) < 2:
        return None
    tsi = float(np.percentile(delta_f, 75) - np.percentile(delta_f, 25))
    return tsi


def salarian_tremor_windows(signal, fs=SAMPLE_RATE, window_sec=3):
    """
    Salarian et al. algorithm: segment signal into 3s non-overlapping windows.
    A window is 'tremor-positive' if its band-filtered RMS > (max_rms / 10).
    Returns: list of per-window dicts with rms, is_tremor, duration_s.
    PMC12635349 / Salarian 2007 IEEE TBME.
    """
    filtered = bandpass(signal)
    win_len = int(window_sec * fs)
    n_windows = len(filtered) // win_len
    if n_windows == 0:
        return []

    windows = []
    for i in range(n_windows):
        chunk = filtered[i * win_len:(i + 1) * win_len]
        rms = float(np.sqrt(np.mean(chunk ** 2)))
        windows.append({'rms': rms, 'duration_s': window_sec})

    # Threshold: max_rms / 10  (Salarian 2007 relative threshold)
    max_rms = max(w['rms'] for w in windows)
    threshold = max_rms / 10.0

    for w in windows:
        w['is_tremor'] = w['rms'] > threshold

    return windows


def compute_ptt_and_volume(windows):
    """
    % Time with Tremor (PTT) and Tremor Volume (CAD).
    PMC12635349 validated thresholds:
      PTT >= 0.8% (0.008) → clinically significant (Braybrook 2016, sensitivity 92.5%)
      Tremor volume > 100.4° → positive (ROC AUC 0.834)
    CAD per window = RMS × 4√2 × window_duration  (PMC12635349, eq. in methods)
    """
    if not windows:
        return 0.0, 0.0

    tremor_wins = [w for w in windows if w['is_tremor']]
    total_time = sum(w['duration_s'] for w in windows)
    ptt = len(tremor_wins) / len(windows) if windows else 0.0

    # Cumulative Angular Displacement (tremor volume)
    cad = sum(w['rms'] * 4 * np.sqrt(2) * w['duration_s'] for w in tremor_wins)

    return float(ptt), float(cad)


def analyze_rest(coords, fs=SAMPLE_RATE):
    """Full rest-phase analysis: dominant freq, TSI, PTT, tremor volume, intensity."""
    data = np.array(coords, dtype=float)
    # Use vector magnitude for 2D signal (matches wrist sensor approach)
    mag_signal = np.sqrt(data[:, 0] ** 2 + data[:, 1] ** 2)

    # Dominant frequency via Welch PSD
    nperseg = min(len(mag_signal), max(16, len(mag_signal) // 4))
    freqs, psd = welch(mag_signal, fs=fs, nperseg=nperseg)
    dominant_freq = float(freqs[np.argmax(psd)])

    # Band power in tremor band
    band_mask = (freqs >= 3.5) & (freqs <= 7.5)
    band_power = float(np.mean(psd[band_mask])) if band_mask.any() else 0.0
    total_power = float(np.mean(psd)) if len(psd) else 1.0
    power_concentration = band_power / total_power if total_power > 0 else 0.0

    # TSI
    tsi = compute_tsi(mag_signal, fs)

    # Salarian PTT + tremor volume (use X axis for cleaner directional signal)
    windows = salarian_tremor_windows(data[:, 0], fs)
    ptt, tremor_volume = compute_ptt_and_volume(windows)

    return {
        "dominant_freq": dominant_freq,
        "intensity": float(np.std(mag_signal)),
        "band_power": band_power,
        "power_concentration": power_concentration,
        "tsi": tsi,
        "ptt": ptt,
        "tremor_volume": tremor_volume,
        "n_windows": len(windows),
        "n_tremor_windows": sum(1 for w in windows if w['is_tremor']),
    }


def analyze_tracking(coords, fs=SAMPLE_RATE):
    """Active tracking phase: dominant freq, band power, intensity for suppression comparison."""
    data = np.array(coords, dtype=float)
    mag_signal = np.sqrt(data[:, 0] ** 2 + data[:, 1] ** 2)

    nperseg = min(len(mag_signal), max(16, len(mag_signal) // 4))
    freqs, psd = welch(mag_signal, fs=fs, nperseg=nperseg)

    band_mask = (freqs >= 3.5) & (freqs <= 7.5)
    band_power = float(np.mean(psd[band_mask])) if band_mask.any() else 0.0

    windows = salarian_tremor_windows(data[:, 0], fs)
    ptt_active, _ = compute_ptt_and_volume(windows)

    return {
        "dominant_freq": float(freqs[np.argmax(psd)]),
        "intensity": float(np.std(mag_signal)),
        "band_power": band_power,
        "ptt": ptt_active,
    }


# ─── Route ────────────────────────────────────────────────────────────────────

@app.route('/analyze', methods=['POST'])
def analyze():
    body = request.json
    if not body:
        return jsonify({"error": "No JSON body"}), 400

    rest_raw = body.get('rest')          # [[x,y], ...] 5s × 60fps ≈ 300 samples
    tracking_raw = body.get('tracking')  # [{x,y,tx,ty}, ...] 30s × 60fps ≈ 1800 samples
    tm = body.get('tracking_metrics', {})  # pre-computed in frontend

    if not rest_raw:
        return jsonify({"error": "Missing rest data"}), 400

    # Convert tracking dicts to [[x,y]] for signal analysis
    tracking_xy = [[f['x'], f['y']] for f in tracking_raw] if tracking_raw else []

    rest = analyze_rest(rest_raw)
    active = analyze_tracking(tracking_xy) if tracking_xy else {}

    # Rest suppression: band power DECREASES during active movement = PD pattern
    rest_suppression = (
        rest['band_power'] > active.get('band_power', 0)
        if active else None
    )
    suppression_ratio = (
        round(active['band_power'] / rest['band_power'], 3)
        if active and rest['band_power'] > 0 else None
    )

    # Extract frontend-computed tracking metrics
    sparc = tm.get('sparc')
    submovement_rate = tm.get('submovementRate')
    rmse = tm.get('rmse')

    # ── Gemini prompt ──────────────────────────────────────────────────────────
    evidence_context = """
EVIDENCE BASE (peer-reviewed, with published thresholds):

1. FREQUENCY & TREMOR BAND (PMC12635349; Thenganatt & Louis 2012, PMC3475963):
   - PD resting tremor: 4–6 Hz core, 3–7 Hz broader.
   - Validated tremor detection band: 3.5–7.5 Hz (Salarian 2007; PMC12635349, 219 PD patients).
   - Essential Tremor: 5–8 Hz typical. Physiological: 8–12 Hz.

2. % TIME WITH TREMOR / PTT (Braybrook et al. 2016; Salarian 2007 IEEE TBME):
   - PTT ≥ 0.8% (0.008) during waking hours = clinically significant tremor.
   - Sensitivity 92.5%, specificity 92.9% for meaningful PD tremor.

3. TREMOR VOLUME / CAD (PMC12635349 ROC analysis):
   - Tremor volume (Cumulative Angular Displacement) > 100.4° = positive.
   - AUC 0.834 — strongest single discriminator in the anchor paper.

4. TREMOR STABILITY INDEX / TSI (Di Biase et al. 2017, Brain, PMC5493195):
   - IQR of cycle-by-cycle frequency variation.
   - PD ≤ 1.05 Hz (stable, regular oscillation).
   - Essential Tremor > 1.05 Hz (variable frequency).
   - Sensitivity 95%, specificity 88%, AUC 0.916.

5. REST SUPPRESSION (Thenganatt & Louis 2012, PMC3475963):
   - PD resting tremor DECREASES (suppresses) during voluntary movement.
   - ET tremor persists or increases during action.
   - Band power suppression ratio < 1.0 = PD pattern.

6. SPARC — SPECTRAL ARC LENGTH / SMOOTHNESS (Beck et al. 2018, PMC6006701):
   - Measures movement smoothness from speed spectrum arc length.
   - Healthy controls: –5.17 ± 0.79. PD (ON meds): –6.11 ± 0.74. PD (OFF): –6.74 ± 0.64.
   - Correlated with UPDRS motor score: r = –0.65, p < 0.001. Effect size d = 2.29.
   - More negative = less smooth = more PD-like.

7. SUBMOVEMENT RATE (Patel et al. 2025, PMC11884197):
   - Micro-corrective velocity reversals per second during tracking.
   - PD: 1.67 ± 0.06 /s. Older healthy controls: 1.36 ± 0.07 /s. Effect size d = 0.80.
   - > 1.5 /s = elevated, consistent with PD motor fragmentation.

8. TRACKING RMSE (Patel et al. 2025, PMC11884197):
   - Root-mean-square error of cursor vs. target position (normalized units).
   - PD: 0.389 ± 0.029. Healthy: 0.265 ± 0.029. Effect size d = 0.63.
   - > 0.35 = elevated tracking error.
"""

    def fmt(v, decimals=3):
        return f"{v:.{decimals}f}" if v is not None else "not available"

    tsi_str = f"{rest['tsi']:.3f} Hz" if rest['tsi'] is not None else "insufficient data (signal too short or no clear oscillation)"

    prompt = f"""
You are an Evidence-Based Research Agent evaluating neuromotor biomarkers for Parkinson's Disease risk screening.

{evidence_context}

MEASURED DATA FROM THIS SESSION:
--- REST PHASE (5 seconds, controller stationary) ---
  Dominant frequency:           {rest['dominant_freq']:.2f} Hz
  Band power (3.5–7.5 Hz):      {rest['band_power']:.6f}
  Band power concentration:      {rest['power_concentration']:.3f}
  Tremor Stability Index (TSI):  {tsi_str}
  % Time with Tremor (PTT):      {rest['ptt'] * 100:.2f}%  (threshold: ≥0.8%)
  Tremor Volume (CAD):           {rest['tremor_volume']:.2f}°  (threshold: >100.4°)
  Signal windows analyzed:       {rest['n_tremor_windows']}/{rest['n_windows']} tremor-positive

--- TRACKING PHASE (30 seconds, following moving circle) ---
  SPARC smoothness:              {fmt(sparc, 2)}  (healthy: –5.17, PD: –6.11)
  Submovement rate:              {fmt(submovement_rate, 3)} /s  (healthy: 1.36, PD: 1.67)
  Tracking RMSE:                 {fmt(rmse, 4)}  (healthy: 0.265, PD: 0.389)
  Active band power:             {active.get('band_power', 0):.6f}
  Active PTT:                    {active.get('ptt', 0) * 100:.2f}%

--- COMPARATIVE ---
  Rest suppression detected:     {rest_suppression}  (True = PD pattern)
  Band power suppression ratio:  {fmt(suppression_ratio, 3)}  (<1.0 = PD pattern)

TASK:
Evaluate ALL 8 metrics systematically against the EVIDENCE BASE above.
For each metric, state whether it falls in the PD-consistent range, the healthy range, or is inconclusive.
Weigh metrics by their published discriminative power (TSI and tremor volume are strongest).

Return ONLY a raw JSON object with NO markdown or code fences:
{{
  "likelihood_percentage": <float 0–100>,
  "dominant_finding": "<the single metric that most strongly supports or refutes PD risk>",
  "evidence_cited": "<quote the specific threshold(s) from the evidence base that apply>",
  "consensus_reasoning": "<systematic evaluation: go through each metric, state PD/healthy/inconclusive, then give overall assessment>",
  "behavioral_nudge": "<a calm, non-alarmist, actionable health suggestion — e.g. consulting a neurologist if multiple markers are elevated>"
}}

RULES:
- Do NOT diagnose. This is a risk screening tool only.
- If fewer than 3 metrics have sufficient data, lower likelihood and note data limitations.
- Weight tremor volume (AUC 0.834) and TSI (AUC 0.916) most heavily.
- A healthy young person resting will show near-zero band power and PTT — do not over-penalise this.
"""

    response = client.models.generate_content(model='gemini-2.0-flash', contents=prompt)
    raw = response.text.strip()
    raw = re.sub(r'^```json\s*', '', raw, flags=re.MULTILINE)
    raw = re.sub(r'^```\s*', '', raw, flags=re.MULTILINE)
    raw = re.sub(r'\s*```$', '', raw, flags=re.MULTILINE)

    try:
        ai_result = json.loads(raw)
    except json.JSONDecodeError:
        ai_result = {"raw_response": raw, "parse_error": True}

    return jsonify({
        "metrics": {
            "rest": rest,
            "active": active,
            "rest_suppression": rest_suppression,
            "suppression_ratio": suppression_ratio,
        },
        "tracking_metrics": {
            "sparc": sparc,
            "submovementRate": submovement_rate,
            "rmse": rmse,
        },
        "ai_analysis": ai_result,
    })


if __name__ == '__main__':
    app.run(port=8000, debug=True)
