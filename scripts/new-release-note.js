#!/usr/bin/env node
/**
 * Starts a release note: node scripts/new-release-note.js <short-name>
 * Makes content/releases/<UTC date-time>-<short-name>.json for you to fill in (dev job 616dc839; rules in docs/systems/releases.md).
 * It is left empty on purpose — the unit test fails until the title and text are written.
 */
const fs = require('fs')
const path = require('path')

const slug = (process.argv[2] || '').trim()
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
  console.error('Usage: node scripts/new-release-note.js <short-name>   (lower case letters, digits and dashes, e.g. zoom-call-folders)')
  process.exit(1)
}
const d = new Date()
const p = n => String(n).padStart(2, '0')
const id = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}-${slug}`
const dir = path.join(__dirname, '..', 'content', 'releases')
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, `${id}.json`)
if (fs.existsSync(file)) {
  console.error(`Already exists: ${file}`)
  process.exit(1)
}
const template = {
  title: '',
  tag: 'new',
  text: '',
  points: [],
}
fs.writeFileSync(file, JSON.stringify(template, null, 2) + '\n')
console.log(`Created ${path.relative(process.cwd(), file)}`)
console.log('Fill in: title (what it is), tag (new | improved | fixed | behind-the-scenes), text (plain English: what it does and where to see it),')
console.log('optional points (what to try).')
console.log('EVERY release people can see must ALSO show what it does (the push is refused otherwise):')
console.log('  - something on screen changed -> "screenshot": a file in public/release-notes/ (sandbox test data only, outline the new part)')
console.log('  - a workspace or process     -> "steps": [{ "name": "...", "detail": "...", "flag": "auto|locked|new|off" }] (2 to 6, in order; optional "stepsTitle")')
console.log('  - nothing anyone can see     -> tag it "behind-the-scenes" (needs neither)')
