import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getMagnitudeSpectrum1To20Hz, isDominantInRange, computeSubmovementRate, computeSPARC, computeTrackingRMSE } from './fft'
import './App.css'

const SAMPLE_RATE = 60
const WINDOW_FRAMES = 120
const PD_LOW = 4
const PD_HIGH = 6
const REST_DURATION_MS = 5 * 1000
const TRACKING_DURATION_MS = 30 * 1000
const THROTTLE_MS = 33
const CONTROLLER_RANGE_SCALE = 1.2   // reduced from 2.2 — stick reaches full area without over-scaling
const IDLE_RESET_MS = 1500
const VELOCITY_SPEED = 0.9           // reduced from 1.8 — slower cursor for precise tracking
const INPUT_DEADZONE = 0.12          // reduced from 0.22 — more responsive at rest
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'

const RUMBLE_THRESHOLD = 0.55        // rumble only kicks in when noticeably off-target (was 0.30)
const RUMBLE_DURATION_MIN = 10       // shorter pulse at low intensity (was 15)
const RUMBLE_DURATION_MAX = 60       // softer max (was 120)
const RUMBLE_WEAK_MAX = 0.35         // max weak motor magnitude (was 0.7)
const RUMBLE_STRONG_MAX = 0.18       // max strong motor magnitude (was 0.45)

// Figure-8 (lemniscate): one full loop in FIGURE8_PERIOD_SEC seconds.
const FIGURE8_PERIOD_SEC = 20
function figure8Position(elapsedMs) {
  const t = (elapsedMs / 1000) * (2 * Math.PI) / FIGURE8_PERIOD_SEC
  const scale = 0.85
  return {
    x: scale * Math.sin(t),
    y: scale * Math.sin(2 * t),
  }
}

