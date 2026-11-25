function formatNumber(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, "");
}

function fitVideoFilter(inputLabel, outputLabel, {
  start = 0,
  duration,
  fit,
  fps,
  transition,
  visualVariant = 0,
  unitVariant = null,
}) {
  const trim = `trim=start=${formatNumber(start)}:duration=${formatNumber(duration)},setpts=PTS-STARTPTS`;
  const finish = [
    `fps=${fps}`,
    "setsar=1",
    "format=yuv420p",
  ];
  const variant = Math.max(0, Math.floor(Number(visualVariant) || 0));
  if (variant > 0) {
    const zoomPercent = ((variant - 1) % 3) + 1;
    const width = Math.round((1080 * (1 + zoomPercent / 100)) / 2) * 2;
    const height = Math.round((1920 * (1 + zoomPercent / 100)) / 2) * 2;
    const maxX = width - 1080;
    const maxY = height - 1920;
    const horizontal = variant % 3;
    const vertical = Math.floor(variant / 3) % 3;
    const x = Math.round((maxX * horizontal) / 2);
    const y = Math.round((maxY * vertical) / 2);
    finish.unshift(
      `scale=${width}:${height}`,
      `crop=1080:1920:${x}:${y}`,
    );
  }

  if (unitVariant?.kind === "mirror") {
    finish.unshift("hflip");
  }

  if (unitVariant?.kind === "crop") {
    const scale = Math.max(1.01, Number(unitVariant.scale) || 1.04);
    const width = Math.round((1080 * scale) / 2) * 2;
    const height = Math.round((1920 * scale) / 2) * 2;
    finish.unshift(
      `scale=${width}:${height}`,
      "crop=1080:1920:(iw-ow)/2:(ih-oh)/2",
    );
  }

  if (transition === "fade") {
    const fadeOutStart = Math.max(0, duration - 0.15);
    finish.unshift(
      "fade=t=in:st=0:d=0.15",
      `fade=t=out:st=${formatNumber(fadeOutStart)}:d=0.15`,
    );
  }

  if (fit === "crop") {
    return `${inputLabel}${trim},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${finish.join(",")}${outputLabel}`;
  }
  if (fit === "pad") {
    return `${inputLabel}${trim},scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,${finish.join(",")}${outputLabel}`;
  }

  const prefix = outputLabel.slice(0, -1);
  return [
    `${inputLabel}${trim},split=2${prefix}bgsrc]${prefix}fgsrc]`,
    `${prefix}bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=20:steps=3${prefix}bg]`,
    `${prefix}fgsrc]scale=1080:1920:force_original_aspect_ratio=decrease${prefix}fg]`,
    `${prefix}bg]${prefix}fg]overlay=(W-w)/2:(H-h)/2,${finish.join(",")}${outputLabel}`,
  ].join(";");
}

function audioFilter(inputIndex, outputLabel, duration, hasAudio, start = 0) {
  const length = formatNumber(duration);
  if (!hasAudio) {
    return `anullsrc=r=48000:cl=stereo,atrim=duration=${length},asetpts=PTS-STARTPTS${outputLabel}`;
  }
  return `[${inputIndex}:a]atrim=start=${formatNumber(start)}:duration=${length},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${outputLabel}`;
}

function coalesceUnits(units) {
  const result = [];
  for (const unit of units) {
    const previous = result.at(-1);
    const sameVariant = JSON.stringify(previous?.variant || null)
      === JSON.stringify(unit.variant || null);
    const videoContinuous = previous
      && previous.videoPath === unit.videoPath
      && sameVariant
      && Math.abs(
        previous.videoStart + previous.duration - unit.videoStart,
      ) < 0.002;
    const audioContinuous = previous
      && previous.audioPath === unit.audioPath
      && (
        !unit.audioPath
        || Math.abs(
          previous.audioStart + previous.duration - unit.audioStart,
        ) < 0.002
      );
    if (videoContinuous && audioContinuous) {
      previous.duration = Number(
        (previous.duration + unit.duration).toFixed(3),
      );
    } else {
      result.push({ ...unit });
    }
  }
  return result;
}

