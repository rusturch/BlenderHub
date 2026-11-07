import { app, shell } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { createServer, type Server } from 'http'

// Application Security Requirement: Google sign-in for cloud sync talks to
// exactly two Google hosts over https (accounts.google.com for the consent
// page, oauth2.googleapis.com for token exchange), the OAuth redirect is a
// loopback listener on 127.0.0.1 with a PKCE challenge and a random state, and
// the only scope ever requested is drive.appdata — the app's own hidden folder
// in the USER'S Drive, nothing else. The client id/secret below identify the
// app, not the user; for installed desktop apps Google documents them as
// non-confidential, so shipping them in an open-source client is the intended
// model (rclone et al. do the same). Tokens never cross IPC.

// "Desktop app" OAuth client of the Blender Hub Google Cloud project. For
// installed apps these identify the application, not a user, and Google
// documents them as non-confidential — shipping them in the client is the
// intended model (see header note).
const PRODUCTION_CLIENT_ID = '845259979840-o8ho3rc5stfeeoupskjijatavgq20amu.apps.googleusercontent.com'
const PRODUCTION_CLIENT_SECRET = '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'

const AUTH_HOST = 'accounts.google.com'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'
const SIGN_IN_TIMEOUT_MS = 10 * 60_000
const REQUEST_TIMEOUT_MS = 20_000

function clientKeys(): { id: string; secret: string } {
  // Dev-only override so sign-in works before the production keys land in the
  // constants above (and for testing against a separate OAuth client).
  if (!app.isPackaged) {
    const id = process.env.BLENDERHUB_GOOGLE_CLIENT_ID
    const secret = process.env.BLENDERHUB_GOOGLE_CLIENT_SECRET
    if (id && secret) return { id, secret }
  }
  return { id: PRODUCTION_CLIENT_ID, secret: PRODUCTION_CLIENT_SECRET }
}

export function oauthKeysConfigured(): boolean {
  return !clientKeys().id.startsWith('TODO')
}

export class CloudAuthError extends Error {}

const base64url = (buffer: Buffer): string => buffer.toString('base64url')

function consentDonePage(titleOk: boolean): string {
  const heading = titleOk ? 'All set' : 'Sign-in failed'
  const body = titleOk
    ? 'Return to Blender Hub — it will connect automatically.<br>Готово! Вернитесь в Blender Hub — подключение завершится само.'
    : 'Start again from Blender Hub.<br>Начните подключение заново из Blender Hub.'
  return `<!doctype html><html><head><meta charset="utf-8"><title>Blender Hub</title><style>
    body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;justify-content:center;padding:48px 16px}
    main{max-width:420px;text-align:center}p{color:#bbb;line-height:1.5}
  </style></head><body><main><h1>${heading}</h1><p>${body}</p></main></body></html>`
}

export interface SignInSession {
  authUrl: string
  /** resolves with the refresh token; rejects on deny/timeout/cancel */
  tokens: Promise<string>
  cancel: () => void
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error('Google did not respond within 20s')
    }
    throw new Error('Google is unreachable')
  }
  const parsed = (await response.json().catch(() => ({}))) as TokenResponse
  // invalid_grant = the user revoked access (or the refresh token is dead):
  // a definitive verdict, not a transient failure
  if (parsed.error === 'invalid_grant') throw new CloudAuthError('Google access was revoked')
  if (!response.ok) throw new Error(`Google sign-in failed (${parsed.error ?? response.status})`)
  return parsed
}

/**
 * Standard OAuth flow for installed apps: a one-shot loopback listener on
 * 127.0.0.1 receives the redirect, PKCE binds the code to this process, and
 * `state` rejects foreign callbacks. The caller opens `authUrl` (or re-opens
 * it from the "Reopen browser" button) and awaits `tokens`.
 */
