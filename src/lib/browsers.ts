/**
 * Browsers yt-dlp can lift cookies out of, in the order a person is most likely
 * to keep a signed-in YouTube session in. `none` is first so "turn it off" is one
 * keypress instead of a hunt through the list.
 */
export const BROWSERS = [
  'none',
  'brave',
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'opera',
  'safari',
  'vivaldi',
  'whale',
] as const

export type Browser = (typeof BROWSERS)[number]

export function isBrowser(value: string): value is Browser {
  return (BROWSERS as readonly string[]).includes(value)
}