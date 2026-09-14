/**
 * The SSRF guard. Lifted from Studio's
 * `lib/core/security/input-validation{,.server}.ts`, trimmed to the two
 * functions the engine calls and their helpers.
 *
 * Two problems, and the pair solves both. `validateUrlWithDNS` refuses a URL
 * whose protocol, port or resolved address should not be reachable from a
 * service — private and reserved ranges, the usual internal ports — and hands
 * back the address it resolved. `secureFetchWithPinnedIP` then connects to
 * *that address*, keeping the original hostname for TLS SNI, which closes the
 * DNS-rebinding window between the check and the connection. Redirects are
 * re-validated one hop at a time rather than followed blindly.
 *
 * Search needs this for the same reason Studio does: a paired client hands it a
 * document URL and it fetches it, and "fetch whatever URL you are given" from
 * inside a deployment's network is the whole SSRF class.
 *
 * lifted: the `isHosted` branches. They relaxed the localhost rules for Actana's
 * hosted deployment, which Search has no notion of; `SEARCH_ALLOW_LOCAL_FETCH`
 * takes their place for an operator running everything on one machine, and it
 * is off unless set. `validateImageUrl` and the database-host validator stayed
 * in Studio with the surfaces that used them.
 */

import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import * as ipaddr from 'ipaddr.js'
import { createLogger } from '@actana/search-shared/log'

const logger = createLogger('security/url-guard')

/** Set to allow `localhost` and private addresses — a single-machine deployment. */
function allowLocalFetch(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.SEARCH_ALLOW_LOCAL_FETCH ?? '')
}

export interface ValidationResult {
  isValid: boolean
  error?: string
}

export interface AsyncValidationResult extends ValidationResult {
  resolvedIP?: string
  originalHostname?: string
}

/**
 * Whether an IP is private or reserved — not routable on the public internet.
 *
 * Through `ipaddr.js` rather than a regular expression, because the formats a
 * regular expression misses are exactly the ones an attacker reaches for:
 * octal (`0177.0.0.1`), hex (`0x7f000001`), IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`).
 */
export function isPrivateOrReservedIP(ip: string): boolean {
  try {
    if (!ipaddr.isValid(ip)) {
      return true
    }
    return ipaddr.process(ip).range() !== 'unicast'
  } catch {
    return true
  }
}

const BLOCKED_PORTS = ['22', '23', '25', '3306', '5432', '6379', '27017', '9200']

/** Protocol, port and literal-address checks, before any DNS is done. */
export function validateExternalUrl(
  url: string | null | undefined,
  paramName = 'url',
  options: { allowHttp?: boolean } = {}
): ValidationResult {
  if (!url || typeof url !== 'string') {
    return { isValid: false, error: `${paramName} is required and must be a string` }
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return { isValid: false, error: `${paramName} must be a valid URL` }
  }

  const protocol = parsedUrl.protocol
  const hostname = parsedUrl.hostname.toLowerCase()
  const cleanHostname =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname

  let isLocalhost = cleanHostname === 'localhost'
  if (ipaddr.isValid(cleanHostname)) {
    const processedIP = ipaddr.process(cleanHostname).toString()
    if (processedIP === '127.0.0.1' || processedIP === '::1') {
      isLocalhost = true
    }
  }

  if (isLocalhost && !allowLocalFetch()) {
    return { isValid: false, error: `${paramName} cannot point to localhost` }
  }

  if (options.allowHttp) {
    if (protocol !== 'https:' && protocol !== 'http:') {
      return { isValid: false, error: `${paramName} must use http:// or https:// protocol` }
    }
  } else if (protocol !== 'https:' && !(protocol === 'http:' && isLocalhost && allowLocalFetch())) {
    return { isValid: false, error: `${paramName} must use https:// protocol` }
  }

  if (!isLocalhost && ipaddr.isValid(cleanHostname) && isPrivateOrReservedIP(cleanHostname)) {
    return { isValid: false, error: `${paramName} cannot point to private IP addresses` }
  }

  if (parsedUrl.port && BLOCKED_PORTS.includes(parsedUrl.port)) {
    return { isValid: false, error: `${paramName} uses a blocked port` }
  }

  return { isValid: true }
}

