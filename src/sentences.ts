// 스트리밍 토큰을 문장(또는 절) 단위로 잘라 TTS로 흘려보내기 위한 분할기.
// 첫 소리를 빨리 내려고, 문장부호가 늦게 오면 절(쉼표) 경계에서 조기 배출한다.
const ENDERS = /[.!?。\n]/;
const CLAUSE = /[,，、]/;
const EARLY_FLUSH_AT = 45; // 첫 절이 이보다 길고 쉼표가 있으면 먼저 읽기 시작

export class SentenceSplitter {
  private buf = "";
  private producedAny = false;

  /** 새 텍스트 조각을 넣고, 이번에 완성된 문장/절들을 반환 */
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];

    // 1) 문장 종결부호 기준으로 완성 문장 배출
    let idx: number;
    while ((idx = this.buf.search(ENDERS)) !== -1) {
      const sent = this.buf.slice(0, idx + 1).trim();
      this.buf = this.buf.slice(idx + 1);
      if (sent) {
        out.push(sent);
        this.producedAny = true;
      }
    }

    // 2) 아직 아무것도 못 냈고 버퍼가 길면 절 경계에서 조기 배출(첫 소리 지연 최소화)
    if (!this.producedAny && out.length === 0 && this.buf.length >= EARLY_FLUSH_AT) {
      const cut = this.lastClauseBoundary(this.buf);
      if (cut > 0) {
        const clause = this.buf.slice(0, cut + 1).trim();
        this.buf = this.buf.slice(cut + 1);
        if (clause) {
          out.push(clause);
          this.producedAny = true;
        }
      }
    }
    return out;
  }

  /** 스트림 종료 후 남은 버퍼 반환 */
  flush(): string {
    const rest = this.buf.trim();
    this.buf = "";
    return rest;
  }

  private lastClauseBoundary(s: string): number {
    for (let i = s.length - 1; i >= 0; i--) if (CLAUSE.test(s[i])) return i;
    return -1;
  }
}
