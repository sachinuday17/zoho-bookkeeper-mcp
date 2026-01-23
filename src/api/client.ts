/**
 * Zoho Books API Client
 */

import * as fs from "fs"
import * as path from "path"
import { getAccessToken, ZohoAuthError } from "../auth/oauth.js"
import { getZohoConfig, MAX_FILE_SIZE_BYTES, REQUEST_TIMEOUT_MS } from "../config.js"
import { getMimeType, validateAttachment } from "../utils/mime-types.js"
import { parseZohoResponse, type ParsedResponse } from "../utils/response-parser.js"

// Security: Allowed base directories for file uploads
// Files can only be uploaded from these directories or their subdirectories
const ALLOWED_UPLOAD_DIRECTORIES = [
  "/app/documents", // Docker container path
  "/tmp/zoho-bookkeeper-uploads", // App-specific temp directory (narrower than /tmp)
  process.env.HOME ? path.join(process.env.HOME, "Documents") : undefined, // User documents
  process.env.ZOHO_ALLOWED_UPLOAD_DIR, // Optional override/additional safe directory
].filter((d): d is string => Boolean(d))

/**
 * Normalize path for cross-platform comparison
 * Security: Handles case-insensitive filesystems (Windows, macOS with default settings)
 */
function normalizeForCompare(p: string): string {
  const normalized = path.normalize(p)
  // Windows and macOS (default) have case-insensitive filesystems
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLowerCase()
    : normalized
}

/**
 * Sanitize filename for multipart upload
 * Security: Prevents header injection via CR/LF and path traversal via separators
 */
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[\r\n]/g, "") // Strip CR/LF to prevent header injection
    .replace(/[/\\]/g, "_") // Replace path separators to prevent traversal
}

/**
 * Validate that a file path is within allowed directories (prevent path traversal)
 * Security: Prevents reading arbitrary files like /etc/passwd
 * Security: Uses realpath to resolve symlinks and prevent symlink-based attacks
 * Security: Returns resolvedPath to prevent TOCTOU attacks
 * Security: Uses normalized paths for case-insensitive filesystem comparison
 */
function validateFilePath(filePath: string): {
  valid: boolean
  error?: string
  resolvedPath?: string
} {
  const resolvedInput = path.resolve(filePath)

  // Prefer canonical path when file exists (symlink protection), otherwise use resolved path
  let realPath = resolvedInput
  try {
    if (fs.existsSync(filePath)) {
      realPath = fs.realpathSync(filePath)
    }
  } catch {
    realPath = resolvedInput
  }

  // Check if real path is within allowed directories (using normalized comparison)
  const normalizedRealPath = normalizeForCompare(realPath)

  const isAllowed = ALLOWED_UPLOAD_DIRECTORIES.some((allowedDir) => {
    const resolvedAllowed = path.resolve(allowedDir)

    // Prefer canonical path for allowed dir, fall back to resolved if it doesn't exist
    let allowedReal = resolvedAllowed
    try {
      if (fs.existsSync(allowedDir)) {
        allowedReal = fs.realpathSync(allowedDir)
      }
    } catch {
      allowedReal = resolvedAllowed
    }

    const normalizedAllowed = normalizeForCompare(allowedReal)
    return (
      normalizedRealPath === normalizedAllowed ||
      normalizedRealPath.startsWith(normalizedAllowed + path.sep)
    )
  })

  if (!isAllowed) {
    return {
      valid: false,
      error: "File path not in allowed upload directories",
    }
  }

  return { valid: true, resolvedPath: realPath }
}

/**
 * Create an AbortController with timeout
 * Security: Prevents hanging requests
 */
function createTimeoutController(timeoutMs: number = REQUEST_TIMEOUT_MS): {
  controller: AbortController
  timeoutId: ReturnType<typeof setTimeout>
  timeoutMs: number
} {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  // Prevent the timeout from keeping the process alive (useful for tests/CLI)
  if (typeof timeoutId === "object" && "unref" in timeoutId) {
    timeoutId.unref()
  }

  return { controller, timeoutId, timeoutMs }
}

/**
 * Resolve organization ID from parameter or environment config
 * Returns the resolved org ID or an error message if neither is available
 */
