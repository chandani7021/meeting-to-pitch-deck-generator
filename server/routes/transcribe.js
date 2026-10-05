import { Router } from 'express'
import multer from 'multer'
import fs from 'fs'

const router = Router()
const upload = multer({ dest: '/tmp/codeck-audio/' })

async function transcribeWithGemini(audioPath, mimeType) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai')
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set in server/.env')

  const client = new GoogleGenerativeAI(apiKey)
  const model = client.getGenerativeModel({ model: 'gemini-2.0-flash' })

  const audioData = fs.readFileSync(audioPath)
  const base64Audio = audioData.toString('base64')

  const result = await model.generateContent([
    { inlineData: { data: base64Audio, mimeType } },
    'Transcribe this audio. Return only the spoken words, nothing else.'
  ])
  return result.response.text().trim()
}

async function transcribeWithOpenAI(audioPath) {
  const { default: OpenAI, toFile } = await import('openai')
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set in server/.env')

  const client = new OpenAI({ apiKey })
  const file = await toFile(fs.createReadStream(audioPath), 'audio.webm', { type: 'audio/webm' })
  const response = await client.audio.transcriptions.create({ file, model: 'whisper-1' })
  return response.text
}

// POST /api/transcribe
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio provided' })

  const audioPath = req.file.path
  const mimeType = req.body.mimeType || 'audio/webm'

  try {
    const provider = process.env.AI_PROVIDER || 'local'
    let text

    // Local whisper.cpp is the default: audio never leaves the machine.
    if (provider === 'local') {
      const local = await import('../lib/transcribe.js')
      text = await local.transcribeAudio(audioPath, mimeType, req.dataDir)
    } else if (process.env.OFFLINE_MODE !== '0') {
      throw new Error(`AI_PROVIDER="${provider}" would upload this audio, but OFFLINE_MODE is on. Use AI_PROVIDER=local.`)
    } else if (provider === 'gemini') {
      text = await transcribeWithGemini(audioPath, mimeType)
    } else if (provider === 'openai') {
      text = await transcribeWithOpenAI(audioPath)
    } else if (provider === 'groq') {
      const groqProvider = await import('../lib/providers/groq.js')
      text = await groqProvider.transcribeAudio(audioPath, mimeType)
    } else {
      throw new Error(`Audio transcription requires the local, gemini, openai or groq provider — currently using "${provider}"`)
    }

    res.json({ text })
  } catch (err) {
    console.error('Transcription error:', err.message)
    res.status(500).json({ error: err.message })
  } finally {
    fs.unlink(audioPath, () => {})
  }
})

export default router
