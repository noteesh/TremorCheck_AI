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

  return { stick, spectrum, dominantInPD, bufferLength, usingMouse, reportMousePosition, clearBuffer }
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
  const { stick, spectrum, dominantInPD, bufferLength, usingMouse, reportMousePosition, clearBuffer } =
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

  const handleTestAreaMouseMove = useCallback((e) => {
    const rect = testAreaRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = (e.clientX - rect.left) / rect.width * 2 - 1
    const y = 1 - (e.clientY - rect.top) / rect.height * 2
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

  return (
    <div className="dashboard">
      {/* Full-screen tracking test overlay */}
      {(testPhase === 'running' || testPhase === 'analyzing' || testPhase === 'done') && (
        <div
          className={`test-overlay ${testPhase}`}
          ref={testAreaRef}
          onMouseMove={testPhase === 'running' ? handleTestAreaMouseMove : undefined}
        >
          {testPhase === 'running' && (
            <>
              <div className="test-instruction">
                Follow the white dot. Test runs 30 seconds. Your position is sampled every 0.5s.
              </div>
              <div className="test-timer">
                {sec}s / {totalSec}s
              </div>
              <div className="test-progress-bar">
                <div className="test-progress-fill" style={{ width: `${progress * 100}%` }} />
              </div>
              {lastComparison && (
                <div className="test-coords">
                  Cursor: ({lastComparison.cursor.x.toFixed(2)}, {lastComparison.cursor.y.toFixed(2)})
                  {'  ·  '}
                  Target: ({lastComparison.target.x.toFixed(2)}, {lastComparison.target.y.toFixed(2)})
                </div>
              )}
              {accuracyHistory.length > 0 && (
                <div className="test-accuracy-chart">
                  <div className="test-accuracy-label">
                    Accuracy over time (each point = 1s, not cumulative) — {lastComparison ? (Math.max(0, 1 - Math.hypot(lastComparison.cursor.x - lastComparison.target.x, lastComparison.cursor.y - lastComparison.target.y) / 2) * 100).toFixed(0) : 0}% now
                  </div>
                  <svg className="test-accuracy-line-chart" viewBox="0 0 360 56" preserveAspectRatio="none">
                    {(() => {
                      const w = 360
                      const h = 52
                      const n = accuracyHistory.length
                      const points = accuracyHistory.map((a, i) => {
                        const x = n > 1 ? (i / (n - 1)) * w : 0
                        const y = h * (1 - a)
                        return `${x},${y}`
                      }).join(' ')
                      return (
                        <>
                          <polyline
                            fill="none"
                            stroke="var(--cyan)"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            points={points}
                          />
                        </>
                      )
                    })()}
                  </svg>
                </div>
              )}
              <div className="test-playfield">
                <div
                  className="test-target-dot"
                  style={{
                    left: `${50 + (targetPosition?.x ?? 0) * 45}%`,
                    top: `${50 - (targetPosition?.y ?? 0) * 45}%`,
                  }}
                />
                <div
                  className="test-user-dot"
                  style={{
                    left: `${50 + stick.x * 45 * TRACKING_SENSITIVITY}%`,
                    top: `${50 - stick.y * 45 * TRACKING_SENSITIVITY}%`,
                  }}
                />
              </div>
            </>
          )}
          {testPhase === 'analyzing' && (
            <div className="test-analyzing">Analyzing with Gemini…</div>
          )}
          {testPhase === 'done' && (
            <div className="test-done-panel">
              <h2>Tracking test complete</h2>
              {geminiError && (
                <p className="test-error">Error: {geminiError}. Is the backend running on {API_URL}?</p>
              )}
              {geminiResult && (
                <pre className="test-gemini-result">{geminiResult}</pre>
              )}
              <button type="button" className="btn btn-done" onClick={exitTest}>
                Back to dashboard
              </button>
            </div>
          )}
        </div>
      )}

      <header className="header">
        <h1>TremorCheck AI</h1>
        <span className="subtitle">Tracking test · tremor-aware feedback</span>
      </header>

      <main className="dashboard-main">
        <p className="dashboard-intro">
          Run the 30-second tracking test: follow the moving dot with your controller or mouse.
          We record your position every 0.5s and send it to Gemini for tremor-related feedback.
        </p>
        <button type="button" className="btn btn-start-test btn-primary" onClick={startTest}>
          Start 30s tracking test
        </button>
        <div className="dashboard-check">
          <span className="dashboard-check-label">Input check</span>
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
                top: `calc(50% - ${stick.y * 38}%)`,
              }}
            />
          </div>
          <span className="dashboard-check-hint">
            {usingMouse ? 'Mouse: move in circle' : 'Controller: left stick'} — if this moves, you’re good to go.
          </span>
        </div>
        <p className="dashboard-about">
          During the test you’ll see an accuracy chart (how close you are to the target). After 30s, your data is analyzed and you’ll get a short report. This is for awareness only — not a medical diagnosis.
        </p>
      </main>

      <footer className="research-footer">
        <strong>Research Reference:</strong> The 4–6 Hz resting tremor frequency is established as
        a primary biomarker for Parkinson&apos;s Disease (as per{' '}
        <a
          href="https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12635349/"
          target="_blank"
          rel="noopener noreferrer"
        >
          PMC12635349
        </a>
        {' '}and related clinical literature).
      </footer>
    </div>
  )
}
