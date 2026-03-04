import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getMagnitudeSpectrum1To20Hz, isDominantInRange } from './fft'
import './App.css'

const SAMPLE_RATE = 60
const WINDOW_FRAMES = 120
const PD_LOW = 4
const PD_HIGH = 6
const TRACKING_DURATION_MS = 30 * 1000
const SAMPLE_INTERVAL_MS = 500
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'
const THROTTLE_MS = 33 // ~30fps UI updates to reduce lag (data still sampled at 60fps)
const TRACKING_SENSITIVITY = 0.5 // 0–1: lower = less movement of your dot for same mouse/stick input
const CONTROLLER_RANGE_SCALE = 2.2 // scale stick so limited physical radius still reaches full area (then clamp to ±1)

const RUMBLE_DEAD_ZONE = 0.12   // no rumble within this distance of target
const RUMBLE_THRESHOLD = 0.30   // rumble starts here, grows to full at max dist (~1.4)
const RUMBLE_DURATION_MIN = 20  // ms at low intensity
const RUMBLE_DURATION_MAX = 120 // ms at full intensity

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
  const pendingStickRef = useRef({ x: 0, y: 0 })
  // Set to current target position during test, null otherwise
  const rumbleTargetRef = useRef(null)
  // Set to the playfield DOM element so tick can compute dot size in normalized coords
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

  const reportMousePosition = useCallback((x, y) => {
    mouseRef.current = {
      x: Math.max(-1, Math.min(1, x)),
      y: Math.max(-1, Math.min(1, y)),
    }
  }, [])

  const tick = useCallback(() => {
    const gp = navigator.getGamepads?.()
    const pad = gp?.[0]
    let x = 0, y = 0
    if (pad) {
      let rx = pad.axes[0] ?? 0
      let ry = -(pad.axes[1] ?? 0) // negate so stick "up" (-1) = dot up
      rx = Math.max(-1, Math.min(1, rx * CONTROLLER_RANGE_SCALE))
      ry = Math.max(-1, Math.min(1, ry * CONTROLLER_RANGE_SCALE))
      x = rx
      y = ry
    } else {
      x = mouseRef.current.x
      y = mouseRef.current.y
    }
    pendingStickRef.current = { x, y }

    // Haptic feedback: scales smoothly with distance — silent on the dot, strong when far
    if (pad?.vibrationActuator && rumbleTargetRef.current) {
      const target = rumbleTargetRef.current
      const dist = Math.hypot(x - target.x, y - target.y)
      // Compute dead zone = visual radius of the target dot (16px) in normalized coords.
      // The playfield maps its full width to [-1, 1], and dots travel ±45% of that.
      // normalized_radius = (dot_px_radius / playfield_px_width) * 2
      const pfW = rumblePlayfieldRef.current?.offsetWidth ?? 800
      const dotDeadZone = (16 / pfW) * 2   // 16px = half of 32px target dot
      if (dist > dotDeadZone) {
        // ramp from 0 just outside dot to 1 at max distance (~1.41 diagonal)
        const t = Math.min(1, Math.max(0, (dist - RUMBLE_THRESHOLD) / (1.41 - RUMBLE_THRESHOLD)))
        const duration = Math.round(RUMBLE_DURATION_MIN + t * (RUMBLE_DURATION_MAX - RUMBLE_DURATION_MIN))
        pad.vibrationActuator.playEffect('dual-rumble', {
          startDelay: 0,
          duration,
          weakMagnitude: t * 0.7,
          strongMagnitude: t * 0.45,
        }).catch(() => {})
      }
    }

    const buf = bufferRef.current
    buf.push(x)
    if (buf.length > WINDOW_FRAMES) buf.shift()
    const now = performance.now()
    if (now - lastRenderRef.current >= THROTTLE_MS) {
      lastRenderRef.current = now
      setStick(pendingStickRef.current)
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
  }, [])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [tick])

  return { stick, spectrum, dominantInPD, bufferLength, usingMouse, reportMousePosition, clearBuffer, rumbleTargetRef, rumblePlayfieldRef }
}

function useTestMode() {
  const [restFreqInPD, setRestFreqInPD] = useState(false)
  const [activeFreqInPD, setActiveFreqInPD] = useState(false)
  const [restSpectrum, setRestSpectrum] = useState(null)
  const [activeSpectrum, setActiveSpectrum] = useState(null)
  const latestRef = useRef({ spectrum: null, dominantInPD: false })

  const captureRest = useCallback(() => {
    const { spectrum, dominantInPD } = latestRef.current
    if (spectrum) {
      setRestSpectrum([...spectrum])
      setRestFreqInPD(!!dominantInPD)
    }
  }, [])
  const captureActive = useCallback(() => {
    const { spectrum, dominantInPD } = latestRef.current
    if (spectrum) {
      setActiveSpectrum([...spectrum])
      setActiveFreqInPD(!!dominantInPD)
    }
  }, [])

  const updateLatest = useCallback((spectrum, dominantInPD) => {
    latestRef.current = { spectrum, dominantInPD }
  }, [])

  const verdict =
    restFreqInPD && !activeFreqInPD
      ? 'High Correlation with PD Biomarkers detected.'
      : 'No significant resting tremor detected.'

  return {
    captureRest,
    captureActive,
    updateLatest,
    restFreqInPD,
    activeFreqInPD,
    restSpectrum,
    activeSpectrum,
    verdict,
  }
}

