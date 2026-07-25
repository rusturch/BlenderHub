// Color conversions for the custom picker. Pure — no React/DOM. Channels:
// RGB 0-255, H 0-360, S/L/V 0-100. The picker's square lives in HSV (x =
// saturation, y = value), the slider modes are RGB and HSL.

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface Hsv {
  h: number
  s: number
  v: number
}

export interface Hsl {
  h: number
  s: number
  l: number
}

/** "#abc" / "#abcd" / "#rrggbb" / "#rrggbbaa" → "rrggbbaa"; alpha defaults to ff */
function expandHex(hex: string): string | null {
  const raw = hex.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3,4}$/.test(raw)) {
    const long = [...raw].map((digit) => digit + digit).join('')
    return long.length === 6 ? `${long}ff` : long
  }
  if (/^[0-9a-f]{6}$/.test(raw)) return `${raw}ff`
  if (/^[0-9a-f]{8}$/.test(raw)) return raw
  return null
}

export function hexToRgb(hex: string): Rgb {
  const digits = expandHex(hex)
  if (!digits) return { r: 0, g: 0, b: 0 }
  const n = parseInt(digits.slice(0, 6), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function alphaFromHex(hex: string): number {
  const digits = expandHex(hex)
  return digits ? parseInt(digits.slice(6), 16) : 255
}

/** append the alpha byte, dropping it when fully opaque so values stay short */
export function withAlpha(hex: string, alpha: number): string {
  const byte = Math.max(0, Math.min(255, Math.round(alpha)))
  return byte >= 255 ? hex : `${hex}${byte.toString(16).padStart(2, '0')}`
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const byte = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const delta = max - min
  let h = 0
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6
    else if (max === gn) h = (bn - rn) / delta + 2
    else h = (rn - gn) / delta + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : delta / max
  return { h, s: s * 100, v: max * 100 }
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const sn = s / 100
  const vn = v / 100
  const c = vn * sn
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = vn - c
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

export function hsvToHsl({ h, s, v }: Hsv): Hsl {
  const sn = s / 100
  const vn = v / 100
  const l = vn * (1 - sn / 2)
  const sl = l === 0 || l === 1 ? 0 : (vn - l) / Math.min(l, 1 - l)
  return { h, s: sl * 100, l: l * 100 }
}

export function hslToHsv({ h, s, l }: Hsl): Hsv {
  const sn = s / 100
  const ln = l / 100
  const v = ln + sn * Math.min(ln, 1 - ln)
  const sv = v === 0 ? 0 : 2 * (1 - ln / v)
  return { h, s: sv * 100, v: v * 100 }
}
