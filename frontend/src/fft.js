/** Next power of 2 >= n */
function nextPow2(n) {
  let p = 1
  while (p < n) p *= 2
  return p
}

/**
 * Radix-2 FFT for real signals. Zero-pads to power of 2. Returns magnitude spectrum.
 * With 120 samples zero-padded to 128, sample rate 60 Hz => bin k = k * (60/128) Hz.
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

/** Zero-pads to next power of 2; with 120 samples -> N=128, bin k = k * (60/128) Hz. */
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
