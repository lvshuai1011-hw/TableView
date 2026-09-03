export type BilingualDescription = {
  chinese: string;
  english: string;
};

const CHINESE_PREFIX = /^\s*中文描述\s*[：:]\s*/;
const ENGLISH_PREFIX = /(?:^|\n)\s*English Description\s*[：:]\s*/i;

export function splitBilingualDescription(value: string): BilingualDescription {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source) return { chinese: "", english: "" };
  const englishMarker = ENGLISH_PREFIX.exec(source);
  if (!englishMarker || englishMarker.index === undefined) {
    return { chinese: source.replace(CHINESE_PREFIX, "").trim(), english: "" };
  }
  return {
    chinese: source.slice(0, englishMarker.index).replace(CHINESE_PREFIX, "").trim(),
    english: source.slice(englishMarker.index + englishMarker[0].length).trim(),
  };
}

export function joinBilingualDescription(value: BilingualDescription) {
  const chinese = value.chinese.trim();
  const english = value.english.trim();
  if (!chinese && !english) return "";
  return `中文描述：${chinese}\n\nEnglish Description: ${english}`;
}
