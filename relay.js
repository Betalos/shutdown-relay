// Shutdown relay: the only thing n8n can ask of TrueNAS is "shut down".
//
// POST /shutdown  {"reason": "...", "dry_run": false}   needs  Authorization: Bearer $RELAY_TOKEN
// GET  /health
//
// Talks to TrueNAS with JSON-RPC 2.0 over WebSocket (the REST API is removed in TrueNAS 26.04). The API key belongs
// to a Full Admin user (system.shutdown allows nothing smaller) and lives only in this container.
// dry_run checks key and permission with a deliberately invalid shutdown (empty reason, non-integer delay): TrueNAS
// accepts it as a job which must end FAILED with EINVAL; if it ever ends otherwise the relay aborts the job and fails.
const http = require('node:http')
const { timingSafeEqual } = require('node:crypto')

const TOKEN = process.env.RELAY_TOKEN
const KEY = process.env.TRUENAS_API_KEY
const WS_URL = String(process.env.TRUENAS_URL || '').replace(/^http/, 'ws').replace(/\/$/, '') + '/api/current'
const DELAY = Number(process.env.SHUTDOWN_DELAY || 15)
const PORT = Number(process.env.RELAY_PORT || 8080)
if (!TOKEN || !KEY || !process.env.TRUENAS_URL) { console.error('RELAY_TOKEN, TRUENAS_API_KEY and TRUENAS_URL are required'); process.exit(1) }

// One short-lived, authenticated connection per request: shutdowns are rare.
function connect () {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const waiting = new Map()
    let n = 0
    const fail = (err) => { for (const w of waiting.values()) w.reject(err); waiting.clear() }
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id != null && waiting.has(m.id)) { waiting.get(m.id).resolve(m); waiting.delete(m.id) }
    }
    ws.onerror = () => { const err = new Error('websocket error'); fail(err); reject(err) }
    ws.onclose = () => fail(new Error('websocket closed'))
    const call = (method, params = []) => new Promise((res, rej) => {
      const id = ++n
      const timer = setTimeout(() => { waiting.delete(id); rej(new Error('timeout: ' + method)) }, 20000)
      waiting.set(id, { resolve: (m) => { clearTimeout(timer); res(m) }, reject: (err) => { clearTimeout(timer); rej(err) } })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
    ws.onopen = async () => {
      try {
        const login = await call('auth.login_with_api_key', [KEY])
        if (login.result !== true) throw new Error('TrueNAS rejected the API key')
        resolve({ call, close: () => ws.close() })
      } catch (err) { ws.close(); reject(err) }
    }
  })
}

async function waitForJob (c, id) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const j = await c.call('core.get_jobs', [[['id', '=', id]]])
    const job = j.result && j.result[0]
    if (job && !['WAITING', 'RUNNING'].includes(job.state)) return job
  }
  return null
}

async function dryRun () {
  const c = await connect()
  try {
    const r = await c.call('system.shutdown', ['', { delay: 'dry-run' }])
    if (r.error) return { ok: /EINVAL|Invalid|valid/i.test(JSON.stringify(r.error)), detail: 'rejected by TrueNAS: ' + JSON.stringify(r.error).slice(0, 160) }
    const job = await waitForJob(c, r.result)
    const ok = !!job && job.state === 'FAILED' && String(job.error).includes('EINVAL')
    if (!ok) await c.call('core.job_abort', [r.result]) // the invalid request must never run
    return { ok, job: r.result, job_state: job && job.state, detail: ok ? 'key and permission accepted; job rejected at validation as expected' : String((job && job.error) || 'job did not fail as expected').slice(0, 200) }
  } finally { c.close() }
}

async function shutdown (reason) {
  const c = await connect()
  try {
    const r = await c.call('system.shutdown', [reason, { delay: DELAY }])
    return r.error ? { ok: false, detail: JSON.stringify(r.error).slice(0, 200) } : { ok: true, job: r.result, delay: DELAY, reason }
  } finally { c.close() }
}

const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const authorized = (req) => {
  const given = Buffer.from(req.headers.authorization || '')
  const expected = Buffer.from('Bearer ' + TOKEN)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true })
    if (req.method !== 'POST' || req.url !== '/shutdown') return send(res, 404, { error: 'not found' })
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' })
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { return send(res, 400, { error: 'body must be JSON' }) }
    if (body.dry_run) {
      const out = await dryRun()
      console.log('dry_run', out.ok, out.job_state || '')
      return send(res, out.ok ? 200 : 502, { dry_run: true, ...out })
    }
    const reason = ('n8n: ' + String(body.reason || 'idle shutdown')).slice(0, 200)
    const out = await shutdown(reason)
    console.log('shutdown', out.ok, reason)
    send(res, out.ok ? 200 : 502, out)
  } catch (err) {
    console.error('error', err.message)
    send(res, 500, { ok: false, error: 'relay error: ' + err.message })
  }
}).listen(PORT, () => console.log('shutdown-relay listening on :' + PORT + ' -> ' + WS_URL))
