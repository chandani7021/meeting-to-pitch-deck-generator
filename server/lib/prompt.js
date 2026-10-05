export function buildProposalPrompt(copods, deckIntent, meetingTitle, anonymize) {
  const org = copods || {}
  const servicesSummary = org.services ? [
    `Research: ${org.services.research.join(', ')}`,
    `Design: ${org.services.design.join(', ')}`,
    `Development: ${org.services.development.join(', ')}`,
    `Branding: ${org.services.marketingBranding.join(', ')}`,
  ].join('\n') : ''

  const caseBlock = org.caseStudies
    ?.map(c => {
      const label = (c.client || c.industry || 'Client').replace(/\s*\(.*?\)/, '')
      const industry = c.industry || ''
      // Top metrics: prefer keyMetrics array, else first clause of results
      const topMetrics = c.keyMetrics?.length
        ? c.keyMetrics.slice(0, 3).map(m => `${m.value} ${m.label}`).join(' · ')
        : c.results?.split(';')[0]?.trim() || ''
      // Top features: first 2 feature names only
      const topFeatures = c.features?.slice(0, 2).map(f => f.name).join(', ') || ''
      const solutionHint = topFeatures || (c.solution?.split(',')[0]?.trim() || '')
      return `• [${label} | ${industry}] Built: ${solutionHint} → Results: ${topMetrics}`
    })
    .join('\n') || ''

  const techStackBlock = org.techStack
    ? `Design tools: ${org.techStack.experienceDesign?.join(', ') || ''}\nEngineering stack: ${org.techStack.experienceEngineering?.join(', ') || ''}`
    : ''

  const differentiators = org.differentiators?.join('\n  - ') || ''
  const notableClients  = org.notableClients?.join(', ') || ''
  const industriesServed = org.industries?.join(', ') || ''
  const stats = org.company?.stats
    ? Object.entries(org.company.stats).map(([k, v]) => `${k}: ${v}`).join(', ')
    : ''
  const testimonialBlock = org.testimonials
    ?.map(t => `  "${t.quote}" — ${t.company}`)
    .join('\n') || ''
  const engagementModels = org.engagementModels
    ?.map(m => {
      const delivs = m.deliverables?.slice(0, 4).map(d => `      · ${d}`).join('\n') || ''
      return `  ${m.name}: ${m.description}${delivs ? '\n' + delivs : ''}`
    })
    .join('\n') || ''

  // ── Intent and title instructions (most important — goes first) ──────────
  const intentSection = deckIntent?.trim()
    ? `\n=== DECK INTENT (follow this precisely) ===\n${deckIntent.trim()}\n`
    : ''

  const anonymizeSection = anonymize ? `
=== ANONYMIZATION MODE: ON ===
Do NOT write any real company, product, brand, or person name anywhere in the output — neither the current client's name, nor any Copods case-study client/product name.
- clientName: replace with a generic descriptor built from the industry/role instead of the real name (e.g. "A Growth-Stage Fintech Client", "Confidential Healthcare Partner").
- In case studies pulled from the company profile: refer to them as "a partner organization", "the client", or by industry only (e.g. "a cybersecurity platform") — never the real client or product name.
- Never invent a fake name as a substitute — use a generic descriptor, not a placeholder brand.
- This applies to every field: executiveSummary, clientNeeds, proposedSolutions, whyCopods, nextSteps, webFindings — scrub all of them.
` : ''

  const titleInstruction = meetingTitle?.trim()
    ? `The deck title MUST be exactly: "${meetingTitle.trim()}" — do not change it.`
    : 'Generate a concise 5-8 word deck title that matches the deckType and content.'

  const orgName = org.company?.name || process.env.ORG_NAME || 'Copods'

  // Only inject the company profile for proposal/pitch/sales intents.
  // Chips that aren't proposals explicitly say "Do NOT include Why Copods" — that phrase
  // is used as the exclusion signal. If no intent is given, default to profile-on (proposal).
  const intentLower = deckIntent?.toLowerCase() || ''
  const explicitlyExcludesProfile =
    intentLower.includes('do not include') ||
    intentLower.includes("don't include") ||
    intentLower.includes('do not use the company')

  const needsProfile = !deckIntent?.trim() || (!explicitlyExcludesProfile && (
    intentLower.includes('proposal') ||
    intentLower.includes('pitch') ||
    intentLower.includes('case stud') ||
    intentLower.includes('our services') ||
    intentLower.includes('track record') ||
    intentLower.includes('why us')
  ))

  return `You are a presentation writer at ${orgName}.
Analyze the meeting transcript and produce a presentation deck in JSON format.
${intentSection}${anonymizeSection}
=== STRICT RULES ===
1. READ the "DECK INTENT" section above and build the deck around THAT purpose — not around a default proposal format.
2. deckType must match the actual purpose: interview | proposal | kickoff | strategy | status | other
3. For NON-PROPOSAL decks (interview, kickoff, status, other): set whyCopods to null and engagementModel to null. Do NOT include Copods services pitch.
4. clientName = the person or company the meeting is ABOUT. NEVER use the meeting platform name (Gmail, Google Meet, Zoom, Teams, Slack are apps not clients).
5. ${titleInstruction}
6. All content must come from the transcript — do not invent facts.
${org.company && needsProfile ? `
=== ${orgName.toUpperCase()} COMPANY PROFILE (use ONLY for proposal/pitch decks) ===
About: ${org.company.description || ''}
Track record: ${stats}
Services:\n${servicesSummary}
Engagement models:\n${engagementModels}
Differentiators:\n  - ${differentiators}
Industries: ${industriesServed}
Notable clients: ${notableClients}
Tech stack:\n${techStackBlock}
Case studies:\n${caseBlock}
Testimonials:\n${testimonialBlock}
` : ''}
=== JSON SCHEMA — return ONLY this, no extra keys ===
{
  "deckType": "<interview | proposal | kickoff | strategy | status | other>",
  "labels": {
    "cover": "<ALL-CAPS short label for cover, matching deckType — e.g. INTERVIEW RECAP, PROJECT KICKOFF, STATUS UPDATE, CLIENT PROPOSAL>",
    "overview": "<slide 2 heading — e.g. Interview Overview, Our Understanding, Project Brief, Meeting Summary>",
    "needs": "<slide 3 heading — e.g. Areas Assessed, Client Challenges, Project Goals, Key Topics>",
    "closing": "<closing slide heading, use \\n for line break — e.g. Thank You, Next Steps\\nAgreed, Let's Build\\nTogether>"
  },
  "orgName": "${orgName}",
  "clientName": "<person or company the meeting is about — NOT the platform>",
  "clientIndustry": "<their industry / domain>",
  "meetingDate": "<ISO date from transcript, or today: ${new Date().toISOString().split('T')[0]}>",
  "deckTitle": "<deck title — follow rule 5 above>",
  "executiveSummary": "<2-3 sentences summarising the deck purpose and key outcome, matching deckType>",
  "clientNeeds": [
    { "title": "<3-5 word heading>", "description": "<1-2 sentences from the transcript>" }
  ],
  "proposedSolutions": [
    {
      "title": "<3-5 words>",
      "subtitle": "<one line description>",
      "keyPoints": ["<bullet point from the transcript — 10-15 words>"],
      "stat": "<relevant stat or null>"
    }
  ],
  "whyCopods": null,
  "engagementModel": null,
  "nextSteps": [
    { "item": "<action>", "owner": "<owner or null>", "dueDate": "<date or null>" }
  ],
  "webFindings": []
}

For PROPOSAL decks only — replace the null values above with:
whyCopods: {
  "keyPoints": ["<differentiator — max 15 words, punchy and specific>"],
  "relevantCaseStudies": [
    {
      "title": "<4-8 word project name — e.g. 'Gen-AI Powered Custom Training Solution'>",
      "description": "<1-2 sentences: what Copods built and the core problem it solved>",
      "stages": ["<3-4 short stage labels (1-2 words each) describing THIS project's actual engagement arc — e.g. ['Audit','Redesign','Build','Launch'] or ['Discover','Prototype','Ship']. Vary these per case study to match its real narrative — do not reuse the same 4 words for every case study.>"],
      "stageSubs": ["<one 1-3 word gloss per stage, in quotes — e.g. '\"What?\"'>", "<matches stages array length>"],
      "audience": ["<primary user segment — 3-6 words>", "<secondary segment if applicable>"],
      "goals": [
        "<goal 1 — 8-15 words, starts with a verb>",
        "<goal 2>",
        "<goal 3>",
        "<goal 4 if relevant>"
      ],
      "solution": [
        "<capability 1 — 8-15 words>",
        "<capability 2>",
        "<capability 3>",
        "<capability 4>",
        "<capability 5 if relevant>"
      ],
      "impact": [
        { "label": "<2-4 word metric name>", "value": "<quantified result — e.g. '40% reduction in time'>"},
        { "label": "<metric 2>",             "value": "<quantified result>" },
        { "label": "<metric 3>",             "value": "<quantified result>" }
      ],
      "techStack": ["<Tool1>", "<Tool2>", "<Tool3>"]
    }
  ]
}
CASE STUDY RULES: Pick 2–3 most relevant to the client's industry. Each case study gets its own slide. goals and solution must each have 3-5 items. impact must lead with the hardest numbers from the profile. Never fabricate metrics. techStack should list the actual tools/frameworks used. stages/stageSubs must be unique per case study and reflect that project's real phases — the slide renders them as a connected arrow flow, so generic reused labels across every case study look wrong and must be avoided.

engagementModel: {
  "name": "<Start|Scale|Transform>",
  "description": "<one sentence: why this model fits this client's situation>",
  "phases": ["<Phase label: one short action phrase — 6-10 words max — e.g. 'Discovery & UX strategy workshop'>", "<Phase 2>", "<Phase 3>"]
}
Phases should reflect the actual deliverables for the chosen model — be specific, not generic. Max 4 phases.

Do NOT include "topics" or "actionItems" or "proposalTitle" or "meetingTitle" keys.
`
}

