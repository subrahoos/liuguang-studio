export type VideoReferenceHostingProvider = "cloudinary";

/** A Cloudinary resource type used by temporary video-reference hosting. */
export type CloudinaryReferenceResourceType = "image" | "video";

/**
 * `already_absent` means Cloudinary confirmed the asset did not exist at
 * deletion time. It is intentionally different from a successful deletion.
 */
export type CloudinaryReferenceCleanupAssetStatus = "deleted" | "already_absent" | "failed" | "unverified";

export interface CloudinaryReferenceCleanupAsset {
  publicId: string;
  resourceType: CloudinaryReferenceResourceType;
  status: CloudinaryReferenceCleanupAssetStatus;
  error?: string;
}

export interface CloudinaryReferenceCleanup {
  startedAt: string;
  completedAt: string;
  total: number;
  deleted: number;
  alreadyAbsent: number;
  failed: number;
  status: "confirmed" | "partial_failure" | "unverified";
  assets: CloudinaryReferenceCleanupAsset[];
  errors: string[];
}

export interface VideoReferenceHostingSetting {
  provider: VideoReferenceHostingProvider;
  enabled: boolean;
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export const EMPTY_VIDEO_REFERENCE_HOSTING: VideoReferenceHostingSetting = {
  provider: "cloudinary",
  enabled: true,
  cloudName: "",
  apiKey: "",
  apiSecret: "",
};
