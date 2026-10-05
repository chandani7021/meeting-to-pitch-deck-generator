import { GoogleGenerativeAI } from '@google/generative-ai'
import { SYSTEM_PROMPT } from '../prompt.js'

const MAX_SEARCH_TOPICS = 3

export async function analyzeTranscript(transcript, clientName, systemPrompt) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set in server/.env')

  const genAI = new GoogleGenerativeAI(apiKey)

  // Step 1: Structured analysis
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    generationConfig: { responseMimeType: 'application/json' }
  })

  const prompt = `${systemPrompt || SYSTEM_PROMPT}\n\nClient name hint: ${clientName || 'unknown'}\n\nTranscript:\n${transcript}`
  const result = await model.generateContent(prompt)
  const text = result.response.text()

  let meetingData
  try {
    meetingData = JSON.parse(text)
  } catch {
    throw new Error('Gemini returned invalid JSON. Try again.')
  }

  // Step 2: Web search for topics that need it (max 3)
  const searchableTopics = (meetingData.topics || [])
    .filter(t => t.searchQuery)
    .slice(0, MAX_SEARCH_TOPICS)

  if (searchableTopics.length > 0) {
    const webFindings = await Promise.all(
      searchableTopics.map(topic => searchWeb(genAI, topic.searchQuery, topic.title))
    )
    meetingData.webFindings = webFindings.filter(Boolean)
  } else {
    meetingData.webFindings = []
  }

  return meetingData
}

async function searchWeb(genAI, query, topic) {
  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      tools: [{ googleSearch: {} }]
    })

    const result = await model.generateContent(
      `Search for current information about: ${query}\n\nSummarise the key findings in 2-3 sentences. Focus on facts relevant to a business meeting.`
    )
    const response = result.response
    const summary = response.text()

    // Extract source URLs from grounding metadata
    const sources = []
    const groundingMeta = response.candidates?.[0]?.groundingMetadata
    if (groundingMeta?.groundingChunks) {
      for (const chunk of groundingMeta.groundingChunks) {
        if (chunk.web?.uri) sources.push(chunk.web.uri)
      }
    }

    return { topic, query, summary, sources: sources.slice(0, 3) }
  } catch {
    return null
  }
}

export const providerInfo = {
  provider: 'gemini',
  model: 'gemini-2.0-flash'
}
