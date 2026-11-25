/**
 * SiliconFlow provider implementation.
 * Supports image and video generation models exposed by SiliconFlow-compatible APIs.
 * Docs: https://docs.siliconflow.cn
 */

import { BaseProvider, ProviderError } from './base'
import type {
  ProviderConfig,
  ImageOptions,
  ImageResult,
  VideoOptions,
  VideoResult,
  TaskStatus,
  TaskStatusEnum,
  Model,
  MediaType,
} from './types'

// ==================== SiliconFlow API response types ====================

interface SFImageResponse {
  images: Array<{
    url: string
    seed?: number
  }>
  timings?: {
    inference?: number
  }
  [key: string]: unknown
}

interface SFVideoSubmitResponse {
  requestId: string
  [key: string]: unknown
}

interface SFVideoStatusResponse {
  requestId: string
  status: string
  results?: {
    videos: Array<{
      url: string
      duration?: number
    }>
    cover_image_url?: string
  }
  reason?: string
  [key: string]: unknown
}

// ==================== Provider implementation ====================

export class SiliconFlowProvider extends BaseProvider {
  readonly name = 'siliconflow'
  readonly displayName = '硅基流动'

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://api.siliconflow.cn/v1',
    })
  }

  /**
   * Generate an image.
   * SiliconFlow image generation is synchronous and returns image URLs directly.
   */
  async generateImage(options: ImageOptions): Promise<ImageResult> {
    const body = {
      model: options.modelId,
      prompt: options.prompt,
      negative_prompt: options.negativePrompt,
      image_size: options.width && options.height
        ? `${options.width}x${options.height}`
        : undefined,
      num_inference_steps: options.steps,
      guidance_scale: options.guidanceScale,
      batch_size: options.count ?? 1,
      seed: options.seed,
      // image-to-image mode
      ...(options.referenceImageUrl && {
        image: options.referenceImageUrl,
      }),
      ...options.extra,
    }

    const response = await this.request<SFImageResponse>(
      '/images/generations',
      {
        method: 'POST',
        body,
        timeout: 0,
      }
    )

    return {
      taskId: `sf-img-${Date.now()}`,
      imageUrls: response.images.map((img) => img.url),
      modelId: options.modelId,
      seed: response.images[0]?.seed,
      duration: response.timings?.inference,
    }
  }

  /**
   * Generate a video.
   * SiliconFlow video generation is asynchronous and needs polling.
   */
  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    const body = {
      model: options.modelId,
      prompt: options.prompt,
      negative_prompt: options.negativePrompt,
      image_size: options.width && options.height
        ? `${options.width}x${options.height}`
        : undefined,
      seed: options.seed,
      // image-to-video mode
      ...(options.firstFrameUrl && {
        image: options.firstFrameUrl,
      }),
      ...options.extra,
    }

    const response = await this.request<SFVideoSubmitResponse>(
      '/video/submit',
      { method: 'POST', body }
    )

    // Poll until the final result is ready.
    const finalStatus = await this.pollTaskStatus(response.requestId, {
      interval: 5000,
    })

    if (!finalStatus.result) {
      throw new ProviderError('任务已完成但没有返回结果', 'NO_RESULT', this.name)
    }

    return finalStatus.result as VideoResult
  }

  /**
   * Query task status.
   */
  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const response = await this.request<SFVideoStatusResponse>(
      `/video/status/${taskId}`
    )

    const status = this.mapStatus(response.status)

    const taskStatus: TaskStatus = {
      taskId: response.requestId,
      status,
    }

    // Parse video result.
    if (status === 'completed' && response.results) {
      taskStatus.result = {
        taskId: response.requestId,
        videoUrls: response.results.videos.map((v) => v.url),
        coverImageUrl: response.results.cover_image_url,
        duration: response.results.videos[0]?.duration,
        modelId: '',
      }
    }

    // Failure details.
    if (status === 'failed') {
      taskStatus.error = response.reason ?? '生成失败'
      taskStatus.errorCode = 'GENERATION_FAILED'
    }

    return taskStatus
  }

  /**
   * List available models.
   */
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    // Model list based on SiliconFlow docs and release notes.
    const models: Model[] = [
      // ==================== Image generation ====================
      {
        id: 'Kwai-Kolors/Kolors',
        name: 'Kolors',
        description: 'Kolors text-to-image model',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'Qwen/Qwen-Image',
        name: 'Qwen Image',
        description: '通义千问图片生成模型',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
    ]

    if (mediaType) {
      return models.filter((m) => m.mediaType === mediaType)
    }

    return models
  }

  // ==================== Private helpers ====================

  /** Map SiliconFlow task status to the internal status enum. */
  private mapStatus(sfStatus: string): TaskStatusEnum {
    const statusMap: Record<string, TaskStatusEnum> = {
      Pending: 'pending',
      InQueue: 'pending',
      Running: 'processing',
      InProgress: 'processing',
      Succeed: 'completed',
      Success: 'completed',
      Failed: 'failed',
      Cancelled: 'cancelled',
    }
    return statusMap[sfStatus] ?? 'pending'
  }
}
