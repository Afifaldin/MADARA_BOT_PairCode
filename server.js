import express from 'express'
import pino from 'pino'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from '@whiskeysockets/baileys'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 10000
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info')
const logger = pino({ level: 'silent' })

app.set('trust proxy', 1)
app.use(express.json({ limit: '10kb' }))
app.use(express.static(path.join(__dirname, 'public')))

const attempts = new Map()
let activeSocket = null
let isStarting = false

function allowRequest(ip) {
  const now = Date.now()
  const windowMs = 60 * 60 * 1000
  const record = attempts.get(ip) || { count: 0, resetAt: now + windowMs }
  if (now > record.resetAt) {
    record.count = 0
    record.resetAt = now + windowMs
  }
  if (record.count >= 3) return false
  record.count += 1
  attempts.set(ip, record)
  return true
}

function cleanNumber(value) {
  return String(value || '').replace(/\D/g, '')
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'MADARA_BOT Pair Code' }))

app.post('/api/pair', async (req, res) => {
  const ip = req.ip || 'unknown'
  if (!allowRequest(ip)) {
    return res.status(429).json({ error: 'تجاوزت عدد المحاولات. حاول بعد ساعة.' })
  }

  const number = cleanNumber(req.body?.phone)
  if (!/^[1-9]\d{8,14}$/.test(number)) {
    return res.status(400).json({ error: 'أدخل رقم الهاتف مع مفتاح الدولة، أرقام فقط، من دون + أو مسافات.' })
  }
  if (isStarting) {
    return res.status(429).json({ error: 'هناك طلب ربط قيد المعالجة. انتظر قليلًا ثم حاول مجددًا.' })
  }

  isStarting = true
  let sock
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

    if (state.creds.registered) {
      return res.status(409).json({
        error: 'يوجد حساب مرتبط مسبقًا بهذه الجلسة. امسح بيانات الجلسة من الخادم فقط إذا كنت متأكدًا أنك تريد إعادة الربط.'
      })
    }

    sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['MADARA_BOT', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000
    })

    sock.ev.on('creds.update', saveCreds)
    activeSocket = sock

    // Allow the socket a moment to initialize before requesting the code.
    await new Promise(resolve => setTimeout(resolve, 1200))
    const code = await sock.requestPairingCode(number)

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        if (statusCode === DisconnectReason.loggedOut) {
          activeSocket = null
        }
      }
    })

    return res.json({ code, message: 'أدخل الرمز داخل واتساب على هاتفك.' })
  } catch (err) {
    console.error('Pairing request failed:', err?.message || err)
    if (sock) {
      try { sock.end(undefined) } catch {}
    }
    activeSocket = null
    return res.status(500).json({
      error: 'تعذر توليد رمز الربط. راجع سجلات الخادم؛ قد تكون المشكلة من اتصال واتساب أو إصدار المكتبة.'
    })
  } finally {
    isStarting = false
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MADARA_BOT Pair Code listening on port ${PORT}`)
})
