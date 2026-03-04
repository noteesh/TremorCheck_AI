import { useCallback, useEffect, useRef, useState } from 'react'
import { getMagnitudeSpectrum1To20Hz, isDominantInRange } from './fft'
import './App.css'

const SAMPLE_RATE = 60
const WINDOW_FRAMES = 120 // 2 seconds at 60fps
const PD_LOW = 4
const PD_HIGH = 6

function useGamepadSlidingWindow() {
  const [stick, setStick] = useState({ x: 0, y: 0 })
  const [spectrum, setSpectrum] = useState(() => Array(20).fill(0))
  const [dominantInPD, setDominantInPD] = useState(false)
  const [bufferLength, setBufferLength] = useState(0)
  const [usingMouse, setUsingMouse] = useState(true) // assume mouse until gamepad seen
  const bufferRef = useRef([])
  const rafRef = useRef(null)
  const mouseRef = useRef({ x: 0, y: 0 })

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
    let x = 0,
      y = 0
    if (pad) {
      x = pad.axes[0] ?? 0
      y = pad.axes[1] ?? 0
    } else {
      x = mouseRef.current.x
      y = mouseRef.current.y
    }
    setStick({ x, y })
    const buf = bufferRef.current
    buf.push(x)
    if (buf.length > WINDOW_FRAMES) buf.shift()
    setBufferLength(buf.length)
    if (buf.length >= WINDOW_FRAMES) {
      const spec = getMagnitudeSpectrum1To20Hz(buf, SAMPLE_RATE)
      setSpectrum(spec)
      setDominantInPD(isDominantInRange(spec, PD_LOW, PD_HIGH))
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [tick])

  return { stick, spectrum, dominantInPD, bufferLength, usingMouse, reportMousePosition }
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

export default function App() {
  const { stick, spectrum, dominantInPD, bufferLength, usingMouse, reportMousePosition } =
    useGamepadSlidingWindow()
  const test = useTestMode()

  const handleStickMouseMove = useCallback(
    (e) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width * 2 - 1
      const y = 1 - (e.clientY - rect.top) / rect.height * 2
      reportMousePosition(x, y)
    },
    [reportMousePosition]
  )

  useEffect(() => {
    if (bufferLength >= WINDOW_FRAMES) test.updateLatest(spectrum, dominantInPD)
  }, [bufferLength, spectrum, dominantInPD, test.updateLatest])

  const displaySpectrum = spectrum
  const highlightPD = dominantInPD

  return (
    <div className="dashboard">
      <header className="header">
        <h1>TremorCheck AI</h1>
        <span className="subtitle">Diagnostic Dashboard</span>
        {usingMouse && (
          <p className="hint-inline">Testing with mouse — move cursor in the circle to simulate stick input.</p>
        )}
      </header>

      <main className="panels">
        <section className="panel left">
          <h2>Input Calibration</h2>
          <p className="hint">{usingMouse ? 'Mouse · Move in circle' : 'Xbox Left Stick · Live'}</p>
          <div
            className="stick-viz"
            onMouseMove={handleStickMouseMove}
            onMouseLeave={() => reportMousePosition(0, 0)}
            role="img"
            aria-label="Input area for stick or mouse"
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
