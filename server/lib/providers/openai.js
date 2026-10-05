import OpenAI from 'openai'
import { SYSTEM_PROMPT } from '../prompt.js'

export async function analyzeTranscript(transcript, clientName) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set in server/.env')

  const client = new OpenAI({ apiKey })

  const response = await client.responses.create({
    model: 'gpt-4o',
    tools: [{ type: 'web_search_preview' }],
    input: `${SYSTEM_PROMPT}\n\nClient name hint: ${clientName || 'unknown'}\n\nTranscript:\n${transcript}`
  })

  let jsonText = ''
  for (const item of response.output || []) {
    if (item.type === 'message') {
      for (const block of item.content || []) {
        if (block.type === 'output_text') jsonText += block.text
      }
    }
  }

  jsonText = jsonText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()

  let meetingData
  try {
    meetingData = JSON.parse(jsonText)
  } catch {
    throw new Error('OpenAI returned invalid JSON. Try again.')
  }

  return meetingData
}

export const providerInfo = {
  provider: 'openai',
  model: 'gpt-4o'
}
