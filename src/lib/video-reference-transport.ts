import {
  hostVideoReferencesForModel,
  type HostedVideoReference,
} from "@/lib/cloudinary-video-reference-hosting";
import { getBoardVideoProfile, type BoardVideoChannelCapabilities } from "@/lib/board-video-protocol";
import {
  uploadLingganyaReferenceFiles,
  type LingganyaReferenceFile,
  type LingganyaReferenceMediaType,
} from "@/lib/lingganya-reference-files";
import type { VideoReferenceHostingSetting } from "@/lib/video-reference-hosting-types";

type ReferenceChannel = BoardVideoChannelCapabilities & {
  apiKey?: string;
};

export type PreparedVideoReferenceBatch = {
  urls: string[];
  assets: HostedVideoReference[];
  transport: "original" | "cloudinary_https" | "lingganya_file_id";
  uploadCount: number;
  expiresAt?: string;
};

export function isLingganyaTemporaryFileReferenceChannel(channel: ReferenceChannel | string | undefined) {
  if (!channel || typeof channel === "string") return false;
  const model = channel.model?.trim().toLowerCase();
  return (model === "sd-2.0-vip" || model === "sd-2.0-g" || model === "sd-2.0-mini")
    && getBoardVideoProfile(channel)?.protocol === "lingganya";
}

export async function prepareVideoReferencesForChannel(input: {
  channel: ReferenceChannel;
  sources: string[];
  setting?: VideoReferenceHostingSetting | null;
  ownerId: string;
  scopeId: string;
  referenceIds?: string[];
  mediaType?: LingganyaReferenceMediaType;
  onLingganyaFileUploaded?: (file: LingganyaReferenceFile) => void | Promise<void>;
}): Promise<PreparedVideoReferenceBatch> {
  if (input.sources.length === 0) {
    return { urls: [], assets: [], transport: "original", uploadCount: 0 };
  }
  const mediaType = input.mediaType || "image";
  if (isLingganyaTemporaryFileReferenceChannel(input.channel)) {
    const uploaded = await uploadLingganyaReferenceFiles({
      baseUrl: String(input.channel.baseUrl || ""),
      apiKey: String(input.channel.apiKey || ""),
      sources: input.sources,
      referenceIds: input.referenceIds,
      mediaType,
      onUploaded: input.onLingganyaFileUploaded,
    });
    return {
      urls: uploaded.fileIds,
      assets: [],
      transport: "lingganya_file_id",
      uploadCount: uploaded.files.length,
      expiresAt: uploaded.expiresAt,
    };
  }

  const hosted = await hostVideoReferencesForModel({
    model: input.channel,
    sources: input.sources,
    setting: input.setting,
    ownerId: input.ownerId,
    scopeId: input.scopeId,
    referenceIds: input.referenceIds,
    resourceType: mediaType === "image" ? "image" : "video",
  });
  return {
    ...hosted,
    uploadCount: 0,
  };
}
