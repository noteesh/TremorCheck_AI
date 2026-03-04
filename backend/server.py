import os
from pathlib import Path
from flask import Flask, request, jsonify
import numpy as np
from scipy.signal import welch
import google.generativeai as genai

app = Flask(__name__)

# Load .env from project root (parent of backend/)
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass
genai.configure(api_key=os.environ.get("GEMINI_API_KEY", ""))
model = genai.GenerativeModel('gemini-1.5-flash')

def analyze_signal(coords):
    # 'coords' is a list of [x, y] values
    data = np.array(coords)
    x_signal = data[:, 0]
    
    # Calculate Power Spectral Density (Find the dominant frequency)
    # Sampling rate fs=120Hz (as per our previous joystick logic)
    freqs, psd = welch(x_signal, fs=120, nperseg=256)
    dominant_freq = freqs[np.argmax(psd)]
    intensity = np.std(x_signal)
    
    return float(dominant_freq), float(intensity)

@app.route('/analyze', methods=['POST'])
def analyze():
    raw_data = request.json.get('data') # Expects list of [x, y]
    
    # 1. Math Brain
    dom_freq, intensity = analyze_signal(raw_data)
    
    # 2. AI Brain Consensus
    evidence_context = """
EVIDENCE BASE:
1. Frequency Signature: Parkinsonian (PD) tremors typically occur in the 4–6 Hz range. 
   Essential Tremors (ET) are broader, 4–12 Hz. Physiological (stress) is 8–13 Hz.
2. Harmonics: PD tremors often exhibit secondary peaks (harmonics) at 2x the base frequency.
3. Movement Attenuation: PD rest tremors typically DECREASE in intensity during active 
   voluntary movement (kinetic tasks), whereas ET tremors persist or INCREASE.
4. Digital Sensitivity: Sensor-based variance (StdDev) above 0.05 in a 120Hz stream 
   is considered 'clinically significant jitter' for awareness screening.
"""

    prompt = f"""
You are an Evidence-Based Research Agent.
{evidence_context}

USER DATA FROM JOYSTICK:
- Detected Dominant Frequency: {dom_freq:.2f} Hz
- Movement Intensity (StdDev): {intensity:.4f}

TASK:
Evaluate the user's tremor profile EXCLUSIVELY against the EVIDENCE BASE provided above.
Do not use outside knowledge.

Return a JSON object:
{{
  "likelihood_percentage": float (0-100),
  "evidence_cited": "Briefly quote which part of the evidence matches this data",
  "consensus_reasoning": "Explain the logic based ONLY on the evidence provided",
  "behavioral_nudge": "A low-stakes health awareness action"
}}

STRICT RULE: If the frequency is outside 3-15 Hz, set likelihood to 0% and state
'Data inconsistent with known neurological tremor signatures'.
"""

    response = model.generate_content(prompt)
    # Note: In a hackathon, use a simple string replace if JSON format is messy
    return response.text

if __name__ == '__main__':
    app.run(port=5000)