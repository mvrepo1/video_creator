if (typeof global.crypto === "undefined") {
  global.crypto = require("crypto");
}

const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
const ffmpeg = require("fluent-ffmpeg");

// Auto-detect ffmpeg path
try {
  const ffmpegPath = require("ffmpeg-static");
  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
} catch {
  // ffmpeg-static không có → dùng ffmpeg từ PATH hệ thống
}
const path = require("path");
const os = require("os");
const fs = require("fs");

let _stop = false;

function stop() { _stop = true; }

// ============================================================
// VOICE MAP
// ============================================================
const VOICES = {
  vi: { female: "vi-VN-HoaiMyNeural", male: "vi-VN-NamMinhNeural" },
  en: { female: "en-US-JennyNeural",  male: "en-US-GuyNeural" },
  es: { female: "es-ES-ElviraNeural", male: "es-ES-AlvaroNeural" },
};

// ============================================================
// TTS — Edge TTS với retry
// ============================================================
async function generateTTSOnce(text, lang, gender) {
  const voice = VOICES[lang]?.[gender] || VOICES.vi.female;
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);

  const chunks = [];
  await Promise.race([
    new Promise((resolve, reject) => {
      audioStream.on("data", c => chunks.push(c));
      audioStream.on("end", resolve);
      audioStream.on("error", reject);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("TTS timeout")), 30000)),
  ]);

  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error("Empty TTS buffer");
  return buf;
}

async function generateTTS(text, lang, gender, emit, label, retries = 3, delay = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const buf = await generateTTSOnce(text, lang, gender);
      if (attempt > 1) emit("video-log", { type: "success", message: `${label}: TTS thành công ở lần thử ${attempt}` });
      return buf;
    } catch (err) {
      emit("video-log", { type: "warning", message: `${label}: TTS thất bại lần ${attempt}/${retries} — ${err.message}` });
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`TTS thất bại sau ${retries} lần thử`);
}

// ============================================================
// FFPROBE duration
// ============================================================
function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      resolve(meta.format.duration || 0);
    });
  });
}

// ============================================================
// COLOR MAP for ffmpeg drawtext
// ============================================================
const COLOR_MAP = {
  white:      "white",
  ivory:      "0xFFFFF0",
  yellow:     "yellow",
  gold:       "0xFFD700",
  orange:     "orange",
  red:        "red",
  pink:       "0xFF69B4",
  cyan:       "cyan",
  skyblue:    "0x87CEEB",
  lime:       "0x39FF14",
  lightgreen: "0x90EE90",
  violet:     "0xEE82EE",
  silver:     "0xC0C0C0",
  black:      "black",
};

// ============================================================
// CREATE CLIP: image + audio → mp4
// ============================================================
async function createClip({ imgPath, audioPath, outputPath, aspectRatio, overlay }) {
  const isPortrait = aspectRatio === "9:16";
  const [w, h] = isPortrait ? [720, 1280] : [1280, 720];

  const baseVf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `format=yuv420p`,
  ];

  // Build drawtext filters for title/subtitle
  const drawtextFilters = [];
  if (overlay) {
    const titleCol = COLOR_MAP[overlay.titleColor] || "white";
    const subCol   = COLOR_MAP[overlay.subColor]   || "white";
    const fontFile = overlay.font;
    const dur = overlay.duration;
    const topBase = Math.round((overlay.topPercent / 100) * h);

    const escapeText = t => t.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");

    if (overlay.title) {
      drawtextFilters.push(
        `drawtext=font='${fontFile}':text='${escapeText(overlay.title)}':fontsize=${overlay.titleSize}:fontcolor=${titleCol}:x=(w-tw)/2:y=${topBase}:enable='between(t,0,${dur})'`
      );
    }
    if (overlay.subtitle) {
      const subY = overlay.title
        ? `${topBase}+${overlay.titleSize + 12}`
        : topBase;
      drawtextFilters.push(
        `drawtext=font='${fontFile}':text='${escapeText(overlay.subtitle)}':fontsize=${overlay.subSize}:fontcolor=${subCol}:x=(w-tw)/2:y=${subY}:enable='between(t,0,${dur})'`
      );
    }
  }

  const allFilters = [...baseVf, ...drawtextFilters].join(",");

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imgPath)
      .inputOptions(["-loop 1"])
      .input(audioPath)
      .outputOptions([
        "-c:v libx264",
        "-preset fast",
        "-crf 23",
        "-c:a aac",
        "-b:a 128k",
        "-shortest",
        "-movflags +faststart",
        "-r 24",
      ])
      .addOption("-vf", allFilters)
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

