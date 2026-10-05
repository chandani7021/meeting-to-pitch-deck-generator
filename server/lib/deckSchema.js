/**
 * JSON Schemas for grammar-constrained decoding.
 *
 * Ollama's `format` parameter takes a JSON Schema and compiles it to a llama.cpp
 * GBNF grammar, so the sampler physically cannot emit off-schema tokens. With a
 * 4B local model that is the difference between reliable structured output and
 * failing a third of the time — it is the single reason local generation is
 * viable here at all.
 *
 * Note what is ABSENT: whyCopods and its case studies. Those are built from the
 * profile in caseStudies.js, so the model never spends tokens on them.
 */

const str = (desc) => ({ type: 'string', description: desc })

export const GENERATION_SCHEMA = {
  type: 'object',
  required: ['deckType', 'labels', 'clientName', 'deckTitle', 'executiveSummary', 'clientNeeds', 'proposedSolutions', 'nextSteps'],
  properties: {
    deckType: { type: 'string', enum: ['interview', 'proposal', 'kickoff', 'strategy', 'status', 'other'] },
    labels: {
      type: 'object',
      required: ['cover', 'overview', 'needs', 'closing'],
      properties: {
        cover:    str('ALL-CAPS cover label, e.g. CLIENT PROPOSAL'),
        overview: str('slide 2 heading'),
        needs:    str('slide 3 heading'),
        closing:  str('closing heading, \\n allowed'),
      },
    },
    clientName:     str('person or company the meeting is about — never the platform'),
    clientIndustry: str('their industry or domain'),
    deckTitle:      str('deck title'),
    executiveSummary: str('2-3 sentences'),
    clientNeeds: {
      type: 'array', minItems: 2, maxItems: 6,
      items: {
        type: 'object', required: ['title', 'description'],
        properties: { title: str('3-5 words'), description: str('1-2 sentences from the transcript') },
      },
    },
    proposedSolutions: {
      type: 'array', minItems: 1, maxItems: 5,
      items: {
        type: 'object', required: ['title', 'keyPoints'],
        properties: {
          title: str('3-5 words'), subtitle: str('one line'),
          keyPoints: { type: 'array', minItems: 1, maxItems: 5, items: str('10-15 words, from the transcript') },
          stat: str('a relevant stat, or omit'),
        },
      },
    },
    engagementModel: {
      type: ['object', 'null'],
      properties: {
        name: { type: 'string', enum: ['Start', 'Scale', 'Transform'] },
        description: str('why this model fits'),
        phases: { type: 'array', maxItems: 4, items: str('6-10 words') },
      },
    },
    nextSteps: {
      type: 'array', maxItems: 6,
      items: {
        type: 'object', required: ['item'],
        properties: { item: str('the action'), owner: { type: ['string', 'null'] }, dueDate: { type: ['string', 'null'] } },
      },
    },
  },
}

/** Per-section schemas for decomposed generation (see generate.js). */
export const SECTION_SCHEMAS = {
  frame: {
    type: 'object',
    required: ['deckType', 'labels', 'clientName', 'deckTitle', 'executiveSummary'],
    properties: {
      deckType: GENERATION_SCHEMA.properties.deckType,
      labels: GENERATION_SCHEMA.properties.labels,
      clientName: GENERATION_SCHEMA.properties.clientName,
      clientIndustry: GENERATION_SCHEMA.properties.clientIndustry,
      deckTitle: GENERATION_SCHEMA.properties.deckTitle,
      executiveSummary: GENERATION_SCHEMA.properties.executiveSummary,
    },
  },
  clientNeeds: {
    type: 'object', required: ['clientNeeds'],
    properties: { clientNeeds: GENERATION_SCHEMA.properties.clientNeeds },
  },
  proposedSolutions: {
    type: 'object', required: ['proposedSolutions'],
    properties: { proposedSolutions: GENERATION_SCHEMA.properties.proposedSolutions },
  },
  closing: {
    type: 'object', required: ['nextSteps'],
    properties: {
      nextSteps: GENERATION_SCHEMA.properties.nextSteps,
      engagementModel: GENERATION_SCHEMA.properties.engagementModel,
    },
  },
}

/** Ops the edit engine may emit. Small vocabulary = fewer model mistakes. */
export const EDIT_OPS_SCHEMA = {
  type: 'object',
  required: ['ops'],
  properties: {
    reply: str('one short sentence for the chat, describing what changed'),
    ops: {
      type: 'array', minItems: 0, maxItems: 8,
      items: {
        type: 'object', required: ['op', 'path'],
        properties: {
          op:   { type: 'string', enum: ['replace', 'remove', 'insert', 'move'] },
          path: str('JSON Pointer into the deck, e.g. /proposedSolutions/1/keyPoints/0'),
          from: str('source pointer, for move only'),
          value: {},
        },
      },
    },
  },
}

/** Durable client facts extracted after a deck is generated. */
export const DOSSIER_SCHEMA = {
  type: 'object',
  properties: {
    industry:     { type: ['string', 'null'] },
    stakeholders: { type: 'array', maxItems: 6, items: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' } } } },
    goals:        { type: 'array', maxItems: 5, items: { type: 'string' } },
    constraints:  { type: 'array', maxItems: 5, items: { type: 'string' } },
    budgetSignal: { type: ['string', 'null'] },
    timeline:     { type: ['string', 'null'] },
    decisions:    { type: 'array', maxItems: 5, items: { type: 'string' } },
  },
}
