import { NextRequest, NextResponse } from "next/server";
import { getGlobalModelSettings, resolveGlobalImageChannel, resolveGlobalVideoChannel, resolveGlobalVideoReferenceHosting, resolveGlobalVideoReferenceHostingCredentials } from "@/lib/model-pool";
import { resolveUserVideoReferenceHostingCredentials } from "@/lib/user-video-reference-hosting-credentials";
import { isLingganyaTemporaryFileReferenceChannel } from "@/lib/video-reference-transport";
import { isReadyVideoReferenceHosting } from "@/lib/cloudinary-video-reference-hosting";
import { getBoardVideoProfile } from "@/lib/board-video-protocol";
import { getProductProductionRequestUser } from "@/lib/server/product-production-access";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getProductProductionRequestUser(req);
  if (!user) return NextResponse.json({ error: "未登录或商品生产线尚未开放。" }, { status: 403 });
  const settings = await getGlobalModelSettings();
  const provider = settings.providers["openai-seedance"];
  const imageChannels = await Promise.all((provider?.imageChannels || []).filter((channel) => channel.enabled !== false).map(async (channel) => {
    const resolved = await resolveGlobalImageChannel(user.id, channel.id);
    return {
      id: channel.id,
      name: channel.name,
      model: channel.model,
      available: resolved?.id === channel.id && Boolean(resolved.apiKey && resolved.baseUrl && resolved.model),
    };
  }));
  const videoCandidates = (provider?.videoChannels || []).flatMap((channel) => {
    if (channel.enabled === false) return [];
    const profile = getBoardVideoProfile(channel);
    if (!profile?.directVideoReplacement || profile.directVideoReplacementReferenceContract !== "product_front_face") return [];
    return [{
      id: channel.id,
      name: channel.name,
      model: channel.model,
      durationOptions: profile.durationOptions,
      resolutionOptions: profile.resolutionOptions,
      defaultDuration: profile.generationSeconds,
      defaultResolution: profile.resolution,
      faceOptional: profile.directVideoReplacementFaceOptional,
      sceneOptional: profile.directVideoReplacementSceneOptional,
      audioSupported: profile.maxReferenceAudios > 0,
    }];
  });
  const videoChannels = await Promise.all(videoCandidates.map(async (channel) => {
    const resolved = await resolveGlobalVideoChannel(user.id, channel.id, "full_video");
    const temporaryFiles = Boolean(resolved && isLingganyaTemporaryFileReferenceChannel(resolved));
    let hostingReady = temporaryFiles;
    if (!temporaryFiles) {
      const setting = await resolveGlobalVideoReferenceHosting();
      const credentials = user.role === "admin" ? await resolveGlobalVideoReferenceHostingCredentials() : await resolveUserVideoReferenceHostingCredentials(user.id);
      hostingReady = Boolean(setting && credentials && isReadyVideoReferenceHosting({ ...setting, ...credentials }));
    }
    return { ...channel, temporaryFiles, hostingReady, available: resolved?.id === channel.id && Boolean(resolved.apiKey && resolved.baseUrl && resolved.model) };
  }));
  return NextResponse.json({ imageChannels, videoChannels }, { headers: { "Cache-Control": "private, no-store" } });
}