// Legacy fallback (no profile loaded)
export const SYSTEM_PROMPT = buildProposalPrompt({
  company: { name: process.env.ORG_NAME || 'Copods', description: 'A digital design and engineering studio.', location: 'Pune, India', stats: {} },
  services: {
    research: ['User interviews', 'Usability testing', 'Stakeholder workshops'],
    design: ['UX design', 'Visual design', 'Design systems', 'Interaction design'],
    development: ['Web apps', 'Mobile apps', 'SaaS', 'AI integration', 'Backend engineering'],
    marketingBranding: ['Brand identity', 'Website design'],
  },
  engagementModels: [
    { name: 'Start', description: 'Co-pilot from ideation to MVP launch' },
    { name: 'Scale', description: 'Expand design and development capacity' },
    { name: 'Transform', description: 'Streamline digital touch-points for growth' },
  ],
  differentiators: [
    'Design-led development with strong ownership',
    'Leadership attention from start to finish',
    'Domain expertise across 30+ sectors',
    'Zero attrition — same team throughout',
  ],
  notableClients: ['Anvilogic', 'Upstox', 'Kristal', 'PhonePe'],
  industries: ['Fintech', 'Healthcare', 'SaaS', 'E-Commerce'],
  testimonials: [],
  caseStudies: [
    { client: 'Anvilogic (Cybersecurity)', solution: 'No-code builder + AI co-pilot', results: '40% efficiency gain, $20M revenue increase' },
    { client: 'Kristal (Wealth Management)', solution: 'UX redesign + design system', results: '40% sales revenue increase in 2024' },
  ],
})
