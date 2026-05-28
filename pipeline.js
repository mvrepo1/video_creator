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
// SUBTITLE — stable-ts → ASS
// ============================================================
const { execFile, spawn } = require("child_process");

function findPython() {
  // Thử các lệnh phổ biến theo thứ tự
  return ["python", "python3", "py"];
}

async function runStableTs(audioPath, outSrtPath, lang) {
  const langFlag = lang === "vi" ? "vi" : lang === "en" ? "en" : lang;
  const candidates = findPython();

  // stable-ts CLI: stable-ts <audio> -o <output.srt> --language <lang> --model small
  // Nếu dùng `python -m stable_whisper` thì args khác
  // Thử cả 2 cách: stable-ts binary và python -m stable_whisper

  // Cách 1: stable-ts binary trực tiếp
  async function tryBinary(bin) {
    return new Promise((resolve, reject) => {
      const args = [
        audioPath,
        "-o", outSrtPath,
        "--language", langFlag,
        "--model", "small",
        "--regroup", "true",
      ];
      const proc = spawn(bin, args, { timeout: 180000 });
      let stderr = "";
      proc.stderr.on("data", d => stderr += d.toString());
      proc.stdout.on("data", () => {}); // drain
      proc.on("close", code => code === 0 ? resolve() : reject(Object.assign(new Error(`exit ${code}: ${stderr.slice(-400)}`), { stderr })));
      proc.on("error", reject);
    });
  }

  // Cách 2: python -m stable_whisper
  async function tryPythonModule(py) {
    return new Promise((resolve, reject) => {
      const args = [
        "-m", "stable_whisper",
        audioPath,
        "-o", outSrtPath,
        "--language", langFlag,
        "--model", "small",
        "--regroup", "true",
      ];
      const proc = spawn(py, args, { timeout: 180000 });
      let stderr = "";
      proc.stderr.on("data", d => stderr += d.toString());
      proc.stdout.on("data", () => {});
      proc.on("close", code => code === 0 ? resolve() : reject(Object.assign(new Error(`exit ${code}: ${stderr.slice(-400)}`), { stderr })));
      proc.on("error", reject);
    });
  }

  const lastErrors = [];

  // Thử stable-ts binary trước
  try { await tryBinary("stable-ts"); return; } catch (e) { if (e.code !== "ENOENT") lastErrors.push("stable-ts: " + e.message); }

  // Thử qua python/python3/py
  for (const py of candidates) {
    try { await tryPythonModule(py); return; } catch (e) {
      if (e.code === "ENOENT") continue;
      lastErrors.push(`${py} -m stable_whisper: ${e.message}`);
    }
  }

  if (lastErrors.length) throw new Error(lastErrors[0]);
  throw new Error("Không tìm thấy stable-ts. Chạy: pip install stable-ts");
}

function parseSrt(srtContent) {
  // Chuẩn hóa line endings (Windows CRLF → LF)
  const normalized = srtContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.trim().split(/\n{2,}/);
  const entries = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    // Tìm dòng timestamp (có thể không phải dòng 2 nếu có BOM hoặc số thứ tự trên cùng)
    let timeLine = null;
    let textStart = -1;
    for (let li = 0; li < lines.length; li++) {
      if (lines[li].includes("-->")) {
        timeLine = lines[li];
        textStart = li + 1;
        break;
      }
    }
    if (!timeLine || textStart < 0) continue;

    const m = timeLine.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;

    const toSec = (h, mn, s, ms) => +h * 3600 + +mn * 60 + +s + +ms / 1000;
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end   = toSec(m[5], m[6], m[7], m[8]);
    const text  = lines.slice(textStart).join(" ").replace(/<[^>]+>/g, "").trim();
    if (text) entries.push({ start, end, text });
  }
  return entries;
}

function wrapLines(text, maxChars) {
  // Wrap text at maxChars per line với dấu \N trong ASS
  const words = text.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars && cur) {
      lines.push(cur.trim());
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines.join("\\N");
}

function secToAssTime(s) {
  const h  = Math.floor(s / 3600);
  const m  = Math.floor((s % 3600) / 60);
  const sc = Math.floor(s % 60);
  const cs = Math.round((s % 1) * 100); // centiseconds
  return `${h}:${String(m).padStart(2,"0")}:${String(sc).padStart(2,"0")}.${String(cs).padStart(2,"0")}`;
}

function buildAssContent(entries, cfg, videoWidth, videoHeight) {
  // Alignment: 2=bottom-center, 5=mid-center, 8=top-center
  const marginV = cfg.position === 8 ? 30 : cfg.position === 2 ? 40 : 0;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${videoWidth}
PlayResY: ${videoHeight}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${cfg.font},${cfg.fontSize},${cfg.textColor},&H000000FF,&H00000000,${cfg.bgColor},0,0,0,0,100,100,0,0,${cfg.borderStyle},${cfg.borderStyle===3?0:2},0,${cfg.position},20,20,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = entries.map(e => {
    const wrapped = wrapLines(e.text, cfg.maxChars);
    return `Dialogue: 0,${secToAssTime(e.start)},${secToAssTime(e.end)},Default,,0,0,0,,${wrapped}`;
  });

  return header + "\n" + events.join("\n");
}