// ============================================================
// CONCAT clips → final video
// ============================================================
async function concatClips(clipPaths, outputPath, tmpDir) {
  const listFile = path.join(tmpDir, "concat_list.txt");
  const listContent = clipPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(listFile, listContent);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions(["-c copy", "-movflags +faststart"])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

// ============================================================
// MIX BG MUSIC into final video
// ============================================================
async function mixBgMusic(videoPath, musicPath, outputPath, volume) {
  const vol = Math.max(0, Math.min(1, volume));
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(musicPath)
      .complexFilter([
        // Loop nhạc nền 999 lần (đủ cho mọi video dài), rồi scale volume
        `[1:a]aloop=loop=999:size=2147483647,asetpts=PTS-STARTPTS,volume=${vol}[bgm]`,
        // Mix giọng đọc + nhạc nền, độ dài theo giọng đọc (duration=first)
        `[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=3[aout]`,
      ])
      .outputOptions([
        "-map 0:v",
        "-map [aout]",
        "-c:v copy",
        "-c:a aac",
        "-b:a 192k",
        "-movflags +faststart",
      ])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

// ============================================================
// MAIN RUN
// ============================================================
async function run(sections, config, emit) {
  _stop = false;
  const { lang, gender, aspectRatio, outputDir, startFrom = 0, overlay = null, bgMusic = null, bgMusicVolume = 0.15 } = config;
  const tmpDir = path.join(os.tmpdir(), `vcreator-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const clipPaths = [];

  emit("video-log", { type: "info", message: `Bắt đầu xử lý ${sections.length - startFrom} sections${startFrom > 0 ? ` (từ section ${startFrom + 1})` : ""}...` });

  for (let i = startFrom; i < sections.length; i++) {
    if (_stop) {
      emit("video-stopped", {});
      cleanup(tmpDir);
      return;
    }

    const section = sections[i];
    const label = `Section ${i + 1}/${sections.length}`;

    emit("video-progress", { step: "tts", sectionIndex: i, total: sections.length, message: `${label}: Tạo giọng đọc...` });
    emit("video-log", { type: "info", message: `${label}: TTS (${lang}/${gender})` });

    let audioBuffer;
    try {
      audioBuffer = await generateTTS(section.script, lang, gender, emit, label);
    } catch (err) {
      emit("video-log", { type: "error", message: `${label}: TTS thất bại sau 3 lần — ${err.message}` });
      // Giữ lại các clip đã render được, emit resume từ section hiện tại
      emit("video-error", { failedIndex: i, completedClips: clipPaths, message: err.message });
      cleanup(tmpDir);
      return;
    }

    const audioPath = path.join(tmpDir, `audio_${i}.mp3`);
    fs.writeFileSync(audioPath, audioBuffer);

    emit("video-progress", { step: "clip", sectionIndex: i, total: sections.length, message: `${label}: Tạo clip video...` });
    emit("video-log", { type: "info", message: `${label}: Render clip (${aspectRatio})` });

    const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
    try {
      await createClip({
        imgPath: section.imagePath,
        audioPath,
        outputPath: clipPath,
        aspectRatio,
        overlay: (overlay && i === 0) ? overlay : null,
      });
    } catch (err) {
      emit("video-log", { type: "error", message: `${label}: Render thất bại — ${err.message}` });
      cleanup(tmpDir);
      return;
    }

    clipPaths.push(clipPath);
    emit("video-log", { type: "success", message: `${label}: ✓ clip xong` });
  }

  if (_stop) {
    emit("video-stopped", {});
    cleanup(tmpDir);
    return;
  }

  // Ghép tất cả clips
  emit("video-progress", { step: "concat", sectionIndex: sections.length, total: sections.length, message: "Ghép video..." });
  emit("video-log", { type: "info", message: "Ghép tất cả clips thành video cuối..." });

  const timestamp = Date.now();
  const finalPath = path.join(outputDir || os.tmpdir(), `video_${timestamp}.mp4`);

  try {
    if (clipPaths.length === 1) {
      fs.copyFileSync(clipPaths[0], finalPath);
    } else {
      await concatClips(clipPaths, finalPath, tmpDir);
    }
  } catch (err) {
    emit("video-log", { type: "error", message: `Ghép video thất bại — ${err.message}` });
    cleanup(tmpDir);
    return;
  }

  // Mix nhạc nền nếu có
  if (bgMusic && fs.existsSync(bgMusic)) {
    emit("video-progress", { step: "music", sectionIndex: sections.length, total: sections.length, message: "Mix nhạc nền..." });
    emit("video-log", { type: "info", message: `Mix nhạc nền (volume ${Math.round(bgMusicVolume * 100)}%)...` });
    const mixedPath = path.join(outputDir || os.tmpdir(), `video_${timestamp}_mix.mp4`);
    try {
      await mixBgMusic(finalPath, bgMusic, mixedPath, bgMusicVolume);
      fs.unlinkSync(finalPath); // xóa file trung gian không có nhạc
      Object.defineProperty({ finalPath }, 'finalPath', { value: mixedPath }); // workaround: dùng biến mới
      emit("video-log", { type: "success", message: "✓ Nhạc nền đã được mix" });
      cleanup(tmpDir);
      emit("video-log", { type: "success", message: `✅ Hoàn thành! Video: ${mixedPath}` });
      emit("video-done", { outputPath: mixedPath });
      return mixedPath;
    } catch (err) {
      emit("video-log", { type: "warning", message: `Mix nhạc nền thất bại — ${err.message}. Xuất video không có nhạc.` });
    }
  }

  cleanup(tmpDir);

  emit("video-log", { type: "success", message: `✅ Hoàn thành! Video: ${finalPath}` });
  emit("video-done", { outputPath: finalPath });
  return finalPath;
}

function cleanup(tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

module.exports = { run, stop };