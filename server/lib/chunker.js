/**
 * Turns the Copods profile and past decks into retrievable chunks.
 *
 * Chunk boundaries deliberately match the decomposition prompt.js already
 * used when it stuffed the whole profile into every request — one chunk per
 * case study, testimonial, service group, engagement model. The difference is
 * that now we retrieve the relevant 3 instead of sending all 6+12+4.
 */

const j = (...xs) => xs.filter(Boolean).join(' ')

export function chunkProfile(profile) {
  const out = []
  const org = profile || {}

  org.caseStudies?.forEach((c, i) => {
    const label = (c.client || c.industry || `Case ${i}`).replace(/\s*\(.*?\)/g, '').trim()
    const metrics = c.keyMetrics?.length
      ? c.keyMetrics.map(m => `${m.value} ${m.label}`).join(' · ')
      : (c.results || '')
    out.push({
      id: `profile:caseStudy:${i}`,
      sourceType: 'profile:caseStudy',
      sourceId: String(i),
      // Text is written for retrieval: industry and problem words up front,
      // since queries look like "fintech onboarding UX".
      text: j(`${label} — ${c.industry || ''}.`, c.problem, c.solution,
              c.features?.map(f => f.name).join(', '),
              metrics && `Results: ${metrics}`),
      meta: { label, industry: c.industry || '', index: i },
    })
  })

  org.testimonials?.forEach((t, i) => out.push({
    id: `profile:testimonial:${i}`,
    sourceType: 'profile:testimonial', sourceId: String(i),
    text: j(`"${t.quote}"`, t.company && `— ${t.company}`, t.role),
    meta: { company: t.company || '' },
  }))

  if (org.services) for (const [group, items] of Object.entries(org.services)) {
    out.push({
      id: `profile:service:${group}`,
      sourceType: 'profile:service', sourceId: group,
      text: `${group} services: ${(items || []).join(', ')}`,
      meta: { group },
    })
  }

  org.engagementModels?.forEach((m, i) => out.push({
    id: `profile:engagement:${i}`,
    sourceType: 'profile:engagement', sourceId: m.name || String(i),
    text: j(`${m.name} engagement model.`, m.description, m.deliverables?.join(', ')),
    meta: { name: m.name || '' },
  }))

  if (org.differentiators?.length) out.push({
    id: 'profile:differentiators',
    sourceType: 'profile:differentiator', sourceId: 'all',
    text: `What sets Copods apart: ${org.differentiators.join('; ')}`,
    meta: {},
  })

  if (org.company?.stats) out.push({
    id: 'profile:stats',
    sourceType: 'profile:stats', sourceId: 'all',
    text: `Copods track record: ${Object.entries(org.company.stats).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    meta: {},
  })

  if (org.techStack) out.push({
    id: 'profile:techstack',
    sourceType: 'profile:techstack', sourceId: 'all',
    text: `Tools and stack: ${Object.values(org.techStack).flat().join(', ')}`,
    meta: {},
  })

  return out
}

/** One chunk per meaningful section of a past deck, for cross-deck reuse. */
export function chunkDeck(deckId, deck, clientName) {
  const out = []
  const push = (key, text, meta = {}) => {
    if (text && text.trim().length > 20) {
      out.push({ id: `deck:${deckId}:${key}`, sourceType: 'deck:slide', sourceId: deckId,
                 text: `[${clientName || 'client'}] ${text}`, meta: { key, clientName, ...meta } })
    }
  }
  push('summary', deck.executiveSummary)
  deck.clientNeeds?.forEach((nd, i) => push(`need:${i}`, j(nd.title, nd.description)))
  deck.proposedSolutions?.forEach((sl, i) => push(`solution:${i}`, j(sl.title, sl.subtitle, sl.keyPoints?.join('; '))))
  deck.nextSteps?.forEach((ns, i) => push(`nextStep:${i}`, j(ns.item, ns.owner)))
  if (deck.engagementModel) push('engagement', j(deck.engagementModel.name, deck.engagementModel.description))
  return out
}

/** Sliding windows over a transcript, so past conversations stay searchable. */
export function chunkTranscript(meetingId, transcript, clientName, { words = 180, overlap = 30 } = {}) {
  const w = (transcript || '').trim().split(/\s+/).filter(Boolean)
  if (w.length < 40) return []
  const out = []
  for (let i = 0, n = 0; i < w.length; i += (words - overlap), n++) {
    const slice = w.slice(i, i + words)
    if (slice.length < 30) break
    out.push({
      id: `transcript:${meetingId}:${n}`,
      sourceType: 'transcript', sourceId: meetingId,
      text: `[${clientName || 'client'}] ${slice.join(' ')}`,
      meta: { clientName, window: n },
    })
  }
  return out
}