async function generateSubtitleAss(audioPath, assPath, srtPath, cfg, lang, emit, label) {
  emit("video-log", { type: "info", message: `${label}: Nhận diện giọng nói (stable-ts)...` });
  await runStableTs(audioPath, srtPath, lang);

  if (!fs.existsSync(srtPath)) throw new Error("stable-ts không tạo ra file SRT");

  const srtContent = fs.readFileSync(srtPath, "utf-8");
  const entries    = parseSrt(srtContent);

  // Debug: log vài dòng đầu SRT nếu parse ít kết quả
  if (entries.length === 0) {
    const preview = srtContent.slice(0, 300).replace(/\n/g, "↵");
    throw new Error(`Parse SRT ra 0 entries. Nội dung đầu: ${preview}`);
  }
  if (entries.length <= 2) {
    emit("video-log", { type: "warning", message: `${label}: SRT chỉ có ${entries.length} entries — có thể parse sai. Preview: ${srtContent.slice(0,150)}` });
  }

  emit("video-log", { type: "info", message: `${label}: Tạo ASS (${entries.length} dòng subtitle)...` });
  return entries; // trả về entries, build ASS sau khi biết kích thước video
}

// ============================================================
// CREATE CLIP: image + audio → mp4
// ============================================================
async function createClip({ imgPath, audioPath, outputPath, aspectRatio, overlay, subtitleEntries, subtitleCfg }) {
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

  // Build ASS subtitle file if needed
  let assFilePath = null;
  if (subtitleEntries && subtitleEntries.length && subtitleCfg) {
    assFilePath = outputPath.replace(".mp4", ".ass");
    const assContent = buildAssContent(subtitleEntries, subtitleCfg, w, h);
    fs.writeFileSync(assFilePath, assContent, "utf-8");
  }

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
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
      ]);

    if (assFilePath) {
      // Khi có subtitle: dùng -filter_complex để chain vf + ass
      const assEsc = assFilePath.replace(/\\/g, "/").replace(/:/g, "\\:");
      const subFilter = `ass='${assEsc}'`;
      const fullFilter = allFilters + "," + subFilter;
      cmd.addOption("-vf", fullFilter);
    } else {
      cmd.addOption("-vf", allFilters);
    }

    cmd
      .output(outputPath)
      .on("end", () => {
        // Dọn file .ass tạm
        if (assFilePath) try { fs.unlinkSync(assFilePath); } catch {}
        resolve();
      })
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
  const { lang, gender, aspectRatio, outputDir, startFrom = 0, overlay = null, bgMusic = null, bgMusicVolume = 0.15, subtitle = null } = config;
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

    // Subtitle: chạy stable-ts trên audio để lấy timestamps
    let subtitleEntries = null;
    if (subtitle?.enabled) {
      emit("video-progress", { step: "subtitle", sectionIndex: i, total: sections.length, message: `${label}: Nhận diện subtitle...` });
      try {
        const srtPath = path.join(tmpDir, `sub_${i}.srt`);
        subtitleEntries = await generateSubtitleAss(audioPath, null, srtPath, subtitle, lang, emit, label);
        emit("video-log", { type: "success", message: `${label}: ✓ subtitle (${subtitleEntries.length} dòng)` });
      } catch (err) {
        emit("video-log", { type: "warning", message: `${label}: Subtitle thất bại — ${err.message}. Bỏ qua subtitle.` });
        subtitleEntries = null;
      }
    }

    emit("video-progress", { step: "clip", sectionIndex: i, total: sections.length, message: `${label}: Tạo clip video...` });
    emit("video-log", { type: "info", message: `${label}: Render clip (${aspectRatio})` });

    // Resolve image path — có thể là local path hoặc URL từ template
    let imgPath = section.imagePath;
    if (!imgPath && section.imageUrl) {
      emit("video-log", { type: "info", message: `${label}: Tải ảnh từ URL...` });
      try {
        const imgRes  = await fetch(section.imageUrl);
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
        const imgBuf  = Buffer.from(await imgRes.arrayBuffer());
        const ext     = section.imageUrl.split("?")[0].split(".").pop().toLowerCase() || "jpg";
        imgPath       = path.join(tmpDir, `img_${i}.${ext}`);
        fs.writeFileSync(imgPath, imgBuf);
      } catch (err) {
        emit("video-log", { type: "error", message: `${label}: Tải ảnh thất bại — ${err.message}` });
        emit("video-error", { failedIndex: i, completedClips: clipPaths, message: err.message });
        cleanup(tmpDir);
        return;
      }
    }

    const clipPath = path.join(tmpDir, `clip_${i}.mp4`);
    try {
      await createClip({
        imgPath,
        audioPath,
        outputPath: clipPath,
        aspectRatio,
        overlay: (overlay && i === 0) ? overlay : null,
        subtitleEntries,
        subtitleCfg: subtitle,
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