import { BaseProvider, ProviderError } from './base'
import { Agent, EnvHttpProxyAgent, request as undiciRequest, type Dispatcher } from 'undici'
import { appendFile } from 'node:fs/promises'
import {
  IMAGE_REQUEST_TIMEOUT_MS,
  IMAGE_RESPONSE_BODY_IDLE_TIMEOUT_MS,
  IMAGE_RESPONSE_BODY_TIMEOUT_MS,
  IMAGE_RESPONSE_FORMAT,
} from '@/lib/image-generation-policy'
import type {
  ProviderConfig,
  ImageOptions,
  ImageResult,
  ImageTransportTiming,
  VideoOptions,
  VideoResult,
  TaskStatus,
  TaskStatusEnum,
  Model,
  MediaType,
} from './types'
import { modelApiErrorCode, normalizeModelApiUsage, recordModelApiCall } from '@/lib/model-api-audit'

type UnknownRecord = Record<string, unknown>

interface OpenAIImageResponse {
  created?: number
  data?: Array<{
    url?: string
    b64_json?: string
    revised_prompt?: string
  }>
}

/** Image requests can take several minutes on high-resolution image models. */
export const DEFAULT_IMAGE_REQUEST_TIMEOUT_MS = IMAGE_REQUEST_TIMEOUT_MS
const REFERENCE_IMAGE_FETCH_TIMEOUT_MS = 120 * 1000
const VIDEO_SUBMIT_SAFE_RETRY_ATTEMPTS = 3
const VIDEO_SUBMIT_SAFE_RETRY_DELAY_MS = 1500

function hasConfiguredOutboundProxy() {
  return Boolean(
    process.env.http_proxy?.trim()
      || process.env.HTTP_PROXY?.trim()
      || process.env.https_proxy?.trim()
      || process.env.HTTPS_PROXY?.trim()
      || process.env.all_proxy?.trim()
      || process.env.ALL_PROXY?.trim(),
  )
}

function openAIRequestDispatcher(): Dispatcher {
  const options = {
    connectTimeout: 60_000,
    headersTimeout: 0,
    bodyTimeout: 0,
  }
  // Explicit undici dispatchers do not inherit Node's environment proxy. The
  // 3100 launcher supplies the proxy through HTTP(S)_PROXY, so keep all
  // OpenAI-compatible image/video requests on the same outbound route.
  return hasConfiguredOutboundProxy()
    ? new EnvHttpProxyAgent(options)
    : new Agent(options)
}

export class ImageResponseBodyIdleTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    public readonly bytesReceived: number
  ) {
    super(`Image response body made no progress for ${timeoutMs}ms`)
    this.name = 'ImageResponseBodyIdleTimeoutError'
  }
}

export interface ImageResponseBodyReadResult {
  text: string
  bytesReceived: number
  chunkCount: number
  firstByteWaitMs: number
  bodyTransferMs: number
  maxChunkGapMs: number
}

export async function readImageResponseBodyWithIdleTimeout(
  body: AsyncIterable<Uint8Array>,
  idleTimeoutMs = IMAGE_RESPONSE_BODY_IDLE_TIMEOUT_MS
): Promise<ImageResponseBodyReadResult> {
  const chunks: Buffer[] = []
  let bytesReceived = 0
  let chunkCount = 0
  let firstChunkAt: number | undefined
  let previousChunkAt: number | undefined
  let maxChunkGapMs = 0
  const readStartedAt = performance.now()
  const iterator = body[Symbol.asyncIterator]()

  while (true) {
    let idleTimeoutId: ReturnType<typeof setTimeout> | null = null
    try {
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          idleTimeoutId = setTimeout(
            () => reject(new ImageResponseBodyIdleTimeoutError(idleTimeoutMs, bytesReceived)),
            idleTimeoutMs
          )
        }),
      ])
      if (next.done) break
      const chunkReceivedAt = performance.now()
      if (firstChunkAt === undefined) firstChunkAt = chunkReceivedAt
      if (previousChunkAt !== undefined) {
        maxChunkGapMs = Math.max(maxChunkGapMs, chunkReceivedAt - previousChunkAt)
      }
      previousChunkAt = chunkReceivedAt
      const chunk = Buffer.from(next.value)
      chunks.push(chunk)
      bytesReceived += chunk.length
      chunkCount += 1
    } finally {
      if (idleTimeoutId) clearTimeout(idleTimeoutId)
    }
  }

  const completedAt = performance.now()
  return {
    text: Buffer.concat(chunks, bytesReceived).toString('utf8'),
    bytesReceived,
    chunkCount,
    firstByteWaitMs: Math.max(0, Math.round((firstChunkAt ?? completedAt) - readStartedAt)),
    bodyTransferMs: firstChunkAt === undefined ? 0 : Math.max(0, Math.round(completedAt - firstChunkAt)),
    maxChunkGapMs: Math.max(0, Math.round(maxChunkGapMs)),
  }
}

export function normalizeOpenAICompatiblePath(path: string, baseUrl: string): string {
  let normalized = path.trim()
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized)
      normalized = `${parsed.pathname}${parsed.search}`
    } catch {
      normalized = path.trim()
    }
  }
  if (!normalized.startsWith('/')) normalized = `/${normalized}`
  normalized = normalized.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'

  const normalizedBase = baseUrl.trim().replace(/\/+$/, '')
  if (/\/v1$/i.test(normalizedBase) && /^\/v1(?:\/|$)/i.test(normalized)) {
    normalized = normalized.slice(3) || '/'
  }
  return normalized
}

export function preferredOpenAIImageResult(item: { url?: string; b64_json?: string }) {
  if (item.b64_json) return { value: `data:image/png;base64,${item.b64_json}`, transport: 'b64_json' as const }
  if (item.url) return { value: item.url, transport: 'url' as const }
  return { value: undefined, transport: 'unknown' as const }
}

