/** Next power of 2 >= n */
function nextPow2(n) {
  let p = 1
  while (p < n) p *= 2
  return p
}

/**
 * Radix-2 FFT for real signals. Zero-pads to power of 2. Returns magnitude spectrum.
 */
function fftReal(signal) {
  if (signal.length === 0) return []
  const N = nextPow2(signal.length)
  const complex = new Array(N * 2)
  for (let i = 0; i < N; i++) {
    complex[i * 2] = i < signal.length ? signal[i] : 0
    complex[i * 2 + 1] = 0
  }
  fft(complex, N, false)
  const mag = []
  for (let k = 0; k <= N / 2; k++) {
    const re = complex[k * 2]
    const im = complex[k * 2 + 1]
    mag[k] = Math.sqrt(re * re + im * im) / N
  }
  return mag
}

function fft(buffer, N, inverse) {
  const inv = inverse ? 1 : -1
  let j = 0
  for (let i = 0; i < N; i++) {
    if (i < j) {
      swap(buffer, i * 2, j * 2)
      swap(buffer, i * 2 + 1, j * 2 + 1)
    }
    let m = N >> 1
    while (m >= 1 && j >= m) {
      j -= m
      m >>= 1
    }
    j += m
  }
  let mmax = 2
  while (N > mmax) {
    const theta = (inv * 2 * Math.PI) / mmax
    const wtemp = Math.sin(0.5 * theta)
    const wpr = -2 * wtemp * wtemp
    const wpi = Math.sin(theta)
    let wr = 1
    let wi = 0
    for (let m = 0; m < mmax; m += 2) {
      for (let i = m; i < N; i += mmax * 2) {
        const j = i + mmax
        const tr = wr * buffer[j * 2] - wi * buffer[j * 2 + 1]
        const ti = wr * buffer[j * 2 + 1] + wi * buffer[j * 2]
        buffer[j * 2] = buffer[i * 2] - tr
        buffer[j * 2 + 1] = buffer[i * 2 + 1] - ti
        buffer[i * 2] += tr
        buffer[i * 2 + 1] += ti
      }
      const wtemp = wr
      wr = wr * wpr - wi * wpi + wr
      wi = wi * wpr + wtemp * wpi + wi
    }
    mmax *= 2
  }
}

function swap(arr, a, b) {
  const t = arr[a]
  arr[a] = arr[b]
  arr[b] = t
}

/** Zero-pads to next power of 2; returns magnitude array for 1–20 Hz bins. */
export function getMagnitudeSpectrum1To20Hz(signal, sampleRate = 60) {
  if (signal.length < 2) return new Array(20).fill(0)
  const N = nextPow2(signal.length)
  const binWidth = sampleRate / N
  const mag = fftReal(signal)
  const out = []
  for (let hz = 1; hz <= 20; hz++) {
    const k = Math.round(hz / binWidth)
    out[hz - 1] = mag[Math.min(k, mag.length - 1)] ?? 0
  }
  return out
}

/** Dominant frequency in range [lowHz, highHz] from magnitude spectrum (1..20 bins) */
export function getDominantFrequencyInRange(spectrum1To20, lowHz = 4, highHz = 6) {
  let maxMag = 0
  let peakHz = 0
  for (let i = lowHz - 1; i < highHz && i < spectrum1To20.length; i++) {
    if (spectrum1To20[i] > maxMag) {
      maxMag = spectrum1To20[i]
      peakHz = i + 1
    }
  }
  return peakHz
}

/** Check if dominant frequency of full spectrum falls in [lowHz, highHz] */
export function isDominantInRange(spectrum1To20, lowHz = 4, highHz = 6) {
  let globalMax = 0
  let globalPeakHz = 0
  for (let i = 0; i < spectrum1To20.length; i++) {
    if (spectrum1To20[i] > globalMax) {
      globalMax = spectrum1To20[i]
      globalPeakHz = i + 1
    }
  }
  return globalPeakHz >= lowHz && globalPeakHz <= highHz
}

/**
 * Simple low-pass filter (1st-order IIR) to smooth a signal before differentiation.
 * alpha = cutoff / (cutoff + sampleRate / (2*PI)) — simplified RC filter.
 */
function lowPassFilter(signal, alpha = 0.2) {
  const out = new Array(signal.length)
  out[0] = signal[0]
  for (let i = 1; i < signal.length; i++) {
    out[i] = alpha * signal[i] + (1 - alpha) * out[i - 1]
  }
  return out
}

/**
 * Compute velocity (1st derivative) and jerk (3rd derivative) of a position signal.
 * Uses central differences for better accuracy.
 */
