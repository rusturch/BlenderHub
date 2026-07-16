// Translator round-trip for src/renderer/src/locales/*.json:
//   npm run i18n:export  -> translations.csv (key,en,ru,... one row per string)
//   npm run i18n:import  -> writes the CSV back into the per-language JSON files
// en.json is the source of truth for the key set and row order. A new column
// in the CSV becomes a new <lang>.json on import (Language type in i18n.tsx
// and the Settings picker still need that code added by hand).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES_DIR = join(ROOT, 'src', 'renderer', 'src', 'locales')
const DEFAULT_CSV = join(ROOT, 'translations.csv')

function readLocales() {
  const langs = readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)))
  const dicts = {}
  for (const lang of langs) {
    dicts[lang] = JSON.parse(readFileSync(join(LOCALES_DIR, `${lang}.json`), 'utf8'))
  }
  return { langs, dicts }
}

function csvField(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

// Pretty-print with a blank line between key groups (prefix before the first dot).
function stringifyGrouped(dict) {
  const lines = ['{']
  const keys = Object.keys(dict)
  let prevGroup = null
  keys.forEach((key, index) => {
    const group = key.split('.')[0]
    if (prevGroup !== null && group !== prevGroup) lines.push('')
    prevGroup = group
    const comma = index === keys.length - 1 ? '' : ','
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(dict[key])}${comma}`)
  })
  lines.push('}', '')
  return lines.join('\n')
}

function exportCsv(csvPath) {
  const { langs, dicts } = readLocales()
  const keys = Object.keys(dicts.en)
  for (const lang of langs) {
    for (const key of Object.keys(dicts[lang])) {
      if (!keys.includes(key)) {
        console.warn(`warn: ${lang}.json has key "${key}" missing from en.json — appended at the bottom`)
        keys.push(key)
      }
    }
  }
  const rows = [['key', ...langs].map(csvField).join(',')]
  for (const key of keys) {
    rows.push([key, ...langs.map((lang) => dicts[lang][key] ?? '')].map(csvField).join(','))
  }
  // BOM so Excel detects UTF-8 (Cyrillic otherwise turns to mojibake)
  writeFileSync(csvPath, '\uFEFF' + rows.join('\r\n') + '\r\n', 'utf8')
  console.log(`exported ${keys.length} keys × ${langs.length} languages -> ${csvPath}`)
}

function importCsv(csvPath) {
  const rows = parseCsv(readFileSync(csvPath, 'utf8'))
  if (rows.length < 2) throw new Error('CSV is empty')
  const header = rows[0]
  if (header[0] !== 'key') throw new Error(`first column must be "key", got "${header[0]}"`)
  const langs = header.slice(1).filter((lang) => lang.trim() !== '')
  if (!langs.includes('en')) throw new Error('CSV must contain an "en" column')

  const { langs: existingLangs } = readLocales()
  const dicts = Object.fromEntries(langs.map((lang) => [lang, {}]))
  const seen = new Set()
  for (const row of rows.slice(1)) {
    const key = row[0]
    if (!key) continue
    if (seen.has(key)) throw new Error(`duplicate key "${key}" in CSV`)
    seen.add(key)
    langs.forEach((lang, index) => {
      const value = row[index + 1] ?? ''
      // Empty cell = untranslated: key is omitted so the app falls back to en.
      if (value !== '') dicts[lang][key] = value
    })
    if (!dicts.en[key]) console.warn(`warn: key "${key}" has an empty en value`)
  }

  for (const lang of langs) {
    writeFileSync(join(LOCALES_DIR, `${lang}.json`), stringifyGrouped(dicts[lang]), 'utf8')
    const translated = Object.keys(dicts[lang]).length
    console.log(`wrote ${lang}.json (${translated}/${seen.size} translated)`)
    if (!existingLangs.includes(lang)) {
      console.log(
        `note: "${lang}" is a new language — add it to the Language type in src/renderer/src/lib/i18n.tsx and to the Settings language picker`
      )
    }
  }
}

const [command, pathArg] = process.argv.slice(2)
const csvPath = pathArg ? resolve(pathArg) : DEFAULT_CSV
if (command === 'export') exportCsv(csvPath)
else if (command === 'import') importCsv(csvPath)
else {
  console.error('usage: node scripts/i18n-csv.mjs export|import [path/to/translations.csv]')
  process.exit(1)
}
