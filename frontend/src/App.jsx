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
      x = pad.axes[0] ?? 0
      y = -(pad.axes[1] ?? 0) // negate so stick "up" (-1) = dot up
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
  const scale = 0.75
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

  // Start full-screen 30s figure-8 test
  const startTest = useCallback(() => {
    samplesRef.current = []
    phaseStartRef.current = Date.now()
    setGeminiResult(null)
    setGeminiError(null)
    setTrackingElapsed(0)
    setLastComparison(null)
    setTestPhase('running')

    // Sample user position every 0.5s
    sampleIntervalRef.current = setInterval(() => {
      const pos = stickRef.current
      samplesRef.current.push([pos.x, pos.y])
    }, SAMPLE_INTERVAL_MS)

    // Print cursor vs target every 1s (console + on-screen)
    comparisonIntervalRef.current = setInterval(() => {
      const elapsed = Date.now() - phaseStartRef.current
      const target = figure8Position(elapsed)
      const cursor = { x: stickRef.current.x, y: stickRef.current.y }
      console.log(`[${(elapsed / 1000).toFixed(1)}s] Cursor: (${cursor.x.toFixed(3)}, ${cursor.y.toFixed(3)})  Target: (${target.x.toFixed(3)}, ${target.y.toFixed(3)})`)
      setLastComparison({ cursor, target, elapsed })
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

  const displaySpectrum = spectrum
  const highlightPD = dominantInPD

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
        <span className="subtitle">Diagnostic Dashboard</span>
        {usingMouse && testPhase === 'idle' && (
          <p className="hint-inline">Use mouse or Xbox controller. Start the test to follow the dot.</p>
        )}
      </header>

      <main className="panels">
        <section className="panel left">
          <h2>Input Calibration</h2>
          <p className="hint">{usingMouse ? 'Mouse · Move in circle' : 'Xbox Left Stick · Live'}</p>
          <button type="button" className="btn btn-start-test" onClick={startTest}>
            Start 30s tracking test (figure-8)
          </button>
          <div
            className="stick-viz"
            onMouseMove={handleStickMouseMove}
            onMouseLeave={() => reportMousePosition(0, 0)}
            role="img"
            aria-label="Tracking area"
          >
            <div className="stick-base" />
            <div
              className="stick-dot"
              style={{
                left: `calc(50% + ${stick.x * 45}%)`,
                top: `calc(50% - ${stick.y * 45}%)`,
              }}
            />
          </div>
          <div className="axis-labels">
            <span>X: {(stick.x * 100).toFixed(0)}%</span>
            <span>Y: {(stick.y * 100).toFixed(0)}%</span>
          </div>
        </section>

        <section className="panel middle">
          <h2>Frequency Spectrogram</h2>
          <p className="hint">1–20 Hz · Real-time</p>
          <div className="spectrogram">
            {displaySpectrum.map((val, i) => {
              const hz = i + 1
              const inPD = hz >= PD_LOW && hz <= PD_HIGH
              const max = Math.max(1, ...displaySpectrum)
              const h = max ? (val / max) * 100 : 0
              return (
                <div
                  key={hz}
                  className={`bar ${inPD && highlightPD ? 'pd-range' : ''}`}
                  style={{ height: `${Math.max(2, h)}%` }}
                  title={`${hz} Hz`}
                />
              )
            })}
          </div>
          <div className="spectrogram-labels">
            <span>1 Hz</span>
            <span>4–6 Hz (PD range)</span>
            <span>20 Hz</span>
          </div>
        </section>

        <section className="panel right">
          <h2>Diagnostic Status</h2>
          <div className="status-block rest">
            <span className="status-label">Resting</span>
            <span className={`status-badge ${test.restFreqInPD ? 'active' : ''}`}>
              {test.restSpectrum != null ? (test.restFreqInPD ? '4–6 Hz' : 'Other') : '—'}
            </span>
          </div>
          <div className="status-block active">
            <span className="status-label">Active</span>
            <span className={`status-badge ${test.activeFreqInPD ? 'active' : ''}`}>
              {test.activeSpectrum != null ? (test.activeFreqInPD ? '4–6 Hz' : 'Other') : '—'}
            </span>
          </div>
          <div className="test-buttons">
            <button
              className="btn btn-rest"
              onClick={test.captureRest}
              disabled={bufferLength < WINDOW_FRAMES}
            >
              Capture Rest
            </button>
            <button
              className="btn btn-active"
              onClick={test.captureActive}
              disabled={bufferLength < WINDOW_FRAMES}
            >
              Capture Active
            </button>
          </div>
          <div className={`verdict ${test.restFreqInPD && !test.activeFreqInPD ? 'positive' : ''}`}>
            {test.verdict}
          </div>
        </section>
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