function useGamepadSlidingWindow() {
  const [stick, setStick] = useState({ x: 0, y: 0 })
  const [spectrum, setSpectrum] = useState(() => Array(20).fill(0))
  const [dominantInPD, setDominantInPD] = useState(false)
  const [bufferLength, setBufferLength] = useState(0)
  const [usingMouse, setUsingMouse] = useState(true)
  const bufferRef = useRef([])
  const rafRef = useRef(null)
  const mouseRef = useRef({ x: 0, y: 0 })
  const lastRenderRef = useRef(0)
  const dotPosRef = useRef({ x: 0, y: 0 })
  const lastInputTimeRef = useRef(performance.now())
  const lastTickTimeRef = useRef(performance.now())
  const lastMouseInputTimeRef = useRef(performance.now())
  const rumbleTargetRef = useRef(null)
  const rumblePlayfieldRef = useRef(null)

  useEffect(() => {
    const onConnect = () => setUsingMouse(false)
    const onDisconnect = () => setUsingMouse(true)
    window.addEventListener('gamepadconnected', onConnect)
    window.addEventListener('gamepaddisconnected', onDisconnect)
    if (navigator.getGamepads?.()?.[0]) setUsingMouse(false)
    return () => {
      window.removeEventListener('gamepadconnected', onConnect)
      window.removeEventListener('gamepaddisconnected', onDisconnect)
    }
  }, [])

  const setMouse = useCallback((x, y) => {
    mouseRef.current = {
      x: Math.max(-1, Math.min(1, x)),
      y: Math.max(-1, Math.min(1, y)),
    }
    lastMouseInputTimeRef.current = performance.now()
  }, [])

  const tick = useCallback(() => {
    const now = performance.now()
    const dt = Math.min((now - lastTickTimeRef.current) / 1000, 0.1)
    lastTickTimeRef.current = now

    const gp = navigator.getGamepads?.()
    const pad = gp?.[0]
    const dot = dotPosRef.current

    if (pad) {
      let rx = pad.axes[0] ?? 0
      let ry = -(pad.axes[1] ?? 0)
      rx = Math.max(-1, Math.min(1, rx * CONTROLLER_RANGE_SCALE))
      ry = Math.max(-1, Math.min(1, ry * CONTROLLER_RANGE_SCALE))
      const mag = Math.hypot(rx, ry)
      if (mag > INPUT_DEADZONE) {
        const scale = (mag - INPUT_DEADZONE) / (1 - INPUT_DEADZONE)
        const vx = (rx / mag) * scale * VELOCITY_SPEED * dt
        const vy = (ry / mag) * scale * VELOCITY_SPEED * dt
        dot.x = Math.max(-1, Math.min(1, dot.x + vx))
        dot.y = Math.max(-1, Math.min(1, dot.y + vy))
        lastInputTimeRef.current = now
      } else if (now - lastInputTimeRef.current >= IDLE_RESET_MS) {
        dot.x = 0
        dot.y = 0
      }
    } else {
      dot.x = mouseRef.current.x
      dot.y = mouseRef.current.y
      if (now - lastMouseInputTimeRef.current >= IDLE_RESET_MS) {
        dot.x = 0
        dot.y = 0
      } else {
        lastInputTimeRef.current = lastMouseInputTimeRef.current
      }
    }

    // Haptic feedback: scales smoothly with distance
    if (pad?.vibrationActuator && rumbleTargetRef.current && rumblePlayfieldRef.current) {
      const target = rumbleTargetRef.current
      const dist = Math.hypot(dot.x - target.x, dot.y - target.y)
      const pfW = rumblePlayfieldRef.current.offsetWidth || 800
      const dotDeadZone = (16 / pfW) * 2
      if (dist > dotDeadZone) {
        const t = Math.min(1, Math.max(0, (dist - dotDeadZone) / (RUMBLE_THRESHOLD - dotDeadZone)))
        const duration = Math.round(RUMBLE_DURATION_MIN + t * (RUMBLE_DURATION_MAX - RUMBLE_DURATION_MIN))
        pad.vibrationActuator.playEffect('dual-rumble', {
          startDelay: 0,
          duration,
          weakMagnitude: t * RUMBLE_WEAK_MAX,
          strongMagnitude: t * RUMBLE_STRONG_MAX,
        }).catch(() => {})
      }
    }

    const buf = bufferRef.current
    buf.push(dot.x)
    if (buf.length > WINDOW_FRAMES) buf.shift()
    if (now - lastRenderRef.current >= THROTTLE_MS) {
      lastRenderRef.current = now
      setStick({ x: dot.x, y: dot.y })
      setBufferLength(buf.length)
      if (buf.length >= WINDOW_FRAMES) {
        const spec = getMagnitudeSpectrum1To20Hz(buf, SAMPLE_RATE)
        setSpectrum(spec)
        setDominantInPD(isDominantInRange(spec, PD_LOW, PD_HIGH))
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const clearBuffer = useCallback(() => {
    bufferRef.current = []
    setBufferLength(0)
    dotPosRef.current = { x: 0, y: 0 }
    setStick({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [tick])

  return { stick, spectrum, dominantInPD, bufferLength, usingMouse, setMouse, clearBuffer, rumbleTargetRef, rumblePlayfieldRef }
}

export default function App() {
  const { stick, usingMouse, setMouse, rumbleTargetRef, rumblePlayfieldRef } = useGamepadSlidingWindow()

  // 'idle' | 'resting' | 'running' | 'analyzing' | 'done'
  const [testPhase, setTestPhase] = useState('idle')
  const [phaseElapsed, setPhaseElapsed] = useState(0)
  const [result, setResult] = useState(null)
  const [analysisError, setAnalysisError] = useState(null)
  const [lastComparison, setLastComparison] = useState(null)
  const [accuracyHistory, setAccuracyHistory] = useState([])

  const maxAccuracyPoints = 30
  const phaseStartRef = useRef(0)
  const restFramesRef = useRef([])
  const trackFramesRef = useRef([])
  const stickRef = useRef(stick)
  stickRef.current = stick
  const rafRef = useRef(null)
  const comparisonIntervalRef = useRef(null)
  const playfieldRef = useRef(null)
  const lastPhaseRenderRef = useRef(0)

  const stopTimers = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    if (comparisonIntervalRef.current) { clearInterval(comparisonIntervalRef.current); comparisonIntervalRef.current = null }
  }, [])

  // ── Phase loop ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (testPhase !== 'resting' && testPhase !== 'running') return

    phaseStartRef.current = performance.now()
    const duration = testPhase === 'resting' ? REST_DURATION_MS : TRACKING_DURATION_MS

    // Comparison interval (tracking only)
    if (testPhase === 'running') {
      comparisonIntervalRef.current = setInterval(() => {
        const elapsed = performance.now() - phaseStartRef.current
        const target = figure8Position(elapsed)
        const dot = stickRef.current
        const dist = Math.hypot(dot.x - target.x, dot.y - target.y)
        const accuracy = Math.max(0, 1 - dist / 2)
        setLastComparison({ dot, target, elapsed })
        setAccuracyHistory(prev => [...prev.slice(1 - maxAccuracyPoints), accuracy])
      }, 1000)
    }

    const loop = () => {
      const elapsed = performance.now() - phaseStartRef.current

      // Sample data at ~60fps
      const { x, y } = stickRef.current
      if (testPhase === 'resting') {
        restFramesRef.current.push([x, y])
      } else {
        const target = figure8Position(elapsed)
        trackFramesRef.current.push({ x, y, tx: target.x, ty: target.y })
      }

      // Throttle UI updates
      if (performance.now() - lastPhaseRenderRef.current >= THROTTLE_MS) {
        lastPhaseRenderRef.current = performance.now()
        setPhaseElapsed(elapsed)
      }

      if (elapsed >= duration) {
        stopTimers()
        if (testPhase === 'resting') {
          setTestPhase('running')
        } else {
          setTestPhase('analyzing')
        }
        return
      }

      rafRef.current = requestAnimationFrame(loop)
    }

    rafRef.current = requestAnimationFrame(loop)
    return () => stopTimers()
  }, [testPhase, stopTimers])

  // ── Analysis ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (testPhase !== 'analyzing') return

    const restFrames = restFramesRef.current
    const trackFrames = trackFramesRef.current

    const xTrack = trackFrames.map(f => f.x)
    const yTrack = trackFrames.map(f => f.y)

    const sparc = computeSPARC(xTrack, yTrack, SAMPLE_RATE)
    const submovementRate = computeSubmovementRate(xTrack, yTrack, SAMPLE_RATE)
    const rmse = computeTrackingRMSE(trackFrames)

    fetch(`${API_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rest: restFrames,
        tracking: trackFrames,
        tracking_metrics: { sparc, submovementRate, rmse },
      }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`Server error ${res.status}`)
        return res.json()
      })
      .then(data => {
        setResult(data)
        setAnalysisError(null)
        setTestPhase('done')
      })
      .catch(err => {
        setAnalysisError(err.message || 'Could not reach backend')
        setTestPhase('done')
      })
  }, [testPhase])

  // ── Actions ───────────────────────────────────────────────────────────────
  const startTest = useCallback(() => {
    stopTimers()
    restFramesRef.current = []
    trackFramesRef.current = []
    setResult(null)
    setAnalysisError(null)
    setPhaseElapsed(0)
    setLastComparison(null)
    setAccuracyHistory([])
    setTestPhase('resting')
  }, [stopTimers])

  const exitTest = useCallback(() => {
    stopTimers()
    setTestPhase('idle')
  }, [stopTimers])

  // ── Derived values ────────────────────────────────────────────────────────
  const trackingElapsed = testPhase === 'running' ? phaseElapsed : 0
  const restElapsed = testPhase === 'resting' ? phaseElapsed : 0

  const targetPosition = useMemo(() => {
    if (testPhase !== 'running') return null
    return figure8Position(trackingElapsed)
  }, [testPhase, trackingElapsed])

  rumbleTargetRef.current = targetPosition

  const progress = Math.min(1, trackingElapsed / TRACKING_DURATION_MS)
  const sec = Math.floor(trackingElapsed / 1000)
  const totalSec = TRACKING_DURATION_MS / 1000
  const restSecsLeft = Math.max(0, Math.ceil((REST_DURATION_MS - restElapsed) / 1000))

  const nowAccuracy = lastComparison
    ? Math.max(0, 1 - Math.hypot(lastComparison.dot.x - lastComparison.target.x, lastComparison.dot.y - lastComparison.target.y) / 2)
    : null

  // ── Mouse handlers ────────────────────────────────────────────────────────
  const handlePlayfieldMouseMove = useCallback((e) => {
    const rect = playfieldRef.current?.getBoundingClientRect()
    if (!rect) return
    setMouse(
      (e.clientX - rect.left) / rect.width * 2 - 1,
      1 - (e.clientY - rect.top) / rect.height * 2,
    )
  }, [setMouse])

  const handleStickMouseMove = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    setMouse(
      (e.clientX - rect.left) / rect.width * 2 - 1,
      1 - (e.clientY - rect.top) / rect.height * 2,
    )
  }, [setMouse])

  const isOverlay = testPhase !== 'idle'

  return (
    <div className="dashboard">
      {/* ── TEST OVERLAY ── */}
      {isOverlay && (
        <div className={`test-overlay ${testPhase}`}>

          {/* REST PHASE */}
          {testPhase === 'resting' && (
            <div className="test-analyzing">
              <div className="analyzing-spinner" />
              <div className="analyzing-text">
                Hold <strong>completely still</strong> — {restSecsLeft}s remaining
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginTop: '0.5rem' }}>
                Rest your hand. Do not move the controller or mouse.
              </div>
            </div>
          )}

          {/* TRACKING PHASE */}
          {testPhase === 'running' && (
            <>
              {/* HUD bar */}
              <div className="test-hud">
                <span className="test-hud-title">TremorCheck &middot; Live Test</span>
                <div className="test-progress-track">
                  <div className="test-progress-fill" style={{ width: `${progress * 100}%` }} />
                </div>
                {nowAccuracy !== null && (
                  <div className="test-accuracy-pill">
                    ◎ {(nowAccuracy * 100).toFixed(0)}%
                  </div>
                )}
                <div className="test-timer">
                  {sec}s
                  <span style={{ color: 'var(--text-dim)', fontSize: '1rem', fontWeight: 400 }}>
                    /{totalSec}
                  </span>
                </div>
              </div>

              {/* Instruction */}
              <div className="test-instruction-bar">
                Follow the <strong style={{ color: '#fff' }}>white ring</strong> — keep your{' '}
                <strong style={{ color: 'var(--cyan)' }}>cyan dot</strong> as close to it as possible
              </div>

              {/* Mini accuracy chart */}
              {accuracyHistory.length > 1 && (
                <div className="test-chart-bar">
                  <svg className="test-accuracy-line-chart" viewBox="0 0 800 44" preserveAspectRatio="none">
                    {(() => {
                      const w = 800, h = 40
                      const n = accuracyHistory.length
                      const pts = accuracyHistory.map((a, i) => {
                        const px = n > 1 ? (i / (n - 1)) * w : 0
                        const py = h * (1 - a) + 2
                        return `${px},${py}`
                      }).join(' ')
                      const fillPts = `0,${h + 2} ${pts} ${w},${h + 2}`
                      return (
                        <>
                          <defs>
                            <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="var(--cyan)" stopOpacity="0.18" />
                              <stop offset="100%" stopColor="var(--cyan)" stopOpacity="0" />
                            </linearGradient>
                          </defs>
                          <polygon fill="url(#chartFill)" points={fillPts} />
                          <polyline fill="none" stroke="var(--cyan)" strokeWidth="1.5"
                            strokeLinecap="round" strokeLinejoin="round" points={pts} />
                        </>
                      )
                    })()}
                  </svg>
                </div>
              )}

              {/* Playfield */}
              <div
                className="test-playfield"
                ref={(el) => { playfieldRef.current = el; rumblePlayfieldRef.current = el }}
                onMouseMove={handlePlayfieldMouseMove}
                onMouseLeave={() => setMouse(0, 0)}
              >
                <div
                  className="test-target-dot"
                  style={{
                    left: `${50 + (targetPosition?.x ?? 0) * 45}%`,
                    top:  `${50 - (targetPosition?.y ?? 0) * 45}%`,
                  }}
                />
                <div
                  className="test-user-dot"
                  style={{
                    left: `${Math.max(2, Math.min(98, 50 + stick.x * 45))}%`,
                    top:  `${Math.max(2, Math.min(98, 50 - stick.y * 45))}%`,
                  }}
                />
              </div>
            </>
          )}

          {/* ANALYZING */}
          {testPhase === 'analyzing' && (
            <div className="test-analyzing">
              <div className="analyzing-spinner" />
              <div className="analyzing-text">Analyzing with <strong>Gemini</strong>…</div>
            </div>
          )}

          {/* RESULTS */}
          {testPhase === 'done' && (
            <div className="test-done-panel">
              <div className="results-card">
                <div className="results-card-header">
                  <div className="results-card-icon">🧠</div>
                  <div>
                    <p className="results-card-title">Analysis Complete</p>
                    <p className="results-card-subtitle">Tremor biomarker screening results</p>
                  </div>
                </div>
                <div className="results-card-body">
                  {analysisError && (
                    <div className="test-error">
                      ⚠ {analysisError} — is the backend running on <code>{API_URL}</code>?
                    </div>
                  )}
                  {result && <ResultCard result={result} />}
                  <button type="button" className="btn-done" onClick={exitTest}>
                    ← Back to dashboard
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── HEADER ── */}
      <header className="header">
        <div className="header-logo">⚡</div>
        <div className="header-text">
          <h1>TremorCheck AI</h1>
          <span className="subtitle">Motor-pattern screening via movement analysis</span>
        </div>
        <span className="header-badge">BETA</span>
      </header>

      {/* ── MAIN ── */}
      <main className="dashboard-main">
        <div className="hero">
          <div className="hero-eyebrow">Neuromotor Screening Tool</div>
          <h2>Track your tremor.<br /><span>Know your baseline.</span></h2>
          <p className="hero-sub">
            A 35-second movement test (5s rest + 30s tracking) that uses your mouse or gamepad
            to detect tremor patterns. Your data is analyzed by Gemini AI against 8 clinical biomarkers.
          </p>
        </div>

        <button type="button" className="btn-primary" onClick={startTest}>
          <span className="btn-primary-icon">▶</span>
          Start Test (5s rest + 30s tracking)
        </button>

        <div className="stats-row">
          <div className="stat-cell">
            <span className="stat-value">35s</span>
            <span className="stat-label">Test Duration</span>
          </div>
          <div className="stat-cell">
            <span className="stat-value">4–6Hz</span>
            <span className="stat-label">PD Signature</span>
          </div>
          <div className="stat-cell">
            <span className="stat-value">8</span>
            <span className="stat-label">Biomarkers</span>
          </div>
        </div>

        <div className="dashboard-check-card">
          <div className="check-card-header">
            <div className="check-card-dot" />
            <span className="check-card-title">Input Check</span>
          </div>
          <div className="check-card-body">
            <div
              className="stick-viz stick-viz-small"
              onMouseMove={handleStickMouseMove}
              onMouseLeave={() => setMouse(0, 0)}
              role="img"
              aria-label="Input preview"
            >
              <div className="stick-base" />
              <div
                className="stick-dot"
                style={{
                  left: `calc(50% + ${stick.x * 38}%)`,
                  top:  `calc(50% - ${stick.y * 38}%)`,
                }}
              />
            </div>
            <p className="check-card-hint">
              <strong>{usingMouse ? '🖱 Mouse detected' : '🎮 Controller detected'}</strong><br />
              {usingMouse
                ? "Move your mouse over this circle — if the dot tracks, you're ready."
                : 'Use your left stick to move the dot. Full range recommended.'}
            </p>
          </div>
        </div>

        <div className="dashboard-disclaimer">
          <span className="disclaimer-icon">⚠</span>
          <span>
            This tool is for <strong style={{ color: 'var(--text-muted)' }}>awareness screening only</strong> and
            is not a medical diagnosis. Consult a qualified neurologist if you have concerns about tremor or movement disorders.
          </span>
        </div>
      </main>

      {/* ── FOOTER ── */}
      <footer className="research-footer">
        <strong>Research:</strong> 4–6 Hz resting tremor is a primary PD biomarker per{' '}
        <a href="https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12635349/" target="_blank" rel="noopener noreferrer">
          PMC12635349
        </a>{' '}and related clinical literature.
      </footer>
    </div>
  )
}

// ─── Results card ─────────────────────────────────────────────────────────────
function ResultCard({ result }) {
  if (result.error) return <div className="verdict error">{result.error}</div>

  const m = result.metrics
  const ai = result.ai_analysis
  const tm = result.tracking_metrics

  return (
    <div className="result-card">
      <p className="result-section-label">Rest biomarkers</p>
      <div className="metrics-grid">
        <Metric
          label="Dominant freq"
          value={`${m?.rest?.dominant_freq?.toFixed(2)} Hz`}
          note="PD: 4–6 Hz"
          flag={m?.rest?.dominant_freq >= 3.5 && m?.rest?.dominant_freq <= 7.5}
        />
        <Metric
          label="TSI"
          value={m?.rest?.tsi != null ? m.rest.tsi.toFixed(3) : '—'}
          note="PD ≤ 1.05 Hz"
          flag={m?.rest?.tsi != null && m.rest.tsi <= 1.05}
        />
        <Metric
          label="% Time tremor"
          value={m?.rest?.ptt != null ? `${(m.rest.ptt * 100).toFixed(1)}%` : '—'}
          note="PD: ≥ 0.8%"
          flag={m?.rest?.ptt != null && m.rest.ptt >= 0.008}
        />
        <Metric
          label="Tremor volume"
          value={m?.rest?.tremor_volume != null ? m.rest.tremor_volume.toFixed(1) : '—'}
          note="PD: >100.4°"
          flag={m?.rest?.tremor_volume > 100.4}
        />
      </div>

      <p className="result-section-label">Tracking biomarkers</p>
      <div className="metrics-grid">
        <Metric
          label="SPARC smoothness"
          value={tm?.sparc != null ? tm.sparc.toFixed(2) : '—'}
          note="PD: < −6.1"
          flag={tm?.sparc != null && tm.sparc < -6.1}
        />
        <Metric
          label="Submovements/s"
          value={tm?.submovementRate != null ? tm.submovementRate.toFixed(2) : '—'}
          note="PD: > 1.5/s"
          flag={tm?.submovementRate > 1.5}
        />
        <Metric
          label="Tracking RMSE"
          value={tm?.rmse != null ? tm.rmse.toFixed(3) : '—'}
          note="PD: > 0.35"
          flag={tm?.rmse > 0.35}
        />
        <Metric
          label="Rest suppression"
          value={m?.rest_suppression ? 'Yes' : 'No'}
          note="Yes = PD signal"
          flag={m?.rest_suppression}
        />
      </div>

      {ai && !ai.parse_error && (
        <div className={`verdict ${ai.likelihood_percentage > 40 ? 'positive' : ''}`}>
          <div className="likelihood">
            <span className="likelihood-pct">{Number(ai.likelihood_percentage).toFixed(0)}%</span>
            <span className="likelihood-label">PD biomarker correlation</span>
          </div>
          <p className="ai-dominant">{ai.dominant_finding}</p>
          <p className="ai-reasoning">{ai.consensus_reasoning}</p>
          <p className="ai-nudge">{ai.behavioral_nudge}</p>
        </div>
      )}

      {ai?.parse_error && (
        <div className="verdict error"><p>{ai.raw_response}</p></div>
      )}
    </div>
  )
}

function Metric({ label, value, note, flag }) {
  return (
    <div className={`metric ${flag ? 'flagged' : ''}`}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {note && <span className="metric-note">{note}</span>}
    </div>
  )
}