function normalizeUnits(plan) {
  if (Array.isArray(plan?.units) && plan.units.length > 0) {
    return coalesceUnits(plan.units.map((unit) => ({
      videoPath: unit.videoPath,
      videoStart: Number(unit.videoStart) || 0,
      duration: Number(unit.duration),
      audioPath: unit.audioPath || null,
      audioStart: Number(unit.audioStart) || 0,
      audioSourceStart: Number(unit.audioSourceStart ?? unit.audioStart) || 0,
      variant: unit.variant || null,
    })));
  }

  return (plan?.segments || []).map((segment) => ({
    videoPath: segment.path,
    videoStart: 0,
    duration: segment.useDuration,
    audioPath: segment.hasAudio === false ? null : segment.path,
    audioStart: 0,
  }));
}

function escapeSubtitlePath(filePath) {
  return String(filePath)
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, "$1\\:")
    .replaceAll("'", "\\'");
}

function buildRenderArgs({
  plan,
  outputPath,
  bgmPath,
  productImagePath,
  subtitlePath,
  settings,
}) {
  const units = normalizeUnits(plan);
  if (!units.length) {
    throw new Error("没有可渲染的素材片段");
  }
  const {
    fit = "blur",
    audioMode = "original",
    bgmVolume = 0.2,
    fps = 30,
    quality = "balanced",
    encoder = "cpu",
    transition = "cut",
    productTailDuration = 1.5,
  } = settings || {};

  if (!["blur", "crop", "pad"].includes(fit)) {
    throw new Error("画面适配方式无效");
  }
  if (!["original", "mix", "bgm"].includes(audioMode)) {
    throw new Error("声音模式无效");
  }
  if ((audioMode === "mix" || audioMode === "bgm") && !bgmPath) {
    throw new Error("当前声音模式需要选择背景音乐");
  }

  const args = ["-hide_banner", "-y"];
  const unitInputs = [];
  const continuousAnchor = Boolean(
    plan.narrativeSourceId && plan.narrativeAudioPath,
  );
  let nextInputIndex = 0;
  for (const unit of units) {
    const videoInputIndex = nextInputIndex;
    nextInputIndex += 1;
    args.push("-i", unit.videoPath);

    let audioInputIndex = null;
    if (!continuousAnchor && unit.audioPath) {
      audioInputIndex = nextInputIndex;
      nextInputIndex += 1;
      args.push("-i", unit.audioPath);
    }
    unitInputs.push({ videoInputIndex, audioInputIndex });
  }

  let anchorAudioInputIndex = null;
  if (continuousAnchor) {
    anchorAudioInputIndex = nextInputIndex;
    nextInputIndex += 1;
    args.push("-i", plan.narrativeAudioPath);
  }

  let productInputIndex = null;
  if (productImagePath) {
    productInputIndex = nextInputIndex;
    nextInputIndex += 1;
    args.push(
      "-loop",
      "1",
      "-t",
      formatNumber(productTailDuration),
      "-i",
      productImagePath,
    );
  }

  let bgmInputIndex = null;
  if (bgmPath) {
    bgmInputIndex = nextInputIndex;
    args.push("-stream_loop", "-1", "-i", bgmPath);
  }

  const filters = [];
  const concatLabels = [];
  units.forEach((unit, index) => {
    const input = unitInputs[index];
    filters.push(fitVideoFilter(
      `[${input.videoInputIndex}:v]`,
      `[v${index}]`,
      {
        start: unit.videoStart,
        duration: unit.duration,
        fit,
        fps,
        transition,
        visualVariant: continuousAnchor ? 0 : plan.visualVariant,
        unitVariant: unit.variant,
      },
    ));
    if (continuousAnchor) {
      concatLabels.push(`[v${index}]`);
    } else {
      filters.push(audioFilter(
        input.audioInputIndex,
        `[a${index}]`,
        unit.duration,
        input.audioInputIndex !== null,
        unit.audioSourceStart,
      ));
      concatLabels.push(`[v${index}][a${index}]`);
    }
  });

  if (productInputIndex !== null) {
    const index = units.length;
    filters.push(fitVideoFilter(
      `[${productInputIndex}:v]`,
      `[v${index}]`,
      {
        duration: productTailDuration,
        fit,
        fps,
        transition,
        visualVariant: continuousAnchor ? 0 : plan.visualVariant,
      },
    ));
    if (continuousAnchor) {
      concatLabels.push(`[v${index}]`);
    } else {
      filters.push(audioFilter(
        productInputIndex,
        `[a${index}]`,
        productTailDuration,
        false,
      ));
      concatLabels.push(`[v${index}][a${index}]`);
    }
  }

  const concatVideoLabel = subtitlePath ? "[vcat]" : "[vout]";
  if (continuousAnchor) {
    filters.push(
      `${concatLabels.join("")}concat=n=${concatLabels.length}:v=1:a=0${concatVideoLabel}`,
    );
    const anchorDuration = Math.min(
      Number(plan.totalDuration),
      Number(plan.narrativeAudioDuration) || Number(plan.totalDuration),
    );
    const anchorAudio = `[${anchorAudioInputIndex}:a]atrim=start=${formatNumber(plan.narrativeAudioStart || 0)}:duration=${formatNumber(anchorDuration)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${formatNumber(plan.totalDuration)},atrim=duration=${formatNumber(plan.totalDuration)}`;
    if (productInputIndex === null) {
      filters.push(`${anchorAudio}[acat]`);
    } else {
      filters.push(`${anchorAudio}[amain]`);
      filters.push(audioFilter(
        null,
        "[atail]",
        productTailDuration,
        false,
      ));
      filters.push("[amain][atail]concat=n=2:v=0:a=1[acat]");
    }
  } else {
    filters.push(
      `${concatLabels.join("")}concat=n=${concatLabels.length}:v=1:a=1${concatVideoLabel}[acat]`,
    );
  }
  if (subtitlePath) {
    filters.push(
      `[vcat]subtitles='${escapeSubtitlePath(subtitlePath)}':force_style='FontName=Microsoft YaHei,FontSize=18,Outline=2,Alignment=2,MarginV=120'[vout]`,
    );
  }

  const totalDuration = plan.totalDuration
    + (productInputIndex === null ? 0 : productTailDuration);
  if (bgmInputIndex !== null) {
    filters.push(
      `[${bgmInputIndex}:a]atrim=duration=${formatNumber(totalDuration)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${formatNumber(bgmVolume)}[bgm]`,
    );
  }
  if (audioMode === "mix") {
    filters.push(
      "[acat][bgm]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-14:LRA=7:TP=-1[aout]",
    );
  } else if (audioMode === "bgm") {
    // concat always emits the original/silent audio pad. Consume it when the
    // user selects BGM only, otherwise FFmpeg rejects the unconnected output.
    filters.push("[acat]anullsink");
    filters.push("[bgm]loudnorm=I=-14:LRA=7:TP=-1[aout]");
  } else {
    filters.push("[acat]loudnorm=I=-14:LRA=7:TP=-1[aout]");
  }

  const videoEncoder = encoder === "nvidia" ? "h264_nvenc" : "libopenh264";
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    videoEncoder,
  );

  if (videoEncoder === "h264_nvenc") {
    const preset = quality === "high" ? "p6" : quality === "compact" ? "p4" : "p5";
    const cq = quality === "high" ? "19" : quality === "compact" ? "27" : "23";
    args.push("-preset", preset, "-rc", "vbr", "-cq", cq, "-b:v", "0");
  } else {
    const bitrates = quality === "high"
      ? ["10M", "14M", "20M"]
      : quality === "compact"
        ? ["3500k", "5M", "8M"]
        : ["6M", "8M", "12M"];
    args.push(
      "-rc_mode", "bitrate",
      "-b:v", bitrates[0],
      "-maxrate", bitrates[1],
      "-bufsize", bitrates[2],
    );
  }

  args.push(
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-r",
    String(fps),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-metadata",
    `comment=Generated by Ecommerce Quick Cut; plan=${plan.id}`,
    "-t",
    formatNumber(totalDuration),
    outputPath,
  );

  return args;
}

module.exports = { buildRenderArgs };
