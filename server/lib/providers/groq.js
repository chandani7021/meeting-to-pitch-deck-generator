import Groq, { toFile } from 'groq-sdk'
import { SYSTEM_PROMPT } from '../prompt.js'
import fs from 'fs'

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b'
const TRANSCRIPTION_MODEL = process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo'

function getClient() {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY is not set in server/.env')
  return new Groq({ apiKey })
}

export async function analyzeTranscript(transcript, clientName, systemPrompt) {
  const groq = getClient()

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt || SYSTEM_PROMPT },
      { role: 'user', content: `Client name hint: ${clientName || 'unknown'}\n\nMeeting transcript:\n${transcript}` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.4,
  })

  const text = completion.choices[0]?.message?.content || ''
  try {
    const data = JSON.parse(text)
    data.webFindings = data.webFindings || []
    return data
  } catch {
    throw new Error('Groq returned invalid JSON. Try again.')
  }
}

export async function transcribeAudio(audioPath, mimeType) {
  const groq = getClient()

  const file = await toFile(fs.createReadStream(audioPath), 'audio.webm', { type: mimeType || 'audio/webm' })
  const result = await groq.audio.transcriptions.create({
    file,
    model: TRANSCRIPTION_MODEL,
    response_format: 'text',
    language: 'en',
  })
  return typeof result === 'string' ? result.trim() : result?.text?.trim() || ''
}

export const providerInfo = {
  provider: 'groq',
  model: MODEL,
  transcriptionModel: TRANSCRIPTION_MODEL,
}
