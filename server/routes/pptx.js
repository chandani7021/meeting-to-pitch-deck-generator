import { Router } from 'express'
import { buildPresentation } from '../lib/builder.js'
import fs from 'fs'
import path from 'path'

const router = Router()

function loadProfile(dataDir) {
  try {
    const p = path.join(dataDir || path.join(process.env.HOME, '.codeck'), 'copods-profile.json')
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {}
  return {}
}

// POST /api/generate
router.post('/generate', async (req, res) => {
  const { meetingData } = req.body
  if (!meetingData) {
    return res.status(400).json({ error: 'meetingData is required' })
  }

  try {
    const profile = loadProfile(req.dataDir)
    const orgConfig = {
      orgName:    process.env.ORG_NAME    || profile.company?.name    || 'Our Company',
      orgTagline: process.env.ORG_TAGLINE || profile.company?.tagline || '',
      services:   profile.services || null,
    }
    const result = await buildPresentation(meetingData, req.dataDir, orgConfig)
    res.json(result)
  } catch (err) {
    console.error('PPTX generation error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
