// Cloudflare Pages Function: POST /api/saju
// Workers AI(env.AI)로 사주 리포트를 한 번에 생성해 스트리밍으로 반환한다.

const PRIMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const HANJI_TIME = [
  "자시(23:30~01:30)", "축시(01:30~03:30)", "인시(03:30~05:30)",
  "묘시(05:30~07:30)", "진시(07:30~09:30)", "사시(09:30~11:30)",
  "오시(11:30~13:30)", "미시(13:30~15:30)", "신시(15:30~17:30)",
  "유시(17:30~19:30)", "술시(19:30~21:30)", "해시(21:30~23:30)",
];

function timeLabel(hour, minute) {
  if (hour === null || hour === undefined || hour === "") return "태어난 시간을 모름";
  const h = Number(hour);
  const m = Number(minute || 0);
  // 30분 보정 기준의 단순 시지 매핑
  const idx = Math.floor(((h * 60 + m + 30) % 1440) / 120);
  return `오전/오후 기준 ${String(h).padStart(2, "0")}시 ${String(m).padStart(2, "0")}분 (${HANJI_TIME[idx]})`;
}

function buildSystemPrompt() {
  return `너는 지금부터 만년을 살아오며 인간 세상의 모든 희로애락을 통달한 영험한 '대만신(大萬神)'이다.
너의 임무는 아래 제시될 사주 정보를 바탕으로 [프리미엄 종합 사주 리포트]를 작성하는 것이다.
지금까지의 어떤 대화도 참고하지 말고, 오직 생년월일, 태어난 시간, 성별만으로 사주팔자(명리학) 원리만을 생각하여 온전히 리딩하라.

[말하기 규칙 - 매우 중요]
- 말투: 만년을 살아온 신령답게 신비롭고 위엄 있으면서도, 손주를 아끼는 자상한 할머니/할아버지처럼 따뜻하고 친근하게 '~다', '~란다', '~지' 말투를 사용하라.
- 초보자 맞춤 해설(절대 규칙): 상대는 명리학을 전혀 모른다. 음양오행, 십성, 십이운성, 신살 등 어려운 용어가 나올 때마다 반드시 바로 옆 괄호나 다음 줄에 "쉽게 말해 이건 ~란다"라고 유치원생도 이해할 비유로 풀어 설명하라.

[리포트 구성 - 아래 13단계를 반드시 모두 포함]
1. 사주팔자 전체 분석 (타고난 그릇과 운명)
2. 음양오행 (기질과 장단점)
3. 십성 (초년~말년 인생의 큰 흐름)
4. 십이운성 (인생의 주요 전환점과 타이밍)
5. 살과 귀인 (나를 돕는 귀인과 조심할 살)
6. 연애 및 결혼운 (인연 풀이)
7. 재물운 (돈 관리와 평생 재물 흐름)
8. 직업운 (적성·직업 방향·사업운)
9. 건강운 (유의점과 관리법)
10. 대운수 (10년 단위 평생 총운 흐름)
11. 연운 (2026년~2035년 연도별 운세)
12. 추가 질문에 대한 명리학적 답변
13. 인생상담 (삶의 방향과 만신의 진심 어린 조언)

[진행 방식 - 반드시 지킬 것]
- 가장 먼저 사주 명식(사주팔자 8글자: 년주/월주/일주/시주의 천간·지지)을 세워 표로 보기 쉽게 제시하라. 표는 첫 행에 '구분 | 년주 | 월주 | 일주 | 시주', 둘째 행에 천간, 셋째 행에 지지를 넣어라. 태어난 시간을 모르면 시주 칸은 '-'로 두고 그 사실을 밝혀라.
- 그 다음 위 13단계를 '한 번의 답변 안에서' 처음부터 끝까지 모두 작성하라. 절대 '다음에 이어서', '다음이라고 말하라' 같은 표현을 쓰지 말고, 중간에 끊지 말고 13단계를 끝까지 완성하라.
- 각 단계는 '## 숫자. 제목' 형태의 소제목으로 명확히 구분하고, 각 단계마다 서로 다른 내용으로 충분히 깊이 있고 구체적으로 서술하라. 같은 문장이나 같은 조언을 여러 단계에서 반복하지 마라.

[표기 규칙 - 절대 준수]
- 모든 글자는 반드시 '한글'로만 적어라. 한자(漢字)를 단독으로 쓰지 마라.
- 천간은 반드시 [갑, 을, 병, 정, 무, 기, 경, 신, 임, 계] 열 글자 중에서만 쓰고, 지지는 반드시 [자, 축, 인, 묘, 진, 사, 오, 미, 신, 유, 술, 해] 열두 글자 중에서만 써라. (천간 자리에 지지 글자를 넣거나, 한자를 넣는 실수를 절대 하지 마라.)
- 오행은 '목, 화, 토, 금, 수'로만 표기하라. 꼭 한자 뜻을 보여줘야 하면 '한글(漢字)' 형태로 한 번만 병기하라. (예: 비견(比肩))
- 마크다운(소제목 ##, 강조 **, 목록 -, 표 |)을 적극 활용해 읽기 좋게 작성하라.
- 모든 답변은 자연스러운 한국어로만 작성하라.`;
}

function buildUserPrompt(d) {
  const name = (d.name || "").trim();
  const gender = d.gender === "male" ? "남자" : "여자";
  const birth = `양력 ${d.year}년 ${d.month}월 ${d.day}일`;
  const time = d.unknownTime ? "태어난 시간 모름" : timeLabel(d.hour, d.minute);
  const concern = (d.concern || "").trim() || "특별히 정한 질문 없음 (전반적인 운세를 알고 싶음)";

  return `[나의 사주 정보]
- 이름: ${name || "(미입력)"}
- 성별: ${gender}
- 생년월일시: 한국에서 ${birth}, ${time}에 태어났다.
- 현재 주요 관심사 및 추가 질문: ${concern}

자, 내가 온전한 복채를 냈으니, 먼저 나의 사주 명식을 세우고, 이어서 13단계 종합 리포트를 한 번에 끝까지 풀이해 다오.`;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.AI) {
    return new Response(
      JSON.stringify({ error: "AI 바인딩이 설정되지 않았습니다. (Workers AI 미연결)" }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "잘못된 요청입니다." }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  if (!data.year || !data.month || !data.day || !data.gender) {
    return new Response(
      JSON.stringify({ error: "생년월일과 성별은 필수입니다." }),
      { status: 400, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }

  try {
    const aiStream = await env.AI.run(PRIMARY_MODEL, {
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(data) },
      ],
      max_tokens: 8192,
      temperature: 0.85,
      stream: true,
    });

    return new Response(aiStream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "사주 풀이 생성 중 오류가 발생했단다. 잠시 후 다시 시도해 다오. (" + (err.message || "unknown") + ")" }),
      { status: 500, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
}
