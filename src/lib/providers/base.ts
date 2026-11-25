// Base AI provider utilities: HTTP requests, errors, and task polling.

import type {
  AIProvider,
  ProviderConfig,
  ImageOptions,
  ImageResult,
  VideoOptions,
  VideoResult,
  TaskStatus,
  Model,
  MediaType,
  TaskStatusEnum,
} from './types'

// Provider request error.
export class ProviderError extends Error {
  code: string
  statusCode?: number
  provider: string

  constructor(message: string, code: string, provider: string, statusCode?: number) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.provider = provider
    this.statusCode = statusCode
  }
}

// Base provider abstraction.
export abstract class BaseProvider implements AIProvider {
  abstract readonly name: string
  abstract readonly displayName: string

  protected config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  abstract generateImage(options: ImageOptions): Promise<ImageResult>
  abstract generateVideo(options: VideoOptions): Promise<VideoResult>
  abstract getTaskStatus(taskId: string): Promise<TaskStatus>
  abstract listModels(mediaType?: MediaType): Promise<Model[]>

  protected async request<T = unknown>(
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
    const requestTimeout = timeout ?? this.config.timeout ?? 0

    const mergedHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.getAuthHeaders(),
      ...this.config.headers,
      ...headers,
    }

    const controller = requestTimeout > 0 ? new AbortController() : null
    const timeoutId = controller ? setTimeout(() => controller.abort(), requestTimeout) : null

    try {
      const response = await fetch(url, {
        method,
        headers: mergedHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller?.signal,
      })

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        throw new ProviderError(
          `API request failed: ${response.status} ${response.statusText} - ${errorBody}`,
          'API_ERROR',
          this.name,
          response.status
        )
      }

      return await response.json() as T
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error
      }

      if (error instanceof DOMException && error.name === 'AbortError') {
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
    }
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
    }
  }

  protected async pollTaskStatus(
    taskId: string,
    options: {
      interval?: number
      maxAttempts?: number
      isTerminal?: (status: TaskStatusEnum) => boolean
    } = {}
  ): Promise<TaskStatus> {
    const {
      interval = 3000,
      maxAttempts = 200,
      isTerminal = (s) => ['completed', 'failed', 'cancelled'].includes(s),
    } = options

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const status = await this.getTaskStatus(taskId)

      if (isTerminal(status.status)) {
        if (status.status === 'failed') {
          throw new ProviderError(
            `Task failed: ${status.error ?? 'unknown error'}`,
            status.errorCode ?? 'TASK_FAILED',
            this.name
          )
        }
        return status
      }

      await this.sleep(interval)
    }

    throw new ProviderError(
      `Task polling timed out after ${maxAttempts} attempts`,
      'POLL_TIMEOUT',
      this.name
    )
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  protected async uploadMedia(fileUrl: string, uploadPath: string): Promise<string> {
    void uploadPath
    return fileUrl
  }
}
