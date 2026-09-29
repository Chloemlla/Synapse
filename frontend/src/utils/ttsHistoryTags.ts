/**
 * 「我的生成记录」的预设标签：给历史记录做快捷分类，可与自由文本备注并用。
 *
 * 后端只约束数量与长度（最多 10 个、单个 ≤ 24 字），不校验具体取值，
 * 所以这里增删标签不需要同步改后端。
 */
export const TTS_HISTORY_PRESET_TAGS = [
  "工作",
  "学习",
  "配音",
  "朗读",
  "重要",
  "待修改",
] as const;

/** 与后端单个标签长度上限保持一致，前端提前截断，避免保存后才被静默裁剪。 */
export const TTS_HISTORY_TAG_MAX_LENGTH = 24;

/** 标题与备注的输入上限，与后端裁剪口径一致。 */
export const TTS_HISTORY_TITLE_MAX_LENGTH = 120;
export const TTS_HISTORY_NOTE_MAX_LENGTH = 1000;