function derivatives(signal, dt) {
  const n = signal.length
  const vel = new Array(n).fill(0)
  const acc = new Array(n).fill(0)
  const jerk = new Array(n).fill(0)

  for (let i = 1; i < n - 1; i++) vel[i] = (signal[i + 1] - signal[i - 1]) / (2 * dt)
  vel[0] = vel[1]
  vel[n - 1] = vel[n - 2]

  for (let i = 1; i < n - 1; i++) acc[i] = (vel[i + 1] - vel[i - 1]) / (2 * dt)
  acc[0] = acc[1]
  acc[n - 1] = acc[n - 2]

  for (let i = 1; i < n - 1; i++) jerk[i] = (acc[i + 1] - acc[i - 1]) / (2 * dt)
  jerk[0] = jerk[1]
  jerk[n - 1] = jerk[n - 2]

  return { vel, acc, jerk }
}

/**
 * Submovement rate: velocity zero-crossings per second.
 * Each zero-crossing of velocity = one micro-corrective movement.
 * PD: ~1.67/s, healthy controls: ~1.36/s (Patel et al. 2025, PMC11884197).
 *
 * @param {number[]} xSignal - X position over time
 * @param {number[]} ySignal - Y position over time
 * @param {number} sampleRate - samples per second
 * @returns {number} submovements per second
 */
export function computeSubmovementRate(xSignal, ySignal, sampleRate = 60) {
  if (xSignal.length < 4) return 0
  const dt = 1 / sampleRate

  // Smooth before differentiating to suppress noise
  const xSmooth = lowPassFilter(xSignal, 0.25)
  const ySmooth = lowPassFilter(ySignal, 0.25)

  const { vel: vx } = derivatives(xSmooth, dt)
  const { vel: vy } = derivatives(ySmooth, dt)

  // Speed = vector magnitude of velocity
  const speed = vx.map((v, i) => Math.sqrt(v * v + vy[i] * vy[i]))

  // Count zero-crossings of speed (local minima ≈ direction reversals)
  let crossings = 0
  for (let i = 1; i < speed.length - 1; i++) {
    if (speed[i - 1] > speed[i] && speed[i] < speed[i + 1]) crossings++
  }

  const durationSeconds = xSignal.length / sampleRate
  return crossings / durationSeconds
}

/**
 * SPARC (Spectral Arc Length) — movement smoothness metric.
 * More negative = less smooth = more PD-like.
 * Healthy: ~-5.17, PD ON: ~-6.11, PD OFF: ~-6.74 (Beck et al. 2018, PMC6006701).
 *
 * Algorithm: arc length of the normalized speed FFT magnitude spectrum
 * up to the frequency where spectrum falls below 5% of max or 20 Hz.
 *
 * @param {number[]} xSignal - X position
 * @param {number[]} ySignal - Y position
 * @param {number} sampleRate
 * @returns {number} SPARC value (negative, closer to 0 = smoother)
 */
export function computeSPARC(xSignal, ySignal, sampleRate = 60) {
  if (xSignal.length < 8) return 0
  const dt = 1 / sampleRate

  const xSmooth = lowPassFilter(xSignal, 0.3)
  const ySmooth = lowPassFilter(ySignal, 0.3)

  const { vel: vx } = derivatives(xSmooth, dt)
  const { vel: vy } = derivatives(ySmooth, dt)

  const speed = vx.map((v, i) => Math.sqrt(v * v + vy[i] * vy[i]))

  // FFT of speed
  const N = nextPow2(speed.length)
  const mag = fftReal(speed)  // magnitude spectrum

  const maxMag = Math.max(...mag.slice(0, N / 2 + 1))
  if (maxMag === 0) return 0

  // Normalized spectrum and frequency axis
  const binWidth = sampleRate / N
  const freqCutoff = 20 // Hz

  // Find cutoff bin: stop where normalized mag < 0.05 or freq > freqCutoff
  let cutoffBin = mag.length - 1
  for (let k = 1; k < mag.length; k++) {
    if ((k * binWidth) > freqCutoff || (mag[k] / maxMag) < 0.05) {
      cutoffBin = k
      break
    }
  }

  // Compute arc length of normalized magnitude spectrum
  // SPARC = -integral sqrt(1 + (dV/dw)^2) dw
  let arcLength = 0
  for (let k = 1; k <= cutoffBin; k++) {
    const v0 = mag[k - 1] / maxMag
    const v1 = mag[k] / maxMag
    const dv = v1 - v0
    arcLength += Math.sqrt(binWidth * binWidth + dv * dv)
  }

  return -arcLength
}

/**
 * Tracking RMSE: root mean square distance from cursor to target per frame.
 * PD: ~0.389 normalized units, healthy: ~0.265 (Patel et al. 2025, PMC11884197).
 *
 * @param {Array<{x,y,tx,ty}>} frames
 * @returns {number}
 */
export function computeTrackingRMSE(frames) {
  if (!frames.length) return 0
  const sumSq = frames.reduce((acc, f) => {
    const dx = f.x - f.tx
    const dy = f.y - f.ty
    return acc + dx * dx + dy * dy
  }, 0)
  return Math.sqrt(sumSq / frames.length)
}
