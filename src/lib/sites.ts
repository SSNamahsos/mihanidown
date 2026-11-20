/**
 * What mihanidown can actually reach.
 *
 * The honest answer is "whatever yt-dlp extracts" — roughly 1,800 domains — plus
 * any file on the web through the direct engine, plus any page that publishes an
 * og:video or an <img>. There is no blocklist in this app and there is no
 * allowlist either, so the catalogue below is documentation, not a gate.
 *
 * `--sites` prints the live extractor list straight from yt-dlp instead of this
 * file, because that list moves weekly and a hardcoded copy goes stale.
 */

export type Group = {
  name: string
  note: string
  sites: string[]
}

export const CATALOGUE: Group[] = [
  {
    name: 'video platforms',
    note: 'first-class extractors, best format coverage',
    sites: [
      'youtube.com', 'youtu.be', 'youtube music', 'youtube shorts',
      'vimeo.com', 'dailymotion.com', 'twitch.tv', 'kick.com',
      'rumble.com', 'odysee.com', 'bilibili.com', 'nicovideo.jp',
      'vk.com', 'ok.ru', 'rutube.ru', 'bbc.co.uk/iplayer', 'itv.com',
      'cnn.com', 'arte.tv', 'ted.com', 'archive.org',
      'streamable.com', 'bandcamp.com (video)', 'coub.com',
    ],
  },
  {
    name: 'social',
    note: 'posts, reels, stories and live streams',
    sites: [
      'x.com / twitter.com', 'instagram.com', 'threads.net', 'tiktok.com',
      'facebook.com', 'reddit.com', 'tumblr.com', 'pinterest.com',
      'snapchat.com', 'linkedin.com', 'mastodon.social (any instance)',
      'bluesky.app', 'weibo.com', 'douyin.com', 'xiaohongshu.com',
    ],
  },
  {
    name: 'streaming services',
    note: 'usually needs your cookies — that is what ^k is for',
    sites: [
      'netflix.com', 'primevideo.com', 'disneyplus.com', 'hulu.com',
      'max.com', 'paramountplus.com', 'peacocktv.com', 'crunchyroll.com',
      'spotify.com', 'apple.com/podcasts', 'audible.com',
    ],
  },
  {
    name: 'publishers and news',
    note: 'usually needs your cookies',
    sites: [
      'nytimes.com', 'washingtonpost.com', 'theguardian.com', 'bbc.com',
      'vice.com', 'vice.com (video)', 'cnet.com', 'engadget.com',
      'wired.com', 'techcrunch.com', 'arstechnica.com',
    ],
  },
  {
    name: 'cameras and forums',
    note: 'plenty of extractors nobody advertises',
    sites: [
      'chaturbate.com', 'bitchat.com', 'onlyfans.com', 'fansly.com',
      'patreon.com (public posts)', 'subscribestar-adult.com',
      'thisav.com', 'javhd.com', 'javlibrary.com',
      'e621.net', 'deviantart.com', 'artstation.com',
      'imgur.com', '9gag.com', 'imgur (gifs)', 'v.redd.it',
    ],
  },
  {
    name: 'adult',
    note: 'extractors exist; you need to be an adult where you are and keep to what you have the right to keep',
    sites: [
      'pornhub.com', 'xvideos.com', 'xnxx.com', 'redtube.com',
      'youporn.com', 'tube8.com', 'eporner.com', 'motherless.com',
      'spankbang.com', 'erome.com', 'fansly.com', 'onlyfans.com',
      'chaturbate.com', 'myfreecams.com', 'stripchat.com', 'bongacams.com',
      'onlyfans (preview)', 'javmost.com', 'hentaistream.com',
    ],
  },
  {
    name: 'audio and podcasts',
    note: 'audio-only rows appear when a source has no video stream',
    sites: [
      'soundcloud.com', 'bandcamp.com', 'mixcloud.com', 'audiomack.com',
      'anchor.fm', 'spotify.com', 'apple.com/podcasts', 'youtube (mp3)',
      'libsyn.org', 'podbean.com', 'spreaker.com', 'audioboom.com',
    ],
  },
  {
    name: 'anything else',
    note: 'the direct engine does not care what a site is',
    sites: [
      'any url ending in a file extension',
      'any url with an image/* or video/* content-type',
      'any page publishing og:video, og:image or twitter:player:stream',
      'any page with a <video>, <audio> or <img> tag',
      'r.jina.ai as a text mirror for pages that block bots',
    ],
  },
]

/** `--sites` with no yt-dlp available yet. */
export function catalogueText(): string {
  const lines: string[] = []
  for (const group of CATALOGUE) {
    lines.push('')
    lines.push(`  ${group.name.toUpperCase()}`)
    lines.push(`  ${'\u00b7'.repeat(group.name.length + 1)} ${group.note}`)
    lines.push('')
    for (const site of group.sites) lines.push(`    ${site}`)
  }
  lines.push('')
  lines.push('  mihanidown adds no site blocklist. If yt-dlp has an extractor, it works here.')
  lines.push('')
  return lines.join('\n')
}

/** Group yt-dlp's own extractor names, which are CamelCase keys not hostnames. */
export function formatExtractors(names: string[]): string {
  if (names.length === 0) return 'no extractors reported\n'
  const width = Math.min(46, Math.max(...names.map(n => n.length)) + 2)
  const columns = Math.max(1, Math.floor(100 / width))
  const lines: string[] = ['', `  ${names.length} extractors`, '']
  for (let i = 0; i < names.length; i += columns) {
    const row = names
      .slice(i, i + columns)
      .map(n => n.padEnd(width))
      .join('')
      .trimEnd()
    lines.push(`  ${row}`)
  }
  lines.push('')
  return lines.join('\n')
}