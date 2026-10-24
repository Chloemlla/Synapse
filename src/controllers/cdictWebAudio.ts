import type { CDictAudio } from "../services/cdictUpstreamService";

/** The engine labels little-endian PCM as L16; browsers need a container, unlike Android. */
export function toBrowserCdictAudio(audio: CDictAudio): CDictAudio {
  const [mediaType, ...parameters] = audio.contentType.toLowerCase().split(";");
  if (mediaType.trim() !== "audio/l16") return audio;
  const format = new Map(parameters.map((parameter) => {
    const [name, value] = parameter.trim().split("=");
    return [name, value] as const;
  }));
  if ((format.has("rate") && format.get("rate") !== "16000") ||
      (format.has("channels") && format.get("channels") !== "1") ||
      audio.data.length === 0 || audio.data.length % 2 !== 0 || audio.data.length > 8 * 1024 * 1024) {
    throw new Error("Unsupported CDict PCM format");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + audio.data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // signed integer PCM
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(audio.data.length, 40);
  return { contentType: "audio/wav", data: Buffer.concat([header, audio.data]) };
}
