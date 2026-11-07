import { safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDataRoot } from '../paths'
import { machineTag } from './machine'

// The Google refresh token, stored in a PER-MACHINE file rather than
// config.json: config.json is a single file, and when data/ rides in Dropbox
// every machine's DPAPI blob would overwrite the others' on each sign-in — an
// endless mutual logout. A per-machine filename (like
// asset-library-state.<host>.json) keeps each machine's blob to itself.
// safeStorage/DPAPI binds the blob to this machine anyway, so a folder carried
// elsewhere reads as "not connected" and the user simply signs in there too.
// The raw token never crosses IPC.

const MAX_TOKEN_LENGTH = 8192

interface TokenFile {
  tokenEnc?: string
}

const tokenPath = (): string => join(getDataRoot(), `cloud-auth.${machineTag()}.json`)

async function readTokenFile(): Promise<{ raw: Record<string, unknown>; file: TokenFile }> {
  try {
    const parsed = JSON.parse(await readFile(tokenPath(), 'utf8'))
    const raw = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    return { raw, file: { tokenEnc: typeof raw.tokenEnc === 'string' ? raw.tokenEnc : undefined } }
  } catch {
    return { raw: {}, file: {} }
  }
}

let writeQueue: Promise<unknown> = Promise.resolve()

async function writeToken(tokenEnc: string | undefined): Promise<void> {
  const run = writeQueue.then(async () => {
    const { raw } = await readTokenFile()
    await mkdir(getDataRoot(), { recursive: true })
    const target = tokenPath()
    // spread-first so an unknown field written by a newer version survives
    await writeFile(`${target}.tmp`, JSON.stringify({ ...raw, tokenEnc }, null, 2))
    await rename(`${target}.tmp`, target)
  })
  writeQueue = run.catch(() => {})
  return run
}

export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/** decrypt the stored hub token — main-process only. */
export async function getCloudToken(): Promise<string | null> {
  const { file } = await readTokenFile()
  if (!file.tokenEnc || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(file.tokenEnc, 'base64'))
  } catch {
    // machine-bound blob carried over from another machine: present but unreadable
    return null
  }
}

export async function setCloudToken(token: string): Promise<void> {
  const trimmed = token.trim()
  if (!trimmed || trimmed.length > MAX_TOKEN_LENGTH) throw new Error('Invalid cloud token')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable on this system, so the token cannot be saved safely')
  }
  await writeToken(safeStorage.encryptString(trimmed).toString('base64'))
}

export async function clearCloudToken(): Promise<void> {
  await writeToken(undefined)
}

export async function hasCloudToken(): Promise<boolean> {
  return (await getCloudToken()) !== null
}