// Figure-8 (lemniscate): one full loop in FIGURE8_PERIOD_SEC seconds.
const FIGURE8_PERIOD_SEC = 20 // slightly faster than 30s
function figure8Position(elapsedMs) {
  const t = (elapsedMs / 1000) * (2 * Math.PI) / FIGURE8_PERIOD_SEC
  const scale = 0.48 // keep target path small so limited stick radius can reach it
  return {
    x: scale * Math.sin(t),
    y: scale * Math.sin(2 * t),
  }
}

export default function App() {
  const { stick, spectrum, dominantInPD, bufferLength, usingMouse, reportMousePosition, clearBuffer, rumbleTargetRef, rumblePlayfieldRef } =
    useGamepadSlidingWindow()
  const test = useTestMode()

  const [testPhase, setTestPhase] = useState('idle') // 'idle' | 'running' | 'analyzing' | 'done'
  const [trackingElapsed, setTrackingElapsed] = useState(0)
  const [geminiResult, setGeminiResult] = useState(null)
  const [geminiError, setGeminiError] = useState(null)
  const phaseStartRef = useRef(0)
  const samplesRef = useRef([])
  const sampleIntervalRef = useRef(null)
  const comparisonIntervalRef = useRef(null)
  const rafRef = useRef(null)
  const testAreaRef = useRef(null)
  const stickRef = useRef(stick)
  stickRef.current = stick
  const [lastComparison, setLastComparison] = useState(null)
  const [accuracyHistory, setAccuracyHistory] = useState([])
  const maxAccuracyPoints = 30

  // Start full-screen 30s figure-8 test
  const startTest = useCallback(() => {
    samplesRef.current = []
    phaseStartRef.current = Date.now()
    setGeminiResult(null)
    setGeminiError(null)
    setTrackingElapsed(0)
    setLastComparison(null)
    setAccuracyHistory([])
    setTestPhase('running')

    // Sample user position every 0.5s
    sampleIntervalRef.current = setInterval(() => {
      const pos = stickRef.current
      samplesRef.current.push([pos.x, pos.y])
    }, SAMPLE_INTERVAL_MS)

    // Every 1s: log cursor vs target and compute accuracy for chart
    comparisonIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - phaseStartRef.current
      const target = figure8Position(elapsed)
      const cursor = { x: stickRef.current.x, y: stickRef.current.y }
      console.log(`[${(elapsed / 1000).toFixed(1)}s] Cursor: (${cursor.x.toFixed(3)}, ${cursor.y.toFixed(3)})  Target: (${target.x.toFixed(3)}, ${target.y.toFixed(3)})`)
      setLastComparison({ cursor, target, elapsed })
      const dist = Math.hypot(cursor.x - target.x, cursor.y - target.y)
      const accuracy = Math.max(0, 1 - dist / 2)
      setAccuracyHistory((prev) => [...prev.slice(1 - maxAccuracyPoints), accuracy])
    }, 1000)
  }, [])

  // Timer and end condition for running test (throttle UI updates to reduce lag)
  const lastTrackingRenderRef = useRef(0)
  useEffect(() => {
    if (testPhase !== 'running') return
    const start = phaseStartRef.current
    let raf
    const loop = () => {
      const elapsed = Date.now() - start
      if (performance.now() - lastTrackingRenderRef.current >= THROTTLE_MS) {
        lastTrackingRenderRef.current = performance.now()
        setTrackingElapsed(elapsed)
      }
      if (elapsed >= TRACKING_DURATION_MS) {
        if (sampleIntervalRef.current) {
          clearInterval(sampleIntervalRef.current)
          sampleIntervalRef.current = null
        }
        if (comparisonIntervalRef.current) {
          clearInterval(comparisonIntervalRef.current)
          comparisonIntervalRef.current = null
        }
        setTestPhase('analyzing')
        return
      }
      rafRef.current = raf = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      if (raf != null) cancelAnimationFrame(raf)
    }
  }, [testPhase])

  // When analyzing, POST to backend then show result
  useEffect(() => {
    if (testPhase !== 'analyzing') return
    const data = samplesRef.current
    const duration_seconds = TRACKING_DURATION_MS / 1000
    fetch(`${API_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, duration_seconds }),
    })
      .then((res) => res.text())
      .then((text) => {
        setGeminiResult(text)
        setTestPhase('done')
      })
      .catch((err) => {
        setGeminiError(err.message || 'Request failed')
        setTestPhase('done')
      })
  }, [testPhase])

  const targetPosition = useMemo(() => {
    if (testPhase !== 'running') return null
    return figure8Position(trackingElapsed)
  }, [testPhase, trackingElapsed])

  // Keep rumble target in sync so the tick loop can read it without re-creating the callback
  rumbleTargetRef.current = targetPosition

  const playfieldRef = useRef(null)

  const handleTestAreaMouseMove = useCallback((e) => {
    const rect = playfieldRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = Math.max(-1, Math.min(1, (e.clientX - rect.left) / rect.width * 2 - 1))
    const y = Math.max(-1, Math.min(1, 1 - (e.clientY - rect.top) / rect.height * 2))
    reportMousePosition(x, y)
  }, [reportMousePosition])

  const handleStickMouseMove = useCallback(
    (e) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width * 2 - 1
      const y = 1 - (e.clientY - rect.top) / rect.height * 2
      reportMousePosition(x, y)
    },
    [reportMousePosition]
  )

  const exitTest = useCallback(() => {
    if (sampleIntervalRef.current) {
      clearInterval(sampleIntervalRef.current)
      sampleIntervalRef.current = null
    }
    if (comparisonIntervalRef.current) {
      clearInterval(comparisonIntervalRef.current)
      comparisonIntervalRef.current = null
    }
    setTestPhase('idle')
  }, [])

  useEffect(() => {
    if (bufferLength >= WINDOW_FRAMES) test.updateLatest(spectrum, dominantInPD)
  }, [bufferLength, spectrum, dominantInPD, test.updateLatest])

  const progress = Math.min(1, trackingElapsed / TRACKING_DURATION_MS)
  const sec = Math.floor(trackingElapsed / 1000)
  const totalSec = TRACKING_DURATION_MS / 1000

  const nowAccuracy = lastComparison
    ? Math.max(0, 1 - Math.hypot(
        lastComparison.cursor.x - lastComparison.target.x,
        lastComparison.cursor.y - lastComparison.target.y
      ) / 2)
    : null

  return (
    <div className="dashboard">
      {/* ── TEST OVERLAY ── */}
      {(testPhase === 'running' || testPhase === 'analyzing' || testPhase === 'done') && (
        <div className={`test-overlay ${testPhase}`} ref={testAreaRef}>

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
                <div className="test-timer">{sec}s<span style={{color:'var(--text-dim)',fontSize:'1rem',fontWeight:400}}>/{totalSec}</span></div>
              </div>

              {/* Instruction */}
              <div className="test-instruction-bar">
                Follow the <strong style={{color:'#fff'}}>white ring</strong> — keep your{' '}
                <strong style={{color:'var(--cyan)'}}>cyan dot</strong> as close to it as possible
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
                onMouseMove={handleTestAreaMouseMove}
                onMouseLeave={() => reportMousePosition(0, 0)}
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
                    left: `${Math.max(2, Math.min(98, 50 + stick.x * 45 * TRACKING_SENSITIVITY))}%`,
                    top:  `${Math.max(2, Math.min(98, 50 - stick.y * 45 * TRACKING_SENSITIVITY))}%`,
                  }}
                />
              </div>
            </>
          )}

          {testPhase === 'analyzing' && (
            <div className="test-analyzing">
              <div className="analyzing-spinner" />
              <div className="analyzing-text">Analyzing with <strong>Gemini</strong>…</div>
            </div>
          )}

          {testPhase === 'done' && (
            <div className="test-done-panel">
              <div className="results-card">
                <div className="results-card-header">
                  <div className="results-card-icon">🧠</div>
                  <div>
                    <p className="results-card-title">Analysis Complete</p>
                    <p className="results-card-subtitle">Gemini tremor-pattern feedback</p>
                  </div>
                </div>
                <div className="results-card-body">
                  {geminiError && (
                    <div className="test-error">
                      ⚠ {geminiError} — is the backend running on <code>{API_URL}</code>?
                    </div>
                  )}
                  {geminiResult && (
                    <pre className="test-gemini-result">{geminiResult}</pre>
                  )}
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
            A 30-second movement test that uses your mouse or gamepad to detect
            tremor patterns. Your data is analyzed by Gemini AI against clinical biomarkers.
          </p>
        </div>

        <button type="button" className="btn-primary" onClick={startTest}>
          <span className="btn-primary-icon">▶</span>
          Start 30s Tracking Test
        </button>

        <div className="stats-row">
          <div className="stat-cell">
            <span className="stat-value">30s</span>
            <span className="stat-label">Test Duration</span>
          </div>
          <div className="stat-cell">
            <span className="stat-value">4–6Hz</span>
            <span className="stat-label">PD Signature</span>
          </div>
          <div className="stat-cell">
            <span className="stat-value">120Hz</span>
            <span className="stat-label">Sample Rate</span>
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
              onMouseLeave={() => reportMousePosition(0, 0)}
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
                ? 'Move your mouse over this circle — if the dot tracks, you\'re ready.'
                : 'Use your left stick to move the dot. Full range recommended.'}
            </p>
          </div>
        </div>

        <div className="dashboard-disclaimer">
          <span className="disclaimer-icon">⚠</span>
          <span>
            This tool is for <strong style={{color:'var(--text-muted)'}}>awareness screening only</strong> and
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