/**
 * Validate a URL and resolve its hostname, returning the address to connect to.
 *
 * The returned address is the point: checking a hostname and then letting the
 * HTTP client resolve it again is a check an attacker can walk past by
 * answering the second lookup differently.
 */
export async function validateUrlWithDNS(
  url: string | null | undefined,
  paramName = 'url',
  options: { allowHttp?: boolean } = {}
): Promise<AsyncValidationResult> {
  const basicValidation = validateExternalUrl(url, paramName, options)
  if (!basicValidation.isValid) {
    return basicValidation
  }

  const parsedUrl = new URL(url!)
  const hostname = parsedUrl.hostname
  const hostnameLower = hostname.toLowerCase()
  const cleanHostname =
    hostnameLower.startsWith('[') && hostnameLower.endsWith(']')
      ? hostnameLower.slice(1, -1)
      : hostnameLower

  let isLocalhost = cleanHostname === 'localhost'
  if (ipaddr.isValid(cleanHostname)) {
    const processedIP = ipaddr.process(cleanHostname).toString()
    if (processedIP === '127.0.0.1' || processedIP === '::1') {
      isLocalhost = true
    }
  }

  try {
    // Prefer IPv4 for broader network compatibility, fall back to any address
    let address: string
    try {
      address = (await dns.lookup(cleanHostname, { family: 4 })).address
    } catch {
      address = (await dns.lookup(cleanHostname, { verbatim: true })).address
    }

    const resolvedIsLoopback =
      ipaddr.isValid(address) &&
      (() => {
        const ip = ipaddr.process(address).toString()
        return ip === '127.0.0.1' || ip === '::1'
      })()

    if (
      isPrivateOrReservedIP(address) &&
      !(isLocalhost && resolvedIsLoopback && allowLocalFetch())
    ) {
      logger.warn('URL resolves to blocked IP address', {
        paramName,
        hostname,
        resolvedIP: address,
      })
      return { isValid: false, error: `${paramName} resolves to a blocked IP address` }
    }

    return { isValid: true, resolvedIP: address, originalHostname: hostname }
  } catch (error) {
    logger.warn('DNS lookup failed for URL', {
      paramName,
      hostname,
      error: error instanceof Error ? error.message : String(error),
    })
    return { isValid: false, error: `${paramName} hostname could not be resolved` }
  }
}

export interface SecureFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeout?: number
  maxRedirects?: number
  maxResponseBytes?: number
}

export class SecureFetchHeaders {
  readonly #headers: Map<string, string>

  constructor(headers: Record<string, string>) {
    this.#headers = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  }

  get(name: string): string | null {
    return this.#headers.get(name.toLowerCase()) ?? null
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.#headers)
  }

  [Symbol.iterator]() {
    return this.#headers.entries()
  }
}

export interface SecureFetchResponse {
  ok: boolean
  status: number
  statusText: string
  headers: SecureFetchHeaders
  text: () => Promise<string>
  json: () => Promise<unknown>
  arrayBuffer: () => Promise<ArrayBuffer>
}

const DEFAULT_MAX_REDIRECTS = 5

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304
}

function resolveRedirectUrl(baseUrl: string, location: string): string {
  try {
    return new URL(location, baseUrl).toString()
  } catch {
    throw new Error(`Invalid redirect location: ${location}`)
  }
}

/**
 * A DNS lookup that always answers with one pre-resolved address. This is what
 * pins the connection to the address the validator checked.
 */
export function createPinnedLookup(resolvedIP: string): LookupFunction {
  const family = resolvedIP.includes(':') ? 6 : 4
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: resolvedIP, family }])
    } else {
      callback(null, resolvedIP, family)
    }
  }
}

/**
 * Fetch with the address pinned, keeping the hostname for TLS SNI. Each
 * redirect is re-validated before it is followed.
 */
