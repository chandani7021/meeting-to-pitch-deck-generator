import Anthropic from '@anthropic-ai/sdk'
import { SYSTEM_PROMPT } from '../prompt.js'

export async function analyzeTranscript(transcript, clientName) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in server/.env')

  const client = new Anthropic({ apiKey })

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: `${SYSTEM_PROMPT}\n\nClient name hint: ${clientName || 'unknown'}\n\nTranscript:\n${transcript}`
    }]
  })

  // Extract JSON from text content blocks (Claude populates webFindings via web_search tool)
  let jsonText = ''
  for (const block of response.content) {
    if (block.type === 'text') {
      jsonText += block.text
    }
  }

  // Strip any markdown fences if present
  jsonText = jsonText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()

  let meetingData
  try {
    meetingData = JSON.parse(jsonText)
  } catch {
    throw new Error('Claude returned invalid JSON. Try again.')
  }

  return meetingData
}

export const providerInfo = {
  provider: 'claude',
  model: 'claude-sonnet-4-6'
}
