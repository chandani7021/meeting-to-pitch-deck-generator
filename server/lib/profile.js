/** Single source for the company profile (was duplicated in ai.js and pptx.js). */
import fs from 'fs'
import path from 'path'

export function profilePath(dataDir) {
  return path.join(dataDir || process.env.DATA_DIR || path.join(process.env.HOME, '.codeck'), 'copods-profile.json')
}

export function loadProfile(dataDir) {
  try {
    const p = profilePath(dataDir)
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (err) { console.warn('[profile] unreadable:', err.message) }
  return null
}

export function orgConfigFrom(profile) {
  return {
    orgName:    process.env.ORG_NAME    || profile?.company?.name    || 'Our Company',
    orgTagline: process.env.ORG_TAGLINE || profile?.company?.tagline || '',
    services:   profile?.services || null,
  }
}