function resolveOrganizationId(organizationId?: string): { orgId: string } | { error: string } {
  const config = getZohoConfig()
  const orgId = organizationId || config.organizationId

  if (!orgId) {
    return {
      error:
        "Organization ID required. Set ZOHO_ORGANIZATION_ID environment variable or pass organization_id parameter.",
    }
  }

  return { orgId }
}

/**
 * Make a request to the Zoho Books API
 */
export async function zohoRequest<T>(
  method: string,
  endpoint: string,
  organizationId?: string,
  body?: Record<string, unknown>,
  queryParams?: Record<string, string>
): Promise<ParsedResponse<T>> {
  const config = getZohoConfig()

  // Resolve organization ID
  const orgIdResult = resolveOrganizationId(organizationId)
  if ("error" in orgIdResult) {
    return {
      ok: false,
      errorMessage: orgIdResult.error,
    }
  }

  let token: string

  try {
    token = await getAccessToken()
  } catch (error) {
    if (error instanceof ZohoAuthError) {
      return {
        ok: false,
        errorMessage: error.message,
      }
    }
    return {
      ok: false,
      errorMessage: `Authentication error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Build URL with query params
  const url = new URL(`${config.apiUrl}${endpoint}`)
  url.searchParams.set("organization_id", orgIdResult.orgId)

  if (queryParams) {
    Object.entries(queryParams).forEach(([key, value]) => {
      url.searchParams.set(key, value)
    })
  }

  // Security: Add request timeout
  const { controller, timeoutId, timeoutMs } = createTimeoutController()

  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    signal: controller.signal,
  }

  if (body && method !== "GET" && method !== "HEAD") {
    // Zoho expects a JSONString parameter wrapping the actual data
    options.body = JSON.stringify({ JSONString: JSON.stringify(body) })
  }

  try {
    const response = await fetch(url.toString(), options)
    return parseZohoResponse<T>(response, endpoint)
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        errorMessage: `Request timeout after ${timeoutMs / 1000} seconds`,
      }
    }
    return {
      ok: false,
      errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Make a GET request to the Zoho Books API
 */
export async function zohoGet<T>(
  endpoint: string,
  organizationId?: string,
  queryParams?: Record<string, string>
): Promise<ParsedResponse<T>> {
  return zohoRequest<T>("GET", endpoint, organizationId, undefined, queryParams)
}

/**
 * Make a POST request to the Zoho Books API
 */
export async function zohoPost<T>(
  endpoint: string,
  organizationId?: string,
  body?: Record<string, unknown>
): Promise<ParsedResponse<T>> {
  return zohoRequest<T>("POST", endpoint, organizationId, body)
}

/**
 * Make a PUT request to the Zoho Books API
 */
export async function zohoPut<T>(
  endpoint: string,
  organizationId?: string,
  body?: Record<string, unknown>
): Promise<ParsedResponse<T>> {
  return zohoRequest<T>("PUT", endpoint, organizationId, body)
}

/**
 * Make a DELETE request to the Zoho Books API
 */
export async function zohoDelete<T>(
  endpoint: string,
  organizationId?: string
): Promise<ParsedResponse<T>> {
  return zohoRequest<T>("DELETE", endpoint, organizationId)
}

/**
 * Upload a file attachment to a Zoho Books entity
 * Uses multipart/form-data for proper file upload
 */
export async function zohoUploadAttachment(
  endpoint: string,
  organizationId: string | undefined,
  filePath: string
): Promise<ParsedResponse<Record<string, unknown>>> {
  const config = getZohoConfig()

  // Resolve organization ID
  const orgIdResult = resolveOrganizationId(organizationId)
  if ("error" in orgIdResult) {
    return {
      ok: false,
      errorMessage: orgIdResult.error,
    }
  }

  let token: string

  // Security: Validate file path is within allowed directories (prevent path traversal)
  const pathValidation = validateFilePath(filePath)
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    return {
      ok: false,
      errorMessage: pathValidation.error || "Invalid file path",
    }
  }

  // Security: Use resolved path for all subsequent operations to prevent TOCTOU attacks
  const resolvedPath = pathValidation.resolvedPath

  // Validate the attachment file type using resolved path (ensures checks match the file being uploaded)
  const validation = validateAttachment(resolvedPath)
  if (!validation.valid) {
    return {
      ok: false,
      errorMessage: validation.error,
    }
  }

  // Security: Open file once and validate/read via same handle (prevents TOCTOU + avoids blocking I/O)
  let fileBuffer: Buffer
  let fileName: string
  let mimeType: string

  let fh: fs.promises.FileHandle | undefined
  try {
    // Security: Use O_NOFOLLOW to prevent symlink-based path traversal attacks
    const flags =
      typeof fs.constants.O_NOFOLLOW === "number"
        ? fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        : fs.constants.O_RDONLY

    fh = await fs.promises.open(resolvedPath, flags)
    const stats = await fh.stat()

    // Security: Ensure it's a regular file (rejects directories, FIFOs, sockets, devices)
    if (!stats.isFile()) {
      return {
        ok: false,
        errorMessage: "Upload path must be a regular file",
      }
    }

    // Security: Validate file size (prevent OOM)
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      return {
        ok: false,
        errorMessage: `File too large: ${(stats.size / 1024 / 1024).toFixed(2)}MB (max ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB)`,
      }
    }

    fileBuffer = await fh.readFile()
    // Security: Sanitize filename to prevent header injection and path traversal
    fileName = sanitizeFilename(path.basename(resolvedPath))
    mimeType = getMimeType(resolvedPath)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err?.code === "ELOOP") {
      return {
        ok: false,
        errorMessage: "Symlinks are not allowed for uploads",
      }
    }
    return {
      ok: false,
      errorMessage: "File not found or inaccessible",
    }
  } finally {
    await fh?.close().catch(() => undefined)
  }

  try {
    token = await getAccessToken()
  } catch (error) {
    if (error instanceof ZohoAuthError) {
      return {
        ok: false,
        errorMessage: error.message,
      }
    }
    return {
      ok: false,
      errorMessage: `Authentication error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Build URL
  const url = new URL(`${config.apiUrl}${endpoint}`)
  url.searchParams.set("organization_id", orgIdResult.orgId)

  const formData = new FormData()
  const blob = new Blob([fileBuffer], { type: mimeType })
  formData.append("attachment", blob, fileName)

  // Security: Add request timeout
  const { controller, timeoutId, timeoutMs } = createTimeoutController()

  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        // DO NOT set Content-Type header - let fetch set it with the correct multipart boundary
      },
      body: formData,
      signal: controller.signal,
    })

    return parseZohoResponse<Record<string, unknown>>(response, endpoint)
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        errorMessage: `Upload timeout after ${timeoutMs / 1000} seconds`,
      }
    }
    return {
      ok: false,
      errorMessage: `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Get attachment info from a Zoho Books entity
 */
export async function zohoGetAttachment(
  endpoint: string,
  organizationId?: string
): Promise<ParsedResponse<Record<string, unknown>>> {
  return zohoGet<Record<string, unknown>>(endpoint, organizationId)
}

/**
 * Delete attachment from a Zoho Books entity
 */
export async function zohoDeleteAttachment(
  endpoint: string,
  organizationId?: string
): Promise<ParsedResponse<Record<string, unknown>>> {
  return zohoDelete<Record<string, unknown>>(endpoint, organizationId)
}

/**
 * List organizations (special endpoint without organization_id)
 */
export async function zohoListOrganizations(): Promise<ParsedResponse<Record<string, unknown>>> {
  const config = getZohoConfig()
  let token: string

  try {
    token = await getAccessToken()
  } catch (error) {
    if (error instanceof ZohoAuthError) {
      return {
        ok: false,
        errorMessage: error.message,
      }
    }
    return {
      ok: false,
      errorMessage: `Authentication error: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // Security: Add request timeout
  const { controller, timeoutId, timeoutMs } = createTimeoutController()

  try {
    const response = await fetch(`${config.apiUrl}/organizations`, {
      method: "GET",
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    })

    return parseZohoResponse<Record<string, unknown>>(response, "/organizations")
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        errorMessage: `Request timeout after ${timeoutMs / 1000} seconds`,
      }
    }
    return {
      ok: false,
      errorMessage: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
