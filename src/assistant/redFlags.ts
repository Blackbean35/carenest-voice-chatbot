import type { AssistantInput } from "./types";
import { fetchChildProfile, ageInMonths } from "./data/profiles";

// LLM 호출 *이전에* 코드로 검사하는 결정적(deterministic) 안전장치.
// 목적: false negative 원천 차단 + 데모에서 100% 재현. (전략문서 §3-2)
interface RedFlagRule {
  key: string;
  keywords?: string[];
  action: "119" | "ER";
  message: string;
}

const RED_FLAGS: RedFlagRule[] = [
  {
    key: "cyanosis",
    keywords: ["입술 파", "입술이 파", "청색", "얼굴 새파", "새파랗"],
    action: "119",
    message:
      "입술·얼굴이 파랗게 변하는 것은 산소 부족을 뜻하는 응급 신호입니다. 지금 즉시 119에 신고하세요.",
  },
  {
    key: "resp_distress",
    keywords: ["숨을 못", "숨을 안", "헐떡", "호흡곤란", "숨소리가 이상"],
    action: "119",
    message:
      "호흡곤란은 응급 상황입니다. 지금 즉시 119에 신고하고 기도를 확보하세요.",
  },
  {
    key: "unconscious",
    keywords: ["축 늘어", "의식이 없", "못 깨", "안 깨", "반응이 없"],
    action: "119",
    message:
      "의식이 없거나 축 늘어져 반응하지 않는 것은 응급입니다. 지금 즉시 119에 신고하세요.",
  },
  {
    key: "seizure",
    keywords: ["경련", "발작", "눈이 돌아", "몸을 떨"],
    action: "119",
    message:
      "경련이 있을 때는 응급입니다. 아이를 옆으로 눕히고 주변 위험물을 치운 뒤 지금 즉시 119에 신고하세요.",
  },
];

export interface RedFlagHit {
  key: string;
  action: "119" | "ER";
  message: string;
}

/**
 * 입력을 검사해 red-flag에 걸리면 즉시 반환(LLM 우회).
 * 연령 가중 규칙(3개월 미만 + 발열)은 프로필/체온을 함께 본다.
 */
export async function checkRedFlags(
  input: AssistantInput,
  now: Date = new Date()
): Promise<RedFlagHit | null> {
  const text = input.question;

  for (const rule of RED_FLAGS) {
    if (rule.keywords?.some((k) => isCurrentSymptom(text, k))) {
      return { key: rule.key, action: rule.action, message: rule.message };
    }
  }

  // 연령 가중: 생후 3개월 미만 + 발열(≥38도) → 무조건 응급실
  const mentionsFever = /열|발열|체온|도예요|도에요|39|38/.test(text);
  if (input.childId && mentionsFever) {
    const profile = await fetchChildProfile(input.childId);
    if (profile) {
      const months = ageInMonths(profile.birthDate, now);
      const temp = input.temperatureC ?? extractTemp(text);
      const feverish = temp === null ? true : temp >= 38;
      if (months < 3 && feverish) {
        return {
          key: "neonate_fever",
          action: "ER",
          message: `생후 ${months}개월(3개월 미만) 아이의 발열은 겉으로 괜찮아 보여도 심각한 감염일 수 있어 즉시 병원 진료가 필요합니다. 해열제로 관찰하지 말고 지금 응급실 또는 소아과 진료를 받으세요.`,
        };
      }
    }
  }

  return null;
}

/** "39도", "38.5도" 같은 표현에서 체온 숫자 추출 */
function extractTemp(text: string): number | null {
  const m = text.match(/(\d{2}(?:\.\d)?)\s*도/);
  return m ? parseFloat(m[1]) : null;
}

// --- 문맥 인식 키워드 매칭 (오탐 감소) --------------------------------------
// 목표: '지금 진행 중인 증상'만 잡고, ①이름에 포함된 경우(김경련) ②과거력/과거시제
// (예전에 경련했었다) 는 제외한다. 안전이 우선이므로 '방금 경련했어요' 같은 현재 응급은 유지.

// 흔한 한 글자 성씨 (이름-내 오탐 방지용)
const SURNAMES = new Set(
  "김이박최정강조윤장임한오서신권황안송전홍유고문양손배백허남심노하곽성차주우구민류방원채천".split("")
);

/** text 안에서 keyword가 '현재 증상'으로 최소 한 번이라도 등장하면 true */
function isCurrentSymptom(text: string, keyword: string): boolean {
  let from = 0;
  for (;;) {
    const idx = text.indexOf(keyword, from);
    if (idx === -1) return false;
    if (!isNameEmbedded(text, idx) && !isPastContext(text, idx, keyword.length)) {
      return true; // 이름도 과거력도 아닌 현재 언급 → 응급으로 인정
    }
    from = idx + keyword.length;
  }
}

/** 성씨 한 글자가 키워드 바로 앞에 붙어 있으면 이름의 일부로 간주 (예: 김+경련) */
function isNameEmbedded(text: string, idx: number): boolean {
  let s = idx;
  while (s > 0 && /[가-힣]/.test(text[s - 1])) s--;
  const prefix = text.slice(s, idx); // 같은 한글 단어에서 키워드 앞부분
  return prefix.length === 1 && SURNAMES.has(prefix);
}

/** 키워드 주변이 과거력/과거시제 문맥이면 true (과거는 응급 아님) */
function isPastContext(text: string, idx: number, len: number): boolean {
  const before = text.slice(Math.max(0, idx - 8), idx);
  const after = text.slice(idx + len, idx + len + 6);
  // 앞: 과거를 가리키는 명사/부사 ("과거력에 경련", "예전에 경련")
  if (/과거력|병력|기왕력|예전|이전|전에/.test(before)) return true;
  // 뒤: 과거시제 어미 ("경련했었", "경련한 적", "경련이 있었") — 현재형(해요/중)은 제외
  if (/했었|였었|이었|앓았|한 ?적|던 ?적|있었|적 ?있|과거력|병력/.test(after)) return true;
  return false;
}
