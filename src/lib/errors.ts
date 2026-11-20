/**
 * yt-dlp speaks in error codes and extractor jargon. The sheet shows a
 * sentence and a next action instead, because "HTTP Error 403: Forbidden"
 * tells a person nothing about what to press.
 */

export type Diagnosis = {
  /** one line, imperative, no apology */
  message: string
  /** what to actually do about it */
  action: string
  /** true when the user can fix this without changing accounts or tooling */
  recoverable: boolean
  /** which rung of the client ladder is worth trying next, if any */
  retryable: boolean
}

const BOT_CHECK =
  /sign in to confirm (you'?re not a bot|your age)|confirm your age|not a bot/i
const PO_TOKEN_WARNING = /po.?token|forcing sabr|missing a url/i
const PO_TOKEN_PAGE = /page needs to be reloaded|unplayable|login required/i
const FORBIDDEN = /\b403\b|forbidden/i
const UNAVAILABLE = /video unavailable|has been removed|no longer available|private video/i
const GEOFENCE = /not available in your country|blocked it in your country|geo/i
const LOGIN_REQUIRED = /login required|sign in|account cookies|use --cookies/i
const MEMBERS_ONLY = /members[- ]only|join this channel|paid members/i
const DRM = /drm|widevine|encrypted|fairplay/i
const RATE_LIMIT = /too many requests|rate.?limit|429/i
const AGE_RESTRICTED = /age[- ]restricted|age_restricted|inappropriate for some users/i
const UNSUPPORTED = /unsupported url|no suitable extractor/i
const TOO_MANY = /requested format is not available/i
const NETWORK = /unable to download|connection|timeout|temporary failure|network/i
const DISK = /no space left|permission denied|read-only/i
/**
 * A handshake cut off mid-flight is what a name-based filter looks like from the
 * inside: no HTTP answer at all, because there was never a conversation. The
 * wording differs by platform — Windows reports 10054 "forcibly closed", OpenSSL
 * reports an EOF in the middle of the record layer — so all of them are listed.
 */
const CUT_OFF =
  /connection ?reset|connectionreseterror|forcibly closed by the remote host|\b10054\b|reset by peer|econnreset|sslsyscall|_ssl\.c|eof occurred in violation|remote end closed|wrong version number|unusual failure|handshake.*fail/i

export type DiagnoseContext = {
  /** the front is switched off, so a filtered connection has an answer */
  frontOff?: boolean
}

export function diagnose(rawError: string, phase: 'fetch' | 'download', context: DiagnoseContext = {}): Diagnosis {
  const text = rawError.trim()

  if (DRM.test(text)) {
    return {
      message: 'This stream is DRM-protected.',
      action:
        'Encrypted streams are out of reach for any downloader, and we are not going to break the encryption. Everything else works.',
      recoverable: false,
      retryable: false,
    }
  }

  if (AGE_RESTRICTED.test(text) || BOT_CHECK.test(text)) {
    return {
      message:
        phase === 'fetch'
          ? 'YouTube asked us to prove we are not a bot.'
          : 'YouTube rejected the media request as automated.',
      action:
        'Press ^k to hand over cookies from a signed-in browser, or set --cookies chrome. mihanidown is already rotating player clients; this account check is the part cookies solve.',
      recoverable: true,
      retryable: false,
    }
  }

  if (MEMBERS_ONLY.test(text)) {
    return {
      message: 'This video is members-only.',
      action:
        'Sign in to the channel on a browser first, then set --cookies chrome so mihanidown borrows that session.',
      recoverable: true,
      retryable: false,
    }
  }

  if (PO_TOKEN_PAGE.test(text)) {
    return {
      message: 'YouTube refused the page reload for this client.',
      action:
        'Cookies plus the tv client conflict. Press ^k for cookies, or ^y to retry without cookies.',
      recoverable: true,
      retryable: true,
    }
  }

  if (PO_TOKEN_WARNING.test(text)) {
    return {
      message: 'YouTube withheld the high-quality formats — no proof-of-origin token.',
      action:
        'A local PO-Token provider fixes this. See `mihanidown --po-token` for the one-line setup; until then the tv client still yields 1080p.',
      recoverable: true,
      retryable: true,
    }
  }

  if (RATE_LIMIT.test(text)) {
    return {
      message: 'Rate limited.',
      action: 'Wait a few minutes, or route through a residential connection. A VPN usually makes this worse, not better.',
      recoverable: true,
      retryable: true,
    }
  }

  if (UNSUPPORTED.test(text)) {
    return {
      message: 'No extractor claims this url.',
      action:
        'If the page embeds a player, try the direct grab: press d to download the raw file, or pass --all-formats to see everything yt-dlp found.',
      recoverable: true,
      retryable: false,
    }
  }

  if (GEOFENCE.test(text)) {
    return {
      message: 'The uploader locked this to one country.',
      action:
        'This is a lock on the video, not a block on the site, and the front does not touch it: your connection still comes from where it comes from. Only a connection inside the allowed region will play it.',
      recoverable: false,
      retryable: false,
    }
  }

  if (UNAVAILABLE.test(text)) {
    return {
      message: 'The uploader removed or privatised this.',
      action: 'Nothing to fetch. Check the url in a browser.',
      recoverable: false,
      retryable: false,
    }
  }

  if (LOGIN_REQUIRED.test(text)) {
    return {
      message: 'This needs a signed-in session.',
      action: 'Press ^k to pick a browser, or set --cookies firefox.',
      recoverable: true,
      retryable: false,
    }
  }

  if (DISK.test(text)) {
    return {
      message: 'The filesystem refused the write.',
      action: 'Check free space and folder permissions, or set --out to somewhere writable.',
      recoverable: true,
      retryable: false,
    }
  }

  if (FORBIDDEN.test(text)) {
    return {
      message: 'The media url was rejected.',
      action:
        'Usually an expired url or a client mismatch. Press ^r to re-fetch; if it persists, set --cookies chrome.',
      recoverable: true,
      retryable: true,
    }
  }

  if (TOO_MANY.test(text)) {
    return {
      message: 'That format is not offered any more.',
      action: 'Press ^r to re-fetch and pick from the refreshed list.',
      recoverable: true,
      retryable: true,
    }
  }

  if (CUT_OFF.test(text) && context.frontOff) {
    return {
      message: 'The handshake was cut off before the server answered.',
      action:
        'That is what a name-based filter looks like. Run mihanidown --front-check to measure it, or --front on to route around it.',
      recoverable: true,
      retryable: true,
    }
  }

  if (CUT_OFF.test(text)) {
    return {
      message: 'The connection was cut off in the middle of the handshake.',
      action: 'Run mihanidown --front-check. If it says the connection is filtered, the front fixes exactly this.',
      recoverable: true,
      retryable: true,
    }
  }

  if (NETWORK.test(text)) {
    return {
      message: 'The network dropped the transfer.',
      action: 'Press ^r to try again. Partial files are cleaned up automatically.',
      recoverable: true,
      retryable: true,
    }
  }

  return {
    message: firstLine(text) || 'The fetch failed.',
    action: 'Press ^r to retry, ^q to quit.',
    recoverable: true,
    retryable: true,
  }
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0)
  if (!line) return ''
  return line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, '').replace(/\s+/g, ' ').slice(0, 120)
}

/** yt-dlp exit codes worth translating; everything else falls through. */
export function diagnoseExit(code: number | null, stderr: string, phase: 'fetch' | 'download', context: DiagnoseContext = {}): Diagnosis {
  if (code === 0) return {message: '', action: '', recoverable: true, retryable: false}
  return diagnose(stderr, phase, context)
}