export async function secureFetchWithPinnedIP(
  url: string,
  resolvedIP: string,
  options: SecureFetchOptions & { allowHttp?: boolean } = {},
  redirectCount = 0
): Promise<SecureFetchResponse> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const maxResponseBytes = options.maxResponseBytes

  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : isHttps ? 443 : 80

    const agentOptions: http.AgentOptions = { lookup: createPinnedLookup(resolvedIP) }
    const agent = isHttps ? new https.Agent(agentOptions) : new http.Agent(agentOptions)

    // `accept-encoding` is dropped: the body is buffered and compared against
    // `maxResponseBytes` uncompressed, and a compressed response would make
    // that cap meaningless.
    const { 'accept-encoding': _dropped, ...sanitizedHeaders } = options.headers ?? {}

    const requestOptions: http.RequestOptions = {
      hostname: parsed.hostname,
      port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: sanitizedHeaders,
      agent,
      timeout: options.timeout || 300000,
    }

    const protocol = isHttps ? https : http
    const req = protocol.request(requestOptions, (res) => {
      const statusCode = res.statusCode || 0
      const location = res.headers.location

      if (isRedirectStatus(statusCode) && location && redirectCount < maxRedirects) {
        res.resume()
        const redirectUrl = resolveRedirectUrl(url, location)

        validateUrlWithDNS(redirectUrl, 'redirectUrl', { allowHttp: options.allowHttp })
          .then((validation) => {
            if (!validation.isValid) {
              reject(new Error(`Redirect blocked: ${validation.error}`))
              return
            }
            return secureFetchWithPinnedIP(
              redirectUrl,
              validation.resolvedIP!,
              options,
              redirectCount + 1
            )
          })
          .then((response) => {
            if (response) resolve(response)
          })
          .catch(reject)
        return
      }

      if (isRedirectStatus(statusCode) && location && redirectCount >= maxRedirects) {
        res.resume()
        reject(new Error(`Too many redirects (max: ${maxRedirects})`))
        return
      }

      const chunks: Buffer[] = []
      let totalBytes = 0
      let responseTerminated = false

      res.on('data', (chunk: Buffer) => {
        if (responseTerminated) return

        totalBytes += chunk.length
        if (
          typeof maxResponseBytes === 'number' &&
          maxResponseBytes > 0 &&
          totalBytes > maxResponseBytes
        ) {
          responseTerminated = true
          res.destroy(new Error(`Response exceeded maximum size of ${maxResponseBytes} bytes`))
          return
        }

        chunks.push(chunk)
      })

      res.on('error', (error) => {
        reject(error)
      })

      res.on('end', () => {
        if (responseTerminated) return
        const bodyBuffer = Buffer.concat(chunks)
        const body = bodyBuffer.toString('utf-8')
        const headersRecord: Record<string, string> = {}
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') {
            headersRecord[key.toLowerCase()] = value
          } else if (Array.isArray(value)) {
            headersRecord[key.toLowerCase()] = value.join(', ')
          }
        }

        resolve({
          ok: statusCode >= 200 && statusCode < 300,
          status: statusCode,
          statusText: res.statusMessage || '',
          headers: new SecureFetchHeaders(headersRecord),
          text: async () => body,
          json: async () => JSON.parse(body),
          arrayBuffer: async () =>
            bodyBuffer.buffer.slice(
              bodyBuffer.byteOffset,
              bodyBuffer.byteOffset + bodyBuffer.byteLength
            ),
        })
      })
    })

    req.on('error', (error) => {
      reject(error)
    })

    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Request timed out after ${requestOptions.timeout}ms`))
    })

    if (options.body) {
      req.write(options.body)
    }

    req.end()
  })
}

/** Validate and fetch in one call — the shape most call sites want. */
export async function secureFetch(
  url: string,
  options: SecureFetchOptions & { allowHttp?: boolean } = {},
  paramName = 'url'
): Promise<SecureFetchResponse> {
  const validation = await validateUrlWithDNS(url, paramName, { allowHttp: options.allowHttp })
  if (!validation.isValid) {
    throw new Error(`Invalid ${paramName}: ${validation.error}`)
  }
  return secureFetchWithPinnedIP(url, validation.resolvedIP!, options)
}