export function startSignIn(): Promise<SignInSession> {
  const { id, secret } = clientKeys()
  if (!oauthKeysConfigured()) {
    return Promise.reject(
      new Error('Google OAuth keys are not configured in this build yet (see cloud-sync/google-auth.ts)')
    )
  }

  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(16))

  return new Promise<SignInSession>((resolveSession, rejectSession) => {
    const server: Server = createServer()
    let settled = false
    let resolveTokens!: (token: string) => void
    let rejectTokens!: (error: Error) => void
    const tokens = new Promise<string>((resolve, reject) => {
      resolveTokens = resolve
      rejectTokens = reject
    })
    // the engine attaches its own handler; avoid unhandled-rejection noise here
    tokens.catch(() => {})

    const finish = (error: Error | null, refreshToken?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      if (error) rejectTokens(error)
      else resolveTokens(refreshToken!)
    }

    const timer = setTimeout(() => finish(new Error('Sign-in timed out')), SIGN_IN_TIMEOUT_MS)
    timer.unref?.()

    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const ok = url.searchParams.get('state') === state && Boolean(url.searchParams.get('code'))
      response.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(consentDonePage(ok))
      if (!ok) {
        // denied consent or a foreign/forged callback — keep listening only
        // for the real one unless the user explicitly denied
        if (url.searchParams.get('error')) finish(new Error('Sign-in was cancelled in the browser'))
        return
      }
      const code = url.searchParams.get('code')!
      void tokenRequest({
        grant_type: 'authorization_code',
        code,
        client_id: id,
        client_secret: secret,
        redirect_uri: `http://127.0.0.1:${port}`,
        code_verifier: verifier
      })
        .then((parsed) => {
          if (!parsed.refresh_token) throw new Error('Google did not issue a refresh token')
          finish(null, parsed.refresh_token)
        })
        .catch((error: Error) => finish(error))
    })

    let port = 0
    server.on('error', (error) => {
      if (!settled) {
        settled = true
        rejectSession(error)
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        rejectSession(new Error('Could not open the sign-in listener'))
        server.close()
        return
      }
      port = address.port
      const authUrl = new URL(`https://${AUTH_HOST}/o/oauth2/v2/auth`)
      authUrl.searchParams.set('client_id', id)
      authUrl.searchParams.set('redirect_uri', `http://127.0.0.1:${port}`)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('scope', SCOPE)
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('state', state)
      // offline + consent → Google issues a refresh token on every sign-in,
      // not only the first one per account
      authUrl.searchParams.set('access_type', 'offline')
      authUrl.searchParams.set('prompt', 'consent')
      resolveSession({
        authUrl: authUrl.toString(),
        tokens,
        cancel: () => finish(new Error('Sign-in was cancelled'))
      })
    })
  })
}

/** open the Google consent page; main-only, https + fixed host, never a renderer URL. */
export function openAuthUrlInBrowser(rawUrl: string): void {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || url.hostname !== AUTH_HOST) {
    throw new Error('Refusing to open an untrusted sign-in URL')
  }
  void shell.openExternal(url.toString())
}

// --- access-token cache --------------------------------------------------------

interface CachedAccess {
  accessToken: string
  expiresAt: number
}

const accessCache = new Map<string, CachedAccess>()
const refreshInFlight = new Map<string, Promise<string>>()

/**
 * Exchange the stored refresh token for a short-lived access token, cached in
 * memory until shortly before expiry. Single-flight per refresh token so
 * concurrent callers don't race Google. invalid_grant → CloudAuthError.
 */
export async function getAccessToken(refreshToken: string, forceRefresh = false): Promise<string> {
  const cached = accessCache.get(refreshToken)
  if (!forceRefresh && cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken

  const running = refreshInFlight.get(refreshToken)
  if (running) return running

  const { id, secret } = clientKeys()
  const task = tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: id,
    client_secret: secret
  })
    .then((parsed) => {
      if (!parsed.access_token) throw new CloudAuthError('Google did not issue an access token')
      accessCache.set(refreshToken, {
        accessToken: parsed.access_token,
        expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000
      })
      return parsed.access_token
    })
    .finally(() => refreshInFlight.delete(refreshToken))
  refreshInFlight.set(refreshToken, task)
  return task
}

export function dropAccessToken(refreshToken: string): void {
  accessCache.delete(refreshToken)
}

/** best-effort revoke on disconnect so the grant disappears from the Google account. */
export async function revokeToken(refreshToken: string): Promise<void> {
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }).catch(() => {})
  accessCache.delete(refreshToken)
}
