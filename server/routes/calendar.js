import { Router } from 'express'
import fs from 'fs'
import path from 'path'

const router = Router()
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']
const CALLBACK_URL = 'http://localhost:3001/api/calendar/callback'
const OFFLINE = () => process.env.OFFLINE_MODE !== '0'

/**
 * googleapis is loaded lazily and only when offline mode is off.
 *
 * Two reasons: in offline mode this whole route is inert (the app reads the
 * local macOS Calendar over AppleScript instead), and the package is 202 MB —
 * two thirds of server/node_modules — so a static import would have forced it
 * into every build for a code path that never runs.
 */
async function loadGoogle() {
  if (OFFLINE()) {
    throw new Error('Google Calendar is disabled in offline mode. Codeck reads your local macOS Calendar instead.')
  }
  try {
    const { google } = await import('googleapis')
    return google
  } catch {
    throw new Error('The googleapis package is not installed in this build. Reinstall with `npm i --prefix server googleapis` to use Google Calendar.')
  }
}

async function makeOAuth2Client() {
  const google = await loadGoogle()
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    CALLBACK_URL
  )
}

function tokenPath(dataDir) {
  return path.join(dataDir, 'google-tokens.json')
}

function loadTokens(dataDir) {
  const p = tokenPath(dataDir)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

async function authedClient(dataDir) {
  const tokens = loadTokens(dataDir)
  if (!tokens) return null
  const client = await makeOAuth2Client()
  client.setCredentials(tokens)
  return client
}

// Derive client name from event — pick the external attendee's org domain or name
function deriveClientName(event, orgDomain) {
  const external = (event.attendees || []).filter(a => {
    const domain = a.email?.split('@')[1] || ''
    return !a.self && domain !== orgDomain && !domain.startsWith('resource.')
  })
  if (external.length > 0) {
    const first = external[0]
    if (first.displayName) return first.displayName
    // Capitalise domain as fallback: acmecorp.com → Acmecorp
    const domain = first.email.split('@')[1].split('.')[0]
    return domain.charAt(0).toUpperCase() + domain.slice(1)
  }
  return ''
}

// GET /api/calendar/status
router.get('/status', (req, res) => {
  const tokens = loadTokens(req.dataDir)
  // `offline` tells the UI to use the local-calendar IPC path instead.
  res.json({ connected: !!tokens, offline: OFFLINE(), local: OFFLINE() })
})

// GET /api/calendar/auth-url
router.get('/auth-url', async (_req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: 'Google credentials not configured' })
    }
    const client = await makeOAuth2Client()
    res.json({ url: client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' }) })
  } catch (err) {
    res.status(409).json({ error: err.message })
  }
})

// GET /api/calendar/callback  — browser lands here after Google auth
router.get('/callback', async (req, res) => {
  const { code, error } = req.query
  if (error) return res.send(`<h3>Auth failed: ${error}</h3>`)
  if (!code) return res.status(400).send('Missing code')

  try {
    const client = await makeOAuth2Client()
    const { tokens } = await client.getToken(code)
    fs.writeFileSync(tokenPath(req.dataDir), JSON.stringify(tokens, null, 2))
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f172a;color:#fff">
        <h2 style="color:#6366f1">✓ Google Calendar connected</h2>
        <p style="color:#94a3b8">You can close this tab and return to Codeck.</p>
        <script>setTimeout(()=>window.close(),2000)</script>
      </body></html>
    `)
  } catch (err) {
    res.status(500).send(`Auth error: ${err.message}`)
  }
})

// GET /api/calendar/disconnect
router.get('/disconnect', (req, res) => {
  const p = tokenPath(req.dataDir)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  res.json({ ok: true })
})

// GET /api/calendar/upcoming
router.get('/upcoming', async (req, res) => {
  let auth
  try { auth = await authedClient(req.dataDir) }
  catch (err) { return res.status(409).json({ error: err.message }) }
  if (!auth) return res.status(401).json({ error: 'Not connected' })

  try {
    const google = await loadGoogle()
    const calendar = google.calendar({ version: 'v3', auth })
    const now = new Date()

    // Fetch all meetings for today
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0)
    const endOfDay   = new Date(now); endOfDay.setHours(23, 59, 59, 999)

    const result = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
    })

    const orgDomain = process.env.ORG_EMAIL_DOMAIN || (process.env.ORG_NAME || '').toLowerCase() + '.co'

    const events = (result.data.items || [])
      .filter(e => e.summary && e.start?.dateTime)  // skip all-day events
      .map(e => ({
        id: e.id,
        title: e.summary,
        start: e.start.dateTime,
        end: e.end?.dateTime,
        clientName: deriveClientName(e, orgDomain),
        attendees: (e.attendees || [])
          .filter(a => !a.resource)
          .map(a => ({ email: a.email, name: a.displayName || a.email, self: !!a.self })),
      }))

    res.json({ events })
  } catch (err) {
    // Token may have expired — clear it
    if (err.code === 401) fs.unlinkSync(tokenPath(req.dataDir))
    res.status(500).json({ error: err.message })
  }
})

export default router