export class OpenAISeedanceProvider extends BaseProvider {
  readonly name = 'openai-seedance'
  readonly displayName = 'Custom OpenAI / Seedance'

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: OpenAISeedanceProvider.normalizeOpenAIBaseUrl(config.baseUrl || 'https://api.openai.com/v1'),
      extra: OpenAISeedanceProvider.normalizeExtraBaseUrls(config.extra),
    })
  }

  protected override async request<T = unknown>(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
      body?: unknown
      headers?: Record<string, string>
      timeout?: number
    } = {}
  ): Promise<T> {
    const { method = 'GET', body, headers = {}, timeout } = options
    const url = `${this.config.baseUrl}${path}`
    const requestTimeout = timeout && timeout > 0
      ? timeout
      : this.config.timeout && this.config.timeout > 0
        ? this.config.timeout
        : DEFAULT_IMAGE_REQUEST_TIMEOUT_MS
    const controller = requestTimeout > 0 ? new AbortController() : null
    const timeoutId = controller ? setTimeout(() => controller.abort(), requestTimeout) : null
    const dispatcher = openAIRequestDispatcher()

    try {
      const response = await undiciRequest(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...this.getAuthHeaders(),
          ...this.config.headers,
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller?.signal,
        headersTimeout: 0,
        bodyTimeout: 0,
        dispatcher,
      })
      const rawBody = await response.body.text().catch(() => '')

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new ProviderError(
          `API request failed: ${response.statusCode} ${response.statusText || ''} - ${rawBody}`,
          'API_ERROR',
          this.name,
          response.statusCode
        )
      }

      if (!rawBody.trim()) return undefined as T
      return JSON.parse(rawBody) as T
    } catch (error) {
      if (error instanceof ProviderError) throw error

      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProviderError(
          `Request timed out after ${requestTimeout}ms: ${method} ${url}`,
          'TIMEOUT',
          this.name
        )
      }

      throw new ProviderError(
        `Network request failed: ${method} ${url} - ${error instanceof Error ? error.message : String(error)}`,
        'NETWORK_ERROR',
        this.name
      )
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      await dispatcher.close().catch(() => undefined)
    }
  }

  private static normalizeOpenAIBaseUrl(baseUrl: string): string {
    const normalized = baseUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v1\/images\/edits$/i, '/v1')
      .replace(/\/v1\/images\/generations$/i, '/v1')
      .replace(/\/v1\/chat\/completions$/i, '/v1')
      .replace(/\/v1\/responses$/i, '/v1')
      .replace(/\/v1\/videos(?:\/.*)?$/i, '/v1')
      .replace(/\/v1\/video\/generations(?:\/.*)?$/i, '/v1')
    if (/^https:\/\/media\.apishop\.vip$/i.test(normalized)) {
      return `${normalized}/v1`
    }
    return normalized
  }

  private static normalizeExtraBaseUrls(extra: ProviderConfig['extra']): ProviderConfig['extra'] {
    if (!extra) return extra
    return {
      ...extra,
      imageBaseUrl: typeof extra.imageBaseUrl === 'string'
        ? OpenAISeedanceProvider.normalizeOpenAIBaseUrl(extra.imageBaseUrl)
        : extra.imageBaseUrl,
      videoBaseUrl: typeof extra.videoBaseUrl === 'string'
        ? OpenAISeedanceProvider.normalizeOpenAIBaseUrl(extra.videoBaseUrl)
        : extra.videoBaseUrl,
    }
  }

  async generateImage(options: ImageOptions): Promise<ImageResult> {
    if (options.referenceImageUrls?.length || options.referenceImageUrl) {
      return this.generateImageEdit(options)
    }

    const body = {
      model: options.modelId || 'gpt-image-2',
      prompt: options.prompt,
      n: options.count ?? 1,
      size: this.toOpenAIImageSize(options.width, options.height),
      response_format: IMAGE_RESPONSE_FORMAT,
      ...options.extra,
    }

    const response = await this.withMediaConfig('image', () =>
      this.request<OpenAIImageResponse>(
        this.resolvePath('/images/generations', 'imagePath'),
        {
          method: 'POST',
          body,
          timeout: 0,
        }
      )
    )

    const data = response.data ?? []
    const imageResults = data.map(preferredOpenAIImageResult)
    const imageUrls = imageResults
      .map((item) => item.value)
      .filter((url): url is string => Boolean(url))

    if (imageUrls.length === 0) {
      throw new ProviderError('Image API did not return url or b64_json', 'NO_IMAGE_RESULT', this.name)
    }

    return {
      taskId: `openai-img-${Date.now()}`,
      imageUrls,
      modelId: options.modelId,
      extra: {
        created: response.created,
        revisedPrompts: data.map((item) => item.revised_prompt).filter(Boolean),
        rawDataCount: data.length,
        resultFormats: imageResults.map((item) => item.transport),
      },
    }
  }

  private async generateImageEdit(options: ImageOptions): Promise<ImageResult> {
    const referenceUrls = options.referenceImageUrls?.length
      ? options.referenceImageUrls
      : options.referenceImageUrl
        ? [options.referenceImageUrl]
        : []
    if (referenceUrls.length === 0) {
      throw new ProviderError('Image edit requires at least one reference image', 'NO_REFERENCE_IMAGE', this.name)
    }

    const references = await Promise.all(referenceUrls.slice(0, 16).map((url) => this.loadReferenceImage(url)))
    const formData = new FormData()
    const size = this.toOpenAIImageSize(options.width, options.height)

    formData.set('model', options.modelId || 'gpt-image-2')
    formData.set('prompt', options.prompt)
    formData.set('n', String(options.count ?? 1))
    formData.set('response_format', IMAGE_RESPONSE_FORMAT)
    if (size) formData.set('size', size)
    references.forEach((reference) => {
      formData.append(
        'image',
        new Blob([this.toArrayBuffer(reference.bytes)], { type: reference.mimeType }),
        reference.filename
      )
    })

    for (const [key, value] of Object.entries(options.extra ?? {})) {
      if (value === undefined || value === null) continue
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        formData.set(key, String(value))
      }
    }

    const referenceBytes = references.reduce((total, reference) => total + reference.bytes.byteLength, 0)
    const promptBytes = Buffer.byteLength(options.prompt || '', 'utf8')
    await this.appendImageDebugLog('upstream_request_payload', {
      model: options.modelId || 'gpt-image-2',
      size: size || null,
      count: options.count ?? 1,
      responseFormat: IMAGE_RESPONSE_FORMAT,
      aspectRatio: options.extra?.aspect_ratio || null,
      quality: options.extra?.quality || null,
      referenceCount: references.length,
      referenceBytes,
      promptBytes,
      approximateMultipartBytes: referenceBytes + promptBytes,
    })

    const { data: response, timing } = await this.withMediaConfig('image', () =>
      this.requestFormData<OpenAIImageResponse>(
        this.resolvePath('/images/edits', 'imageEditPath'),
        formData,
        0
      )
    )

    const data = response.data ?? []
    const imageResults = data.map(preferredOpenAIImageResult)
    const imageUrls = imageResults
      .map((item) => item.value)
      .filter((url): url is string => Boolean(url))

    if (imageUrls.length === 0) {
      throw new ProviderError('Image edit API did not return url or b64_json', 'NO_IMAGE_EDIT_RESULT', this.name)
    }

    return {
      taskId: `openai-img-edit-${Date.now()}`,
      imageUrls,
      modelId: options.modelId,
      extra: {
        created: response.created,
        revisedPrompts: data.map((item) => item.revised_prompt).filter(Boolean),
        rawDataCount: data.length,
        resultFormats: imageResults.map((item) => item.transport),
        timing,
      },
    }
  }

  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    return this.withMediaConfig('video', async () => {
      const aspectRatio = this.toVideoAspectRatio(options.width, options.height)
      const resolution = this.toVideoResolution(options.width, options.height)
      const isOmniModel = /omni/i.test(options.modelId || '')
      const isOmniVrefModel = /omni-flash-vref/i.test(options.modelId || '')
      const isGrokVideoModel = this.isGrokVideoModel(options.modelId)
      const isLingganyaSd20Vip = this.config.extra?.lingganyaSd20Vip === true
        && String(options.modelId || '').trim().toLowerCase() === 'sd-2.0-vip'
      const isLingganyaSd20G = this.config.extra?.lingganyaSd20G === true
        && String(options.modelId || '').trim().toLowerCase() === 'sd-2.0-g'
      const isLingganyaSd20Mini = this.config.extra?.lingganyaSd20Mini === true
        && String(options.modelId || '').trim().toLowerCase() === 'sd-2.0-mini'
      const omniDuration = isOmniModel ? this.toOmniDuration(options.duration) : undefined
      const grokDuration = isGrokVideoModel ? this.toGrokDuration() : undefined
      const referenceImageUrls = this.buildVideoReferenceImages(options)
      const secondsValue = grokDuration ?? options.duration
      const seconds = secondsValue !== undefined ? String(secondsValue) : undefined
      const omniVideoReference = typeof options.extra?.video === 'string'
        ? options.extra.video.trim()
        : ''
      const lingganyaVideos = Array.isArray(options.extra?.videos)
        ? options.extra.videos.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : []
      const lingganyaAudios = Array.isArray(options.extra?.audios)
        ? options.extra.audios.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : []
      const lingganyaMiniVideos = Array.isArray(options.extra?.reference_videos)
        ? options.extra.reference_videos.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : []
      const lingganyaMiniAudios = Array.isArray(options.extra?.reference_audios)
        ? options.extra.reference_audios.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : []
      if ((isLingganyaSd20Vip || isLingganyaSd20G)
        && [...referenceImageUrls, ...lingganyaVideos, ...lingganyaAudios]
          .some((value) => !/^file_[a-zA-Z0-9_-]+$/.test(value))) {
        throw new ProviderError(
          `${options.modelId} references must be uploaded through Lingganya /v1/files before submission`,
          'INVALID_LINGGANYA_REFERENCE',
          this.name
        )
      }
      if (isOmniVrefModel && !/^https:\/\//i.test(omniVideoReference)) {
        throw new ProviderError(
          'omni-flash-vref requires a public HTTPS reference video URL',
          'OMNI_VREF_VIDEO_REQUIRED',
          this.name
        )
      }
      let body: UnknownRecord
      if (isLingganyaSd20Mini) {
        const duration = Math.round(Number(options.duration))
        if (!Number.isInteger(duration) || duration < 5 || duration > 15) {
          throw new ProviderError(
            'sd-2.0-mini duration must be an integer from 5 to 15 seconds',
            'INVALID_DURATION',
            this.name
          )
        }
        body = {
          model: options.modelId,
          prompt: options.prompt,
          seconds: duration,
          resolution: '720p',
          size: aspectRatio,
          ...(referenceImageUrls.length > 0 ? { images: referenceImageUrls } : {}),
          ...((lingganyaMiniVideos.length > 0 || lingganyaMiniAudios.length > 0) ? {
            extra: {
              ...(lingganyaMiniVideos.length > 0 ? { reference_videos: lingganyaMiniVideos } : {}),
              ...(lingganyaMiniAudios.length > 0 ? { reference_audios: lingganyaMiniAudios } : {}),
            },
          } : {}),
        }
      } else if (isLingganyaSd20G) {
        const duration = Math.round(Number(options.duration))
        if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
          throw new ProviderError(
            'sd-2.0-g duration must be an integer from 4 to 15 seconds',
            'INVALID_DURATION',
            this.name
          )
        }
        body = {
          model: options.modelId,
          prompt: options.prompt,
          duration,
          resolution,
          ratio: aspectRatio,
          ...(referenceImageUrls.length > 0 ? { images: referenceImageUrls } : {}),
          ...(lingganyaVideos.length > 0 ? { videos: lingganyaVideos } : {}),
          ...(lingganyaAudios.length > 0 ? { audios: lingganyaAudios } : {}),
        }
      } else if (isLingganyaSd20Vip) {
        const duration = Math.round(Number(options.duration))
        if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
          throw new ProviderError(
            'sd-2.0-vip duration must be an integer from 4 to 15 seconds',
            'INVALID_DURATION',
            this.name
          )
        }
        body = {
          model: options.modelId,
          prompt: options.prompt,
          seconds: duration,
          resolution,
          size: aspectRatio,
          ...(referenceImageUrls.length > 0 ? { images: referenceImageUrls } : {}),
        }
      } else if (isOmniModel) {
        body = {
          model: options.modelId || 'omni-flash',
          prompt: options.prompt,
          duration: isOmniVrefModel ? 10 : omniDuration,
          aspect_ratio: this.toOmniAspectRatio(aspectRatio),
          resolution,
          images: referenceImageUrls.slice(0, isOmniVrefModel ? 5 : 7),
          ...(isOmniVrefModel && { video: omniVideoReference }),
        }
      } else if (isGrokVideoModel) {
        body = {
          model: options.modelId,
          prompt: options.prompt,
          seconds,
          aspect_ratio: aspectRatio,
          resolution: this.toGrokResolution(resolution),
          ...(referenceImageUrls.length > 0 && {
            image_urls: referenceImageUrls.slice(0, 7),
          }),
        }
      } else {
        body = {
          ...this.sanitizeVideoExtra(options.extra),
          model: options.modelId || 'seedance-v1-5-pro',
          prompt: options.prompt,
          negative_prompt: options.negativePrompt,
          duration: options.duration,
          seconds,
          fps: options.fps,
          width: options.width,
          height: options.height,
          size: options.width && options.height ? `${options.width}x${options.height}` : undefined,
          aspect_ratio: aspectRatio,
          ratio: aspectRatio,
          resolution,
          n: 1,
          seed: options.seed,
          ...(referenceImageUrls.length > 0 && {
            images: referenceImageUrls,
          }),
          ...(options.firstFrameUrl && {
            image: options.firstFrameUrl,
            image_url: options.firstFrameUrl,
            first_frame_url: options.firstFrameUrl,
            input_image: options.firstFrameUrl,
          }),
          ...(options.lastFrameUrl && {
            last_frame_url: options.lastFrameUrl,
          }),
          ...(options.voiceover && {
            voiceover: options.voiceover,
          }),
          ...(options.audioPrompt && {
            audio_prompt: options.audioPrompt,
          }),
        }
      }

      const response = await this.submitVideoRequest(body)

      const extractedTaskId = this.extractTaskId(response)
      const taskId = extractedTaskId ?? `seedance-video-${Date.now()}`
      const immediateResult = this.parseVideoResult(taskId, response, options.modelId)
      if (immediateResult.videoUrls.length > 0) {
        return immediateResult
      }

      const submittedStatus = this.mapStatus(this.readString(response, ['status', 'task_status', 'state']) ?? '')
      if (submittedStatus === 'completed') {
        const contentResult = await this.tryFetchVideoContentResult(taskId, options.modelId)
        if (contentResult?.videoUrls.length) {
          return {
            ...contentResult,
            extra: {
              submitResponse: response,
              contentResponse: contentResult.extra,
            },
          }
        }
      }

      if (!extractedTaskId) {
        throw new ProviderError(
          `Seedance submit API did not return a task id: ${JSON.stringify(response).slice(0, 500)}`,
          'NO_TASK_ID',
          this.name
        )
      }

      const remoteTaskId = extractedTaskId
      let finalStatus: TaskStatus
      try {
        finalStatus = await this.pollTaskStatus(remoteTaskId, {
          interval: 5000,
          maxAttempts: 240,
        })
      } catch (error) {
        if (error instanceof ProviderError && this.shouldTryVideoContentAfterStatusError(error)) {
          const fallbackResult = await this.waitForVideoContentResult(remoteTaskId, options.modelId, response)
          if (fallbackResult?.videoUrls.length) {
            return fallbackResult
          }
        }
        throw error
      }

      if (!finalStatus.result) {
        throw new ProviderError('Video task completed without a result', 'NO_RESULT', this.name)
      }

      return finalStatus.result as VideoResult
    })
  }

  private async submitVideoRequest(body: UnknownRecord): Promise<UnknownRecord> {
    const configuredPath = this.resolvePath('/videos', 'videoSubmitPath')
    const fallbackPaths = [
      '/videos',
      '/video/generations',
      '/videos/generations',
      '/videos/generate',
      '/generations/videos',
    ]
    const paths = Array.from(new Set([configuredPath, ...fallbackPaths]))
    let lastError: ProviderError | undefined
    const audit = this.config.audit?.callType === 'video' ? this.config.audit : undefined
    const rootCallId = audit ? crypto.randomUUID() : ''
    let auditAttempt = 0

    for (const path of paths) {
      const debugSummary = this.videoSubmitDebugSummary(path, body)
      for (let attempt = 1; attempt <= VIDEO_SUBMIT_SAFE_RETRY_ATTEMPTS; attempt++) {
        console.info('[video-submit] start', {
          ...debugSummary,
          attempt,
          maxAttempts: VIDEO_SUBMIT_SAFE_RETRY_ATTEMPTS,
        })
        const startedAt = Date.now()
        const callId = audit
          ? auditAttempt === 0 ? rootCallId : crypto.randomUUID()
          : ''
        auditAttempt += 1
        try {
          const response = await this.request<UnknownRecord>(path, {
            method: 'POST',
            body,
            timeout: 0,
          })
          if (audit) {
            await recordModelApiCall({
              ...audit,
              id: callId,
              parentCallId: auditAttempt > 1 ? rootCallId : undefined,
              attemptNumber: auditAttempt,
              status: 'success',
              durationMs: Date.now() - startedAt,
              remoteTaskId: this.extractTaskId(response),
              usage: normalizeModelApiUsage(response.usage),
            }).catch(() => undefined)
          }
          return response
        } catch (error) {
          if (audit) {
            await recordModelApiCall({
              ...audit,
              id: callId,
              parentCallId: auditAttempt > 1 ? rootCallId : undefined,
              attemptNumber: auditAttempt,
              status: 'error',
              durationMs: Date.now() - startedAt,
              httpStatus: error instanceof ProviderError ? error.statusCode : undefined,
              errorCode: modelApiErrorCode(error),
              errorMessage: 'Model service request failed.',
            }).catch(() => undefined)
          }
          const shouldRetry = error instanceof ProviderError
            && this.isDefinitelyUnsentVideoSubmitError(error)
            && attempt < VIDEO_SUBMIT_SAFE_RETRY_ATTEMPTS
          console.warn('[video-submit] failed', {
            ...debugSummary,
            attempt,
            maxAttempts: VIDEO_SUBMIT_SAFE_RETRY_ATTEMPTS,
            retrying: shouldRetry,
            errorCode: error instanceof ProviderError ? error.code : undefined,
            statusCode: error instanceof ProviderError ? error.statusCode : undefined,
            message: error instanceof Error ? error.message : String(error),
          })
          if (shouldRetry) {
            await this.sleep(VIDEO_SUBMIT_SAFE_RETRY_DELAY_MS * attempt)
            continue
          }
          if (error instanceof ProviderError && this.shouldTryNextVideoPath(error)) {
            lastError = error
            break
          }
          throw error
        }
      }
    }

    throw lastError ?? new ProviderError('No compatible Seedance video generation endpoint was found', 'NO_VIDEO_ENDPOINT', this.name)
  }

  private sanitizeVideoExtra(extra: VideoOptions['extra']): UnknownRecord {
    if (!extra) return {}

    const blockedKeys = new Set([
      'model',
      'prompt',
      'negative_prompt',
      'duration',
      'seconds',
      'fps',
      'width',
      'height',
      'size',
      'aspect_ratio',
      'ratio',
      'resolution',
      'resolution_name',
      'n',
      'seed',
      'images',
      'image',
      'image_url',
      'first_frame_url',
      'input_image',
      'last_frame_url',
      'image_urls',
      'reference_images',
      // Lingganya-only media fields. They are valid for the dedicated
      // Lingganya protocol, but generic Seedance-compatible endpoints reject
      // them (for example: "extra.reference_mode is not supported").
      'reference_mode',
      'reference_videos',
      'reference_audios',
      'generate_audio',
      'voiceover',
      'audio_prompt',
    ])

    return Object.fromEntries(
      Object.entries(extra).filter(([key]) => !blockedKeys.has(key))
    )
  }

  private videoSubmitDebugSummary(path: string, body: UnknownRecord) {
    const imageFields = [
      body.images,
      body.image_urls,
      body.reference_images,
      body.image,
      body.image_url,
      body.first_frame_url,
      body.input_image,
    ]
    const imageStrings = Array.from(new Set(imageFields.flatMap((value) => {
      if (Array.isArray(value)) {
        return value.flatMap((item) => {
          if (typeof item === 'string') return [item]
          if (item && typeof item === 'object' && typeof (item as UnknownRecord).url === 'string') {
            return [(item as UnknownRecord).url as string]
          }
          return []
        })
      }
      if (value && typeof value === 'object' && typeof (value as UnknownRecord).url === 'string') {
        return [(value as UnknownRecord).url as string]
      }
      return typeof value === 'string' ? [value] : []
    })))
    const requestPayloadBytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
    const referencePayloadBytes = imageStrings.reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0)

    return {
      endpoint: `${this.config.baseUrl}${path}`,
      model: typeof body.model === 'string' ? body.model : undefined,
      seconds: body.seconds ?? body.duration,
      referenceImageCount: imageStrings.length,
      dataUriReferenceCount: imageStrings.filter((value) => value.startsWith('data:')).length,
      referencePayloadMB: Number((referencePayloadBytes / 1024 / 1024).toFixed(2)),
      requestPayloadMB: Number((requestPayloadBytes / 1024 / 1024).toFixed(2)),
    }
  }

  private shouldTryNextVideoPath(error: ProviderError): boolean {
    if (error.code !== 'API_ERROR') return false
    if (error.statusCode !== 404 && error.statusCode !== 405) return false
    const message = error.message.toLowerCase()
    return message.includes('invalid url') || message.includes('not found') || message.includes('not supported')
  }

  private isDefinitelyUnsentVideoSubmitError(error: ProviderError): boolean {
    if (error.code !== 'NETWORK_ERROR') return false
    return [
      /before secure TLS connection was established/i,
      /\bconnect ECONNREFUSED\b/i,
      /\bgetaddrinfo (?:ENOTFOUND|EAI_AGAIN)\b/i,
      /\bconnect (?:ENETUNREACH|EHOSTUNREACH)\b/i,
      /\bUND_ERR_CONNECT_TIMEOUT\b/i,
      /\bConnect Timeout Error\b/i,
    ].some((pattern) => pattern.test(error.message))
  }

  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    return this.withMediaConfig('video', async () => {
      const response = await this.requestVideoStatus(taskId)
      const status = this.mapStatus(this.readString(response, ['status', 'task_status', 'state']) ?? '')

      const taskStatus: TaskStatus = {
        taskId,
        status,
        progress: this.readNumber(response, ['progress', 'percent']),
        extra: response,
      }

      if (status === 'completed') {
        const parsedResult = this.parseVideoResult(taskId, response, '')
        taskStatus.result = parsedResult.videoUrls.length
          ? parsedResult
          : await this.tryFetchVideoContentResult(taskId, '')
      }

      if (status === 'failed') {
        taskStatus.error =
          this.readNestedString(response, [['error', 'message'], ['error', 'type']]) ??
          this.readString(response, ['error', 'message', 'error_message', 'reason']) ??
          'Seedance video task failed'
        taskStatus.errorCode = this.readString(response, ['code', 'error_code'])
      }

      return taskStatus
    })
  }

  private async requestVideoStatus(taskId: string): Promise<UnknownRecord> {
    const encoded = encodeURIComponent(taskId)
    const configuredPath = this.resolveTaskPath(`/videos/${encoded}`, 'videoStatusPath', encoded)
    const fallbackPaths = [
      `/videos/${encoded}`,
      `/video/generations/${encoded}`,
      `/videos/generations/${encoded}`,
    ]
    const paths = Array.from(new Set([configuredPath, ...fallbackPaths]))
    let lastError: ProviderError | undefined

    for (const path of paths) {
      try {
        return await this.request<UnknownRecord>(path, { timeout: 0 })
      } catch (error) {
        if (error instanceof ProviderError && (this.shouldTryNextVideoPath(error) || this.shouldTryNextVideoStatusPath(error))) {
          lastError = error
          continue
        }
        throw error
      }
    }

    throw lastError ?? new ProviderError('No compatible Seedance video status endpoint was found', 'NO_VIDEO_STATUS_ENDPOINT', this.name)
  }

  private shouldTryNextVideoStatusPath(error: ProviderError): boolean {
    if (error.code !== 'API_ERROR' || error.statusCode !== 403) return false
    const message = error.message.toLowerCase()
    return message.includes('no access to model') || message.includes('model  ') || message.includes('model')
  }

  private shouldTryVideoContentAfterStatusError(error: ProviderError): boolean {
    if (error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR') return true
    if (error.code !== 'API_ERROR') return false
    return error.statusCode === 403 || error.statusCode === 404 || error.statusCode === 405
  }

  private async waitForVideoContentResult(
    taskId: string,
    modelId: string,
    submitResponse: UnknownRecord
  ): Promise<VideoResult | undefined> {
    for (let attempt = 0; attempt < 240; attempt++) {
      const result = await this.tryFetchVideoContentResult(taskId, modelId, submitResponse)
      if (result?.videoUrls.length) return result
      await this.sleep(5000)
    }
    return undefined
  }

  private async tryFetchVideoContentResult(
    taskId: string,
    modelId: string,
    submitResponse?: UnknownRecord
  ): Promise<VideoResult | undefined> {
    const encoded = encodeURIComponent(taskId)
    const configuredPath = this.resolveTaskPath(`/videos/${encoded}/content`, 'videoContentPath', encoded)
    const fallbackPaths = [
      `/videos/${encoded}/content`,
      `/video/generations/${encoded}/content`,
      `/videos/generations/${encoded}/content`,
    ]
    const paths = Array.from(new Set([configuredPath, ...fallbackPaths]))

    for (const path of paths) {
      try {
        const result = await this.requestVideoContent(path, taskId, modelId)
        if (!result) continue
        return {
          ...result,
          extra: {
            submitResponse,
            contentResponse: result.extra,
          },
        }
      } catch (error) {
        if (error instanceof ProviderError && this.shouldTreatVideoContentAsPending(error)) {
          continue
        }
        if (error instanceof ProviderError && this.shouldTryNextVideoPath(error)) {
          continue
        }
        continue
      }
    }

    return undefined
  }

  private async requestVideoContent(path: string, taskId: string, modelId: string): Promise<VideoResult | undefined> {
    const url = `${this.config.baseUrl}${path}`
    const dispatcher = openAIRequestDispatcher()

    try {
      const response = await undiciRequest(url, {
        method: 'GET',
        headers: {
          Accept: 'video/mp4,video/*,application/json',
          ...this.getAuthHeaders(),
          ...this.config.headers,
        },
        headersTimeout: 0,
        bodyTimeout: 0,
        dispatcher,
      })
      const contentType = this.headerValue(response.headers, 'content-type')?.split(';')[0] || ''
      const bytes = Buffer.from(await response.body.arrayBuffer())

      if (response.statusCode < 200 || response.statusCode >= 300) {
        const rawBody = this.safeBufferPreview(bytes)
        throw new ProviderError(
          `Video content API failed: ${response.statusCode} ${response.statusText || ''} - ${rawBody}`,
          'API_ERROR',
          this.name,
          response.statusCode
        )
      }

      if (bytes.length === 0) return undefined

      if (contentType.includes('json') || this.looksLikeJson(bytes)) {
        const parsed = JSON.parse(bytes.toString('utf8')) as UnknownRecord
        const parsedResult = this.parseVideoResult(taskId, parsed, modelId)
        return parsedResult.videoUrls.length ? parsedResult : undefined
      }

      if (contentType.startsWith('video/') || contentType === 'application/octet-stream') {
        const mimeType = contentType.startsWith('video/') ? contentType : 'video/mp4'
        return {
          taskId,
          videoUrls: [`data:${mimeType};base64,${bytes.toString('base64')}`],
          modelId,
          extra: {
            contentType: mimeType,
            contentPath: path,
          },
        }
      }

      return undefined
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError(
        `Video content network error: ${error instanceof Error ? error.message : String(error)}`,
        'NETWORK_ERROR',
        this.name
      )
    } finally {
      await dispatcher.close().catch(() => undefined)
    }
  }

  private shouldTreatVideoContentAsPending(error: ProviderError): boolean {
    if (error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR') return true
    if (error.code !== 'API_ERROR') return false
    return Boolean(error.statusCode && [404, 409, 425, 429, 500, 502, 503, 504].includes(error.statusCode))
  }

  private looksLikeJson(bytes: Buffer): boolean {
    const first = bytes.toString('utf8', 0, Math.min(bytes.length, 32)).trimStart()[0]
    return first === '{' || first === '['
  }

  private safeBufferPreview(bytes: Buffer): string {
    return bytes.toString('utf8', 0, Math.min(bytes.length, 800))
  }

  private headerValue(headers: unknown, name: string): string | undefined {
    const lower = name.toLowerCase()
    const record = headers as Record<string, string | string[] | undefined>
    const value = record[name] ?? record[lower]
    if (Array.isArray(value)) return value[0]
    return value
  }

  async listModels(mediaType?: MediaType): Promise<Model[]> {
    const models: Model[] = [
      {
        id: 'gpt-image-2',
        name: 'GPT Image 2 / image-2',
        description: 'OpenAI-compatible image generation model',
        modes: ['text-to-image', 'image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'seedance-v1-5-pro',
        name: 'Seedance 1.5 Pro',
        description: 'Seedance-compatible text-to-video and image-to-video model',
        modes: ['text-to-video', 'image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      {
        id: 'omni-flash',
        name: 'Omni Flash',
        description: 'Omni async video generation with text-to-video and up to 7 reference images',
        modes: ['text-to-video', 'image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      {
        id: 'grok-imagine-video-1.5',
        name: 'Grok Imagine Video 1.5',
        description: 'OpenAI-compatible async Grok video task endpoint with image_urls multi-reference input',
        modes: ['text-to-video', 'image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
    ]

    return mediaType ? models.filter((model) => model.mediaType === mediaType) : models
  }

  private resolvePath(defaultPath: string, extraKey: string): string {
    const custom = this.config.extra?.[extraKey]
    if (typeof custom === 'string' && custom.trim()) {
      return normalizeOpenAICompatiblePath(custom, this.config.baseUrl)
    }
    return defaultPath
  }

  private resolveTaskPath(defaultPath: string, extraKey: string, encodedTaskId: string): string {
    return this.resolvePath(defaultPath, extraKey)
      .replace('{id}', encodedTaskId)
      .replace('{task_id}', encodedTaskId)
  }

  private async requestFormData<T = unknown>(
    path: string,
    formData: FormData,
    timeout: number
  ): Promise<{ data: T; timing: ImageTransportTiming }> {
    const url = `${this.config.baseUrl}${path}`
    const configuredRequestTimeout = timeout && timeout > 0
      ? timeout
      : this.config.timeout && this.config.timeout > 0
        ? this.config.timeout
        : DEFAULT_IMAGE_REQUEST_TIMEOUT_MS
    // Saved model-pool entries from before the 30-minute policy may still
    // contain 10 minutes. Image edits must not inherit that shorter limit.
    const requestTimeout = Math.max(configuredRequestTimeout, DEFAULT_IMAGE_REQUEST_TIMEOUT_MS)
    const responseBodyTimeout = Math.max(requestTimeout, IMAGE_RESPONSE_BODY_TIMEOUT_MS)
    const maxAttempts = 1
    let lastError: ProviderError | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const requestStartedAt = performance.now()
      const requestStartedAtUnixMs = Date.now()
      const controller = requestTimeout > 0 ? new AbortController() : null
      let responsePhase: 'headers' | 'body' = 'headers'
      let headerTimeoutId = controller ? setTimeout(() => controller.abort(), requestTimeout) : null
      let responseBodyTimeoutId: ReturnType<typeof setTimeout> | null = null
      let dispatcher: Dispatcher | undefined
      try {
        await this.appendImageDebugLog('upstream_request_start', {
          url: this.redactUrl(url),
          path,
          attempt,
          timeout: requestTimeout,
          hasFormData: true,
        })
        // Let Node encode its own FormData once, then send the resulting
        // complete multipart body through the matching undici client. This
        // avoids cross-client dispatcher errors and keeps image edits from
        // hitting Node fetch's fixed five-minute response-header deadline.
        const encodedRequest = new Request(url, {
          method: 'POST',
          body: formData,
        })
        const contentType = encodedRequest.headers.get('content-type')
        if (!contentType) {
          throw new ProviderError('Could not encode image-edit multipart payload', 'IMAGE_EDIT_MULTIPART_ERROR', this.name)
        }
        const multipartBody = Buffer.from(await encodedRequest.arrayBuffer())
        dispatcher = openAIRequestDispatcher()
        const response = await undiciRequest(url, {
          method: 'POST',
          headers: {
            ...this.getAuthHeaders(),
            ...this.config.headers,
            'Content-Type': contentType,
          },
          body: multipartBody,
          signal: controller?.signal,
          headersTimeout: 0,
          bodyTimeout: 0,
          dispatcher,
        })

        if (headerTimeoutId) {
          clearTimeout(headerTimeoutId)
          headerTimeoutId = null
        }
        const headersReceivedAt = performance.now()
        const headersReceivedAtUnixMs = Date.now()
        responsePhase = 'body'
        if (controller) {
          responseBodyTimeoutId = setTimeout(() => controller.abort(), responseBodyTimeout)
        }

        const safeResponseHeaders = this.pickSafeResponseHeaders(response.headers)
        const requestIdHeader = safeResponseHeaders.requestId
        const upstreamRequestId = Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader
        await this.appendImageDebugLog('upstream_response_headers', {
          statusCode: response.statusCode,
          headers: safeResponseHeaders,
        })
        let rawBody: string
        let bodyRead: ImageResponseBodyReadResult
        const bodyReadStartedAtUnixMs = Date.now()
        let firstResponseByteAtUnixMs = bodyReadStartedAtUnixMs
        let bodyReadCompletedAtUnixMs = bodyReadStartedAtUnixMs
        try {
          bodyRead = await readImageResponseBodyWithIdleTimeout(
            response.body,
            IMAGE_RESPONSE_BODY_IDLE_TIMEOUT_MS
          )
          rawBody = bodyRead.text
          firstResponseByteAtUnixMs = bodyReadStartedAtUnixMs + bodyRead.firstByteWaitMs
          bodyReadCompletedAtUnixMs = Date.now()
          await this.appendImageDebugLog('upstream_response_body_diagnostics', {
            statusCode: response.statusCode,
            requestId: upstreamRequestId,
            firstResponseByteAtMs: firstResponseByteAtUnixMs,
            responseBodyCompletedAtMs: bodyReadCompletedAtUnixMs,
            firstByteWaitMs: Math.max(0, firstResponseByteAtUnixMs - headersReceivedAtUnixMs),
            bodyTransferMs: bodyRead.bodyTransferMs,
            chunkCount: bodyRead.chunkCount,
            maxChunkGapMs: bodyRead.maxChunkGapMs,
            bytesReceived: bodyRead.bytesReceived,
            averageBytesPerSecond: bodyRead.bodyTransferMs > 0
              ? Math.round(bodyRead.bytesReceived * 1000 / bodyRead.bodyTransferMs)
              : bodyRead.bytesReceived,
          })
        } catch (error) {
          if (error instanceof ImageResponseBodyIdleTimeoutError) {
            controller?.abort()
            await this.appendImageDebugLog('upstream_response_body_stalled', {
              statusCode: response.statusCode,
              idleTimeout: error.timeoutMs,
              bytesReceived: error.bytesReceived,
              requestId: upstreamRequestId,
            })
            const requestIdText = upstreamRequestId ? `；上游请求 ID：${upstreamRequestId}` : ''
            throw new ProviderError(
              `上游已返回生成成功状态，但 Base64 图片数据连续 ${Math.round(error.timeoutMs / 1000)} 秒没有继续传输（已接收 ${error.bytesReceived} 字节${requestIdText}）。本次图片没有完整抵达 3100，未自动重试付费任务。`,
              'IMAGE_EDIT_RESPONSE_BODY_STALLED',
              this.name
            )
          }
          if (controller?.signal.aborted) {
            await this.appendImageDebugLog('upstream_response_body_timeout', {
              statusCode: response.statusCode,
              timeout: responseBodyTimeout,
            })
            throw new ProviderError(
              `Image edit response body timed out after ${responseBodyTimeout}ms`,
              'IMAGE_EDIT_RESPONSE_BODY_TIMEOUT',
              this.name
            )
          }
          throw error
        } finally {
          if (responseBodyTimeoutId) {
            clearTimeout(responseBodyTimeoutId)
            responseBodyTimeoutId = null
          }
        }
        if (controller?.signal.aborted) {
          await this.appendImageDebugLog('upstream_response_body_timeout', {
            statusCode: response.statusCode,
            timeout: responseBodyTimeout,
          })
          throw new ProviderError(
            `Image edit response body timed out after ${responseBodyTimeout}ms`,
            'IMAGE_EDIT_RESPONSE_BODY_TIMEOUT',
            this.name
          )
        }
        await this.appendImageDebugLog('upstream_response_body', {
          statusCode: response.statusCode,
          bodyLength: rawBody.length,
          preview: rawBody.slice(0, 300),
        })

        if (response.statusCode < 200 || response.statusCode >= 300) {
          const providerError = new ProviderError(
            'Image edit API failed: ' + response.statusCode + ' ' + (response.statusText || '') + ' - ' + rawBody.slice(0, 800),
            'IMAGE_EDIT_API_ERROR',
            this.name,
            response.statusCode
          )
          if (attempt < maxAttempts && this.isRetriableImageEditError(providerError)) {
            lastError = providerError
            await this.sleep(1500 * attempt)
            continue
          }
          throw providerError
        }

        if (!rawBody.trim()) {
          const providerError = new ProviderError(
            'Image edit API returned an empty response. The upstream image-edit service may be temporarily unstable.',
            'EMPTY_IMAGE_EDIT_RESPONSE',
            this.name
          )
          if (attempt < maxAttempts) {
            lastError = providerError
            await this.sleep(1500 * attempt)
            continue
          }
          throw providerError
        }

        try {
          return {
            data: JSON.parse(rawBody) as T,
            timing: {
              upstreamRequestStartedAtMs: requestStartedAtUnixMs,
              responseHeadersAtMs: headersReceivedAtUnixMs,
              firstResponseByteAtMs: firstResponseByteAtUnixMs,
              responseBodyCompletedAtMs: bodyReadCompletedAtUnixMs,
              upstreamProcessingMs: Math.max(0, Math.round(headersReceivedAt - requestStartedAt)),
              resultTransferMs: Math.max(0, bodyReadCompletedAtUnixMs - headersReceivedAtUnixMs),
              responseFirstByteWaitMs: Math.max(0, firstResponseByteAtUnixMs - headersReceivedAtUnixMs),
              responseBodyTransferMs: bodyRead.bodyTransferMs,
              responseChunkCount: bodyRead.chunkCount,
              responseMaxChunkGapMs: bodyRead.maxChunkGapMs,
              responseAverageBytesPerSecond: bodyRead.bodyTransferMs > 0
                ? Math.round(bodyRead.bytesReceived * 1000 / bodyRead.bodyTransferMs)
                : bodyRead.bytesReceived,
              upstreamTotalMs: Math.max(0, bodyReadCompletedAtUnixMs - requestStartedAtUnixMs),
              responseBodyBytes: bodyRead.bytesReceived,
            },
          }
        } catch {
          const providerError = new ProviderError(
            `Image edit API returned invalid JSON: ${rawBody.slice(0, 800)}`,
            'INVALID_IMAGE_EDIT_RESPONSE',
            this.name
          )
          if (attempt < maxAttempts) {
            lastError = providerError
            await this.sleep(1500 * attempt)
            continue
          }
          throw providerError
        }
      } catch (error) {
        const providerError = this.normalizeImageEditError(
          error,
          responsePhase === 'body' ? responseBodyTimeout : requestTimeout
        )
        await this.appendImageDebugLog('upstream_request_failed', {
          code: providerError.code,
          statusCode: providerError.statusCode,
          message: providerError.message,
        })
        if (attempt < maxAttempts && this.isRetriableImageEditError(providerError)) {
          lastError = providerError
          await this.sleep(1500 * attempt)
          continue
        }
        throw providerError
      } finally {
        if (headerTimeoutId) clearTimeout(headerTimeoutId)
        if (responseBodyTimeoutId) clearTimeout(responseBodyTimeoutId)
        if (dispatcher) void dispatcher.close().catch(() => undefined)
      }
    }

    throw lastError ?? new ProviderError('Image edit API failed', 'IMAGE_EDIT_FAILED', this.name)
  }

  private async appendImageDebugLog(event: string, payload: UnknownRecord = {}) {
    const debugLogPath = this.config.extra?.debugLogPath
    if (typeof debugLogPath !== 'string' || !debugLogPath.trim()) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      provider: this.name,
      event,
      ...payload,
    })
    await appendFile(debugLogPath, `${line}\n`, 'utf8').catch(() => undefined)
  }

  private redactUrl(url: string) {
    return url.replace(/([?&](?:key|api_key|token|access_token)=)[^&]+/gi, '$1***')
  }

  private pickSafeResponseHeaders(headers: Record<string, string | string[] | undefined>) {
    return {
      contentType: headers['content-type'],
      contentLength: headers['content-length'],
      requestId: headers['x-request-id'] || headers['x-correlation-id'] || headers['cf-ray'],
    }
  }

  private normalizeImageEditError(error: unknown, timeout: number): ProviderError {
    if (error instanceof ProviderError) {
      return error
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      return new ProviderError(`Image edit request timed out (${timeout}ms)`, 'TIMEOUT', this.name)
    }
    const cause = error instanceof Error && 'cause' in error
      ? (error as Error & { cause?: unknown }).cause
      : undefined
    const causeMessage = cause instanceof Error
      ? `; cause=${cause.name}: ${cause.message}`
      : cause
        ? `; cause=${String(cause)}`
        : ''
    return new ProviderError(
      `Image edit network error: ${error instanceof Error ? error.message : String(error)}${causeMessage}`,
      'NETWORK_ERROR',
      this.name
    )
  }

  private isRetriableImageEditError(error: ProviderError): boolean {
    const retriableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504])
    if (error.statusCode && retriableStatuses.has(error.statusCode)) return true
    return ['NETWORK_ERROR', 'TIMEOUT', 'EMPTY_IMAGE_EDIT_RESPONSE', 'INVALID_IMAGE_EDIT_RESPONSE'].includes(error.code)
  }

  private async loadReferenceImage(imageUrl: string): Promise<{ bytes: Uint8Array; mimeType: string; filename: string }> {
    if (imageUrl.startsWith('data:')) {
      const match = imageUrl.match(/^data:([^;,]+);base64,(.+)$/)
      if (!match) {
        throw new ProviderError('Reference image data URI is invalid', 'INVALID_REFERENCE_IMAGE', this.name)
      }
      const mimeType = match[1] || 'image/png'
      return {
        bytes: Buffer.from(match[2], 'base64'),
        mimeType,
        filename: `reference.${this.extensionFromMime(mimeType)}`,
      }
    }

    let response: Response
    try {
      response = await fetch(imageUrl, { signal: AbortSignal.timeout(REFERENCE_IMAGE_FETCH_TIMEOUT_MS) })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new ProviderError(
          `Reference image fetch timed out after ${REFERENCE_IMAGE_FETCH_TIMEOUT_MS}ms`,
          'REFERENCE_IMAGE_FETCH_TIMEOUT',
          this.name
        )
      }
      throw new ProviderError(
        `Reference image fetch failed: ${error instanceof Error ? error.message : String(error)}`,
        'REFERENCE_IMAGE_FETCH_FAILED',
        this.name
      )
    }
    if (!response.ok) {
      throw new ProviderError(
        `Failed to fetch reference image: ${response.status} ${response.statusText}`,
        'REFERENCE_IMAGE_FETCH_FAILED',
        this.name,
        response.status
      )
    }

    const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/png'
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      bytes,
      mimeType,
      filename: `reference.${this.extensionFromMime(mimeType)}`,
    }
  }

  private extensionFromMime(mimeType: string): string {
    const normalized = mimeType.toLowerCase()
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg'
    if (normalized.includes('webp')) return 'webp'
    if (normalized.includes('gif')) return 'gif'
    return 'png'
  }

  private toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    return buffer
  }

  private mediaConfig(mediaType: 'image' | 'video'): { apiKey: string; baseUrl: string } {
    const extra = this.config.extra ?? {}
    const apiKey = mediaType === 'image' ? extra.imageApiKey : extra.videoApiKey
    const baseUrl = mediaType === 'image' ? extra.imageBaseUrl : extra.videoBaseUrl
    return {
      apiKey: typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : this.config.apiKey,
      baseUrl: typeof baseUrl === 'string' && baseUrl.trim()
        ? OpenAISeedanceProvider.normalizeOpenAIBaseUrl(baseUrl)
        : this.config.baseUrl,
    }
  }

  private async withMediaConfig<T>(mediaType: 'image' | 'video', task: () => Promise<T>): Promise<T> {
    const original = this.config
    this.config = {
      ...original,
      ...this.mediaConfig(mediaType),
    }
    try {
      return await task()
    } finally {
      this.config = original
    }
  }

  private toOpenAIImageSize(width?: number, height?: number): string | undefined {
    if (!width || !height) return undefined
    return `${width}x${height}`
  }

  private toVideoAspectRatio(width?: number, height?: number): '9:16' | '16:9' | '1:1' | undefined {
    if (!width || !height) return undefined
    if (width === height) return '1:1'
    return height > width ? '9:16' : '16:9'
  }

  private toVideoResolution(width?: number, height?: number): '480p' | '720p' | '1080p' | undefined {
    if (!width || !height) return undefined
    const longSide = Math.max(width, height)
    if (longSide >= 1920) return '1080p'
    if (longSide >= 1280) return '720p'
    return '480p'
  }

  private toOmniAspectRatio(aspectRatio?: '9:16' | '16:9' | '1:1'): 'portrait' | 'landscape' | 'square' | undefined {
    if (aspectRatio === '9:16') return 'portrait'
    if (aspectRatio === '16:9') return 'landscape'
    if (aspectRatio === '1:1') return 'square'
    return undefined
  }

  private toOmniDuration(duration?: number): 4 | 6 | 8 | 10 {
    const allowed = [4, 6, 8, 10] as const
    if (!duration || !Number.isFinite(duration)) return 8
    return allowed.reduce((best, current) =>
      Math.abs(current - duration) < Math.abs(best - duration) ? current : best
    )
  }

  private isGrokVideoModel(modelId?: string): boolean {
    return /grok.*video|grok-imagine/i.test(modelId || '')
  }

  private toGrokDuration(): 10 {
    return 10
  }

  private toGrokResolution(resolution?: '480p' | '720p' | '1080p'): '480p' | '720p' | undefined {
    if (resolution === '480p') return '480p'
    if (resolution === '720p' || resolution === '1080p') return '720p'
    return undefined
  }

  private buildVideoReferenceImages(options: VideoOptions): string[] {
    return Array.from(new Set([
      options.firstFrameUrl,
      ...(options.referenceImageUrls ?? []),
    ].filter((url): url is string => typeof url === 'string' && url.trim().length > 0))).slice(0, 7)
  }

  private extractTaskId(response: UnknownRecord): string | undefined {
    const candidates = [
      response.id,
      response.task_id,
      response.taskId,
      response.task,
      response.request_id,
      response.requestId,
      (response.output as UnknownRecord | undefined)?.task_id,
      (response.output as UnknownRecord | undefined)?.taskId,
      (response.data as UnknownRecord | undefined)?.task_id,
      (response.data as UnknownRecord | undefined)?.taskId,
      (response.data as UnknownRecord | undefined)?.id,
    ]
    const found = candidates.find((value) => typeof value === 'string' && value.length > 0)
    return typeof found === 'string' ? found : undefined
  }

  private parseVideoResult(taskId: string, response: UnknownRecord, modelId: string): VideoResult {
    const output = (response.output as UnknownRecord | undefined) ?? response
    const data = (response.data as UnknownRecord | undefined) ?? output
    const content = (data.content as UnknownRecord | undefined) ?? data

    const videoUrls = this.collectUrls(content, [
      'video_url',
      'videoUrl',
      'url',
      'output_url',
      'outputUrl',
      'result_url',
      'resultUrl',
      'download_url',
      'downloadUrl',
      'file_url',
      'fileUrl',
      'b64_json',
      'base64',
      'video_base64',
      'videoBase64',
    ])

    const responseData = response.data
    if (Array.isArray(responseData)) {
      for (const item of responseData) {
        if (typeof item === 'string') videoUrls.push(item)
        if (item && typeof item === 'object') {
          videoUrls.push(...this.collectUrls(item as UnknownRecord, [
            'video_url',
            'videoUrl',
            'url',
            'output_url',
            'outputUrl',
            'result_url',
            'resultUrl',
            'download_url',
            'downloadUrl',
            'file_url',
            'fileUrl',
            'b64_json',
            'base64',
            'video_base64',
            'videoBase64',
          ]))
        }
      }
    }

    const videos = content.videos
    if (Array.isArray(videos)) {
      for (const item of videos) {
        if (typeof item === 'string') videoUrls.push(item)
        if (item && typeof item === 'object') {
          videoUrls.push(...this.collectUrls(item as UnknownRecord, [
            'url',
            'video_url',
            'videoUrl',
            'download_url',
            'result_url',
            'resultUrl',
            'file_url',
            'b64_json',
            'base64',
            'video_base64',
            'videoBase64',
          ]))
        }
      }
    }

    const results = content.results
    if (Array.isArray(results)) {
      for (const item of results) {
        if (item && typeof item === 'object') {
          videoUrls.push(...this.collectUrls(item as UnknownRecord, [
            'url',
            'video_url',
            'videoUrl',
            'download_url',
            'result_url',
            'resultUrl',
            'file_url',
            'b64_json',
            'base64',
            'video_base64',
            'videoBase64',
          ]))
        }
      }
    }

    const outputVideos = (output.videos ?? output.video) as unknown
    if (Array.isArray(outputVideos)) {
      for (const item of outputVideos) {
        if (typeof item === 'string') videoUrls.push(item)
        if (item && typeof item === 'object') {
          videoUrls.push(...this.collectUrls(item as UnknownRecord, [
            'url',
            'video_url',
            'videoUrl',
            'download_url',
            'result_url',
            'resultUrl',
            'file_url',
            'b64_json',
            'base64',
            'video_base64',
            'videoBase64',
          ]))
        }
      }
    } else if (typeof outputVideos === 'string') {
      videoUrls.push(outputVideos)
    }

    return {
      taskId,
      videoUrls: Array.from(new Set(videoUrls.filter((url) => this.isVideoReference(url)))),
      coverImageUrl: this.readString(content, ['cover_url', 'coverImageUrl', 'cover_image_url']),
      duration: this.readNumber(content, ['duration']),
      modelId,
      hasAudio: Boolean(content.has_audio ?? content.hasAudio),
      extra: response,
    }
  }

  private collectUrls(source: UnknownRecord, keys: string[]): string[] {
    const urls: string[] = []
    for (const key of keys) {
      const value = source[key]
      if (typeof value === 'string') {
        if (this.isVideoReference(value)) {
          urls.push(value)
        } else if (key.toLowerCase().includes('base64') || key === 'b64_json') {
          urls.push(`data:video/mp4;base64,${value}`)
        }
      }
    }
    return urls
  }

  private isVideoReference(value: string): boolean {
    return /^https?:\/\//i.test(value) || /^data:video\//i.test(value)
  }

  private readString(source: UnknownRecord, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = source[key]
      if (typeof value === 'string') return value
    }
    return undefined
  }

  private readNestedString(source: UnknownRecord, paths: string[][]): string | undefined {
    for (const path of paths) {
      let current: unknown = source
      for (const key of path) {
        if (!current || typeof current !== 'object') {
          current = undefined
          break
        }
        current = (current as UnknownRecord)[key]
      }
      if (typeof current === 'string') return current
    }
    return undefined
  }

  private readNumber(source: UnknownRecord, keys: string[]): number | undefined {
    for (const key of keys) {
      const value = source[key]
      if (typeof value === 'number') return value
      if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        return Number(value)
      }
    }
    return undefined
  }

  private mapStatus(rawStatus: string): TaskStatusEnum {
    const normalized = rawStatus.toLowerCase()
    const statusMap: Record<string, TaskStatusEnum> = {
      pending: 'pending',
      queued: 'pending',
      queueing: 'pending',
      submitted: 'pending',
      running: 'processing',
      processing: 'processing',
      generating: 'processing',
      in_progress: 'processing',
      succeeded: 'completed',
      success: 'completed',
      completed: 'completed',
      done: 'completed',
      failed: 'failed',
      error: 'failed',
      cancelled: 'cancelled',
      canceled: 'cancelled',
    }
    return statusMap[normalized] ?? 'processing'
  }
}
